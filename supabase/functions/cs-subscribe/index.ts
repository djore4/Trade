// cs-subscribe — regista/remove a subscrição Web Push de um dispositivo na
// tabela fechada public.cs_push_subs. Chamada do browser com a publishable key.
// Usa a service role para escrever. Não devolve segredos.
import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  try {
    const supa = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );
    const body = await req.json().catch(() => ({}));
    const action = body?.action || 'subscribe';
    const sub = body?.subscription;
    const endpoint = sub?.endpoint;
    if (!endpoint || typeof endpoint !== 'string') return json({ error: 'subscription.endpoint em falta' }, 400);

    if (action === 'unsubscribe') {
      await supa.from('cs_push_subs').delete().eq('endpoint', endpoint);
      return json({ ok: true, removed: true });
    }

    const p256dh = sub?.keys?.p256dh, auth = sub?.keys?.auth;
    if (!p256dh || !auth) return json({ error: 'subscription.keys em falta' }, 400);
    const { error } = await supa.from('cs_push_subs').upsert({
      endpoint, p256dh, auth,
      ua: String(req.headers.get('user-agent') || '').slice(0, 300),
      last_ok: new Date().toISOString(), fail_count: 0,
    }, { onConflict: 'endpoint' });
    if (error) return json({ error: error.message }, 400);
    return json({ ok: true, subscribed: true });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 400);
  }
});
