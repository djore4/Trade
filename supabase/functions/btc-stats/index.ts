// btc-stats — agrega o desempenho REAL do BTC Advisor já pontuado (btc_obs).
// Devolve, por horizonte: nº de amostras, hit-rate direcional, R médio (líquido
// aproximado), profit factor e expectância. É a leitura que a app mostra com o
// rótulo "não validado" enquanto n for baixo. Também separa o efeito da camada
// BTC (quando o posicionamento fez flip/veto ao backbone).
import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

// Só linhas com direção emitida e R realizado contam para expectância.
function agg(rows: any[]) {
  const r = rows.filter((x) => x.dir !== 0 && x.r_realized != null);
  if (!r.length) return { n: 0, hit: null, avgR: null, exp: null, pf: null };
  const wins = r.filter((x) => x.r_realized > 0);
  const gross = wins.reduce((s, x) => s + x.r_realized, 0);
  const loss = -r.filter((x) => x.r_realized < 0).reduce((s, x) => s + x.r_realized, 0);
  const hits = r.filter((x) => x.hit_dir === true).length;
  return {
    n: r.length,
    hit: hits / r.length,
    avgR: r.reduce((s, x) => s + x.r_realized, 0) / r.length,
    exp: r.reduce((s, x) => s + x.r_realized, 0) / r.length,
    pf: loss > 0 ? gross / loss : null,
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const supa = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data, error } = await supa
      .from('btc_obs')
      .select('horizon,dir,base_dir,r_realized,hit_dir,pos_tilt,score')
      .not('settled_at', 'is', null)
      .limit(8000);
    if (error) return json({ error: error.message }, 400);
    const rows = data || [];

    const { count: pending } = await supa.from('btc_obs')
      .select('*', { count: 'exact', head: true }).is('settled_at', null);
    const { count: total } = await supa.from('btc_obs')
      .select('*', { count: 'exact', head: true });

    const byHorizon: Record<string, any> = {};
    for (const h of ['scalp', 'intraday', 'swing']) {
      const hr = rows.filter((r) => r.horizon === h);
      byHorizon[h] = {
        overall: agg(hr),
        // Efeito da camada BTC: linhas onde a decisão final ≠ backbone (flip/veto).
        enrichedChanged: agg(hr.filter((r) => r.dir !== r.base_dir)),
        backboneOnly: agg(hr.filter((r) => r.dir === r.base_dir)),
      };
    }

    return json({ byHorizon, pending: pending ?? 0, total: total ?? 0 });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 400);
  }
});
