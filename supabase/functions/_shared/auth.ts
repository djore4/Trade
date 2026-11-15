/*
 * auth.ts — guarda de acesso comum a todas as edge functions do Asset Manager.
 * ==========================================================================
 * Uso de uma só pessoa → segredo partilhado (AM_SECRET) em vez de Supabase Auth
 * (este projeto Supabase é partilhado com outras apps; o Auth é delas).
 *
 * FALHA FECHADA: sem segredo (env AM_SECRET ou Vault 'am_secret'), TODOS os pedidos são recusados (503).
 *
 * Aceita, por ordem:
 *   1. header `x-am-secret: <AM_SECRET>`            (browser e cron)
 *   2. `Authorization: Bearer <SERVICE_ROLE_KEY>`   (chamadas internas função→função)
 *
 * A publishable key NÃO autentica nada: está no JS público.
 */

const enc = new TextEncoder();

// Comparação em tempo constante (via digest → comprimento fixo).
async function safeEqual(a: string, b: string): Promise<boolean> {
  if (!a || !b) return false;
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// O segredo vem de AM_SECRET (env) ou, se não existir, do Supabase Vault ('am_secret') via a RPC public.am_secret()
// (só executável pela service role). Cache de 60 s. Se nenhuma das fontes existir → falha fechada.
let cached: { v: string; at: number } | null = null;
async function getSecret(): Promise<string> {
  const env = Deno.env.get('AM_SECRET') ?? '';
  if (env) return env;
  if (cached && Date.now() - cached.at < 60_000) return cached.v;
  const url = Deno.env.get('SUPABASE_URL') ?? '', key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (!url || !key) return '';
  try {
    const r = await fetch(`${url}/rest/v1/rpc/am_secret`, {
      method: 'POST', headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) return '';
    const v = await r.json();
    cached = { v: typeof v === 'string' ? v : '', at: Date.now() };
    return cached.v;
  } catch (_e) { return ''; }
}

/** Devolve `null` se autorizado; caso contrário a Response de erro a devolver já. */
export async function guard(req: Request, corsHeaders: Record<string, string>): Promise<Response | null> {
  const fail = (status: number, error: string) =>
    new Response(JSON.stringify({ error }), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  const secret = await getSecret();
  if (!secret) return fail(503, 'código de acesso não configurado no servidor (acesso recusado por defeito).');

  if (await safeEqual(req.headers.get('x-am-secret') ?? '', secret)) return null;

  const svc = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (svc && await safeEqual(bearer, svc)) return null;

  return fail(401, 'não autorizado');
}
