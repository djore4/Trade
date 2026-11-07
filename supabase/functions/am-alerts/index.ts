// am-alerts — API dos alertas do Asset Manager (chamada do browser com a publishable key).
// POST { action, ... }:
//   config                         -> { vapidPublic }
//   subscribe | unsubscribe        { subscription }   (Web Push deste dispositivo)
//   list                           -> { alerts, subscribers }
//   create { alert }               alert: { kind: 'price'|'liq', source: 'bybit'|'yahoo', symbol, label?, op?, level, repeat? }
//   delete { id } | rearm { id }
//   test                           -> envia uma notificação de teste a todos os dispositivos
// Usa a service role (tabelas am_* fechadas). Não devolve segredos (só a chave pública VAPID).
import { createClient } from 'jsr:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const MAX_ACTIVE = 50;
const SYMBOL_RE = /^[A-Z0-9.=^\-]{1,24}$/;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  try {
    const supa = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const body = await req.json().catch(() => ({}));
    const action = String(body?.action || '');

    if (action === 'config') {
      const { data } = await supa.from('cs_config').select('vapid_public').eq('id', 1).maybeSingle();
      if (!data?.vapid_public) return json({ error: 'chaves VAPID nao configuradas' }, 500);
      return json({ vapidPublic: data.vapid_public });
    }

    if (action === 'subscribe' || action === 'unsubscribe') {
      const sub = body?.subscription, endpoint = sub?.endpoint;
      if (typeof endpoint !== 'string' || !endpoint.startsWith('https://')) return json({ error: 'subscription.endpoint invalido' }, 400);
      if (action === 'unsubscribe') { await supa.from('am_push_subs').delete().eq('endpoint', endpoint); return json({ ok: true }); }
      const p256dh = sub?.keys?.p256dh, auth = sub?.keys?.auth;
      if (!p256dh || !auth) return json({ error: 'subscription.keys em falta' }, 400);
      const { error } = await supa.from('am_push_subs').upsert({
        endpoint, p256dh, auth, ua: String(req.headers.get('user-agent') || '').slice(0, 300), last_ok: new Date().toISOString(), fail_count: 0,
      }, { onConflict: 'endpoint' });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    if (action === 'list') {
      const { data, error } = await supa.from('am_alerts').select('*').order('created_at', { ascending: false }).limit(100);
      if (error) return json({ error: error.message }, 400);
      const { count } = await supa.from('am_push_subs').select('endpoint', { count: 'exact', head: true });
      return json({ alerts: data, subscribers: count ?? 0 });
    }

    if (action === 'create') {
      const a = body?.alert ?? {};
      const kind = a.kind, source = a.source, symbol = String(a.symbol || '').trim().toUpperCase(), level = Number(a.level);
      if (kind !== 'price' && kind !== 'liq') return json({ error: 'kind invalido' }, 400);
      if (source !== 'bybit' && source !== 'yahoo') return json({ error: 'source invalido' }, 400);
      if (!SYMBOL_RE.test(symbol)) return json({ error: 'simbolo invalido' }, 400);
      if (!(level > 0) || !isFinite(level)) return json({ error: 'nivel invalido' }, 400);
      if (kind === 'price' && a.op !== 'above' && a.op !== 'below') return json({ error: 'op invalido' }, 400);
      if (kind === 'liq' && (source !== 'bybit' || level >= 100)) return json({ error: 'alerta de liquidacao so para Bybit, nivel em % (<100)' }, 400);
      const { count } = await supa.from('am_alerts').select('id', { count: 'exact', head: true }).eq('active', true);
      if ((count ?? 0) >= MAX_ACTIVE) return json({ error: `maximo de ${MAX_ACTIVE} alertas ativos` }, 400);
      const row = { kind, source, symbol, label: String(a.label || symbol).slice(0, 40), op: kind === 'price' ? a.op : null, level, repeat: !!a.repeat };
      const { data, error } = await supa.from('am_alerts').insert(row).select().single();
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true, alert: data });
    }

    if (action === 'delete' || action === 'rearm') {
      const id = Number(body?.id);
      if (!Number.isInteger(id)) return json({ error: 'id invalido' }, 400);
      if (action === 'delete') { await supa.from('am_alerts').delete().eq('id', id); return json({ ok: true }); }
      const { error } = await supa.from('am_alerts').update({ active: true, armed: true, triggered_at: null, trigger_value: null }).eq('id', id);
      return error ? json({ error: error.message }, 400) : json({ ok: true });
    }

    if (action === 'test') {
      const { data: cfg } = await supa.from('cs_config').select('vapid_public, vapid_private, vapid_subject').eq('id', 1).maybeSingle();
      if (!cfg?.vapid_public || !cfg?.vapid_private) return json({ error: 'chaves VAPID nao configuradas' }, 500);
      webpush.setVapidDetails(cfg.vapid_subject || 'mailto:alerts@assetmanager.local', cfg.vapid_public, cfg.vapid_private);
      const { data: subs } = await supa.from('am_push_subs').select('*');
      let sent = 0; const dead: string[] = [];
      await Promise.all((subs ?? []).map(async (s) => {
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            JSON.stringify({ title: 'Asset Manager', body: 'Notificações ativas neste dispositivo ✓', data: { url: './#trade' } }));
          sent++;
        } catch (e) { const c = (e as { statusCode?: number }).statusCode; if (c === 404 || c === 410) dead.push(s.endpoint); }
      }));
      if (dead.length) await supa.from('am_push_subs').delete().in('endpoint', dead);
      return json({ ok: true, sent, removed: dead.length });
    }

    return json({ error: 'action invalida' }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 400);
  }
});
