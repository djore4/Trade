// btc-scan — BTC Advisor server-side (cron 15m). Corre o motor enriquecido
// (momentum/estrutura da Bybit + opções Deribit + basis + funding multi-venue)
// e regista UMA observação por horizonte em btc_obs. É o grupo de controlo
// direcional: o btc-settle mede depois o desfecho. Não coloca ordens.
//
// Fontes externas degradam com elegância: se Deribit/venues falharem, o motor
// cai no backbone da Bybit e as features enriquecidas ficam nulas (o obs
// regista o que conseguiu). Nada aqui bloqueia o registo do backbone.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import {
  btcDecide, BTC_HORIZONS,
  type OptionsSnap, type OptionLeg, type FundingVenues, type BasisSnap,
} from '../_shared/btc-engine.ts';
import type { Kline, LSR } from '../_shared/cs-engine.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const BYBIT = Deno.env.get('BYBIT_BASE') ?? 'https://api.bybit.com';
const DERIBIT = Deno.env.get('DERIBIT_BASE') ?? 'https://www.deribit.com';
const SYM = 'BTCUSDT';

// ── Bybit (cronológico: antigo → recente) ──
async function fetchKline(interval: string, limit: number): Promise<Kline> {
  const r = await fetch(`${BYBIT}/v5/market/kline?category=linear&symbol=${SYM}&interval=${interval}&limit=${limit}`);
  const d = await r.json();
  const list = (d?.result?.list || []).slice().reverse();
  return {
    closes: list.map((k: string[]) => +k[4]), highs: list.map((k: string[]) => +k[2]),
    lows: list.map((k: string[]) => +k[3]), opens: list.map((k: string[]) => +k[1]),
    vols: list.map((k: string[]) => +k[5]),
  };
}
async function fetchFunding(): Promise<number[]> {
  const r = await fetch(`${BYBIT}/v5/market/funding/history?category=linear&symbol=${SYM}&limit=100`);
  const d = await r.json();
  return (d?.result?.list || []).map((x: any) => parseFloat(x.fundingRate) * 100).reverse();
}
async function fetchOI(): Promise<number[]> {
  const r = await fetch(`${BYBIT}/v5/market/open-interest?category=linear&symbol=${SYM}&intervalTime=15min&limit=96`);
  const d = await r.json();
  return (d?.result?.list || []).map((x: any) => +x.openInterest).filter((v: number) => v > 0).reverse();
}
async function fetchLSR(): Promise<LSR[]> {
  try {
    const r = await fetch(`${BYBIT}/v5/market/account-ratio?category=linear&symbol=${SYM}&period=1h&limit=24`);
    const d = await r.json();
    return (d?.result?.list || []).map((x: any) => ({ buy: +x.buyRatio, sell: +x.sellRatio })).reverse();
  } catch { return []; }
}
async function fetchBybitTicker(category: string): Promise<any | null> {
  try {
    const r = await fetch(`${BYBIT}/v5/market/tickers?category=${category}&symbol=${SYM}`);
    const d = await r.json();
    return d?.result?.list?.[0] ?? null;
  } catch { return null; }
}

// ── Deribit (opções + índice + futuro trimestral) ──
const MONTHS: Record<string, number> = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
function parseDeribitExpiry(name: string): number | null {
  // BTC-27JUN25-100000-C  |  BTC-27JUN25 (future)
  const m = name.match(/^BTC-(\d{1,2})([A-Z]{3})(\d{2})/);
  if (!m) return null;
  const day = +m[1], mon = MONTHS[m[2]], yr = 2000 + +m[3];
  if (mon == null) return null;
  return Date.UTC(yr, mon, day, 8, 0, 0); // Deribit liquida às 08:00 UTC
}
async function fetchDeribitIndex(): Promise<number | null> {
  try {
    const r = await fetch(`${DERIBIT}/api/v2/public/get_index_price?index_name=btc_usd`);
    const d = await r.json();
    return d?.result?.index_price ?? null;
  } catch { return null; }
}
async function fetchDvolSeries(): Promise<{ cur: number | null; series: number[] }> {
  try {
    const end = Date.now(), start = end - 30 * 864e5; // 30 dias, resolução 1h
    const r = await fetch(`${DERIBIT}/api/v2/public/get_volatility_index_data?currency=BTC&start_timestamp=${start}&end_timestamp=${end}&resolution=3600`);
    const d = await r.json();
    const rows = d?.result?.data || [];
    const series = rows.map((x: number[]) => x[4]).filter((v: number) => isFinite(v));
    return { cur: series.length ? series[series.length - 1] : null, series };
  } catch { return { cur: null, series: [] }; }
}
async function fetchDeribitOptions(index: number): Promise<OptionLeg[]> {
  try {
    const r = await fetch(`${DERIBIT}/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=option`);
    const d = await r.json();
    const rows = d?.result || [];
    const legs: OptionLeg[] = [];
    for (const it of rows) {
      const name: string = it.instrument_name || '';
      const parts = name.split('-'); // BTC, 27JUN25, 100000, C
      if (parts.length !== 4) continue;
      const expMs = parseDeribitExpiry(name); if (expMs == null) continue;
      const strike = +parts[2]; if (!isFinite(strike)) continue;
      const iv = it.mark_iv != null ? +it.mark_iv : null; // já em %
      legs.push({ strike, iv: iv ?? 0, oi: +it.open_interest || 0, isPut: parts[3] === 'P', expMs });
    }
    return legs;
  } catch { return []; }
}
async function fetchDeribitFutBasis(index: number): Promise<{ fut: number | null; futDays: number | null }> {
  try {
    const r = await fetch(`${DERIBIT}/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=future`);
    const d = await r.json();
    const now = Date.now();
    const dated = (d?.result || [])
      .filter((it: any) => it.instrument_name && !/PERPETUAL/.test(it.instrument_name))
      .map((it: any) => ({ mark: +it.mark_price, exp: parseDeribitExpiry(it.instrument_name) }))
      .filter((x: any) => x.exp && x.mark > 0 && x.exp - now > 2 * 864e5)
      .sort((a: any, b: any) => a.exp - b.exp);
    if (!dated.length || !index) return { fut: null, futDays: null };
    const f = dated[0], days = (f.exp - now) / 864e5;
    const fut = days > 0 ? (f.mark / index - 1) * (365 / days) * 100 : null; // anualizado
    return { fut, futDays: days };
  } catch { return { fut: null, futDays: null }; }
}

