// =====================================================================
// Proxy pessoal READ-ONLY para a API privada da Bybit (Cloudflare Worker).
//
// Porquê existe: o site é estático (não pode guardar segredos) e os endpoints
// privados da Bybit não permitem CORS de browser. Este worker guarda a chave
// READ-ONLY como *secret* do worker, assina os pedidos (HMAC-SHA256) e devolve
// o JSON ao site, com CORS restrito à origem do site.
//
// Garantias de segurança:
//   - Só endpoints de LEITURA (allow-list). Qualquer outro path -> 403.
//   - Só método GET. Estruturalmente NÃO consegue colocar ordens.
//   - Exige o header X-Proxy-Token (segredo partilhado) -> não é proxy aberto.
//   - CORS restrito a ALLOWED_ORIGIN.
//   - A chave/segredo nunca são devolvidos nem registados.
//
// Secrets/vars (configurados no worker, nunca no código):
//   BYBIT_API_KEY, BYBIT_API_SECRET, PROXY_TOKEN   -> `wrangler secret put`
//   ALLOWED_ORIGIN (ex.: https://djore4.github.io) -> [vars] no wrangler.toml
// =====================================================================

const BYBIT = 'https://api.bybit.com';

// Endpoints de LEITURA permitidos (nada de trade/ordens/transferências).
const ALLOW = new Set([
  '/v5/position/list',
  '/v5/account/wallet-balance',
  '/v5/asset/transfer/query-account-coins-balance',
  '/v5/account/transaction-log',
  '/v5/user/query-api',
]);

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'X-Proxy-Token, Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function jsonResponse(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}

async function hmacHex(secret, payload) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export default {
  async fetch(request, env) {
    const ch = corsHeaders(env);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: ch });
    if (request.method !== 'GET') return jsonResponse({ ok: false, erro: 'Só GET (read-only).' }, 405, ch);

    // Token de acesso ao proxy (não é a chave Bybit) — evita proxy aberto.
    if (!env.PROXY_TOKEN || request.headers.get('X-Proxy-Token') !== env.PROXY_TOKEN)
      return jsonResponse({ ok: false, erro: 'Token do proxy inválido.' }, 401, ch);

    if (!env.BYBIT_API_KEY || !env.BYBIT_API_SECRET)
      return jsonResponse({ ok: false, erro: 'Proxy sem chaves configuradas.' }, 500, ch);

    const url = new URL(request.url);
    const path = url.searchParams.get('path') || '';
    if (!ALLOW.has(path)) return jsonResponse({ ok: false, erro: 'Endpoint não permitido (só leitura).' }, 403, ch);

    // Query para a Bybit = todos os parâmetros exceto `path`, ordenados.
    // A MESMA string é usada para assinar e para o URL (têm de coincidir).
    const params = new URLSearchParams(url.searchParams);
    params.delete('path');
    const query = [...params.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');

    const ts = Date.now().toString();
    const recv = '5000';
    const signature = await hmacHex(env.BYBIT_API_SECRET, ts + env.BYBIT_API_KEY + recv + query);

    let upstream;
    try {
      upstream = await fetch(BYBIT + path + (query ? '?' + query : ''), {
        method: 'GET',
        headers: {
          'X-BAPI-API-KEY': env.BYBIT_API_KEY,
          'X-BAPI-TIMESTAMP': ts,
          'X-BAPI-RECV-WINDOW': recv,
          'X-BAPI-SIGN': signature,
        },
      });
    } catch (e) {
      return jsonResponse({ ok: false, erro: 'Bybit indisponível a partir do proxy.' }, 502, ch);
    }

    const body = await upstream.text(); // resposta da Bybit (nunca inclui a chave)
    return new Response(body, {
      status: upstream.status,
      headers: { ...ch, 'Content-Type': 'application/json' },
    });
  },
};
