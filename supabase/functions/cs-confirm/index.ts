// cs-confirm — gate humano do bot semi-automático.
//   GET                       → lista as ordens em 'pending_confirm' (p/ a app).
//   POST {order_id, action}   → action 'confirm' | 'reject'.
//       confirm: marca 'confirmed' e chama cs-order (coloca, salvo dry_run).
//       reject : marca 'cancelled'.
//
// Proteção: se a env CS_BOT_SECRET estiver definida, exige-a no header
// 'x-cs-secret' (ou body.secret) — impede confirmações com a anon key pública.
import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cs-secret',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const supa = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    if (req.method === 'GET') {
      const { data } = await supa.from('cs_bot_orders').select('*')
        .eq('status', 'pending_confirm').order('confidence', { ascending: false });
      return json({ pending: data || [] });
    }
    if (req.method !== 'POST') return json({ error: 'GET/POST only' }, 405);

    const secret = Deno.env.get('CS_BOT_SECRET');
    const body = await req.json().catch(() => ({}));
    if (secret) {
      const given = req.headers.get('x-cs-secret') || body?.secret;
      if (given !== secret) return json({ error: 'não autorizado' }, 401);
    }

    const { order_id, action } = body;
    if (!order_id || !['confirm', 'reject'].includes(action)) return json({ error: 'order_id/action inválidos' }, 400);

    const { data: row } = await supa.from('cs_bot_orders').select('*').eq('id', order_id).single();
    if (!row) return json({ error: 'ordem não encontrada' }, 404);
    if (row.status !== 'pending_confirm') return json({ error: `status=${row.status}, não confirmável` }, 409);

    if (action === 'reject') {
      await supa.from('cs_bot_orders').update({ status: 'cancelled', decided_by: 'human' }).eq('id', order_id);
      return json({ ok: true, order_id, status: 'cancelled' });
    }

    // confirm → marca e dispara cs-order.
    await supa.from('cs_bot_orders').update({
      status: 'confirmed', decided_by: 'human', confirmed_at: new Date().toISOString(),
    }).eq('id', order_id);

    const res = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/cs-order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}` },
      body: JSON.stringify({ order_id }),
    });
    const out = await res.json().catch(() => ({}));
    return json({ ok: true, order_id, status: 'confirmed', order_result: out });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 400);
  }
});
