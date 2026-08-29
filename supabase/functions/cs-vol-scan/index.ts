// cs-vol-scan — scanner de VOLATILIDADE server-side (disparado por pg_cron, 15m).
// Corre o universo de perps da Bybit, calcula o score de EXPANSÃO de
// volatilidade (compressão BB/ATR/ADX + NR7/inside + combustível de
// posicionamento), faz dedup contra cs_vol_alerts e envia Web Push aos
// dispositivos subscritos (cs_push_subs). As chaves VAPID vêm de cs_config.
//
// Não é execução, nem previsão de direção — só assinala "isto está prestes a
// mexer muito". Cada alerta é gravado para validação futura (houve expansão?).
import { createClient } from 'jsr:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

type Kline = { closes: number[]; highs: number[]; lows: number[]; opens: number[]; vols: number[] };
type LSR = { buy: number; sell: number };

// ── Indicadores (cópia exata do motor partilhado _shared/cs-engine.ts) ──
const csMean = (a: number[]) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const csStd = (a: number[]) => {
  if (a.length < 2) return 0;
  const m = csMean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length);
};
const coinOf = (symbol: string) => symbol.replace(/USDT$/, '').replace(/USDC$/, '');
function csADX(h: number[], l: number[], c: number[], p = 14): number | null {
  const n = c.length; if (n < 2 * p + 2) return null;
  const tr: number[] = [], pdm: number[] = [], mdm: number[] = [];
  for (let i = 1; i < n; i++) {
    const up = h[i] - h[i - 1], dn = l[i - 1] - l[i];
    pdm.push(up > dn && up > 0 ? up : 0);
    mdm.push(dn > up && dn > 0 ? dn : 0);
    tr.push(Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])));
  }
  const wilder = (arr: number[]) => {
    let s = arr.slice(0, p).reduce((a, b) => a + b, 0); const o = [s];
    for (let i = p; i < arr.length; i++) { s = s - s / p + arr[i]; o.push(s); } return o;
  };
  const trS = wilder(tr), pS = wilder(pdm), mS = wilder(mdm), dx: number[] = [];
  for (let i = 0; i < trS.length; i++) {
    const t = trS[i] || 1e-9, pdi = 100 * pS[i] / t, mdi = 100 * mS[i] / t;
    dx.push(100 * Math.abs(pdi - mdi) / ((pdi + mdi) || 1e-9));
  }
  if (dx.length < p) return null;
  let adx = csMean(dx.slice(0, p));
  for (let i = p; i < dx.length; i++) adx = (adx * (p - 1) + dx[i]) / p;
  return adx;
}
function csBBWidthPct(closes: number[], p = 20): { cur: number; pct: number } | null {
  if (closes.length < p + 30) return null;
  const widths: number[] = [];
  for (let i = p; i <= closes.length; i++) {
    const w = closes.slice(i - p, i), m = csMean(w);
    widths.push(m ? 4 * csStd(w) / m : 0);
  }
  const cur = widths[widths.length - 1], sorted = widths.slice().sort((a, b) => a - b);
  return { cur, pct: sorted.filter(x => x <= cur).length / sorted.length * 100 };
}

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const BYBIT = Deno.env.get('BYBIT_BASE') ?? 'https://api.bybit.com';
const MIN_TURNOVER = 300e3;
const HEALTHY_TURNOVER = 20e6;

