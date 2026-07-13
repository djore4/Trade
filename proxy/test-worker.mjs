// Testes do worker (Node 18+ tem fetch/crypto.subtle/Request/Response globais).
// Valida: assinatura HMAC == node crypto; allow-list; token; método; sem segredo
// na resposta. Não contacta a Bybit real (stub de fetch).
import crypto from 'node:crypto';
import assert from 'node:assert';
import worker from './bybit-worker.js';

const ENV = {
  BYBIT_API_KEY: 'TESTKEY123',
  BYBIT_API_SECRET: 'TESTSECRET456',
  PROXY_TOKEN: 'proxytoken789',
  ALLOWED_ORIGIN: 'https://example.github.io',
};
const BASE = 'https://proxy.workers.dev/';
let pass = 0;
const ok = (name) => { console.log('  ✓', name); pass++; };

// --- 1. OPTIONS -> 204 + CORS
{
  const r = await worker.fetch(new Request(BASE, { method: 'OPTIONS' }), ENV);
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), ENV.ALLOWED_ORIGIN);
  ok('OPTIONS devolve 204 com CORS restrito');
}

// --- 2. método != GET -> 405
{
  const r = await worker.fetch(new Request(BASE + '?path=/v5/position/list', {
    method: 'POST', headers: { 'X-Proxy-Token': ENV.PROXY_TOKEN } }), ENV);
  assert.equal(r.status, 405);
  ok('POST rejeitado (405) — só leitura');
}

// --- 3. sem token -> 401
{
  const r = await worker.fetch(new Request(BASE + '?path=/v5/position/list'), ENV);
  assert.equal(r.status, 401);
  ok('Sem X-Proxy-Token -> 401');
}

// --- 4. path fora da allow-list -> 403 (mesmo com token)
{
  const r = await worker.fetch(new Request(BASE + '?path=/v5/order/create', {
    headers: { 'X-Proxy-Token': ENV.PROXY_TOKEN } }), ENV);
  assert.equal(r.status, 403);
  ok('Endpoint de trade fora da allow-list -> 403');
}

// --- 5. GET válido: assinatura correta, headers certos, sem segredo na resposta
{
  let captured = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    captured = { url, opts };
    return new Response(JSON.stringify({ retCode: 0, result: { list: [] } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const r = await worker.fetch(new Request(BASE + '?path=/v5/position/list&category=linear&settleCoin=USDT', {
      headers: { 'X-Proxy-Token': ENV.PROXY_TOKEN } }), ENV);
    assert.equal(r.status, 200);

    // query ordenada e igual à assinada
    const u = new URL(captured.url);
    assert.equal(u.pathname, '/v5/position/list');
    assert.equal(u.search, '?category=linear&settleCoin=USDT');

    const h = captured.opts.headers;
    const ts = h['X-BAPI-TIMESTAMP'];
    const query = 'category=linear&settleCoin=USDT';
    const expected = crypto.createHmac('sha256', ENV.BYBIT_API_SECRET)
      .update(ts + ENV.BYBIT_API_KEY + '5000' + query).digest('hex');
    assert.equal(h['X-BAPI-SIGN'], expected);
    assert.equal(h['X-BAPI-API-KEY'], ENV.BYBIT_API_KEY);
    ok('GET assina HMAC-SHA256 igual ao node crypto (paridade v5)');

    const body = await r.text();
    assert.ok(!body.includes(ENV.BYBIT_API_SECRET) && !body.includes(ENV.BYBIT_API_KEY),
      'resposta não pode conter a chave/segredo');
    ok('Resposta não expõe a chave/segredo');
  } finally { globalThis.fetch = realFetch; }
}

console.log(`\n${pass} testes do worker OK`);
