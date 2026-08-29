// cs-bot — loop semi-automático do CryptoScan (disparado por pg_cron).
// Corre o MESMO motor da app (server-side, _shared/cs-engine.ts) sobre os
// perps da Bybit, filtra por convicção, e ENFILEIRA os melhores candidatos em
// cs_bot_orders (status 'pending_confirm'). Não coloca ordens — isso é a
// cs-order, chamada após confirmação humana (ou auto, se auto_confirm=true).
//
// Guarda-costas ao nível do loop: killswitch, enabled, nº de slots livres
// (max_open_positions menos posições reais abertas), dedup por sig_key.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import {
  buildConfig, evaluateCandidate, isSuggestion, sigKey, coinOf, csSetupType,
  type Candidate, type Kline, type LSR,
} from '../_shared/cs-engine.ts';
import { bybitKeysFromEnv, bybitGet } from '../_shared/bybit.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const BYBIT = Deno.env.get('BYBIT_BASE') ?? 'https://api.bybit.com';

// ── Fetchers públicos (cronológico: antigo → recente), iguais aos do browser ──
async function fetchKline(sym: string, interval: string, limit: number): Promise<Kline> {
  const r = await fetch(`${BYBIT}/v5/market/kline?category=linear&symbol=${sym}&interval=${interval}&limit=${limit}`);
  const d = await r.json();
  const list = (d?.result?.list || []).slice().reverse();
  return {
    closes: list.map((k: string[]) => +k[4]), highs: list.map((k: string[]) => +k[2]),
    lows: list.map((k: string[]) => +k[3]), opens: list.map((k: string[]) => +k[1]),
    vols: list.map((k: string[]) => +k[5]),
  };
}
async function fetchFunding(sym: string): Promise<number[]> {
  const r = await fetch(`${BYBIT}/v5/market/funding/history?category=linear&symbol=${sym}&limit=100`);
  const d = await r.json();
  return (d?.result?.list || []).map((x: any) => parseFloat(x.fundingRate) * 100).reverse();
}
async function fetchOI(sym: string): Promise<number[]> {
  const r = await fetch(`${BYBIT}/v5/market/open-interest?category=linear&symbol=${sym}&intervalTime=15min&limit=96`);
  const d = await r.json();
  return (d?.result?.list || []).map((x: any) => +x.openInterest).filter((v: number) => v > 0).reverse();
}
async function fetchLSR(sym: string): Promise<LSR[]> {
  try {
    const r = await fetch(`${BYBIT}/v5/market/account-ratio?category=linear&symbol=${sym}&period=1h&limit=24`);
    const d = await r.json();
    return (d?.result?.list || []).map((x: any) => ({ buy: parseFloat(x.buyRatio), sell: parseFloat(x.sellRatio) })).reverse();
  } catch { return []; }
}

