import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Trading 212 Public API (contas Invest / Stocks ISA).
// Auth: HTTP Basic com API Key + API Secret. Secrets: T212_API_KEY, T212_API_SECRET, T212_ENV (live|demo)
//
// A T212 limita os pedidos (posicoes/conta: 1 por ~5s; instrumentos: 1 por 50s e a resposta e enorme).
// Sem cache, cada refresh/separador/dispositivo batia na T212 e ~metade das chamadas davam 502/429.
// Agora:
//  - cache partilhada (memoria do isolate + tabela public.pf_cache via service role)
//  - dentro de FRESH_MS serve a cache sem tocar na T212
//  - se a T212 falhar (429/timeout), devolve os ultimos dados bons com stale:true
//  - instrumentos (moeda/tipo/nome) persistidos 7 dias; refrescados em background
//  - timeouts em todos os pedidos externos
//
// Resposta: { positions, cash, account, accountError, instruments, at, cached, stale, staleReason }
const FRESH_MS = 15_000;          // janela em que a cache e servida sem consultar a T212
const FORCE_MIN_MS = 5_000;       // com ?force=1, minimo entre pedidos reais (limite da T212)
const MAX_STALE_MS = 30 * 60_000; // idade maxima dos dados "stale" aceites em caso de erro
const INSTR_TTL = 7 * 24 * 3600_000;

const SB_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status });
const num = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const bg = (p: Promise<unknown>) => {
  const q = p.catch(() => {});
  const er = (globalThis as any).EdgeRuntime;
  if (er?.waitUntil) er.waitUntil(q);
};

async function getJson(url: string, headers: Record<string, string>, ms = 8000) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(ms) });
  const text = await r.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch (_e) { /* corpo nao-JSON */ }
  return { ok: r.ok, status: r.status, data, text };
}

/* ── cache na base de dados (service role; tabela sem acesso anon) ─────────── */
const dbH = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };
async function dbGet(k: string): Promise<{ v: any; at: number } | null> {
  if (!SB_URL || !SB_KEY) return null;
  try {
    const r = await fetch(`${SB_URL}/rest/v1/pf_cache?k=eq.${encodeURIComponent(k)}&select=v,at`, { headers: dbH, signal: AbortSignal.timeout(3000) });
    if (!r.ok) return null;
    const a = await r.json();
    return a[0] ? { v: a[0].v, at: Date.parse(a[0].at) } : null;
  } catch (_e) { return null; }
}
async function dbSet(k: string, v: unknown) {
  if (!SB_URL || !SB_KEY) return;
  await fetch(`${SB_URL}/rest/v1/pf_cache?on_conflict=k`, {
    method: 'POST', signal: AbortSignal.timeout(4000),
    headers: { ...dbH, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ k, v, at: new Date().toISOString() }),
  });
}

type Snap = { positions: any[]; account: Record<string, unknown> | null; accountError: string | null };
let mem: { at: number; snap: Snap } | null = null;
let memInstr: { at: number; map: Record<string, any> } | null = null;
let instrLastTry = 0;

async function fetchLive(base: string, headers: Record<string, string>, prev: Snap | null): Promise<Snap> {
  const [pos, summary] = await Promise.all([
    getJson(`${base}/equity/portfolio`, headers),
    getJson(`${base}/equity/account/summary`, headers),
  ]);
  if (!pos.ok || !Array.isArray(pos.data)) {
    throw new Error(`Trading 212 API: ${pos.status} ${pos.text.slice(0, 120)}`);
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
  } else if (summary.status === 429 && prev?.account) {
    account = prev.account;   // limite de pedidos: reaproveita a conta anterior em vez de a perder
  } else {
    try {
      const cash = await getJson(`${base}/equity/account/cash`, headers);
      if (cash.ok && cash.data) account = { currency: null, ...cash.data };
      else accountError = `summary: HTTP ${summary.status} ${summary.text.slice(0, 120)} | cash: HTTP ${cash.status} ${cash.text.slice(0, 120)}`;
    } catch (e) { accountError = `summary: HTTP ${summary.status} | cash: ${(e as Error).message}`; }
  }
  return { positions: pos.data, account, accountError };
}