// ── Funding multi-venue ──
async function fetchBinanceFunding(): Promise<number | null> {
  try {
    const r = await fetch('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT');
    const d = await r.json();
    return d?.lastFundingRate != null ? parseFloat(d.lastFundingRate) * 100 : null;
  } catch { return null; }
}
async function fetchOkxFunding(): Promise<number | null> {
  try {
    const r = await fetch('https://www.okx.com/api/v5/public/funding-rate?instId=BTC-USDT-SWAP');
    const d = await r.json();
    const rate = d?.data?.[0]?.fundingRate;
    return rate != null ? parseFloat(rate) * 100 : null;
  } catch { return null; }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const supa = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: cfgRow } = await supa.from('cs_config').select('obs_horizon_h, btc_swing_horizon_h, btc_scalp_horizon_h').eq('id', 1).single();
    const hScalp = +(cfgRow?.btc_scalp_horizon_h ?? 2);
    const hIntraday = +(cfgRow?.obs_horizon_h ?? 4);
    const hSwing = +(cfgRow?.btc_swing_horizon_h ?? 72);
    const hByKey: Record<string, number> = { scalp: hScalp, intraday: hIntraday, swing: hSwing };

    // Backbone (Bybit) — obrigatório. Se falhar, não há decisão.
    const [k15, k60, fund, oi, lsr, perpT, spotT] = await Promise.all([
      fetchKline('15', 200), fetchKline('60', 200), fetchFunding(), fetchOI(), fetchLSR(),
      fetchBybitTicker('linear'), fetchBybitTicker('spot'),
    ]);
    if (k15.closes.length < 60 || k60.closes.length < 50) return json({ error: 'klines insuficientes' }, 400);

    // Enriquecido (best-effort, degrada com elegância).
    const index = (await fetchDeribitIndex()) ?? (perpT ? +perpT.markPrice : k15.closes[k15.closes.length - 1]);
    const [dvol, optLegs, futB, binF, okxF] = await Promise.all([
      fetchDvolSeries(), fetchDeribitOptions(index), fetchDeribitFutBasis(index),
      fetchBinanceFunding(), fetchOkxFunding(),
    ]);
    const options: OptionsSnap = { index, dvol: dvol.cur, dvolSeries: dvol.series, legs: optLegs };
    const venues: FundingVenues = {
      bybit: perpT?.fundingRate != null ? parseFloat(perpT.fundingRate) * 100 : (fund.length ? fund[fund.length - 1] : null),
      binance: binF, okx: okxF,
    };
    const basis: BasisSnap = {
      perp: perpT ? +perpT.markPrice : null,
      spot: spotT ? +spotT.lastPrice : null,
      fut: futB.fut, futDays: futB.futDays,
    };

    const nowIso = new Date().toISOString();
    const rows: any[] = [];
    for (const key of ['scalp', 'intraday', 'swing'] as const) {
      const dec = btcDecide({ k15, k60, fund, oi, lsr }, { options, venues, basis }, key, 100, 5);
      const H = hByKey[key];
      const p = dec.plan;
      rows.push({
        ts: nowIso, horizon: key, horizon_h: H,
        dir: dec.dir, score: dec.score, confidence: dec.confidence, setup: dec.setup,
        price: dec.price, stop: p?.stop ?? null, tp1: p?.tps?.[0]?.price ?? null,
        tp1_r: p?.tps?.[0]?.r ?? null, stop_pct: p?.stopPct ?? null, blended_rr: p?.blendedRR ?? null,
        base_dir: dec.baseDir, base_score: dec.baseScore, regime: dec.regime, adx: dec.adx,
        dvol: dec.opt.dvol, dvol_pct: dec.opt.dvolPct, iv_skew: dec.opt.skew, iv_term: dec.opt.term,
        put_call_oi: dec.opt.putCall, funding_agg: dec.funding.agg, funding_disp: dec.funding.disp,
        basis_perp: dec.basis.perp, basis_fut: dec.basis.fut, pos_tilt: dec.posTilt.tilt,
      });
    }
    await supa.from('btc_obs').insert(rows);

    return json({
      ok: true, ts: nowIso, index,
      enriched: { dvol: dvol.cur, dvolPts: dvol.series.length, legs: optLegs.length, binance: binF != null, okx: okxF != null, fut: futB.fut != null },
      decisions: rows.map(r => ({ horizon: r.horizon, dir: r.dir, score: Math.round(r.score), conf: +(+r.confidence).toFixed(1), tilt: +(+r.pos_tilt).toFixed(2) })),
    });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 400);
  }
});
