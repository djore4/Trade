// am-ppr — guarda os PPR do Asset Manager na base (sincroniza todos os dispositivos).
// POST { action, ... }:
//   get                      -> { data: { funds }, rev }
//   put { data, rev }        -> grava se `rev` for a revisão atual: { ok: true, rev }
//                               senão devolve { conflict: true, data, rev } (o cliente junta e repete)
// Usa a service role (tabela am_ppr fechada).
import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const MAX_FUNDS = 20, MAX_BUYS = 2000, MAX_BYTES = 300_000;
const isNum = (v: unknown) => typeof v === 'number' && isFinite(v);

function validate(data: any): string | null {
  if (!data || !Array.isArray(data.funds)) return 'data.funds invalido';
  if (data.funds.length > MAX_FUNDS) return `maximo de ${MAX_FUNDS} PPR`;
  for (const f of data.funds) {
    if (!f || typeof f.id !== 'string' || typeof f.name !== 'string' || !Array.isArray(f.buys)) return 'PPR invalido';
    if (f.buys.length > MAX_BUYS) return 'demasiadas compras';
    for (const b of f.buys) {
      if (typeof b?.id !== 'string' || typeof b.d !== 'string' || !isNum(b.amt) || !isNum(b.units)) return 'compra invalida';
    }
    if (f.price != null && (!isNum(f.price.v) || typeof f.price.d !== 'string')) return 'preco invalido';
  }
  if (JSON.stringify(data).length > MAX_BYTES) return 'dados demasiado grandes';
  return null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  try {
    const supa = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const body = await req.json().catch(() => ({}));
    const action = String(body?.action || '');
    const read = () => supa.from('am_ppr').select('data, rev').eq('id', 1).single();

    if (action === 'get') {
      const { data, error } = await read();
      if (error) return json({ error: error.message }, 400);
      return json({ data: data.data, rev: data.rev });
    }

    if (action === 'put') {
      const rev = Number(body?.rev);
      if (!Number.isInteger(rev) || rev < 0) return json({ error: 'rev invalido' }, 400);
      const err = validate(body?.data);
      if (err) return json({ error: err }, 400);
      const funds = body.data.funds;
      const { data: upd, error } = await supa.from('am_ppr')
        .update({ data: { funds }, rev: rev + 1, updated_at: new Date().toISOString() })
        .eq('id', 1).eq('rev', rev).select('rev');
      if (error) return json({ error: error.message }, 400);
      if (upd && upd.length) return json({ ok: true, rev: upd[0].rev });
      const { data: cur, error: e2 } = await read();
      if (e2) return json({ error: e2.message }, 400);
      return json({ conflict: true, data: cur.data, rev: cur.rev });
    }

    return json({ error: 'action invalida' }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 400);
  }
});
