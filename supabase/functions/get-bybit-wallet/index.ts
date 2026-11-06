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

async function bybitRequest(path: string, query: string, apiKey: string, apiSecret: string) {
  const timestamp = Date.now().toString();
  const recvWindow = '5000';
  const signStr = `${timestamp}${apiKey}${recvWindow}${query}`;
  const signature = await hmacSign(signStr, apiSecret);
  const response = await fetch(`https://api.bybit.com${path}?${query}`, {
    headers: {
      'X-BAPI-API-KEY': apiKey,
      'X-BAPI-SIGN': signature,
      'X-BAPI-TIMESTAMP': timestamp,
      'X-BAPI-RECV-WINDOW': recvWindow,
    },
  });
  return response.json();
}

// Paginate spot order history — up to 3 pages of 50 orders each (150 total).
// No startTime restriction so purchases from years ago are included.
async function fetchSpotOrders(apiKey: string, apiSecret: string) {
  let allOrders: any[] = [];
  let cursor = '';

  for (let page = 0; page < 3; page++) {
    const query = `category=spot&orderStatus=Filled&limit=50${
      cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
    }`;
    const data = await bybitRequest('/v5/order/history', query, apiKey, apiSecret);
    const list: any[] = data?.result?.list ?? [];
    allOrders = allOrders.concat(list);
    cursor = data?.result?.nextPageCursor ?? '';
    if (!cursor || list.length < 50) break; // no more pages
  }

  return { result: { list: allOrders } };
}

// Secrets: BYBIT_API_KEY, BYBIT_API_SECRET
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

    // Wallet + tx log run in parallel; spot orders paginate sequentially after
    const [balanceData, txlogData, spotOrderData] = await Promise.all([
      bybitRequest('/v5/account/wallet-balance', 'accountType=UNIFIED', apiKey, apiSecret),
      bybitRequest('/v5/account/transaction-log', 'accountType=UNIFIED&limit=50&type=TRADE', apiKey, apiSecret),
      fetchSpotOrders(apiKey, apiSecret),
    ]);

    return new Response(JSON.stringify({
      balance: balanceData,
      txlog: txlogData,
      spotOrders: spotOrderData,
    }), {
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
