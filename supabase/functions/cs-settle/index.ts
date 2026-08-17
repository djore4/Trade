// cs-settle — pontua as sugestões 'open' com o desfecho real (1.º toque stop vs
// TP1) a partir das velas de 15m da Bybit, líquido de custos. Idempotente.
// Chamada pelo cron (pg_cron, 15 min) e/ou pelo browser. Usa a service role.
import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const COST_RT = 0.17;   // % round-trip (taker + slippage)
const TF_MIN = 15;      // timeframe das velas
const MAX_HOLD = 96;    // janela máxima = 24h em velas de 15m

type Bar = { t: number; o: number; h: number; l: number; c: number };

async function fetchKline(symbol: string, startMs: number, endMs: number): Promise<Bar[]> {
  const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${TF_MIN}&start=${startMs}&end=${endMs}&limit=200`;
  const r = await fetch(url);
  const d = await r.json();
  const list = (d?.result?.list || []).slice().reverse(); // Bybit devolve do mais recente → cronológico
  return list.map((k: string[]) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4] }));
}

// 1.º toque: stop verificado antes do TP1 na mesma vela (conservador).
function settle(row: any, bars: Bar[]) {
  const entryMs = new Date(row.entry_ts).getTime();
  const after = bars.filter((b) => b.t > entryMs);
  const dir = row.side === 'long' ? 1 : -1;
  const stop = +row.stop, tp1 = +row.tp1, tp1r = +row.tp1_r || 1;
  const stopPct = row.stop_pct != null ? +row.stop_pct : Math.abs(row.entry - stop) / row.entry * 100;
  const costR = stopPct > 0 ? COST_RT / stopPct : 0;
  let hit: string | null = null, R: number | null = null, barsN = 0;
  for (let i = 0; i < after.length; i++) {
    const b = after[i]; barsN = i + 1;
    if (dir > 0) {
      if (b.l <= stop) { hit = 'stop'; R = -1; break; }
      if (b.h >= tp1) { hit = 'tp1'; R = tp1r; break; }
    } else {
      if (b.h >= stop) { hit = 'stop'; R = -1; break; }
      if (b.l <= tp1) { hit = 'tp1'; R = tp1r; break; }
    }
  }
  if (hit) return { status: (R as number) > 0 ? 'won' : 'lost', hit, outcome_r: (R as number) - costR, bars: barsN };
  const ageMin = (Date.now() - entryMs) / 60000;
  if (ageMin >= MAX_HOLD * TF_MIN && after.length >= 1) {
    const last = after[Math.min(after.length, MAX_HOLD) - 1];
    const mtm = dir > 0 ? (last.c - row.entry) / (row.entry - stop) : (row.entry - last.c) / (stop - row.entry);
    return { status: 'expired', hit: 'timeout', outcome_r: mtm - costR, bars: Math.min(after.length, MAX_HOLD) };
  }
  return null; // ainda sem desfecho → continua open
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const supa = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );
    const cutoff = new Date(Date.now() - 20 * 60000).toISOString(); // dar tempo a formar velas
    const { data: open, error } = await supa
      .from('cs_suggestions').select('*')
      .eq('status', 'open').lt('entry_ts', cutoff)
      .order('entry_ts', { ascending: true }).limit(100);
    if (error) return json({ error: error.message }, 400);

    let settled = 0, stillOpen = 0, errs = 0;
    for (const row of (open || [])) {
      try {
        const entryMs = new Date(row.entry_ts).getTime();
        const endMs = Math.min(Date.now(), entryMs + (MAX_HOLD + 2) * TF_MIN * 60000);
        const bars = await fetchKline(row.symbol, entryMs, endMs);
        const res = settle(row, bars);
        if (!res) { stillOpen++; continue; }
        const { error: uerr } = await supa.from('cs_suggestions').update({
          status: res.status, hit: res.hit, outcome_r: res.outcome_r,
          bars_to_outcome: res.bars, settled_at: new Date().toISOString(),
        }).eq('id', row.id);
        if (uerr) { errs++; } else { settled++; }
      } catch (_e) { errs++; }
    }
    return json({ scanned: (open || []).length, settled, stillOpen, errs });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 400);
  }
});
