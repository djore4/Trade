import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Mapa de liquidacoes ESTIMADO para um perpetuo linear da Bybit  (?symbol=APTUSDT&window=1d|1w|1m).
//
// Nenhuma exchange publica onde estao as liquidacoes reais; isto e um modelo (como os "heatmaps" comerciais):
//  1. velas + open interest (OI) da Bybit, em barras de 15m (1d), 1h (1w) ou 4h (1m);
//  2. cada aumento de OI abre posicoes novas, longas e curtas, ao preco tipico da vela, repartidas por patamares
//     de alavancagem (TIERS/WEIGHTS: pressuposto, nao observado);
//  3. preco de liquidacao: longa = P*(1 - 1/L + MMR); curta = P*(1 + 1/L - MMR);
//  4. posicoes cuja liquidacao foi atingida pelo intervalo de uma vela posterior sao removidas (ja liquidadas);
//     quedas de OI fecham posicoes proporcionalmente;
//  5. o que sobrevive e agrupado por preco.
// Limites: ignora posicoes anteriores a janela, margem cruzada/isolada e tiers de margem de manutencao.
//
// Contexto real: liquidacoes recentes da OKX (endpoint publico), quando o ativo existe la.
const TIERS = [5, 10, 25, 50, 100];
const WEIGHTS = [0.15, 0.30, 0.30, 0.18, 0.07];
const MMR = 0.005;
const NBINS = 70;
const RANGE = 0.4;   // +-40% em torno do preco atual
const WINDOWS: Record<string, { kline: string; oi: string; limit: number }> = {
  '1d': { kline: '15', oi: '15min', limit: 96 },
  '1w': { kline: '60', oi: '1h', limit: 168 },
  '1m': { kline: '240', oi: '4h', limit: 180 },
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' }, status,
  });

type Bar = { t: number; o: number; h: number; l: number; c: number };
async function bybit(path: string) {
  const r = await fetch(`https://api.bybit.com${path}`, { signal: AbortSignal.timeout(9000) });
  const d = await r.json();
  if (d?.retCode !== 0) throw new Error(`Bybit ${d?.retCode}: ${d?.retMsg}`);
  return d.result;
}

function model(bars: Bar[], oi: number[]) {
  type E = { liq: number; long: boolean; w: number };
  let es: E[] = [];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    es = es.filter((e) => (e.long ? b.l > e.liq : b.h < e.liq));            // varrimento por velas posteriores
    if (i > 0 && oi[i - 1] > 0) {
      const d = oi[i] - oi[i - 1];
      if (d < 0) { const f = oi[i] / oi[i - 1]; for (const e of es) e.w *= f; }   // fecho proporcional
      else if (d > 0) {
        const pe = (b.h + b.l + b.c) / 3, notional = d * pe;
        TIERS.forEach((L, k) => {
          const lo = pe * (1 - 1 / L + MMR), sh = pe * (1 + 1 / L - MMR);
          if (lo < b.l) es.push({ liq: lo, long: true, w: notional * WEIGHTS[k] });     // so se nao foi atingida na propria vela
          if (sh > b.h) es.push({ liq: sh, long: false, w: notional * WEIGHTS[k] });
        });
      }
    }
  }
  return es;
}