// Pool de concorrência simples.
async function pool<T>(items: T[], fn: (t: T) => Promise<void>, n: number): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx]); }
  });
  await Promise.all(workers);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const supa = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: st } = await supa.from('cs_bot_state').select('*').eq('id', 1).single();
    if (!st) return json({ error: 'cs_bot_state ausente — aplicar a migração.' }, 400);
    if (st.killswitch) return json({ skipped: 'killswitch' });
    if (!st.enabled) return json({ skipped: 'disabled' });

    const cfg = buildConfig({
      sensitivity: st.sensitivity, recalibrate: st.recalibrate,
      capital: +st.capital, leverage: +st.leverage,
    });
    if (st.min_confidence != null) cfg.minConfidence = +st.min_confidence;

    // Slots livres = teto − posições reais abertas na subconta.
    let freeSlots = st.max_open_positions;
    const keys = bybitKeysFromEnv();
    if (keys.apiKey && (keys.apiSecret || keys.privateKeyPem)) {
      const pos = await bybitGet('/v5/position/list', 'category=linear&settleCoin=USDT', keys);
      const openPos = (pos?.result?.list || []).filter((p: any) => Math.abs(+p.size) > 0).length;
      freeSlots = Math.max(0, st.max_open_positions - openPos);
    }
    // Menos os que já estão na fila à espera de confirmação/colocação.
    const { count: pendingCount } = await supa.from('cs_bot_orders')
      .select('*', { count: 'exact', head: true }).in('status', ['pending_confirm', 'confirmed', 'placing']);
    freeSlots = Math.max(0, freeSlots - (pendingCount ?? 0));
    if (freeSlots <= 0) return json({ scanned: 0, enqueued: 0, note: 'sem slots livres' });

    // ── Universo ──
    const tr = await fetch(`${BYBIT}/v5/market/tickers?category=linear`);
    const td = await tr.json();
    let uni: Candidate[] = (td?.result?.list || [])
      .filter((t: any) => /USDT$/.test(t.symbol) && !/[0-9]/.test(coinOf(t.symbol)))
      .map((t: any) => ({
        symbol: t.symbol, coin: coinOf(t.symbol), price: parseFloat(t.lastPrice),
        chg24: parseFloat(t.price24hPcnt) * 100, fr: parseFloat(t.fundingRate) * 100,
        turnover: parseFloat(t.turnover24h) || 0, lowLiq: false,
      }))
      .filter((c: Candidate) => c.turnover >= cfg.minTurnover && isFinite(c.price) && c.price > 0);
    uni.forEach(c => { c.lowLiq = c.turnover < cfg.healthyTurnover; });
    uni.sort((a, b) => b.turnover - a.turnover);
    const enrich = uni.slice(0, cfg.universeTop);

    await pool(enrich, async (c) => {
      try {
        const [k15, k60, fund, oi, lsr] = await Promise.all([
          fetchKline(c.symbol, '15', 200), fetchKline(c.symbol, '60', 120),
          fetchFunding(c.symbol), fetchOI(c.symbol), fetchLSR(c.symbol),
        ]);
        evaluateCandidate(c, { k15, k60, fund, oi, lsr }, cfg);
      } catch { c.err = true; }
    }, cfg.concurrency);

    const sug = enrich
      .filter(c => !c.err && c.dir !== 0 && isSuggestion(c, cfg))
      .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));

    // ── Enfileirar até freeSlots, com dedup por sig_key ──
    let enqueued = 0; const queued: string[] = [];
    for (const c of sug) {
      if (enqueued >= freeSlots) break;
      const p = c.plan; if (!p) continue;
      const key = sigKey(c.symbol, c.dir!);
      const { data: exists } = await supa.from('cs_bot_orders').select('id').eq('sig_key', key).maybeSingle();
      if (exists) continue;

      const status = st.auto_confirm ? 'confirmed' : 'pending_confirm';
      const { data: ins, error } = await supa.from('cs_bot_orders').insert({
        sig_key: key, entry_ts: new Date().toISOString(), symbol: c.symbol, coin: c.coin,
        side: c.dir! > 0 ? 'long' : 'short',
        entry: p.entry, stop: p.stop, tp1: p.tps[0].price, tp2: p.tps[1]?.price ?? null, tp3: p.tps[2]?.price ?? null,
        tp1_r: p.tps[0].r, stop_pct: p.stopPct, blended_rr: p.blendedRR,
        qty: p.qty, notional: p.notional, leverage: p.lev, risk_usd: p.riskUsd,
        score: c.score, confidence: c.confidence, sensitivity: cfg.sensitivity,
        regime: c.sigs!.regime.type, setup: csSetupType(c.sigs!, c.dir!),
        signals: {
          funding: c.sigs!.h1.on, oi: c.sigs!.h2.on, cascade: c.sigs!.h3.on,
          thrust: c.sigs!.thrust.on, breakout: c.sigs!.brk.on, structure: c.sigs!.st.on,
        },
        turnover: c.turnover, low_liq: !!c.lowLiq, recalibrated: !!st.recalibrate,
        status, order_link_id: key, decided_by: st.auto_confirm ? 'auto' : null,
        confirmed_at: st.auto_confirm ? new Date().toISOString() : null,
      }).select('id').single();
      if (error) continue;
      enqueued++; queued.push(key);

      // auto-confirm → dispara a colocação já.
      if (st.auto_confirm && ins?.id) {
        try {
          await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/cs-order`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}` },
            body: JSON.stringify({ order_id: ins.id }),
          });
        } catch { /* fica confirmed; a próxima passagem/retry trata */ }
      }
    }

    return json({ scanned: enrich.length, candidates: sug.length, freeSlots, enqueued, queued, mode: st.auto_confirm ? 'auto' : 'semi', dry_run: st.dry_run });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 400);
  }
});
