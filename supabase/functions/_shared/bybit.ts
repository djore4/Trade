/*
 * bybit.ts — cliente v5 assinado (partilhado pelas edge functions do bot).
 * Assinatura HMAC-SHA256 igual à de get-bybit-positions, agora também para POST.
 *
 * GET:  sign = timestamp + apiKey + recvWindow + queryString(alfabético)
 * POST: sign = timestamp + apiKey + recvWindow + rawJsonBody
 */

export interface BybitKeys { apiKey: string; apiSecret: string; base: string; }

export function bybitKeysFromEnv(): BybitKeys {
  const apiKey = Deno.env.get('BYBIT_SUB_API_KEY') ?? Deno.env.get('BYBIT_API_KEY') ?? '';
  const apiSecret = Deno.env.get('BYBIT_SUB_API_SECRET') ?? Deno.env.get('BYBIT_API_SECRET') ?? '';
  const base = Deno.env.get('BYBIT_BASE') ?? 'https://api.bybit.com';
  return { apiKey, apiSecret, base };
}

async function hmacSign(message: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

const RECV = '5000';

export async function bybitGet(path: string, query: string, k: BybitKeys): Promise<any> {
  const ts = Date.now().toString();
  const sign = await hmacSign(`${ts}${k.apiKey}${RECV}${query}`, k.apiSecret);
  const r = await fetch(`${k.base}${path}?${query}`, {
    headers: {
      'X-BAPI-API-KEY': k.apiKey, 'X-BAPI-SIGN': sign,
      'X-BAPI-TIMESTAMP': ts, 'X-BAPI-RECV-WINDOW': RECV,
    },
  });
  return await r.json();
}

export async function bybitPost(path: string, body: Record<string, unknown>, k: BybitKeys): Promise<any> {
  const ts = Date.now().toString();
  const raw = JSON.stringify(body);
  const sign = await hmacSign(`${ts}${k.apiKey}${RECV}${raw}`, k.apiSecret);
  const r = await fetch(`${k.base}${path}`, {
    method: 'POST',
    headers: {
      'X-BAPI-API-KEY': k.apiKey, 'X-BAPI-SIGN': sign,
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
