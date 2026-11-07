import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Velas (OHLCV) para o grafico do separador Trade. Dados publicos, sem chaves.
//   ?source=bybit&symbol=APTUSDT&interval=15&limit=500
//        interval: 1 3 5 15 30 60 120 240 360 720 D W M   (categoria linear/inverse deduzida do simbolo)
//   ?source=yahoo&symbol=MSTR&interval=5m&range=5d
//        interval: 1m 2m 5m 15m 30m 60m 1d 1wk 1mo ; range: 1d 5d 1mo 3mo 6mo 1y 2y 5y 10y max
// Resposta: { source, symbol, candles: [{t (segundos UTC), o, h, l, c, v}] (ascendente), currency?, name?, prevClose? }
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=2' },
    status,
  });

const BYBIT_INTERVALS = new Set(['1', '3', '5', '15', '30', '60', '120', '240', '360', '720', 'D', 'W', 'M']);
const YAHOO_INTERVALS = new Set(['1m', '2m', '5m', '15m', '30m', '60m', '90m', '1h', '1d', '5d', '1wk', '1mo']);
const YAHOO_RANGES = new Set(['1d', '5d', '1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'ytd', 'max']);

async function bybit(symbol: string, interval: string, limit: number) {
  const category = /(USDT|USDC|PERP)$/.test(symbol) ? 'linear' : 'inverse';
  const url = `https://api.bybit.com/v5/market/kline?category=${category}&symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  const d = await r.json();
  if (d?.retCode !== 0) throw new Error(`Bybit ${d?.retCode}: ${d?.retMsg}`);
  // [startTime(ms), open, high, low, close, volume, turnover] — mais recente primeiro
  const candles = (d.result?.list ?? []).map((k: string[]) => ({
    t: Math.floor(Number(k[0]) / 1000), o: Number(k[1]), h: Number(k[2]), l: Number(k[3]), c: Number(k[4]), v: Number(k[5]),
  })).reverse();
  return { candles };
}

async function yahoo(symbol: string, interval: string, range: string) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TradeDesk/1.0)' }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`Yahoo ${r.status}`);
  const d = await r.json();
  const res = d?.chart?.result?.[0];
  if (!res) throw new Error(d?.chart?.error?.description || 'sem dados');
  const ts: number[] = res.timestamp ?? [];
  const q = res.indicators?.quote?.[0] ?? {};
  const candles: Record<string, number>[] = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    if (o == null || h == null || l == null || c == null) continue;
    candles.push({ t: ts[i], o, h, l, c, v: q.volume?.[i] ?? 0 });
  }
  const m = res.meta ?? {};
  return { candles, currency: m.currency ?? null, name: m.shortName ?? m.longName ?? null, prevClose: m.chartPreviousClose ?? m.previousClose ?? null };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const q = new URL(req.url).searchParams;
    const source = (q.get('source') || '').toLowerCase();
    const symbol = (q.get('symbol') || '').trim().toUpperCase();
    if (!symbol || symbol.length > 24) return json({ error: 'symbol invalido' }, 400);

    if (source === 'bybit') {
      const interval = q.get('interval') || '15';
      if (!BYBIT_INTERVALS.has(interval)) return json({ error: 'interval invalido' }, 400);
      const limit = Math.min(1000, Math.max(1, Number(q.get('limit')) || 500));
      return json({ source, symbol, ...(await bybit(symbol, interval, limit)) });
    }
    if (source === 'yahoo') {
      const interval = q.get('interval') || '15m';
      const range = q.get('range') || '1mo';
      if (!YAHOO_INTERVALS.has(interval) || !YAHOO_RANGES.has(range)) return json({ error: 'interval/range invalido' }, 400);
      return json({ source, symbol, ...(await yahoo(symbol, interval, range)) });
    }
    return json({ error: 'source tem de ser bybit ou yahoo' }, 400);
  } catch (e) {
    return json({ error: (e as Error).message }, 502);
  }
});
