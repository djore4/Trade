import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Trading 212 Public API (contas Invest / Stocks ISA).
// Auth: HTTP Basic com API Key + API Secret (Authorization: Basic base64(KEY:SECRET)).
// Secrets: T212_API_KEY, T212_API_SECRET, T212_ENV (live|demo)
//
// Resposta: { positions, cash, account?, accountError? }
//  - positions: /equity/portfolio
//  - account:   resumo normalizado { currency, total, invested, ppl, free }, vindo de
//               /equity/account/summary (atual) ou, se falhar, /equity/account/cash (antigo)
//  - cash:      igual a account (compatibilidade com o formato antigo)
//  - accountError: porque falhou a conta (estado HTTP + excerto), em vez de engolir o erro
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
      };
    } else {
      // Fallback: endpoint antigo /equity/account/cash
      const cash = await getJson(`${base}/equity/account/cash`, headers);
      if (cash.ok && cash.data) {
        account = { currency: null, ...cash.data };
      } else {
        accountError =
          `summary: HTTP ${summary.status} ${summary.text.slice(0, 120)} | ` +
          `cash: HTTP ${cash.status} ${cash.text.slice(0, 120)}`;
      }
    }

    return json({ positions: pos.data, cash: account, account, accountError });
  } catch (error) {
    return json({ error: (error as Error).message }, 500);
  }
});
