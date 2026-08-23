// cs-order — coloca UMA ordem já confirmada da fila cs_bot_orders na subconta
// Bybit. Revalida os guarda-costas (defesa em profundidade), define leverage,
// arredonda qty/preços ao passo do instrumento, envia ordem market com
// stop-loss e take-profit (TP1) anexos e idempotência por orderLinkId=sig_key.
// Em sucesso, grava a posição em cs_suggestions para o loop cs-settle pontuar.
//
// Body: { order_id: number }  (linha em status 'confirmed'; ou 'pending_confirm'
// se cs_bot_state.auto_confirm=true). Usa a service role.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { bybitKeysFromEnv, bybitGet, bybitPost, fetchFilters, roundStep, roundTick } from '../_shared/bybit.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const utcDayStart = () => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d.toISOString(); };

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  try {
    const supa = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const body = await req.json().catch(() => ({}));
    const orderId = body?.order_id;
    if (!orderId) return json({ error: 'order_id em falta' }, 400);

    // ── Estado + kill-switch ──
    const { data: st } = await supa.from('cs_bot_state').select('*').eq('id', 1).single();
    if (!st) return json({ error: 'cs_bot_state ausente' }, 400);
    if (st.killswitch) return json({ blocked: 'killswitch' }, 200);
    if (!st.enabled) return json({ blocked: 'disabled' }, 200);

    // ── Linha da fila ──
    const { data: row } = await supa.from('cs_bot_orders').select('*').eq('id', orderId).single();
    if (!row) return json({ error: 'ordem não encontrada' }, 404);
    const okStatus = row.status === 'confirmed' || (row.status === 'pending_confirm' && st.auto_confirm);
    if (!okStatus) return json({ blocked: `status=${row.status}` }, 200);

    // TTL — não colocar ordens confirmadas há demasiado tempo (preço já mudou).
    const ageMin = (Date.now() - new Date(row.created_at).getTime()) / 60000;
    if (ageMin > (st.confirm_ttl_min ?? 30)) {
      await supa.from('cs_bot_orders').update({ status: 'expired', error: 'TTL excedido' }).eq('id', orderId);
      return json({ blocked: 'expired' }, 200);
    }

    // ── Guarda-costas (revalidados aqui) ──
    const keys = bybitKeysFromEnv();
    if (!keys.apiKey || (!keys.apiSecret && !keys.privateKeyPem))
      return json({ error: 'Credenciais Bybit da subconta não configuradas (falta API key + secret HMAC ou chave privada RSA).' }, 500);

    // nº posições abertas reais na subconta
    const pos = await bybitGet('/v5/position/list', 'category=linear&settleCoin=USDT', keys);
    const openPos = (pos?.result?.list || []).filter((p: any) => Math.abs(+p.size) > 0).length;
    if (openPos >= st.max_open_positions)
      return json({ blocked: `max_open_positions (${openPos}/${st.max_open_positions})` }, 200);

    // ordens já colocadas hoje + risco acumulado
    const { data: today } = await supa.from('cs_bot_orders')
      .select('risk_usd').eq('status', 'placed').gte('placed_at', utcDayStart());
    const placedToday = (today || []).length;
    const riskToday = (today || []).reduce((s: number, r: any) => s + (+r.risk_usd || 0), 0);
    if (placedToday >= st.max_daily_orders)
      return json({ blocked: `max_daily_orders (${placedToday}/${st.max_daily_orders})` }, 200);
    if (riskToday + (+row.risk_usd || 0) > st.max_daily_risk_usd)
      return json({ blocked: `max_daily_risk_usd (${(riskToday + (+row.risk_usd || 0)).toFixed(2)}/${st.max_daily_risk_usd})` }, 200);
    if ((+row.notional || 0) > st.max_notional_usd)
      return json({ blocked: `max_notional_usd (${row.notional}/${st.max_notional_usd})` }, 200);

    // ── DRY-RUN: nunca coloca ordem real ──
    if (st.dry_run) {
      await supa.from('cs_bot_orders').update({ status: 'cancelled', error: 'dry_run', decided_by: row.decided_by || 'auto' }).eq('id', orderId);
      return json({ dry_run: true, would_place: { symbol: row.symbol, side: row.side, qty: row.qty, entry: row.entry } }, 200);
    }

    // ── Arredondar ao passo do instrumento ──
    const filt = await fetchFilters(row.symbol, keys.base);
    if (!filt) { await supa.from('cs_bot_orders').update({ status: 'failed', error: 'sem filtros do instrumento' }).eq('id', orderId); return json({ error: 'filtros' }, 400); }
    const qty = roundStep(+row.qty, filt.qtyStep);
    if (qty < filt.minQty || qty <= 0) {
      await supa.from('cs_bot_orders').update({ status: 'failed', error: `qty ${qty} < min ${filt.minQty}` }).eq('id', orderId);
      return json({ blocked: 'qty_below_min', qty, min: filt.minQty }, 200);
    }
    const sl = roundTick(+row.stop, filt.tickSize);
    const tp = roundTick(+row.tp1, filt.tickSize);
    const bybitSide = row.side === 'long' ? 'Buy' : 'Sell';
    const lev = String(Math.max(1, Math.min(filt.maxLev, Math.round(+row.leverage || 5))));

    // Marca 'placing' cedo (evita corrida se chamado 2x).
    await supa.from('cs_bot_orders').update({ status: 'placing' }).eq('id', orderId);

    // ── Definir leverage (tolera "não modificado") ──
    const levRes = await bybitPost('/v5/position/set-leverage',
      { category: 'linear', symbol: row.symbol, buyLeverage: lev, sellLeverage: lev }, keys);
    if (levRes?.retCode && levRes.retCode !== 0 && levRes.retCode !== 110043) {
      await supa.from('cs_bot_orders').update({ status: 'failed', error: `set-leverage: ${levRes.retMsg}` }).eq('id', orderId);
      return json({ error: 'set-leverage', detail: levRes }, 400);
    }

    // ── Colocar ordem market com SL/TP anexos (one-way mode: positionIdx 0) ──
    const orderLinkId = (row.order_link_id || row.sig_key).slice(0, 45);
    const ord = await bybitPost('/v5/order/create', {
      category: 'linear', symbol: row.symbol, side: bybitSide, orderType: 'Market',
      qty: String(qty), timeInForce: 'IOC', positionIdx: 0,
      stopLoss: String(sl), takeProfit: String(tp), tpslMode: 'Full',
      slTriggerBy: 'LastPrice', tpTriggerBy: 'LastPrice',
      orderLinkId, reduceOnly: false,
    }, keys);

    if (ord?.retCode !== 0) {
      await supa.from('cs_bot_orders').update({ status: 'failed', error: `order: ${ord?.retCode} ${ord?.retMsg}` }).eq('id', orderId);
      return json({ error: 'order-create', detail: ord }, 400);
    }

    const bybitOrderId = ord?.result?.orderId ?? null;
    await supa.from('cs_bot_orders').update({
      status: 'placed', bybit_order_id: bybitOrderId, order_link_id: orderLinkId,
      placed_at: new Date().toISOString(), qty,
    }).eq('id', orderId);

    // ── Fechar o ciclo: gravar em cs_suggestions p/ o cs-settle pontuar ──
    await supa.from('cs_suggestions').upsert([{
      sig_key: row.sig_key, entry_ts: new Date().toISOString(), symbol: row.symbol, coin: row.coin,
      side: row.side, entry: +row.entry, stop: +row.stop, tp1: +row.tp1, tp1_r: +row.tp1_r || 1,
      stop_pct: row.stop_pct, blended_rr: row.blended_rr, score: row.score, confidence: row.confidence,
      sensitivity: row.sensitivity, regime: row.regime, setup: row.setup, signals: row.signals,
      turnover: row.turnover, low_liq: !!row.low_liq, leverage: row.leverage, status: 'open',
    }], { onConflict: 'sig_key', ignoreDuplicates: true });

    return json({ placed: true, order_id: orderId, bybit_order_id: bybitOrderId, qty, sl, tp });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 400);
  }
});
