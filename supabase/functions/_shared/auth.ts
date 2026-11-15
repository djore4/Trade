/*
 * auth.ts — guarda de acesso comum a todas as edge functions do Asset Manager.
 * ==========================================================================
 * Uso de uma só pessoa → segredo partilhado (AM_SECRET) em vez de Supabase Auth
 * (este projeto Supabase é partilhado com outras apps; o Auth é delas).
 *
 * FALHA FECHADA: sem AM_SECRET configurado, TODOS os pedidos são recusados (503).
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

/** Devolve `null` se autorizado; caso contrário a Response de erro a devolver já. */
export async function guard(req: Request, corsHeaders: Record<string, string>): Promise<Response | null> {
  const fail = (status: number, error: string) =>
    new Response(JSON.stringify({ error }), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  const secret = Deno.env.get('AM_SECRET') ?? '';
  if (!secret) return fail(503, 'AM_SECRET não configurado no servidor (acesso recusado por defeito).');

  if (await safeEqual(req.headers.get('x-am-secret') ?? '', secret)) return null;

  const svc = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (svc && await safeEqual(bearer, svc)) return null;

  return fail(401, 'não autorizado');
}
