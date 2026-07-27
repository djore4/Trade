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

// Bybit v5 /v5/position/list exige que 'category=linear' seja acompanhado de
// 'settleCoin' (ou 'symbol'); caso contrario devolve erro e lista vazia. As
// inversas nao precisam. Por isso consultamos as lineares por moeda de
// liquidacao (USDT e USDC) e as inversas em separado. queryString tem de estar
// por ordem alfabetica dos parametros para bater certo com a assinatura.
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
      fetchPositions('category=inverse', apiKey, apiSecret),
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
