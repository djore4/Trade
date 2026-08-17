// cs-log — grava as sugestões emitidas pelo CryptoScan (dedup por sig_key).
// Chamada do browser com a anon key; usa a service role para escrever na tabela
// fechada public.cs_suggestions.
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
    const list = Array.isArray(body?.suggestions) ? body.suggestions : [];
    const rows = list.slice(0, 50).map((s: any) => ({
      sig_key: String(s.sig_key || ''),
      entry_ts: s.entry_ts,
      symbol: String(s.symbol || ''),
      coin: String(s.coin || ''),
      side: s.side,
      entry: +s.entry, stop: +s.stop, tp1: +s.tp1,
      tp1_r: s.tp1_r != null ? +s.tp1_r : 1,
      stop_pct: s.stop_pct != null ? +s.stop_pct : null,
      blended_rr: s.blended_rr != null ? +s.blended_rr : null,
      score: s.score != null ? +s.score : null,
      confidence: s.confidence != null ? +s.confidence : null,
      sensitivity: s.sensitivity ?? null,
      regime: s.regime ?? null,
      setup: s.setup ?? null,
      signals: s.signals ?? null,
      turnover: s.turnover != null ? +s.turnover : null,
      low_liq: !!s.low_liq,
      leverage: s.leverage != null ? +s.leverage : null,
    })).filter((r: any) =>
      r.sig_key && r.symbol && (r.side === 'long' || r.side === 'short') &&
      r.entry_ts && isFinite(r.entry) && isFinite(r.stop) && isFinite(r.tp1));

    if (!rows.length) return json({ received: 0, inserted: 0 });
    const { error, count } = await supa
      .from('cs_suggestions')
      .upsert(rows, { onConflict: 'sig_key', ignoreDuplicates: true, count: 'exact' });
    if (error) return json({ error: error.message }, 400);
    return json({ received: rows.length, inserted: count ?? 0 });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 400);
  }
});
