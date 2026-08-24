// cs-exec — coloca UMA ordem a partir de um plano enviado pela app (o cartão do
// scan que o utilizador escolheu executar). Fluxo único: o scan (browser) é o
// cérebro; esta função é a mão. Revalida os guarda-costas de cs_bot_state,
// respeita dry_run, arredonda ao passo do instrumento, define leverage e coloca
// ordem market com SL/TP1 anexos. Regista em cs_bot_orders + cs_suggestions.
//
// Body: { plan: { symbol, coin, side, entry, stop, tp1, tp2?, tp3?, tp1_r?,
//   stop_pct?, blended_rr?, qty, notional?, leverage?, risk_usd?, score?,
//   confidence?, sensitivity?, regime?, setup?, signals?, turnover?, low_liq? },
//   secret? }
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { bybitKeysFromEnv, bybitPost, fetchFilters, roundStep, roundTick } from '../_shared/bybit.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cs-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const utcDayStart = () => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d.toISOString(); };
const hourBucket = (d = new Date()) => '' + d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, '0') + String(d.getUTCDate()).padStart(2, '0') + String(d.getUTCHours()).padStart(2, '0');

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  try {
    const supa = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const body = await req.json().catch(() => ({}));
    const p = body?.plan;
    if (!p || !p.symbol || !p.side || !isFinite(+p.entry) || !isFinite(+p.stop) || !isFinite(+p.tp1) || !(+p.qty > 0))
      return json({ error: 'plano inválido' }, 400);
    if (p.side !== 'long' && p.side !== 'short') return json({ error: 'side inválido' }, 400);

    // ── Estado + segredo ──
    const { data: st } = await supa.from('cs_bot_state').select('*').eq('id', 1).single();
    if (!st) return json({ error: 'cs_bot_state ausente' }, 400);
    const secret = Deno.env.get('CS_BOT_SECRET');
    if (secret) { const given = req.headers.get('x-cs-secret') || body?.secret; if (given !== secret) return json({ error: 'não autorizado' }, 401); }
    if (st.killswitch) return json({ blocked: 'killswitch' });

    const sigKey = `${p.symbol}_${p.side}_${hourBucket()}`;

    // dedup: já existe ordem para esta moeda/lado/hora?
    const { data: dup } = await supa.from('cs_bot_orders').select('id,status').eq('sig_key', sigKey).maybeSingle();
    if (dup && ['placed', 'placing', 'confirmed'].includes(dup.status)) return json({ blocked: 'duplicada', status: dup.status });

    // ── Guarda-costas (dinheiro real) ──
    const keys = bybitKeysFromEnv();
    if (!keys.apiKey || (!keys.apiSecret && !keys.privateKeyPem)) return json({ error: 'Credenciais Bybit não configuradas.' }, 500);

    const { data: today } = await supa.from('cs_bot_orders').select('risk_usd').eq('status', 'placed').gte('placed_at', utcDayStart());
    if ((today || []).length >= st.max_daily_orders) return json({ blocked: `max_daily_orders (${(today || []).length}/${st.max_daily_orders})` });
    const riskToday = (today || []).reduce((s: number, r: any) => s + (+r.risk_usd || 0), 0);
    if (riskToday + (+p.risk_usd || 0) > st.max_daily_risk_usd) return json({ blocked: `max_daily_risk_usd (${(riskToday + (+p.risk_usd || 0)).toFixed(2)}/${st.max_daily_risk_usd})` });
    if ((+p.notional || 0) > st.max_notional_usd) return json({ blocked: `max_notional_usd (${(+p.notional || 0).toFixed(0)}/${st.max_notional_usd})` });

    // Registo base da ordem (snapshot do cartão).
    const orderRow = {
      sig_key: sigKey, entry_ts: new Date().toISOString(), symbol: p.symbol, coin: p.coin || p.symbol.replace(/USDT$/, ''),
      side: p.side, entry: +p.entry, stop: +p.stop, tp1: +p.tp1, tp2: p.tp2 != null ? +p.tp2 : null, tp3: p.tp3 != null ? +p.tp3 : null,
      tp1_r: p.tp1_r != null ? +p.tp1_r : 1, stop_pct: p.stop_pct != null ? +p.stop_pct : null, blended_rr: p.blended_rr != null ? +p.blended_rr : null,
      qty: +p.qty, notional: p.notional != null ? +p.notional : null, leverage: p.leverage != null ? +p.leverage : null, risk_usd: p.risk_usd != null ? +p.risk_usd : null,
      score: p.score ?? null, confidence: p.confidence ?? null, sensitivity: p.sensitivity ?? null, regime: p.regime ?? null, setup: p.setup ?? null,
      signals: p.signals ?? null, turnover: p.turnover ?? null, low_liq: !!p.low_liq, recalibrated: !!st.recalibrate, order_link_id: sigKey, decided_by: 'human',
    };

    // ── DRY-RUN: regista como cancelada (simulação), não coloca ──
    if (st.dry_run) {
      await supa.from('cs_bot_orders').upsert([{ ...orderRow, status: 'cancelled', error: 'dry_run' }], { onConflict: 'sig_key', ignoreDuplicates: false });
      return json({ dry_run: true, would_place: { symbol: p.symbol, side: p.side, qty: +p.qty, entry: +p.entry, stop: +p.stop, tp1: +p.tp1 } });
    }

    // ── Arredondar ao passo do instrumento ──
    const filt = await fetchFilters(p.symbol, keys.base);
    if (!filt) return json({ error: 'sem filtros do instrumento' }, 400);
    const qty = roundStep(+p.qty, filt.qtyStep);
    if (qty < filt.minQty || qty <= 0) return json({ blocked: 'qty_below_min', qty, min: filt.minQty });
    const sl = roundTick(+p.stop, filt.tickSize);
    const tp = roundTick(+p.tp1, filt.tickSize);
    const bybitSide = p.side === 'long' ? 'Buy' : 'Sell';
    const lev = String(Math.max(1, Math.min(filt.maxLev, Math.round(+p.leverage || 5))));

    await supa.from('cs_bot_orders').upsert([{ ...orderRow, status: 'placing', qty }], { onConflict: 'sig_key', ignoreDuplicates: false });

    const levRes = await bybitPost('/v5/position/set-leverage', { category: 'linear', symbol: p.symbol, buyLeverage: lev, sellLeverage: lev }, keys);
    if (levRes?.retCode && levRes.retCode !== 0 && levRes.retCode !== 110043) {
      await supa.from('cs_bot_orders').update({ status: 'failed', error: `set-leverage: ${levRes.retMsg}` }).eq('sig_key', sigKey);
      return json({ error: 'set-leverage', detail: levRes }, 400);
    }

    const ord = await bybitPost('/v5/order/create', {
      category: 'linear', symbol: p.symbol, side: bybitSide, orderType: 'Market',
      qty: String(qty), timeInForce: 'IOC', positionIdx: 0,
      stopLoss: String(sl), takeProfit: String(tp), tpslMode: 'Full',
      slTriggerBy: 'LastPrice', tpTriggerBy: 'LastPrice', orderLinkId: sigKey.slice(0, 45), reduceOnly: false,
    }, keys);
    if (ord?.retCode !== 0) {
      await supa.from('cs_bot_orders').update({ status: 'failed', error: `order: ${ord?.retCode} ${ord?.retMsg}` }).eq('sig_key', sigKey);
      return json({ error: 'order-create', detail: ord }, 400);
    }

    const bybitOrderId = ord?.result?.orderId ?? null;
    await supa.from('cs_bot_orders').update({ status: 'placed', bybit_order_id: bybitOrderId, placed_at: new Date().toISOString() }).eq('sig_key', sigKey);
    await supa.from('cs_suggestions').upsert([{
      sig_key: sigKey, entry_ts: new Date().toISOString(), symbol: p.symbol, coin: orderRow.coin, side: p.side,
      entry: +p.entry, stop: +p.stop, tp1: +p.tp1, tp1_r: orderRow.tp1_r, stop_pct: orderRow.stop_pct, blended_rr: orderRow.blended_rr,
      score: p.score ?? null, confidence: p.confidence ?? null, sensitivity: p.sensitivity ?? null, regime: p.regime ?? null, setup: p.setup ?? null,
      signals: p.signals ?? null, turnover: p.turnover ?? null, low_liq: !!p.low_liq, leverage: orderRow.leverage, status: 'open',
    }], { onConflict: 'sig_key', ignoreDuplicates: true });

    return json({ placed: true, symbol: p.symbol, side: p.side, qty, sl, tp, bybit_order_id: bybitOrderId });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 400);
  }
});
