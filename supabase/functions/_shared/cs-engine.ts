/*
 * cs-engine.ts — Núcleo PURO do CryptoScan, portado fielmente de index.html.
 * ==========================================================================
 * Sem I/O nem dependências Deno: só matemática de indicadores + sinais +
 * scoring + risk engine. Os fetchers da Bybit e o Deno.serve vivem em cada
 * edge function (cs-bot, etc.). Manter este ficheiro 1:1 com a lógica do
 * browser garante que o bot decide EXATAMENTE como a app mostra.
 *
 * Paridade: as funções csH1/H2/H3, csStructure, csThrust, csBreakout,
 * csRegime, csComposite, csRegimeFit, csTradePlan, csSentiment, csConfidence
 * e csSetupType são cópias diretas de index.html (linhas ~3362–3790).
 *
 * Recalibração (guiada pelos dados de cs_suggestions): NÃO está embutida —
 * vive em CS_RECAL e é aplicada por buildConfig({recalibrate:true}). Assim é
 * reversível e comparável (A/B) com o baseline original.
 */

// ─────────────────────────────────────────────────────────────────────────
//  Tipos
// ─────────────────────────────────────────────────────────────────────────
export interface Kline {
  closes: number[]; highs: number[]; lows: number[]; opens: number[]; vols: number[];
}
export interface Signal { score: number; dir: number; ev: string; on: boolean; }
export interface Regime { type: string; ev: string; adx: number | null; bbPct: number | null; }
export interface LSR { buy: number; sell: number; }

export interface CsConfig {
  minTurnover: number; healthyTurnover: number; universeTop: number;
  weights: Record<string, number>;
  scoreThreshold: number; minConfidence: number; sensitivity: string;
  shortlistMax: number; radarMax: number;
  fundingZ: number; fundingZOn: number; fundingZFull: number; fundingChgGate: number;
  oiOn: number; oiFull: number; oiPxGate: number;
  cascadeRangeOn: number; cascadeVolOn: number; cascadeOiDrop: number;
  structOn: number;
  thrustVolOn: number; thrustMomOn: number;
  breakoutBars: number; breakoutOn: number; breakoutFull: number;
  adxTrend: number; bbSqueezePct: number; costPerSide: number;
  tp: { r: number; close: number }[];
  minRR: number;
  leverage: number; levMin: number; levMax: number; maxLev: number;
  riskPct: number; riskMin: number; riskMax: number;
  stopAtr: number; stopAtrMax: number; capital: number; concurrency: number;
  // camada de recalibração (multiplicadores de fit de regime por tipo)
  regimeFitMult?: Record<string, number>;
  costRT?: number;
}

// ─────────────────────────────────────────────────────────────────────────
//  Config base — espelho de CS_CFG em index.html
// ─────────────────────────────────────────────────────────────────────────
export const CS_CFG_BASE: CsConfig = {
  minTurnover: 300e3,
  healthyTurnover: 20e6,
  universeTop: 70,
  weights: { funding: 22, oi: 18, cascade: 14, thrust: 14, breakout: 12, regime: 15, structure: 5 },
  scoreThreshold: 30,
  minConfidence: 4,
  sensitivity: 'balanced',
  shortlistMax: 12,
  radarMax: 10,
  fundingZ: 2,
  fundingZOn: 1.3, fundingZFull: 3.5,
  fundingChgGate: 1.0,
  oiOn: 3, oiFull: 12,
  oiPxGate: 0.6,
  cascadeRangeOn: 1.8, cascadeVolOn: 2.2, cascadeOiDrop: -1,
  structOn: 20,
  thrustVolOn: 1.8, thrustMomOn: 1.0,
  breakoutBars: 48, breakoutOn: 0.1, breakoutFull: 1.5,
  adxTrend: 25,
  bbSqueezePct: 15,
  costPerSide: 0.055 + 0.030,
  tp: [{ r: 1.0, close: 0.40 }, { r: 2.0, close: 0.35 }, { r: 3.5, close: 0.25 }],
  minRR: 1.8,
  leverage: 10,
  levMin: 1, levMax: 25,
  maxLev: 25,
  riskPct: 0.75,
  riskMin: 0.5, riskMax: 1.0,
  stopAtr: 1.2,
  stopAtrMax: 2.5,
  capital: 100,
  concurrency: 8,
};

