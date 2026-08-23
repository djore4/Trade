/*
 * bybit.ts — cliente v5 assinado (partilhado pelas edge functions do bot).
 * Assinatura HMAC-SHA256 igual à de get-bybit-positions, agora também para POST.
 *
 * GET:  sign = timestamp + apiKey + recvWindow + queryString(alfabético)
 * POST: sign = timestamp + apiKey + recvWindow + rawJsonBody
 */

// Autenticação Bybit v5: suporta RSA (X-BAPI-SIGN-TYPE: 2) e HMAC (tipo 1).
// Se houver chave privada RSA no ambiente, usa RSA (mais seguro — o segredo
// nunca sai daqui); caso contrário cai no HMAC com o apiSecret partilhado.
export interface BybitKeys { apiKey: string; apiSecret: string; privateKeyPem: string; base: string; }

export function bybitKeysFromEnv(): BybitKeys {
  const apiKey = Deno.env.get('BYBIT_SUB_API_KEY') ?? Deno.env.get('BYBIT_API_KEY') ?? '';
  const apiSecret = Deno.env.get('BYBIT_SUB_API_SECRET') ?? Deno.env.get('BYBIT_API_SECRET') ?? '';
  const privateKeyPem = Deno.env.get('BYBIT_SUB_API_PRIVATE_KEY') ?? Deno.env.get('BYBIT_API_PRIVATE_KEY') ?? '';
  const base = Deno.env.get('BYBIT_BASE') ?? 'https://api.bybit.com';
  return { apiKey, apiSecret, privateKeyPem, base };
}

const RECV = '5000';

const b64 = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf)));

// PEM (PKCS#8) → ArrayBuffer DER.
function pemToDer(pem: string): ArrayBuffer {
  const body = pem.replace(/-----BEGIN [^-]+-----/g, '').replace(/-----END [^-]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(body);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

let rsaKeyCache: CryptoKey | null = null;
async function importRsa(pem: string): Promise<CryptoKey> {
  if (rsaKeyCache) return rsaKeyCache;
  rsaKeyCache = await crypto.subtle.importKey(
    'pkcs8', pemToDer(pem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'],
  );
  return rsaKeyCache;
}

async function hmacSign(message: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Assina o param_str e devolve {sign, signType}. RSA → base64 + tipo 2.
async function signParam(paramStr: string, k: BybitKeys): Promise<{ sign: string; signType: string }> {
  if (k.privateKeyPem) {
    const key = await importRsa(k.privateKeyPem);
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(paramStr));
    return { sign: b64(sig), signType: '2' };
  }
  return { sign: await hmacSign(paramStr, k.apiSecret), signType: '1' };
}

export async function bybitGet(path: string, query: string, k: BybitKeys): Promise<any> {
  const ts = Date.now().toString();
  const { sign, signType } = await signParam(`${ts}${k.apiKey}${RECV}${query}`, k);
  const r = await fetch(`${k.base}${path}?${query}`, {
    headers: {
      'X-BAPI-API-KEY': k.apiKey, 'X-BAPI-SIGN': sign, 'X-BAPI-SIGN-TYPE': signType,
      'X-BAPI-TIMESTAMP': ts, 'X-BAPI-RECV-WINDOW': RECV,
    },
  });
  return await r.json();
}

export async function bybitPost(path: string, body: Record<string, unknown>, k: BybitKeys): Promise<any> {
  const ts = Date.now().toString();
  const raw = JSON.stringify(body);
  const { sign, signType } = await signParam(`${ts}${k.apiKey}${RECV}${raw}`, k);
  const r = await fetch(`${k.base}${path}`, {
    method: 'POST',
    headers: {
      'X-BAPI-API-KEY': k.apiKey, 'X-BAPI-SIGN': sign, 'X-BAPI-SIGN-TYPE': signType,
      'X-BAPI-TIMESTAMP': ts, 'X-BAPI-RECV-WINDOW': RECV,
      'Content-Type': 'application/json',
    },
    body: raw,
  });
  return await r.json();
}

// Filtros do instrumento (público) — para arredondar qty/preço ao passo válido.
export interface Filters { qtyStep: number; minQty: number; tickSize: number; maxLev: number; }

export async function fetchFilters(symbol: string, base = 'https://api.bybit.com'): Promise<Filters | null> {
  const r = await fetch(`${base}/v5/market/instruments-info?category=linear&symbol=${symbol}`);
  const d = await r.json();
  const it = d?.result?.list?.[0];
  if (!it) return null;
  return {
    qtyStep: +it.lotSizeFilter?.qtyStep || 0.001,
    minQty: +it.lotSizeFilter?.minOrderQty || 0,
    tickSize: +it.priceFilter?.tickSize || 0.0001,
    maxLev: +it.leverageFilter?.maxLeverage || 25,
  };
}

// Arredonda para BAIXO ao passo (qty nunca ultrapassa o pretendido).
export function roundStep(value: number, step: number): number {
  if (!step || step <= 0) return value;
  const decimals = (step.toString().split('.')[1] || '').length;
  return +(Math.floor(value / step) * step).toFixed(decimals);
}
export function roundTick(price: number, tick: number): number {
  if (!tick || tick <= 0) return price;
  const decimals = (tick.toString().split('.')[1] || '').length;
  return +(Math.round(price / tick) * tick).toFixed(decimals);
}