async function okx(coin: string) {
  try {
    const [liq, ins] = await Promise.all([
      fetch(`https://www.okx.com/api/v5/public/liquidation-orders?instType=SWAP&uly=${coin}-USDT&state=filled`, { signal: AbortSignal.timeout(7000) }).then((r) => r.json()),
      fetch(`https://www.okx.com/api/v5/public/instruments?instType=SWAP&uly=${coin}-USDT`, { signal: AbortSignal.timeout(7000) }).then((r) => r.json()),
    ]);
    const ctVal = Number(ins?.data?.[0]?.ctVal) || 0;
    const details = liq?.data?.[0]?.details ?? [];
    if (!ctVal || !details.length) return null;
    const events = details.map((d: any) => ({ t: Math.floor(Number(d.ts) / 1000), side: d.posSide === 'long' ? 'long' : 'short', px: Number(d.bkPx), usd: Number(d.sz) * ctVal * Number(d.bkPx) }))
      .filter((e: any) => isFinite(e.usd) && e.px > 0).sort((a: any, b: any) => b.t - a.t);
    if (!events.length) return null;
    return {
      events: events.slice(0, 12),
      longUsd: events.filter((e: any) => e.side === 'long').reduce((a: number, e: any) => a + e.usd, 0),
      shortUsd: events.filter((e: any) => e.side === 'short').reduce((a: number, e: any) => a + e.usd, 0),
      n: events.length, since: events[events.length - 1].t,
    };
  } catch (_e) { return null; }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const q = new URL(req.url).searchParams;
    const symbol = (q.get('symbol') || '').toUpperCase();
    const w = WINDOWS[q.get('window') || '1w'];
    if (!/^[A-Z0-9]{2,20}(USDT|USDC)$/.test(symbol)) return json({ error: 'simbolo invalido (perpetuo linear USDT/USDC da Bybit)' }, 400);
    if (!w) return json({ error: 'window invalida (1d, 1w, 1m)' }, 400);
    const coin = symbol.replace(/(USDT|USDC)$/, '');

    const [kr, or, okxData] = await Promise.all([
      bybit(`/v5/market/kline?category=linear&symbol=${symbol}&interval=${w.kline}&limit=${w.limit}`),
      bybit(`/v5/market/open-interest?category=linear&symbol=${symbol}&intervalTime=${w.oi}&limit=${Math.min(200, w.limit)}`),
      okx(coin),
    ]);
    const bars: Bar[] = (kr.list ?? []).map((k: string[]) => ({ t: Number(k[0]), o: +k[1], h: +k[2], l: +k[3], c: +k[4] })).reverse();
    if (bars.length < 10) return json({ error: 'poucas velas' }, 502);
    const oiMap = new Map<number, number>((or.list ?? []).map((x: any) => [Number(x.timestamp), Number(x.openInterest)]));
    let last = NaN;
    const oi = bars.map((b) => { const v = oiMap.get(b.t); if (v != null) last = v; return isFinite(last) ? last : 0; });
    if (!oi.some((v) => v > 0)) return json({ error: 'sem dados de open interest' }, 502);

    const price = bars[bars.length - 1].c;
    const es = model(bars, oi);
    const lo = price * (1 - RANGE), hi = price * (1 + RANGE), bw = (hi - lo) / NBINS;
    const bins = Array.from({ length: NBINS }, (_, i) => ({ p: lo + (i + 0.5) * bw, l: 0, s: 0 }));
    let longTot = 0, shortTot = 0;
    for (const e of es) {
      if (e.liq < lo || e.liq >= hi) continue;
      const i = Math.min(NBINS - 1, Math.floor((e.liq - lo) / bw));
      if (e.long) { bins[i].l += e.w; longTot += e.w; } else { bins[i].s += e.w; shortTot += e.w; }
    }
    // maiores aglomerados por lado (maximos locais), do mais proximo ao mais longe
    const top = (side: 'l' | 's') => bins.map((b, i) => ({ i, p: b.p, v: b[side] }))
      .filter((b) => b.v > 0 && b.v >= (bins[b.i - 1]?.[side] ?? 0) && b.v >= (bins[b.i + 1]?.[side] ?? 0))
      .sort((a, b) => b.v - a.v).slice(0, 3).map((b) => ({ p: b.p, pct: (b.p / price - 1) * 100, usd: b.v })).sort((a, b) => Math.abs(a.pct) - Math.abs(b.pct));
    return json({
      symbol, window: q.get('window') || '1w', price, bucket: bw, bins: bins.map((b) => ({ p: b.p, l: Math.round(b.l), s: Math.round(b.s) })),
      totals: { long: Math.round(longTot), short: Math.round(shortTot) },
      clusters: { long: top('l'), short: top('s') },
      oiUsd: oi[oi.length - 1] * price, bars: bars.length, from: Math.floor(bars[0].t / 1000), okx: okxData,
      model: { tiers: TIERS, weights: WEIGHTS, mmr: MMR },
    });
  } catch (e) {
    return json({ error: (e as Error).message }, 502);
  }
});