// Presets de sensibilidade (espelho de CS_SENS).
export const CS_SENS: Record<string, { scoreThreshold: number; minConfidence: number; label: string }> = {
  strict: { scoreThreshold: 30, minConfidence: 4.0, label: 'Rigoroso' },
  balanced: { scoreThreshold: 22, minConfidence: 3.5, label: 'Equilibrado' },
  loose: { scoreThreshold: 16, minConfidence: 3.0, label: 'Permissivo' },
};

// ─────────────────────────────────────────────────────────────────────────
//  RECALIBRAÇÃO — guiada pelos desfechos reais em cs_suggestions.
//  Leitura dos 45 desfechos (17–19 Ago 2026):
//   • fade > continuação: OI Flush·Fade +0.59R / Funding Squeeze +0.29R;
//     Breakout·Continuation ≈0/negativo. breakout/thrust ON destroem expectância.
//   • funding/oi/structure ON são positivos; estrutura OFF é negativa.
//   • regime: trend_down +0.77R, ranging +0.50R, trend_up −0.09R.
//  Tradução em pesos/fit (conservadora — amostra pequena, é reversível):
// ─────────────────────────────────────────────────────────────────────────
export const CS_RECAL = {
  weights: { funding: 26, oi: 22, cascade: 12, thrust: 8, breakout: 7, regime: 18, structure: 9 },
  // multiplicadores aplicados ao fit de regime (favorece contra-tendência/range)
  regimeFitMult: { trend_up: 0.7, trend_down: 1.15, ranging: 1.1, squeeze: 1.0 },
};

export function buildConfig(opts: { sensitivity?: string; recalibrate?: boolean; capital?: number; leverage?: number } = {}): CsConfig {
  const cfg: CsConfig = JSON.parse(JSON.stringify(CS_CFG_BASE));
  if (opts.recalibrate) {
    cfg.weights = { ...cfg.weights, ...CS_RECAL.weights };
    cfg.regimeFitMult = { ...CS_RECAL.regimeFitMult };
  }
  const sk = opts.sensitivity && CS_SENS[opts.sensitivity] ? opts.sensitivity : cfg.sensitivity;
  cfg.sensitivity = sk;
  cfg.scoreThreshold = CS_SENS[sk].scoreThreshold;
  cfg.minConfidence = CS_SENS[sk].minConfidence;
  if (opts.capital && opts.capital > 0) cfg.capital = opts.capital;
  if (opts.leverage && opts.leverage >= cfg.levMin && opts.leverage <= cfg.levMax) cfg.leverage = opts.leverage;
  cfg.costRT = 2 * cfg.costPerSide;
  return cfg;
}

// ─────────────────────────────────────────────────────────────────────────
//  Helpers de estatística e indicadores (espelho de index.html)
// ─────────────────────────────────────────────────────────────────────────
export const csMean = (a: number[]) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
export const csStd = (a: number[]) => {
  if (a.length < 2) return 0;
  const m = csMean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length);
};
export const csSMA = (a: number[], p: number) => a.length < p ? null : csMean(a.slice(-p));

export function csATR(h: number[], l: number[], c: number[], p = 14): number | null {
  const n = c.length; if (n < p + 1) return null;
  const tr: number[] = [];
  for (let i = 1; i < n; i++) tr.push(Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])));
  let atr = csMean(tr.slice(0, p));
  for (let i = p; i < tr.length; i++) atr = (atr * (p - 1) + tr[i]) / p;
  return atr;
}

