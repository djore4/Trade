// cs-vol-settle — mede a EXPANSÃO realizada de cada observação do cs-vol-scan.
// Para cada linha de cs_vol_obs já com horizonte cumprido, puxa as velas de 15m
// da Bybit e calcula a excursão realizada (máx-mín) nas H horas seguintes ao
// registo. É o que permite testar se o score prevê a expansão. Cron 15 min.
import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const BYBIT = Deno.env.get('BYBIT_BASE') ?? 'https://api.bybit.com';

type Bar = { t: number; h: number; l: number };
async function fetchBars(sym: string): Promise<Bar[]> {
  const r = await fetch(`${BYBIT}/v5/market/kline?category=linear&symbol=${sym}&interval=15&limit=200`);
  const d = await r.json();
  const list = (d?.result?.list || []).slice().reverse(); // cronológico
  return list.map((k: string[]) => ({ t: +k[0], h: +k[2], l: +k[3] }));
}
async function pool<T>(items: T[], fn: (t: T) => Promise<void>, n: number): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx]); }
  }));
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const supa = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: cfgRow } = await supa.from('cs_config').select('obs_horizon_h').eq('id', 1).single();
    const H = +(cfgRow?.obs_horizon_h ?? 4);              // horizonte em horas
    const cutoff = new Date(Date.now() - H * 3600e3).toISOString();

    // Observações já com o horizonte cumprido e ainda por pontuar.
    const { data: pend, error } = await supa
      .from('cs_vol_obs').select('id, symbol, ts, price')
      .is('settled_at', null).lt('ts', cutoff)
      .order('ts', { ascending: true }).limit(3000);
    if (error) return json({ error: error.message }, 400);
    if (!pend || !pend.length) return json({ settled: 0, pending: 0 });

    // Agrupa por símbolo — uma chamada de velas por símbolo cobre todas as linhas.
    const bySym = new Map<string, any[]>();
    for (const row of pend) {
      const arr = bySym.get(row.symbol);
      if (arr) arr.push(row); else bySym.set(row.symbol, [row]);
    }

    const symbols = [...bySym.keys()];
    let settled = 0, errs = 0;
    const nowIso = new Date().toISOString();

    await pool(symbols, async (sym) => {
      try {
        const bars = await fetchBars(sym);
        for (const row of bySym.get(sym)!) {
          const tMs = new Date(row.ts).getTime();
          const endMs = tMs + H * 3600e3;
          const win = bars.filter(b => b.t > tMs && b.t <= endMs);
          if (!win.length) { // sem velas na janela (par sem dados) — marca settle vazio p/ não repetir
            await supa.from('cs_vol_obs').update({ settled_at: nowIso, horizon_h: H }).eq('id', row.id);
            settled++; continue;
          }
          const fwdHigh = Math.max(...win.map(b => b.h));
          const fwdLow = Math.min(...win.map(b => b.l));
          const px = +row.price || 0;
          const move = px > 0 ? (fwdHigh - fwdLow) / px * 100 : null;
          const up = px > 0 ? (fwdHigh - px) / px * 100 : null;
          const dn = px > 0 ? (px - fwdLow) / px * 100 : null;
          await supa.from('cs_vol_obs').update({
            horizon_h: H, fwd_high: fwdHigh, fwd_low: fwdLow,
            realized_move: move, realized_up: up, realized_dn: dn, settled_at: nowIso,
          }).eq('id', row.id);
          settled++;
        }
      } catch (_e) { errs++; }
    }, 8);

    return json({ settled, symbols: symbols.length, errs, horizon_h: H });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 400);
  }
});
