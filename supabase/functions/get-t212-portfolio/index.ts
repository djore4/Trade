import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Trading 212 Public API (contas Invest / Stocks ISA).
// Auth: HTTP Basic com API Key + API Secret (Authorization: Basic base64(KEY:SECRET)).
// Secrets: T212_API_KEY, T212_API_SECRET, T212_ENV (live|demo)
//
// Resposta: { positions, cash, account?, accountError?, instruments?, instrumentsError? }
//  - positions:   /equity/portfolio
//  - account:     { currency, total, invested, ppl, free, value } de /equity/account/summary
//                 (fallback: /equity/account/cash). `cash` = igual (compat.)
//  - accountError: porque falhou a conta (em vez de engolir o erro)
//  - instruments: { [ticker]: { currencyCode, type, name, shortName, isin } } so dos tickers detidos,
//                 de /equity/metadata/instruments (limite T212: 1 pedido / 50s -> cache em memoria)
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    status,
  });

const num = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };

async function getJson(url: string, headers: Record<string, string>) {
  const r = await fetch(url, { headers });
  const text = await r.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch (_e) { /* corpo nao-JSON */ }
  return { ok: r.ok, status: r.status, data, text };
}

// Cache (vive enquanto o isolate da edge function estiver quente).
const INSTR_TTL = 6 * 3600 * 1000;
const INSTR_RETRY = 60 * 1000;
let instrCache: { at: number; map: Record<string, any> } = { at: 0, map: {} };
let instrLastTry = 0;

async function loadInstruments(base: string, headers: Record<string, string>, tickers: string[]) {
  const missing = tickers.some(t => !(t in instrCache.map));
  const fresh = Date.now() - instrCache.at < INSTR_TTL;
  if (!missing && fresh) return { map: instrCache.map, error: null as string | null };
  if (Date.now() - instrLastTry < INSTR_RETRY) return { map: instrCache.map, error: 'instrumentos: a aguardar limite de pedidos' };
  instrLastTry = Date.now();
  const r = await getJson(`${base}/equity/metadata/instruments`, headers);
  if (!r.ok || !Array.isArray(r.data)) {
    return { map: instrCache.map, error: `instrumentos: HTTP ${r.status} ${r.text.slice(0, 100)}` };
  }
  const want = new Set(tickers);
  const map: Record<string, any> = {};
  for (const i of r.data) {
    if (want.has(i.ticker)) {
      map[i.ticker] = { currencyCode: i.currencyCode, type: i.type, name: i.name, shortName: i.shortName, isin: i.isin };
    }
  }
  instrCache = { at: Date.now(), map };
  return { map, error: null as string | null };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const apiKey = Deno.env.get('T212_API_KEY') ?? '';
    const apiSecret = Deno.env.get('T212_API_SECRET') ?? '';
    const env = (Deno.env.get('T212_ENV') ?? 'live').toLowerCase();
    const base = env === 'demo'
      ? 'https://demo.trading212.com/api/v0'
      : 'https://live.trading212.com/api/v0';

    if (!apiKey) return json({ error: 'T212_API_KEY nao configurada.' }, 500);

    const headers = { 'Authorization': apiSecret ? 'Basic ' + btoa(`${apiKey}:${apiSecret}`) : apiKey };

    const [pos, summary] = await Promise.all([
      getJson(`${base}/equity/portfolio`, headers),
      getJson(`${base}/equity/account/summary`, headers),
    ]);

    if (!pos.ok) {
      return json({ error: `Trading 212 API: ${pos.status}`, detail: pos.text.slice(0, 300) }, 502);
    }

    let account: Record<string, unknown> | null = null;
    let accountError: string | null = null;

    if (summary.ok && summary.data) {
      const s = summary.data;
      account = {
        currency: s.currency ?? null,
        total: num(s.totalValue),
        invested: num(s.investments?.totalCost),
        ppl: num(s.investments?.unrealizedProfitLoss),
        free: num(s.cash?.availableToTrade),
        value: num(s.investments?.currentValue),
      };
    } else {
      const cash = await getJson(`${base}/equity/account/cash`, headers);
      if (cash.ok && cash.data) {
        account = { currency: null, ...cash.data };
      } else {
        accountError =
          `summary: HTTP ${summary.status} ${summary.text.slice(0, 120)} | ` +
          `cash: HTTP ${cash.status} ${cash.text.slice(0, 120)}`;
      }
    }

    const tickers = Array.isArray(pos.data) ? pos.data.map((p: any) => String(p.ticker)) : [];
    const ins = tickers.length ? await loadInstruments(base, headers, tickers) : { map: {}, error: null };

    return json({
      positions: pos.data, cash: account, account, accountError,
      instruments: ins.map, instrumentsError: ins.error,
    });
  } catch (error) {
    return json({ error: (error as Error).message }, 500);
  }
});