export function csADX(h: number[], l: number[], c: number[], p = 14): number | null {
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

export function csBBWidthPct(closes: number[], p = 20): { cur: number; pct: number } | null {
  if (closes.length < p + 30) return null;
  const widths: number[] = [];
  for (let i = p; i <= closes.length; i++) {
    const w = closes.slice(i - p, i), m = csMean(w);
    widths.push(m ? 4 * csStd(w) / m : 0);
  }
  const cur = widths[widths.length - 1], sorted = widths.slice().sort((a, b) => a - b);
  return { cur, pct: sorted.filter(x => x <= cur).length / sorted.length * 100 };
}

// Rampa linear: mapeia x∈[on,full] → [15,100]; abaixo de `on` devolve 0.
const csRamp = (x: number, on: number, full: number) =>
  x < on ? 0 : Math.min(100, 15 + (Math.min(x, full) - on) / (full - on) * 85);

// ─────────────────────────────────────────────────────────────────────────
//  Sinais (cada um devolve { score 0-100, dir -1|0|+1, ev, on })
// ─────────────────────────────────────────────────────────────────────────
export function csH1(fund: number[], chg24: number, cfg: CsConfig): Signal {
  if (!fund || fund.length < 20) return { score: 0, dir: 0, ev: 'Sem histórico de funding.', on: false };
  const cur = fund[fund.length - 1], hist = fund.slice(0, -1), m = csMean(hist), sd = csStd(hist);
  const z = sd > 0 ? (cur - m) / sd : 0, g = cfg.fundingChgGate;
  let dir = 0, on = false;
  if (z >= cfg.fundingZOn && chg24 <= g) { dir = -1; on = true; }
  else if (z <= -cfg.fundingZOn && chg24 >= -g) { dir = 1; on = true; }
  const score = on ? csRamp(Math.abs(z), cfg.fundingZOn, cfg.fundingZFull) : 0;
  const ev = `Funding ${cur.toFixed(4)}%/8h · z=${z.toFixed(2)} · preço 24h ${chg24 >= 0 ? '+' : ''}${chg24.toFixed(2)}%. ` +
    (on ? (dir < 0 ? 'Crowd long sobrelotado → fade SHORT.' : 'Crowd short sobrelotado → fade LONG.') : 'Sem squeeze qualificado.');
  return { score, dir, ev, on };
}

export function csH2(oi: number[], closes15: number[], cfg: CsConfig): Signal {
  if (!oi || oi.length < 25 || closes15.length < 25) return { score: 0, dir: 0, ev: 'Sem dados de OI.', on: false };
  const oiNow = oi[oi.length - 1], oi6 = oi[oi.length - 25], oiChg = (oiNow - oi6) / oi6 * 100;
  const pxNow = closes15[closes15.length - 1], px6 = closes15[closes15.length - 25], pxChg = (pxNow - px6) / px6 * 100;
  let dir = 0, on = false, score = 0, ev: string;
  if (oiChg > cfg.oiOn && Math.abs(pxChg) < cfg.oiPxGate) {
    on = true; dir = 0; score = csRamp(oiChg, cfg.oiOn, cfg.oiFull);
    ev = `OI +${oiChg.toFixed(1)}% em 6h com preço ${pxChg >= 0 ? '+' : ''}${pxChg.toFixed(2)}% → combustível bidirecional.`;
  } else if (oiChg < -cfg.oiOn) {
    on = true; dir = pxChg > 0 ? -1 : 1; score = csRamp(Math.abs(oiChg), cfg.oiOn, cfg.oiFull);
    ev = `OI ${oiChg.toFixed(1)}% em 6h = flush. Movimento ${pxChg >= 0 ? '+' : ''}${pxChg.toFixed(2)}% → fade ${dir < 0 ? 'SHORT' : 'LONG'}.`;
  } else {
    ev = `OI ${oiChg >= 0 ? '+' : ''}${oiChg.toFixed(1)}% · preço ${pxChg >= 0 ? '+' : ''}${pxChg.toFixed(2)}%. Sem divergência.`;
  }
  return { score, dir, ev, on };
}

export function csH3(k: Kline, oi: number[], cfg: CsConfig): Signal {
  const { highs, lows, closes, opens, vols } = k;
  if (closes.length < 25) return { score: 0, dir: 0, ev: 'Sem dados TF15.', on: false };
  const atr = csATR(highs, lows, closes, 14) || 0, i = closes.length - 1;
  const range = highs[i] - lows[i], volAvg = csMean(vols.slice(-21, -1));
  const volMult = volAvg > 0 ? vols[i] / volAvg : 0;
  let oi2h: number | null = null;
  if (oi && oi.length >= 9) { const a = oi[oi.length - 1], b = oi[oi.length - 9]; oi2h = (a - b) / b * 100; }
  const rangeAtr = atr > 0 ? range / atr : 0;
  const on = rangeAtr > cfg.cascadeRangeOn && volMult > cfg.cascadeVolOn && oi2h != null && oi2h < cfg.cascadeOiDrop;
  let dir = 0, score = 0;
  if (on) {
    dir = closes[i] < opens[i] ? 1 : -1;
    score = Math.max(csRamp(rangeAtr, cfg.cascadeRangeOn, cfg.cascadeRangeOn + 2.4),
      csRamp(volMult, cfg.cascadeVolOn, cfg.cascadeVolOn + 3));
  }
  const ev = `Range ${atr > 0 ? (range / atr).toFixed(1) : '—'}×ATR · vol ${volMult.toFixed(1)}× · OI 2h ${oi2h == null ? '—' : (oi2h >= 0 ? '+' : '') + oi2h.toFixed(1) + '%'}. ` +
    (on ? `Proxy de cascata → mean-reversion ${dir > 0 ? 'LONG' : 'SHORT'}.` : 'Sem cascata qualificada.');
  return { score, dir, ev, on };
}

export function csStructure(closes15: number[], cfg: CsConfig): Signal {
  if (closes15.length < 96) return { score: 0, dir: 0, ev: 'Sem range 24h.', on: false };
  const w = closes15.slice(-96), hi = Math.max(...w), lo = Math.min(...w), px = closes15[closes15.length - 1];
  const pos = hi > lo ? (px - lo) / (hi - lo) * 100 : 50;
  const k = cfg.structOn;
  let dir = 0, on = false, score = 0;
  if (pos <= k) { dir = 1; on = true; score = 20 + (k - pos) / k * 80; }
  else if (pos >= 100 - k) { dir = -1; on = true; score = 20 + (pos - (100 - k)) / k * 80; }
  score = Math.max(0, Math.min(100, score));
  const ev = `Preço a ${pos.toFixed(0)}% do range 24h. ` + (on ? (dir > 0 ? 'Perto do fundo → LONG.' : 'Perto do topo → SHORT.') : 'Meio do range.');
  return { score, dir, ev, on };
}

export function csThrust(k: Kline, cfg: CsConfig): Signal {
  const { opens, closes, vols } = k, n = closes.length;
  if (n < 25) return { score: 0, dir: 0, ev: 'Sem dados p/ thrust.', on: false };
  const i = n - 1, volAvg = csMean(vols.slice(-21, -1)), volMult = volAvg > 0 ? vols[i] / volAvg : 0;
  const body = closes[i] - opens[i], mom3 = closes[i - 3] ? (closes[i] - closes[i - 3]) / closes[i - 3] * 100 : 0;
  const up = body > 0 && mom3 > 0, dn = body < 0 && mom3 < 0;
  let dir = 0, on = false;
  if ((up || dn) && volMult > cfg.thrustVolOn) { dir = up ? 1 : -1; on = true; }
  const score = on ? Math.max(csRamp(volMult, cfg.thrustVolOn, cfg.thrustVolOn + 3),
    csRamp(Math.abs(mom3), cfg.thrustMomOn, cfg.thrustMomOn + 3)) : 0;
  const ev = `Vela ${body >= 0 ? 'verde' : 'vermelha'} · vol ${volMult.toFixed(1)}× · momentum 3v ${mom3 >= 0 ? '+' : ''}${mom3.toFixed(2)}%. ` +
    (on ? `Impulso ${dir > 0 ? 'LONG' : 'SHORT'} com volume.` : 'Sem impulso qualificado.');
  return { score, dir, ev, on };
}

export function csBreakout(k: Kline, cfg: CsConfig): Signal {
  const { highs, lows, closes } = k, n = closes.length, N = cfg.breakoutBars;
  if (n < N + 2) return { score: 0, dir: 0, ev: 'Sem range p/ breakout.', on: false };
  const px = closes[n - 1];
  const priorHi = Math.max(...highs.slice(n - N - 1, n - 1)), priorLo = Math.min(...lows.slice(n - N - 1, n - 1));
  const atr = csATR(highs, lows, closes, 14) || px * 0.005;
  let dir = 0, on = false, mag = 0;
  if (px > priorHi) { dir = 1; on = true; mag = atr > 0 ? (px - priorHi) / atr : 0; }
  else if (px < priorLo) { dir = -1; on = true; mag = atr > 0 ? (priorLo - px) / atr : 0; }
  const score = on ? csRamp(mag, cfg.breakoutOn, cfg.breakoutFull) : 0;
  const ev = `Range ${N}v. ` + (on ? `Rompimento ${dir > 0 ? 'LONG' : 'SHORT'} (${mag.toFixed(2)} ATR além).` : 'Dentro do range.');
  return { score, dir, ev, on };
}

// H4 — Regime (TF 1h): trending / ranging / squeeze.
export function csRegime(k60: Kline, cfg: CsConfig): Regime {
  const { highs, lows, closes } = k60;
  if (closes.length < 50) return { type: 'ranging', ev: 'Dados 1h insuficientes.', adx: null, bbPct: null };
  const adx = csADX(highs, lows, closes, 14), bb = csBBWidthPct(closes, 20);
  const sma20 = csSMA(closes, 20) || 0, px = closes[closes.length - 1];
  let type: string;
  if (bb && bb.pct < cfg.bbSqueezePct) type = 'squeeze';
  else if (adx != null && adx >= cfg.adxTrend) type = px >= sma20 ? 'trend_up' : 'trend_down';
  else type = 'ranging';
  return { type, ev: `ADX ${adx == null ? '—' : adx.toFixed(0)} · BB p${bb ? Math.round(bb.pct) : '—'} →`, adx, bbPct: bb ? bb.pct : null };
}

// Fit de regime (0-100). O multiplicador de recalibração (cfg.regimeFitMult)
// escala o resultado por tipo de regime, favorecendo contra-tendência/range.
export function csRegimeFit(regime: Regime, dir: number, mrOn: boolean, cfg: CsConfig): number {
  let base: number;
  switch (regime.type) {
    case 'squeeze': base = 25; break;
    case 'ranging': base = mrOn ? 80 : 55; break;
    case 'trend_up': base = dir > 0 ? 85 : dir < 0 ? 30 : 50; break;
    case 'trend_down': base = dir < 0 ? 85 : dir > 0 ? 30 : 50; break;
    default: base = 50;
  }
  const mult = cfg.regimeFitMult?.[regime.type] ?? 1;
  return Math.max(0, Math.min(100, base * mult));
}

// ─────────────────────────────────────────────────────────────────────────
//  Scoring composto (determinístico)
// ─────────────────────────────────────────────────────────────────────────
export interface Sigs { h1: Signal; h2: Signal; h3: Signal; thrust: Signal; brk: Signal; st: Signal; regime: Regime; }

export function csComposite(sigs: Sigs, regime: Regime, cfg: CsConfig): { finalDir: number; score: number; fit: number } {
  const W = cfg.weights;
  const parts = [
    { k: 'funding', ...sigs.h1, w: W.funding },
    { k: 'oi', ...sigs.h2, w: W.oi },
    { k: 'cascade', ...sigs.h3, w: W.cascade },
    { k: 'thrust', ...sigs.thrust, w: W.thrust },
    { k: 'breakout', ...sigs.brk, w: W.breakout },
    { k: 'structure', ...sigs.st, w: W.structure },
  ];
  let vote = 0;
  for (const p of parts) vote += p.dir * p.score * p.w;
  const finalDir = vote > 0 ? 1 : vote < 0 ? -1 : 0;
  let score = 0;
  for (const p of parts) {
    const contrib = p.score * p.w / 100;
    if (p.dir === 0) score += contrib * 0.5;
    else if (p.dir === finalDir) score += contrib;
    else score -= contrib * 0.7;
  }
  const mrOn = sigs.h3.dir !== 0 || sigs.st.dir !== 0;
  const fit = csRegimeFit(regime, finalDir, mrOn, cfg);
  score += fit * W.regime / 100;
  return { finalDir, score: Math.max(0, score), fit };
}

// ─────────────────────────────────────────────────────────────────────────
//  Trade plan + risk engine
// ─────────────────────────────────────────────────────────────────────────
export interface TradePlan {
  entry: number; zLo: number; zHi: number; stop: number; riskStop: number; techStop: number;
  stopDist: number; stopPct: number;
  tps: { price: number; rTarget: number; r: number; close: number; pct: number; clamped: boolean }[];
  blendedRR: number; rejected: boolean; rejectedCost: boolean; rejectedRR: boolean;
  riskUsd: number; qty: number; notional: number; lev: number; capped: boolean;
  pWinBE: number; riskPct: number; levTarget: number;
}

export function csTradePlan(
  entry: number, atr: number, dir: number, capital: number,
  k15: { closes: number[]; highs: number[]; lows: number[] } | null,
  leverage: number, regimeType: string, cfg: CsConfig,
): TradePlan | null {
  if (!dir || !atr || !entry) return null;
  const levTarget = (leverage != null ? leverage : cfg.leverage);
  const costRT = cfg.costRT ?? 2 * cfg.costPerSide;
  const closes = (k15 && k15.closes) || [], highs = (k15 && k15.highs) || [], lows = (k15 && k15.lows) || [];
  const riskStopDist = cfg.stopAtr * atr;
  const riskStop = dir > 0 ? entry - riskStopDist : entry + riskStopDist;
  const buf = 0.15 * atr;
  let techStop: number;
  if (dir > 0) techStop = (lows.length ? Math.min(...lows.slice(-20)) : riskStop) - buf;
  else techStop = (highs.length ? Math.max(...highs.slice(-20)) : riskStop) + buf;
  const maxDist = cfg.stopAtrMax * atr;
  const stopDist = Math.min(maxDist, Math.max(riskStopDist, Math.abs(entry - techStop)));
  const stop = dir > 0 ? entry - stopDist : entry + stopDist;
  const stopPct = stopDist / entry * 100;
  const w = closes.slice(-96), hi = w.length ? Math.max(...w) : entry * 2, lo = w.length ? Math.min(...w) : entry / 2;
  const range = Math.max(hi - lo, entry * 1e-4);
  const trendAligned = (regimeType === 'trend_up' && dir > 0) || (regimeType === 'trend_down' && dir < 0);
  const mult = trendAligned ? 1.5 : 1.0;
  const reachUp = Math.max(hi, entry + mult * range);
  const reachDn = Math.min(lo, entry - mult * range);
  const tps = cfg.tp.map(t => {
    let px = dir > 0 ? entry + t.r * stopDist : entry - t.r * stopDist, clamped = false;
    if (dir > 0 && px > reachUp) { px = reachUp; clamped = true; }
    if (dir < 0 && px < reachDn) { px = reachDn; clamped = true; }
    const r = Math.abs(px - entry) / stopDist;
    return { price: px, rTarget: t.r, r, close: t.close, pct: Math.abs(px - entry) / entry * 100, clamped };
  });
  const wSum = tps.reduce((s, t) => s + t.close, 0) || 1;
  const blendedRR = tps.reduce((s, t) => s + t.r * t.close, 0) / wSum;
  const rejectedCost = tps[0].pct <= 2 * costRT;
  const rejectedRR = blendedRR < cfg.minRR;
  const rejected = rejectedCost || rejectedRR;
  const lev = Math.max(1, Math.min(cfg.maxLev, levTarget || 1));
  const capped = (levTarget || 0) > cfg.maxLev;
  const notional = lev * capital;
  const qty = notional / entry;
  const riskUsd = qty * stopDist;
  const riskPct = capital > 0 ? riskUsd / capital * 100 : 0;
  const costsInR = costRT / stopPct;
  const pWinBE = (1 + costsInR) / (1 + blendedRR);
  return {
    entry, zLo: entry - buf, zHi: entry + buf, stop, riskStop, techStop, stopDist, stopPct,
    tps, blendedRR, rejected, rejectedCost, rejectedRR, riskUsd, qty, notional, lev, capped, pWinBE, riskPct, levTarget,
  };
}

// ─────────────────────────────────────────────────────────────────────────
//  Sentimento de posicionamento (L/S ratio + funding + OI)
// ─────────────────────────────────────────────────────────────────────────
export interface Sentiment { longPct: number | null; shortPct?: number; dLong?: number; tone: string; align: number; text: string; }

export function csSentiment(lsr: LSR[], funding: number, oiChg: number | null, dir: number): Sentiment {
  if (!lsr || !lsr.length) return { longPct: null, tone: 'na', align: 0, text: 'Posicionamento (L/S ratio) indisponível.' };
  const last = lsr[lsr.length - 1], longPct = last.buy * 100, shortPct = last.sell * 100;
  const prev = lsr.length >= 7 ? lsr[lsr.length - 7] : lsr[0];
  const dLong = (last.buy - prev.buy) * 100;
  let tone = 'neutral';
  if (longPct >= 60) tone = 'crowded-long';
  else if (longPct <= 40) tone = 'crowded-short';
  let align = 0;
  if (tone === 'crowded-long') align = dir < 0 ? 1 : dir > 0 ? -1 : 0;
  else if (tone === 'crowded-short') align = dir > 0 ? 1 : dir < 0 ? -1 : 0;
  const fundTxt = funding >= 0 ? `longs pagam +${funding.toFixed(4)}%/8h` : `shorts pagam ${funding.toFixed(4)}%/8h`;
  const oiTxt = oiChg == null ? '' : ` · OI 6h ${oiChg >= 0 ? '+' : ''}${oiChg.toFixed(1)}%`;
  const text = `Contas Bybit ${longPct.toFixed(0)}% long / ${shortPct.toFixed(0)}% short (${dLong >= 0 ? '+' : ''}${dLong.toFixed(1)}pp em 6h) · ${fundTxt}${oiTxt}.`;
  return { longPct, shortPct, dLong, tone, align, text };
}

export function csConfidence(score: number, plan: TradePlan | null, sentiment: Sentiment | null, nConfl: number): number {
  let c = score / 10;
  if (plan) {
    if (plan.rejected) c -= 3;
    else if (plan.blendedRR >= 2.4) c += 0.6;
    else if (plan.blendedRR >= 2.0) c += 0.3;
    if (plan.capped) c -= 0.3;
  } else c -= 3;
  if (nConfl >= 3) c += 0.6; else if (nConfl <= 1) c -= 0.5;
  if (sentiment) { if (sentiment.align > 0) c += 0.5; else if (sentiment.align < 0) c -= 0.7; }
  return Math.max(1, Math.min(10, c));
}

export function csSetupType(sigs: Sigs, dir: number): string {
  const s = sigs;
  if (s.h3.on) return 'Cascade Fade · Reversal';
  if (s.brk && s.brk.on) return 'Breakout · Continuation';
  if (s.thrust && s.thrust.on) return 'Volume Thrust · Momentum';
  if (s.h1.on) return 'Funding Squeeze · Reversal';
  if (s.h2.on && s.h2.dir !== 0) return 'OI Flush · Fade';
  const reg = s.regime.type;
  if (reg === 'squeeze') return 'Squeeze · pré-breakout';
  if ((reg === 'trend_up' && dir > 0) || (reg === 'trend_down' && dir < 0)) return 'Trend Continuation';
  if (s.st.on) return 'Range Reversal';
  return dir > 0 ? 'Long tático' : 'Short tático';
}

// ─────────────────────────────────────────────────────────────────────────
//  Avaliação de um candidato (junta sinais → score → plano → confiança)
// ─────────────────────────────────────────────────────────────────────────
export interface Candidate {
  symbol: string; coin: string; price: number; chg24: number; fr: number; turnover: number; lowLiq: boolean;
  atr?: number; dir?: number; score?: number; fit?: number; sigs?: Sigs; plan?: TradePlan | null;
  sentiment?: Sentiment; oiChg6h?: number | null; nConfl?: number; confidence?: number; err?: boolean;
}

export function evaluateCandidate(
  c: Candidate,
  data: { k15: Kline; k60: Kline; fund: number[]; oi: number[]; lsr: LSR[] },
  cfg: CsConfig,
): Candidate {
  const { k15, k60, fund, oi, lsr } = data;
  c.atr = csATR(k15.highs, k15.lows, k15.closes, 14) || 0;
  const sigs: Sigs = {
    h1: csH1(fund, c.chg24, cfg), h2: csH2(oi, k15.closes, cfg), h3: csH3(k15, oi, cfg),
    st: csStructure(k15.closes, cfg), thrust: csThrust(k15, cfg), brk: csBreakout(k15, cfg),
    regime: csRegime(k60, cfg),
  };
  const regime = sigs.regime;
  const comp = csComposite(sigs, regime, cfg);
  c.sigs = sigs; c.dir = comp.finalDir; c.score = comp.score; c.fit = comp.fit;
  c.oiChg6h = (oi && oi.length >= 25) ? (oi[oi.length - 1] - oi[oi.length - 25]) / oi[oi.length - 25] * 100 : null;
  c.plan = csTradePlan(c.price, c.atr, c.dir, cfg.capital, k15, cfg.leverage, regime.type, cfg);
  c.sentiment = csSentiment(lsr, c.fr, c.oiChg6h, c.dir);
  c.nConfl = [sigs.h1, sigs.h2, sigs.h3, sigs.thrust, sigs.brk, sigs.st].filter(x => x.on).length;
  c.confidence = csConfidence(c.score!, c.plan, c.sentiment, c.nConfl);
  return c;
}

// Passa a fasquia de Sugestão? (mesma regra do browser: isSug)
export function isSuggestion(c: Candidate, cfg: CsConfig): boolean {
  return (c.score ?? 0) >= cfg.scoreThreshold && !!c.plan && !c.plan.rejected && (c.confidence ?? 0) >= cfg.minConfidence;
}

// Chave de dedup — 1 por moeda/lado/hora (espelho de csLogSuggestions).
export function sigKey(symbol: string, dir: number, d = new Date()): string {
  const side = dir > 0 ? 'long' : 'short';
  const hb = '' + d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, '0') +
    String(d.getUTCDate()).padStart(2, '0') + String(d.getUTCHours()).padStart(2, '0');
  return `${symbol}_${side}_${hb}`;
}

export const coinOf = (symbol: string) => symbol.replace(/USDT$/, '').replace(/USDC$/, '');
