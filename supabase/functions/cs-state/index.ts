// cs-state — lê/escreve a tabela de controlo cs_bot_state (fechada por RLS) para
// o painel na app. GET devolve o estado; POST aplica um patch de campos
// permitidos. Se CS_BOT_SECRET estiver definida, POST exige-a (x-cs-secret ou
// body.secret) — evita que quem tenha só a anon key mexa nos interruptores.
import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cs-secret',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

// Campos que o painel pode alterar (nunca id).
const NUM = new Set(['capital', 'leverage', 'min_confidence', 'max_open_positions', 'max_daily_orders', 'max_daily_risk_usd', 'max_notional_usd', 'confirm_ttl_min']);
const BOOL = new Set(['enabled', 'killswitch', 'dry_run', 'auto_confirm', 'recalibrate']);
const TXT = new Set(['sensitivity']);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const supa = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    if (req.method === 'GET') {
      const { data } = await supa.from('cs_bot_state').select('*').eq('id', 1).single();
      return json({ state: data });
    }
    if (req.method !== 'POST') return json({ error: 'GET/POST only' }, 405);

    const secret = Deno.env.get('CS_BOT_SECRET');
    const body = await req.json().catch(() => ({}));
    if (secret) {
      const given = req.headers.get('x-cs-secret') || body?.secret;
      if (given !== secret) return json({ error: 'não autorizado' }, 401);
    }

    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body?.patch || {})) {
      if (BOOL.has(k)) patch[k] = !!v;
      else if (NUM.has(k)) { const n = +(v as number); if (isFinite(n)) patch[k] = n; }
      else if (TXT.has(k) && ['strict', 'balanced', 'loose'].includes(String(v))) patch[k] = v;
    }
    if (!Object.keys(patch).length) return json({ error: 'nada para atualizar' }, 400);

    const { data, error } = await supa.from('cs_bot_state').update(patch).eq('id', 1).select('*').single();
    if (error) return json({ error: error.message }, 400);
    return json({ state: data, updated: Object.keys(patch) });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 400);
  }
});
