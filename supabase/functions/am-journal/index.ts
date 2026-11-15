// am-journal — diário automático de operações (Bybit, perpétuos lineares) + teses.
// POST { action, ... }:
//   sync { days? }          importa o PnL fechado (closed-pnl, janelas de 7 dias). Cron horário (days=3); histórico: days=365
//   list { limit? }         -> { trades } (mais recentes primeiro)
//   tag { id, tag?, note? } etiqueta uma operação (ex.: 'tese', 'fomo', 'stop movido', 'tamanho excessivo')
//   thesis_add { symbol, side, thesis, invalid_px, source? }   guarda a tese e cria o alerta de invalidação
//   thesis_list | thesis_close { id }
// Notas: closedPnl vem da Bybit tal como é; o funding pago NÃO está incluído. Só categoria linear.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { guard } from '../_shared/auth.ts';
import { bybitGet } from '../_shared/bybit.ts';
import { bybitMainKeys, num, sleep } from '../_shared/am-sources.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-am-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const DAY = 86400000;
const TAGS = new Set(['tese', 'plano', 'fomo', 'vingança', 'stop movido', 'tamanho excessivo', 'sem stop', 'saída cedo', 'saída tarde', 'sorte']);
const SYMBOL_RE = /^[A-Z0-9.=^\-]{1,24}$/;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  { const denied = await guard(req, cors); if (denied) return denied; }
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  try {
    const supa = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const body = await req.json().catch(() => ({}));
    const action = String(body?.action || '');

    if (action === 'sync') {
      const keys = bybitMainKeys();
      if (!keys) return json({ error: 'credenciais Bybit não configuradas' }, 500);
      const days = Math.min(730, Math.max(1, Number(body?.days) || 3));
      const rows: any[] = []; const notes: string[] = [];
      const now = Date.now();
      for (let w = 0; w * 7 < days; w++) {
        const end = now - w * 7 * DAY, start = end - 7 * DAY;
        let cursor = '';
        for (let page = 0; page < 20; page++) {
          const q = `category=linear&endTime=${end}&limit=100&startTime=${start}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
          const d = await bybitGet('/v5/position/closed-pnl', q, keys);
          if (d?.retCode !== 0) { notes.push(`${d?.retCode} ${d?.retMsg}`); break; }
          for (const x of d.result?.list ?? []) {
            const closed = num(x.updatedTime);
            if (!x.orderId || !closed) continue;
            rows.push({
              id: String(x.orderId), symbol: String(x.symbol),
              side: x.side === 'Sell' ? 'long' : 'short',      // side = lado da ordem de fecho
              qty: num(x.closedSize || x.qty), entry: num(x.avgEntryPrice), exit: num(x.avgExitPrice),
              pnl: num(x.closedPnl), fees: Math.abs(num(x.openFee)) + Math.abs(num(x.closeFee)), lev: num(x.leverage) || null,
              opened_at: x.createdTime ? new Date(num(x.createdTime)).toISOString() : null, closed_at: new Date(closed).toISOString(),
            });
          }
          cursor = d.result?.nextPageCursor ?? '';
          if (!cursor) break;
        }
        if (days > 30) await sleep(150);
      }
      let inserted = 0;
      if (rows.length) {
        // ignoreDuplicates: mantém as etiquetas/notas já gravadas
        const { data, error } = await supa.from('am_trades').upsert(rows, { onConflict: 'id', ignoreDuplicates: true }).select('id');
        if (error) return json({ error: error.message }, 400);
        inserted = data?.length ?? 0;
      }
      return json({ found: rows.length, inserted, notes });
    }

    if (action === 'list') {
      const limit = Math.min(2000, Math.max(1, Number(body?.limit) || 500));
      const { data, error } = await supa.from('am_trades').select('*').order('closed_at', { ascending: false }).limit(limit);
      if (error) return json({ error: error.message }, 400);
      return json({ trades: data });
    }

    if (action === 'tag') {
      const id = String(body?.id || ''); if (!id) return json({ error: 'id em falta' }, 400);
      const patch: Record<string, unknown> = {};
      if ('tag' in body) {
        const t = body.tag == null || body.tag === '' ? null : String(body.tag).toLowerCase();
        if (t && !TAGS.has(t)) return json({ error: 'etiqueta desconhecida' }, 400);
        patch.tag = t;
      }
      if ('note' in body) patch.note = body.note ? String(body.note).slice(0, 300) : null;
      if (!Object.keys(patch).length) return json({ error: 'nada a alterar' }, 400);
      const { error } = await supa.from('am_trades').update(patch).eq('id', id);
      return error ? json({ error: error.message }, 400) : json({ ok: true });
    }

    if (action === 'thesis_add') {
      const symbol = String(body?.symbol || '').toUpperCase(), side = body?.side;
      const thesis = String(body?.thesis || '').trim().slice(0, 400), px = Number(body?.invalid_px);
      const source = body?.source === 'yahoo' ? 'yahoo' : 'bybit';
      if (!SYMBOL_RE.test(symbol)) return json({ error: 'símbolo inválido' }, 400);
      if (side !== 'long' && side !== 'short') return json({ error: 'side tem de ser long ou short' }, 400);
      if (thesis.length < 5) return json({ error: 'escreve a tese (mín. 5 caracteres)' }, 400);
      if (!(px > 0)) return json({ error: 'nível de invalidação inválido' }, 400);
      const { data: al, error: e1 } = await supa.from('am_alerts').insert({
        kind: 'price', source, symbol, label: `Tese invalidada · ${symbol}`, op: side === 'long' ? 'below' : 'above', level: px, repeat: false,
      }).select('id').single();
      if (e1) return json({ error: e1.message }, 400);
      const { data, error } = await supa.from('am_theses').insert({ symbol, source, side, thesis, invalid_px: px, alert_id: al.id }).select('*').single();
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true, thesis: data });
    }

    if (action === 'thesis_list') {
      const { data, error } = await supa.from('am_theses').select('*').order('created_at', { ascending: false }).limit(100);
      if (error) return json({ error: error.message }, 400);
      const ids = (data ?? []).filter((t) => t.status === 'open' && t.alert_id).map((t) => t.alert_id);
      if (ids.length) {
        const { data: als } = await supa.from('am_alerts').select('id,triggered_at').in('id', ids).not('triggered_at', 'is', null);
        for (const a of als ?? []) {
          await supa.from('am_theses').update({ status: 'invalidated', closed_at: a.triggered_at }).eq('alert_id', a.id);
          const t = data!.find((x) => x.alert_id === a.id); if (t) { t.status = 'invalidated'; t.closed_at = a.triggered_at; }
        }
      }
      return json({ theses: data });
    }

    if (action === 'thesis_close') {
      const id = Number(body?.id); if (!Number.isInteger(id)) return json({ error: 'id inválido' }, 400);
      const { data: t } = await supa.from('am_theses').select('alert_id').eq('id', id).maybeSingle();
      await supa.from('am_theses').update({ status: 'closed', closed_at: new Date().toISOString() }).eq('id', id);
      if (t?.alert_id) await supa.from('am_alerts').update({ active: false }).eq('id', t.alert_id);
      return json({ ok: true });
    }

    return json({ error: 'action inválida' }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
