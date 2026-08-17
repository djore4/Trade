// cs-stats — agrega o desempenho REAL das sugestões já pontuadas: expectância
// líquida por escalão de score, por sensibilidade e por liquidez. Leitura p/ a app.
import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

function agg(rows: any[]) {
  if (!rows.length) return { n: 0, win: null, exp: null, pf: null };
  const wins = rows.filter((r) => r.outcome_r > 0);
  const gross = wins.reduce((s, r) => s + r.outcome_r, 0);
  const loss = -rows.filter((r) => r.outcome_r < 0).reduce((s, r) => s + r.outcome_r, 0);
  return {
    n: rows.length,
    win: wins.length / rows.length,
    exp: rows.reduce((s, r) => s + r.outcome_r, 0) / rows.length,
    pf: loss > 0 ? gross / loss : null,
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const supa = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );
    const { data: settled, error } = await supa
      .from('cs_suggestions')
      .select('outcome_r,score,sensitivity,low_liq,side,status')
      .in('status', ['won', 'lost', 'expired'])
      .not('outcome_r', 'is', null)
      .limit(5000);
    if (error) return json({ error: error.message }, 400);
    const rows = settled || [];

    const { count: openCount } = await supa.from('cs_suggestions')
      .select('*', { count: 'exact', head: true }).eq('status', 'open');
    const { count: total } = await supa.from('cs_suggestions')
      .select('*', { count: 'exact', head: true });

    const buckets = [[0, 25], [25, 30], [30, 40], [40, 55], [55, 999]].map(([lo, hi]) => ({
      lo, hi, ...agg(rows.filter((r) => r.score >= lo && r.score < hi)),
    }));
    const bySens = ['strict', 'balanced', 'loose'].map((k) => ({
      k, ...agg(rows.filter((r) => r.sensitivity === k)),
    }));
    const byLiq = {
      normal: agg(rows.filter((r) => !r.low_liq)),
      low: agg(rows.filter((r) => r.low_liq)),
    };

    return json({ overall: agg(rows), buckets, bySens, byLiq, open: openCount ?? 0, total: total ?? 0 });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 400);
  }
});