async function getInstruments(base: string, headers: Record<string, string>, tickers: string[]) {
  let map = memInstr?.map, at = memInstr?.at ?? 0;
  if (!map) {
    const row = await dbGet('t212:instruments');
    if (row) { map = row.v; at = row.at; memInstr = { at, map: map! }; }
  }
  map = map ?? {};
  const missing = tickers.some(t => !(t in map!));
  const expired = Date.now() - at > INSTR_TTL;
  if ((missing || expired) && Date.now() - instrLastTry > 60_000) {
    instrLastTry = Date.now();
    const known = map;
    const job = (async () => {
      const r = await getJson(`${base}/equity/metadata/instruments`, headers, 25_000);
      if (!r.ok || !Array.isArray(r.data)) return;
      const want = new Set([...tickers, ...Object.keys(known)]);
      const nm: Record<string, any> = {};
      for (const i of r.data) {
        if (want.has(i.ticker)) nm[i.ticker] = { currencyCode: i.currencyCode, type: i.type, name: i.name, shortName: i.shortName, isin: i.isin };
      }
      memInstr = { at: Date.now(), map: nm };
      await dbSet('t212:instruments', nm);
    })();
    if (Object.keys(map).length === 0) { await job.catch(() => {}); map = memInstr?.map ?? {}; }
    else bg(job);   // ja temos dados: atualiza em background sem atrasar a resposta
  }
  return map;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const apiKey = Deno.env.get('T212_API_KEY') ?? '';
    const apiSecret = Deno.env.get('T212_API_SECRET') ?? '';
    const env = (Deno.env.get('T212_ENV') ?? 'live').toLowerCase();
    const base = env === 'demo' ? 'https://demo.trading212.com/api/v0' : 'https://live.trading212.com/api/v0';
    if (!apiKey) return json({ error: 'T212_API_KEY nao configurada.' }, 500);
    const headers = { 'Authorization': apiSecret ? 'Basic ' + btoa(`${apiKey}:${apiSecret}`) : apiKey };

    const force = new URL(req.url).searchParams.get('force') === '1';
    const minAge = force ? FORCE_MIN_MS : FRESH_MS;
    const now = Date.now();

    // 1) cache: memoria, ou (se velha/ausente) a mais recente entre memoria e base de dados
    let cached = mem;
    if (!cached || now - cached.at >= minAge) {
      const row = await dbGet('t212:portfolio');
      if (row && (!cached || row.at > cached.at)) cached = { at: row.at, snap: row.v };
    }
    let snap: Snap, at: number, isCached = false, stale = false, staleReason: string | null = null;
    if (cached && now - cached.at < minAge) {
      snap = cached.snap; at = cached.at; isCached = true;
    } else {
      // 2) pedido real a T212; em caso de erro usa os ultimos dados bons
      try {
        snap = await fetchLive(base, headers, cached?.snap ?? null);
        at = Date.now(); mem = { at, snap };
        bg(dbSet('t212:portfolio', snap));
      } catch (e) {
        if (cached && now - cached.at < MAX_STALE_MS) {
          snap = cached.snap; at = cached.at; stale = true; isCached = true; staleReason = (e as Error).message;
        } else {
          return json({ error: (e as Error).message }, 502);
        }
      }
    }

    // 3) instrumentos (moeda/tipo/nome) — persistidos; nao bloqueiam depois da 1.a vez
    const tickers = snap.positions.map((p: any) => String(p.ticker));
    const instruments = tickers.length ? await getInstruments(base, headers, tickers) : {};

    return json({
      positions: snap.positions, cash: snap.account, account: snap.account, accountError: snap.accountError,
      instruments, at, cached: isCached, stale, staleReason,
    });
  } catch (error) {
    return json({ error: (error as Error).message }, 500);
  }
});