// ── Fetchers públicos (cronológico: antigo → recente) ──
async function fetchKline(sym: string, interval: string, limit: number): Promise<Kline> {
  const r = await fetch(`${BYBIT}/v5/market/kline?category=linear&symbol=${sym}&interval=${interval}&limit=${limit}`);
  const d = await r.json();
  const list = (d?.result?.list || []).slice().reverse();
  return {
    closes: list.map((k: string[]) => +k[4]), highs: list.map((k: string[]) => +k[2]),
    lows: list.map((k: string[]) => +k[3]), opens: list.map((k: string[]) => +k[1]),
    vols: list.map((k: string[]) => +k[5]),
  };
}
async function fetchFunding(sym: string): Promise<number[]> {
  const r = await fetch(`${BYBIT}/v5/market/funding/history?category=linear&symbol=${sym}&limit=100`);
  const d = await r.json();
  return (d?.result?.list || []).map((x: any) => parseFloat(x.fundingRate) * 100).reverse();
}
async function fetchOI(sym: string): Promise<number[]> {
  const r = await fetch(`${BYBIT}/v5/market/open-interest?category=linear&symbol=${sym}&intervalTime=15min&limit=96`);
  const d = await r.json();
  return (d?.result?.list || []).map((x: any) => +x.openInterest).filter((v: number) => v > 0).reverse();
}
async function fetchLSR(sym: string): Promise<LSR[]> {
  try {
    const r = await fetch(`${BYBIT}/v5/market/account-ratio?category=linear&symbol=${sym}&period=1h&limit=24`);
    const d = await r.json();
    return (d?.result?.list || []).map((x: any) => ({ buy: parseFloat(x.buyRatio), sell: parseFloat(x.sellRatio) })).reverse();
  } catch { return []; }
}
async function pool<T>(items: T[], fn: (t: T) => Promise<void>, n: number): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx]); }
  }));
}

