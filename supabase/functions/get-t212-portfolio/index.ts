import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Trading 212 Public API (contas Invest / Stocks ISA).
// Live: https://live.trading212.com ; Demo/practice: https://demo.trading212.com
// Autenticacao: a API atual usa HTTP Basic com API Key + API Secret
//   Authorization: Basic base64(API_KEY:API_SECRET)
// Se so existir uma chave (modelo antigo), envia-se em bruto no header.
// Secrets: T212_API_KEY, T212_API_SECRET, T212_ENV (live|demo)
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const apiKey = Deno.env.get('T212_API_KEY') ?? '';
    const apiSecret = Deno.env.get('T212_API_SECRET') ?? '';
    const env = (Deno.env.get('T212_ENV') ?? 'live').toLowerCase();
    const base = env === 'demo'
      ? 'https://demo.trading212.com/api/v0'
      : 'https://live.trading212.com/api/v0';

    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'T212_API_KEY nao configurada.' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500,
      });
    }

    const authValue = apiSecret ? 'Basic ' + btoa(`${apiKey}:${apiSecret}`) : apiKey;
    const headers = { 'Authorization': authValue };

    const [posRes, cashRes] = await Promise.all([
      fetch(`${base}/equity/portfolio`, { headers }),
      fetch(`${base}/equity/account/cash`, { headers }),
    ]);

    if (!posRes.ok) {
      const errText = await posRes.text();
      return new Response(JSON.stringify({ error: `Trading 212 API: ${posRes.status}`, detail: errText.slice(0, 300) }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 502,
      });
    }

    const positions = await posRes.json();
    const cash = cashRes.ok ? await cashRes.json() : null;

    return new Response(JSON.stringify({ positions, cash }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    });
  }
});
