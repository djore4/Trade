// btc-settle — mede o DESFECHO direcional de cada observação do btc-scan.
// Para cada linha de btc_obs com o horizonte cumprido, puxa as velas da Bybit e
// calcula: retorno no horizonte, MFE/MAE na direção emitida, se acertou o sinal
// e o R realizado (primeiro toque em TP1 vs stop). É o que permite dizer, com
// dados, se o advisor tem edge — ou não. Cron 15 min.
import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const BYBIT = Deno.env.get('BYBIT_BASE') ?? 'https://api.bybit.com';
type Bar = { t: number; h: number; l: number; c: number };

async function fetchBars(interval: string, limit: number): Promise<Bar[]> {
  const r = await fetch(`${BYBIT}/v5/market/kline?category=linear&symbol=BTCUSDT&interval=${interval}&limit=${limit}`);
  const d = await r.json();
  const list = (d?.result?.list || []).slice().reverse(); // cronológico
  return list.map((k: string[]) => ({ t: +k[0], h: +k[2], l: +k[3], c: +k[4] }));
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const supa = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    // Observações com horizonte cumprido e ainda por pontuar.
    // (horizon_h varia por linha; filtramos as mais antigas que o maior horizonte
    //  possível e validamos por linha abaixo.)
    const maxH = 72;
    const cutoff = new Date(Date.now() - 0 * 3600e3).toISOString(); // teto = agora; a janela por linha decide
    const { data: pend, error } = await supa
      .from('btc_obs')
      .select('id, ts, horizon, horizon_h, dir, price, stop, tp1, tp1_r, stop_pct')
      .is('settled_at', null)
      .order('ts', { ascending: true }).limit(2000);
    if (error) return json({ error: error.message }, 400);
    if (!pend || !pend.length) return json({ settled: 0, pending: 0 });

    const now = Date.now();
    // Só as que já cumpriram o próprio horizonte.
    const due = pend.filter((r: any) => now - new Date(r.ts).getTime() >= (+r.horizon_h || maxH) * 3600e3);
    if (!due.length) return json({ settled: 0, pending: pend.length });

    // Um fetch de velas cobre todas: 15m (≤50h) para intraday, 60m (≤200h) para swing.
    const [bars15, bars60] = await Promise.all([fetchBars('15', 200), fetchBars('60', 200)]);
    const nowIso = new Date().toISOString();
    let settled = 0;

    for (const row of due) {
      const tMs = new Date(row.ts).getTime();
      const H = (+row.horizon_h || maxH) * 3600e3;
      const endMs = tMs + H;
      const bars = row.horizon === 'swing' ? bars60 : bars15;
      const win = bars.filter(b => b.t > tMs && b.t <= endMs);
      const px = +row.price || 0;

      if (!win.length || px <= 0) { // sem cobertura de velas — marca settle vazio p/ não repetir
        await supa.from('btc_obs').update({ settled_at: nowIso }).eq('id', row.id);
        settled++; continue;
      }

      const fwdHigh = Math.max(...win.map(b => b.h));
      const fwdLow = Math.min(...win.map(b => b.l));
      const fwdClose = win[win.length - 1].c;
      const retFwd = (fwdClose - px) / px * 100;
      const dir = +row.dir || 0;

      let mfe: number | null = null, mae: number | null = null, hitDir: boolean | null = null, rReal: number | null = null;
      if (dir !== 0) {
        const upMove = (fwdHigh - px) / px * 100, dnMove = (px - fwdLow) / px * 100;
        mfe = dir > 0 ? upMove : dnMove;
        mae = dir > 0 ? dnMove : upMove;
        hitDir = dir > 0 ? retFwd > 0 : retFwd < 0;
        // R realizado por primeiro toque (TP1 vs stop) dentro da janela.
        const stop = row.stop != null ? +row.stop : null, tp1 = row.tp1 != null ? +row.tp1 : null;
        const tpR = row.tp1_r != null ? +row.tp1_r : null, stopPct = row.stop_pct != null ? +row.stop_pct : null;
        if (stop != null && tp1 != null && tpR != null) {
          let outcome: number | null = null;
          for (const b of win) {
            const hitStop = dir > 0 ? b.l <= stop : b.h >= stop;
            const hitTp = dir > 0 ? b.h >= tp1 : b.l <= tp1;
            if (hitStop && hitTp) { outcome = -1; break; } // conservador: assume stop na mesma vela
            if (hitStop) { outcome = -1; break; }
            if (hitTp) { outcome = tpR; break; }
          }
          rReal = outcome != null ? outcome : (stopPct && stopPct > 0 ? (dir > 0 ? retFwd : -retFwd) / stopPct : null);
        } else if (stopPct && stopPct > 0) {
          rReal = (dir > 0 ? retFwd : -retFwd) / stopPct;
        }
      }

      await supa.from('btc_obs').update({
        fwd_close: fwdClose, ret_fwd: retFwd, mfe, mae, hit_dir: hitDir, r_realized: rReal, settled_at: nowIso,
      }).eq('id', row.id);
      settled++;
    }

    return json({ settled, due: due.length, pending: pend.length - settled });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 400);
  }
});
