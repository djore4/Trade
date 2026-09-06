import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

async function hmacSign(message: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(signature))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// Bybit v5 /v5/position/list exige 'symbol' OU 'settleCoin' — TANTO para
// 'category=linear' COMO para 'category=inverse' (sem um deles: erro 10001 e
// lista vazia). Por isso consultamos as lineares por moeda de liquidacao (USDT,
// USDC) e as inversas por settleCoin (a moeda-base: BTC p/ BTCUSD, APT p/ APTUSD,
// etc.). queryString tem de estar por ordem alfabetica para bater com a assinatura.
async function fetchPositions(queryString: string, apiKey: string, apiSecret: string) {
  const timestamp = Date.now().toString();
  const recvWindow = '5000';
  const signStr = `${timestamp}${apiKey}${recvWindow}${queryString}`;
  const signature = await hmacSign(signStr, apiSecret);

  const response = await fetch(
    `https://api.bybit.com/v5/position/list?${queryString}`,
    {
      headers: {
        'X-BAPI-API-KEY': apiKey,
        'X-BAPI-SIGN': signature,
        'X-BAPI-TIMESTAMP': timestamp,
        'X-BAPI-RECV-WINDOW': recvWindow,
      },
    }
  );
  const data = await response.json();
  return data?.result?.list ?? [];
}

// settleCoins inversos = moedas-base de todos os contratos inversos (catalogo
// publico, sem auth). Fallback para os principais se a chamada falhar.
async function inverseSettleCoins(): Promise<string[]> {
  const fallback = ['BTC', 'ETH'];
  try {
    const r = await fetch('https://api.bybit.com/v5/market/instruments-info?category=inverse&limit=1000');
    const d = await r.json();
    const set = new Set<string>(fallback);
    for (const x of (d?.result?.list ?? []) as Array<Record<string, unknown>>) {
      const sc = String(x.settleCoin ?? '').toUpperCase();
      if (sc) set.add(sc);
    }
    return [...set];
  } catch (_e) {
    return fallback;
  }
}

// Consulta as inversas por settleCoin, em lotes (evita rate limit / bursts).
async function fetchInverse(apiKey: string, apiSecret: string) {
  const coins = await inverseSettleCoins();
  const out: unknown[] = [];
  const CHUNK = 10;
  for (let i = 0; i < coins.length; i += CHUNK) {
    const part = coins.slice(i, i + CHUNK);
    const lists = await Promise.all(
      part.map(c => fetchPositions(`category=inverse&settleCoin=${c}`, apiKey, apiSecret)),
    );
    for (const l of lists) out.push(...l);
  }
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const apiKey = Deno.env.get('BYBIT_API_KEY') ?? '';
    const apiSecret = Deno.env.get('BYBIT_API_SECRET') ?? '';

    if (!apiKey || !apiSecret) {
      return new Response(JSON.stringify({ error: 'Credenciais Bybit nao configuradas.' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500,
      });
    }

    // Ordem alfabetica: category vem antes de settleCoin.
    const [linearUsdt, linearUsdc, inverseList] = await Promise.all([
      fetchPositions('category=linear&settleCoin=USDT', apiKey, apiSecret),
      fetchPositions('category=linear&settleCoin=USDC', apiKey, apiSecret),
      fetchInverse(apiKey, apiSecret),
    ]);

    const allPositions = [...linearUsdt, ...linearUsdc, ...inverseList];

    return new Response(JSON.stringify({ result: { list: allPositions } }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 400,
    });
  }
});