// ── Preditores de EXPANSÃO de volatilidade (espelho do frontend) ──
function csAtrPctile(highs: number[], lows: number[], closes: number[], p = 14) {
  const n = closes.length; if (n < p + 40) return null;
  const trp: number[] = [];
  for (let i = 1; i < n; i++) {
    const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
    trp.push(closes[i] ? tr / closes[i] : 0);
  }
  const atrp: number[] = [];
  for (let i = p; i <= trp.length; i++) atrp.push(csMean(trp.slice(i - p, i)));
  const cur = atrp[atrp.length - 1], sorted = atrp.slice().sort((a, b) => a - b);
  return { cur, pct: sorted.filter(x => x <= cur).length / sorted.length * 100 };
}
function csNR7(highs: number[], lows: number[]) {
  const n = highs.length; if (n < 7) return false;
  const rng = (i: number) => highs[i] - lows[i], last = rng(n - 1);
  for (let i = n - 7; i < n - 1; i++) if (rng(i) <= last) return false;
  return true;
}
function csInsideBar(highs: number[], lows: number[]) {
  const n = highs.length; if (n < 2) return false;
  return highs[n - 1] < highs[n - 2] && lows[n - 1] > lows[n - 2];
}
function csVolScore(x: { bbH1: number | null; atr15: number | null; adx: number | null; nr7: boolean; inside: boolean; oiChg6h: number | null; funding: number | null; lsLongPct: number | null }) {
  const bbComp = x.bbH1 == null ? 50 : (100 - x.bbH1);
  const atrComp = x.atr15 == null ? 50 : (100 - x.atr15);
  const adxComp = x.adx == null ? 50 : Math.max(0, Math.min(100, (30 - x.adx) / 30 * 100));
  let comp = (0.45 * bbComp + 0.35 * atrComp + 0.20 * adxComp) * 0.70;
  let patt = 0; if (x.nr7) patt += 8; if (x.inside) patt += 5;
  let fuel = 0;
  if (x.oiChg6h != null) fuel += Math.min(8, Math.abs(x.oiChg6h) / 12 * 8);
  if (x.funding != null) fuel += Math.min(5, Math.abs(x.funding) / 0.05 * 5);
  if (x.lsLongPct != null) fuel += Math.min(4, Math.abs(x.lsLongPct - 50) / 20 * 4);
  return Math.max(0, Math.min(100, comp + patt + fuel));
}
function csExpMove24(k60: Kline) {
  const { highs, lows, closes } = k60, n = closes.length; if (n < 30) return null;
  const ranges: number[] = [];
  for (let i = 24; i < n; i++) {
    const h = Math.max(...highs.slice(i - 24, i)), l = Math.min(...lows.slice(i - 24, i)), c = closes[i - 1];
    if (c) ranges.push((h - l) / c * 100);
  }
  if (!ranges.length) return null;
  const sorted = ranges.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
function csTilt(funding: number | null, lsLongPct: number | null): { side: string; reasons: string[] } {
  let sig = 0; const reasons: string[] = [];
  if (lsLongPct != null) {
    if (lsLongPct >= 60) { sig -= 1; reasons.push(`crowd ${lsLongPct.toFixed(0)}% long`); }
    else if (lsLongPct <= 40) { sig += 1; reasons.push(`crowd ${(100 - lsLongPct).toFixed(0)}% short`); }
  }
  if (funding != null) {
    if (funding >= 0.03) { sig -= 1; reasons.push(`funding +${funding.toFixed(3)}%`); }
    else if (funding <= -0.03) { sig += 1; reasons.push(`funding ${funding.toFixed(3)}%`); }
  }
  return { side: sig > 0 ? 'long' : sig < 0 ? 'short' : 'neutral', reasons };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const supa = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const body = await req.json().catch(() => ({}));

    const { data: cfgRow } = await supa.from('cs_config').select('*').eq('id', 1).single();
    if (!cfgRow?.vapid_public || !cfgRow?.vapid_private) return json({ error: 'cs_config sem chaves VAPID' }, 400);
    webpush.setVapidDetails(cfgRow.vapid_subject || 'mailto:alerts@cryptoscan.local', cfgRow.vapid_public, cfgRow.vapid_private);

    // Envio a todos os dispositivos subscritos; remove os mortos (404/410).
    const sendToAll = async (payload: Record<string, unknown>) => {
      const { data: subs } = await supa.from('cs_push_subs').select('*');
      let sent = 0, pruned = 0;
      for (const s of (subs || [])) {
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload));
          sent++;
          await supa.from('cs_push_subs').update({ last_ok: new Date().toISOString(), fail_count: 0 }).eq('endpoint', s.endpoint);
        } catch (e) {
          const code = (e as any)?.statusCode;
          if (code === 404 || code === 410) { await supa.from('cs_push_subs').delete().eq('endpoint', s.endpoint); pruned++; }
          else { await supa.from('cs_push_subs').update({ fail_count: (s.fail_count || 0) + 1 }).eq('endpoint', s.endpoint); }
        }
      }
      return { sent, pruned };
    };

    // Modo teste: envia uma notificação de exemplo (usado pelo botão "Ativar").
    if (body?.test) {
      const res = await sendToAll({ title: '🔔 Alertas ativos', body: 'Vais receber aqui os alertas de volatilidade do CryptoScan.', data: { url: '/' } });
      return json({ test: true, ...res });
    }

    const volThreshold = +cfgRow.vol_threshold || 55;
    const dedupHours = +cfgRow.alert_dedup_hours || 6;
    const topN = +cfgRow.universe_top || 70;

    // Universo (perps USDT líquidos), top-N por turnover.
    const r = await fetch(`${BYBIT}/v5/market/tickers?category=linear`);
    const d = await r.json();
    let uni = (d?.result?.list || [])
      .filter((t: any) => /USDT$/.test(t.symbol) && !/[0-9]/.test(coinOf(t.symbol)))
      .map((t: any) => ({ symbol: t.symbol, coin: coinOf(t.symbol), price: parseFloat(t.lastPrice), chg24: parseFloat(t.price24hPcnt) * 100, fr: parseFloat(t.fundingRate) * 100, turnover: parseFloat(t.turnover24h) || 0 }))
      .filter((c: any) => c.turnover >= MIN_TURNOVER && isFinite(c.price) && c.price > 0);
    uni.sort((a: any, b: any) => b.turnover - a.turnover);
    const enrich = uni.slice(0, topN);

    const cands: any[] = [];
    await pool(enrich, async (c: any) => {
      try {
        const [k15, k60, fund, oi, lsr] = await Promise.all([
          fetchKline(c.symbol, '15', 200), fetchKline(c.symbol, '60', 120),
          fetchFunding(c.symbol), fetchOI(c.symbol), fetchLSR(c.symbol),
        ]);
        if (k15.closes.length < 60 || k60.closes.length < 50) return;
        const bb = csBBWidthPct(k60.closes, 20);
        const bbPct = bb ? bb.pct : null;
        const adx = csADX(k60.highs, k60.lows, k60.closes, 14);
        const atrP = csAtrPctile(k15.highs, k15.lows, k15.closes, 14);
        const lsLongPct = lsr.length ? lsr[lsr.length - 1].buy * 100 : null;
        const oiChg6h = (oi && oi.length >= 25) ? (oi[oi.length - 1] - oi[oi.length - 25]) / oi[oi.length - 25] * 100 : null;
        const nr7 = csNR7(k15.highs, k15.lows), inside = csInsideBar(k15.highs, k15.lows);
        const score = csVolScore({ bbH1: bbPct, atr15: atrP ? atrP.pct : null, adx, nr7, inside, oiChg6h, funding: c.fr, lsLongPct });
        const wk = 24;
        const rangeHi = Math.max(...k15.highs.slice(-wk)), rangeLo = Math.min(...k15.lows.slice(-wk));
        cands.push({
          ...c, score, bbH1: bbPct, atrPct: atrP ? atrP.pct : null, adx,
          nr7, inside, expMove: csExpMove24(k60), tilt: csTilt(c.fr, lsLongPct),
          rangeHi, rangeLo, lowLiq: c.turnover < HEALTHY_TURNOVER,
        });
      } catch { /* par com dados incompletos — ignora */ }
    }, 8);

    const above = cands.filter(c => c.score >= volThreshold).sort((a, b) => b.score - a.score);

    // Log de investigação: TODOS os pares avaliados (grupo de controlo). O
    // cs-vol-settle mede depois a expansão realizada. É isto que permite testar
    // se o score prevê a expansão (não só os alertas).
    if (cands.length) {
      const nowIso = new Date().toISOString();
      const obsRows = cands.map(c => ({
        ts: nowIso, symbol: c.symbol, coin: c.coin, score: c.score, price: c.price,
        bb_h1: c.bbH1, atr_pct: c.atrPct, exp_move: c.expMove, above_alert: c.score >= volThreshold,
      }));
      await supa.from('cs_vol_obs').insert(obsRows);
    }

    // Dedup: não voltar a alertar o mesmo par dentro de dedupHours.
    const sinceIso = new Date(Date.now() - dedupHours * 3600e3).toISOString();
    const { data: recent } = await supa.from('cs_vol_alerts').select('symbol').gte('ts', sinceIso);
    const seen = new Set((recent || []).map((x: any) => x.symbol));
    const fresh = above.filter(c => !seen.has(c.symbol));

    if (fresh.length) {
      const now = new Date();
      const hb = '' + now.getUTCFullYear() + String(now.getUTCMonth() + 1).padStart(2, '0') + String(now.getUTCDate()).padStart(2, '0') + String(now.getUTCHours()).padStart(2, '0');
      const rows = fresh.map(c => ({
        sig_key: `${c.symbol}_${hb}`, symbol: c.symbol, coin: c.coin,
        score: c.score, exp_move: c.expMove, bb_h1: c.bbH1, atr_pct: c.atrPct, adx: c.adx,
        nr7: c.nr7, inside: c.inside, range_lo: c.rangeLo, range_hi: c.rangeHi,
        price: c.price, tilt: c.tilt.side, turnover: c.turnover, low_liq: c.lowLiq,
      }));
      await supa.from('cs_vol_alerts').upsert(rows, { onConflict: 'sig_key', ignoreDuplicates: true });

      // Uma notificação agrupada por scan (evita spam). Título = melhor par.
      const top = fresh.slice(0, 4);
      const t0 = top[0];
      const title = fresh.length === 1
        ? `⚡ ${t0.coin} prestes a mexer`
        : `⚡ ${fresh.length} pares a comprimir`;
      const lines = top.map(c => `${c.coin} ${Math.round(c.score)}/100 · ~${c.expMove != null ? c.expMove.toFixed(1) : '—'}% 24h`);
      const bodyTxt = lines.join('\n') + (fresh.length > top.length ? `\n+${fresh.length - top.length} outros` : '');
      const push = await sendToAll({ title, body: bodyTxt, data: { url: '/', symbol: t0.symbol } });
      return json({ scanned: enrich.length, above: above.length, fresh: fresh.length, notified: push });
    }

    return json({ scanned: enrich.length, above: above.length, fresh: 0 });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 400);
  }
});
