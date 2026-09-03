/*
 * btc-engine.ts — Camada enriquecida do BTC Advisor (FASE 1).
 * ==========================================================================
 * Deriva do CryptoScan: o backbone de momentum/estrutura/regime vem TAL QUAL
 * do cs-engine.ts (mesma matemática que a app mostra). Por cima, adiciona os
 * sinais que só BTC tem com qualidade — posicionamento em opções (Deribit),
 * basis (perp-spot e futuro trimestral) e funding agregado multi-venue — e
 * combina tudo num veredito direcional.
 *
 * IMPORTANTE (honestidade intelectual): estes pesos são HIPÓTESES, não edge
 * provado. O btc-scan regista cada decisão em btc_obs e o btc-settle mede o
 * desfecho OOS. Só depois de amostra é que a app deixa de rotular "não
 * validado". Manter BTC_CFG isolado torna a recalibração reversível e A/B-able,
 * como o CS_RECAL fez para o CryptoScan.
 *
 * Sem I/O: só matemática. Os fetchers (Bybit/Deribit/venues) vivem no btc-scan
 * e no espelho do browser (index.html), 1:1 com este ficheiro.
 */

import {
  type CsConfig, type Kline,
  buildConfig, csATR, csComposite, csSetupType, csTradePlan, csConfidence,
  csH1, csH2, csH3, csStructure, csThrust, csBreakout, csRegime,
  type Sigs,
} from './cs-engine.ts';

// ─────────────────────────────────────────────────────────────────────────
//  Entradas enriquecidas (snapshots recolhidos pelos fetchers)
// ─────────────────────────────────────────────────────────────────────────
export interface OptionLeg { strike: number; iv: number; oi: number; isPut: boolean; expMs: number; }
export interface OptionsSnap {
  index: number;              // preço do índice BTC no momento
  dvol: number | null;        // DVOL atual
  dvolSeries: number[];       // histórico do DVOL (para percentil)
  legs: OptionLeg[];          // resumo por instrumento (mark_iv + OI)
}
export interface FundingVenues { bybit: number | null; binance: number | null; okx: number | null; } // %/8h
export interface BasisSnap { perp: number | null; spot: number | null; fut: number | null; futDays: number | null; }

export interface BtcHorizon { key: 'scalp' | 'intraday' | 'swing'; horizonH: number; stopAtr: number; tpR: number[]; label: string; }

export const BTC_HORIZONS: Record<string, BtcHorizon> = {
  scalp:    { key: 'scalp',    horizonH: 2,  stopAtr: 1.0, tpR: [1.0, 1.8, 3.0], label: 'Scalp (15m · ~2h)' },
  intraday: { key: 'intraday', horizonH: 4,  stopAtr: 1.2, tpR: [1.0, 2.0, 3.5], label: 'Intraday (15m/1h · ~4h)' },
  swing:    { key: 'swing',    horizonH: 72, stopAtr: 2.0, tpR: [1.5, 3.0, 5.0], label: 'Swing (4h/1d · ~3d)' },
};

// ─────────────────────────────────────────────────────────────────────────
//  Config da camada BTC — pesos das HIPÓTESES de posicionamento.
//  Nota de leitura (baseline, a validar): os desfechos do CryptoScan mostraram
//  que em BTC o FADE de extremos de posicionamento > continuação. Por isso os
//  sinais de opções/funding/basis entram como CONTRA-tendência de crowding, com
//  peso modesto, e o DVOL modula tamanho/confiança (não direção).
// ─────────────────────────────────────────────────────────────────────────
export const BTC_CFG = {
  // pesos do voto de posicionamento (somam ~1 depois de normalizar)
  wFunding: 0.35, wBasis: 0.25, wSkew: 0.20, wPutCall: 0.20,
  // gates
  fundingHot: 0.02,     // funding %/8h a partir do qual "quente" (crowding)
  fundingDispHi: 0.015, // dispersão entre venues considerada alta (desacordo)
  basisPerpHot: 0.10,   // prémio perp-spot (%) considerado esticado
  skewHot: 3,           // |skew| (pp) a partir do qual conta
  putCallHi: 1.30, putCallLo: 0.70,
  dvolLowPct: 25, dvolHighPct: 75,
  // quanto o posicionamento pode mexer o score composto e a confiança
  tiltScoreMax: 12,     // pontos de score que o tilt alinhado pode somar/tirar
  tiltFlipMin: 0.55,    // |tilt| mínimo para propor direção quando o base é neutro
};

// ─────────────────────────────────────────────────────────────────────────
//  Derivação dos sinais de opções
// ─────────────────────────────────────────────────────────────────────────
export function pctileOf(series: number[], x: number): number | null {
  if (!series || series.length < 8 || x == null) return null;
  const s = series.filter(v => isFinite(v)).slice().sort((a, b) => a - b);
  if (!s.length) return null;
  return s.filter(v => v <= x).length / s.length * 100;
}

// Escolhe a expiração mais próxima (front) e a seguinte, com pelo menos ~2 dias.
function frontExpiries(legs: OptionLeg[], nowMs: number): { front: number | null; next: number | null } {
  const exps = [...new Set(legs.map(l => l.expMs))].filter(e => e - nowMs > 2 * 864e5).sort((a, b) => a - b);
  return { front: exps[0] ?? null, next: exps[1] ?? null };
}
const atmIv = (legs: OptionLeg[], exp: number, index: number): number | null => {
  const same = legs.filter(l => l.expMs === exp && isFinite(l.iv) && l.iv > 0);
  if (!same.length) return null;
  same.sort((a, b) => Math.abs(a.strike - index) - Math.abs(b.strike - index));
  const near = same.slice(0, 4);
  return near.reduce((s, l) => s + l.iv, 0) / near.length;
};

export interface OptSignals { dvol: number | null; dvolPct: number | null; skew: number | null; term: number | null; putCall: number | null; }

export function btcOptionSignals(o: OptionsSnap | null, nowMs = Date.now()): OptSignals {
  if (!o || !o.legs || !o.legs.length || !o.index) {
    return { dvol: o?.dvol ?? null, dvolPct: null, skew: null, term: null, putCall: null };
  }
  const { front, next } = frontExpiries(o.legs, nowMs);
  // Skew 25Δ (proxy): IV média de puts OTM 5-15% abaixo − IV média de calls OTM 5-15% acima, na front.
  let skew: number | null = null;
  if (front) {
    const putW = o.legs.filter(l => l.expMs === front && l.isPut && l.strike <= o.index * 0.95 && l.strike >= o.index * 0.85 && l.iv > 0);
    const callW = o.legs.filter(l => l.expMs === front && !l.isPut && l.strike >= o.index * 1.05 && l.strike <= o.index * 1.15 && l.iv > 0);
    if (putW.length && callW.length) {
      const pIv = putW.reduce((s, l) => s + l.iv, 0) / putW.length;
      const cIv = callW.reduce((s, l) => s + l.iv, 0) / callW.length;
      skew = pIv - cIv; // pp; >0 = puts mais caras (medo/hedge)
    }
  }
  // Estrutura a prazo: ATM front − ATM next (>0 = backwardation/stress de curto prazo).
  let term: number | null = null;
  if (front && next) {
    const a = atmIv(o.legs, front, o.index), b = atmIv(o.legs, next, o.index);
    if (a != null && b != null) term = a - b;
  }
  // Put/Call por OI (posicionamento agregado).
  const putOi = o.legs.filter(l => l.isPut).reduce((s, l) => s + (l.oi || 0), 0);
  const callOi = o.legs.filter(l => !l.isPut).reduce((s, l) => s + (l.oi || 0), 0);
  const putCall = callOi > 0 ? putOi / callOi : null;
  const dvolPct = (o.dvol != null && o.dvolSeries?.length) ? pctileOf(o.dvolSeries, o.dvol) : null;
  return { dvol: o.dvol ?? null, dvolPct, skew, term, putCall };
}

// ─────────────────────────────────────────────────────────────────────────
//  Sinais de funding multi-venue e basis
// ─────────────────────────────────────────────────────────────────────────
export interface FundingSignals { agg: number | null; disp: number | null; }
export function btcFundingSignals(f: FundingVenues | null): FundingSignals {
  if (!f) return { agg: null, disp: null };
  const vals = [f.bybit, f.binance, f.okx].filter((v): v is number => v != null && isFinite(v));
  if (!vals.length) return { agg: null, disp: null };
  const agg = vals.reduce((a, b) => a + b, 0) / vals.length;
  const disp = vals.length > 1 ? Math.sqrt(vals.reduce((s, v) => s + (v - agg) ** 2, 0) / vals.length) : 0;
  return { agg, disp };
}
export function btcBasisSignals(b: BasisSnap | null): { perp: number | null; fut: number | null } {
  if (!b) return { perp: null, fut: null };
  const perp = (b.perp != null && b.spot != null && b.spot > 0) ? (b.perp - b.spot) / b.spot * 100 : null;
  return { perp, fut: b.fut ?? null };
}

// ─────────────────────────────────────────────────────────────────────────
//  Voto de posicionamento agregado (−1..+1). Convenção: >0 = viés LONG.
//  Todos são FADE de crowding: crowd long (funding/basis quentes, calls caras,
//  put/call baixo) → voto SHORT; crowd short → voto LONG.
// ─────────────────────────────────────────────────────────────────────────
export interface PosTilt { tilt: number; parts: { k: string; v: number; note: string }[]; }
export function btcPositioningTilt(opt: OptSignals, fund: FundingSignals, basis: { perp: number | null; fut: number | null }): PosTilt {
  const c = BTC_CFG, parts: { k: string; v: number; note: string }[] = [];
  const clamp = (x: number) => Math.max(-1, Math.min(1, x));

  // Funding: quente positivo → longs lotados → fade SHORT.
  let vF = 0, nF = 'Funding indisponível.';
  if (fund.agg != null) {
    vF = clamp(-fund.agg / (c.fundingHot * 3));
    nF = `Funding agregado ${fund.agg >= 0 ? '+' : ''}${fund.agg.toFixed(4)}%/8h${fund.disp != null ? ` · dispersão ${fund.disp.toFixed(4)}` : ''} → ${vF < 0 ? 'longs lotados (fade short)' : vF > 0 ? 'shorts lotados (fade long)' : 'neutro'}.`;
  }
  parts.push({ k: 'funding', v: vF, note: nF });

  // Basis perp-spot: prémio alto → alavancagem long → fade SHORT.
  let vB = 0, nB = 'Basis indisponível.';
  if (basis.perp != null) {
    vB = clamp(-basis.perp / (c.basisPerpHot * 3));
    nB = `Basis perp-spot ${basis.perp >= 0 ? '+' : ''}${basis.perp.toFixed(3)}%${basis.fut != null ? ` · fut ${basis.fut >= 0 ? '+' : ''}${basis.fut.toFixed(1)}% a.a.` : ''} → ${vB < 0 ? 'prémio esticado (fade short)' : vB > 0 ? 'desconto (fade long)' : 'neutro'}.`;
  }
  parts.push({ k: 'basis', v: vB, note: nB });

  // Skew: puts muito caras (medo) → contrarian LONG; calls caras (ganância) → SHORT.
  let vS = 0, nS = 'Skew indisponível.';
  if (opt.skew != null) {
    vS = Math.abs(opt.skew) < c.skewHot ? 0 : clamp(opt.skew / (c.skewHot * 4));
    nS = `Skew ${opt.skew >= 0 ? '+' : ''}${opt.skew.toFixed(1)}pp → ${vS > 0 ? 'medo em puts (contrarian long)' : vS < 0 ? 'ganância em calls (contrarian short)' : 'neutro'}.`;
  }
  parts.push({ k: 'skew', v: vS, note: nS });

  // Put/Call OI: extremo alto (muitas puts) → contrarian LONG; extremo baixo → SHORT.
  let vP = 0, nP = 'Put/Call indisponível.';
  if (opt.putCall != null) {
    if (opt.putCall >= c.putCallHi) vP = clamp((opt.putCall - c.putCallHi) / 0.7);
    else if (opt.putCall <= c.putCallLo) vP = -clamp((c.putCallLo - opt.putCall) / 0.5);
    nP = `Put/Call OI ${opt.putCall.toFixed(2)} → ${vP > 0 ? 'excesso de puts (contrarian long)' : vP < 0 ? 'excesso de calls (contrarian short)' : 'neutro'}.`;
  }
  parts.push({ k: 'putcall', v: vP, note: nP });

  const wsum = c.wFunding + c.wBasis + c.wSkew + c.wPutCall;
  const tilt = clamp((vF * c.wFunding + vB * c.wBasis + vS * c.wSkew + vP * c.wPutCall) / wsum);
  return { tilt, parts };
}

// ─────────────────────────────────────────────────────────────────────────
//  Regime de volatilidade (DVOL) — modula tamanho e confiança, NÃO direção.
// ─────────────────────────────────────────────────────────────────────────
export function btcVolRegime(opt: OptSignals): { state: string; sizeMult: number; note: string } {
  const c = BTC_CFG;
  if (opt.dvolPct == null) return { state: 'na', sizeMult: 1, note: 'DVOL indisponível.' };
  if (opt.dvolPct <= c.dvolLowPct) return { state: 'comprimido', sizeMult: 1.1, note: `DVOL p${Math.round(opt.dvolPct)} (baixo) → compressão; expansão provável, favorece continuação.` };
  if (opt.dvolPct >= c.dvolHighPct) return { state: 'esticado', sizeMult: 0.7, note: `DVOL p${Math.round(opt.dvolPct)} (alto) → medo/capitulação; reduzir tamanho, favorece reversão.` };
  return { state: 'normal', sizeMult: 1, note: `DVOL p${Math.round(opt.dvolPct)} (normal).` };
}

// ─────────────────────────────────────────────────────────────────────────
//  Decisão final: backbone (Bybit) + posicionamento (BTC) → direção/score/plano
// ─────────────────────────────────────────────────────────────────────────
export interface BtcDecision {
  horizon: string; dir: number; score: number; confidence: number; setup: string;
  baseDir: number; baseScore: number; regime: string; adx: number | null;
  opt: OptSignals; funding: FundingSignals; basis: { perp: number | null; fut: number | null };
  posTilt: PosTilt; vol: { state: string; sizeMult: number; note: string };
  plan: ReturnType<typeof csTradePlan>;
  price: number; atr: number;
}

export function btcDecide(
  data: { k15: Kline; k60: Kline; fund: number[]; oi: number[]; lsr: { buy: number; sell: number }[] },
  enriched: { options: OptionsSnap | null; venues: FundingVenues | null; basis: BasisSnap | null },
  horizonKey: 'scalp' | 'intraday' | 'swing',
  capital: number, leverage: number,
  nowMs = Date.now(),
): BtcDecision {
  const H = BTC_HORIZONS[horizonKey];
  // Baseline (sem recalibração): o CS_RECAL foi afinado nos desfechos de
  // altcoins do CryptoScan; aplicá-lo a BTC-only não está justificado e
  // divergiria do espelho do browser. Mantém-se A/B-able via BTC_CFG.
  const cfg: CsConfig = buildConfig({ recalibrate: false, capital, leverage });
  cfg.stopAtr = H.stopAtr;
  cfg.tp = H.tpR.map((r, i) => ({ r, close: i === 0 ? 0.4 : i === 1 ? 0.35 : 0.25 }));

  const { k15, k60, fund, oi, lsr } = data;
  const chg24 = k60.closes.length >= 25 ? (k60.closes[k60.closes.length - 1] - k60.closes[k60.closes.length - 25]) / k60.closes[k60.closes.length - 25] * 100 : 0;
  const sigs: Sigs = {
    h1: csH1(fund, chg24, cfg), h2: csH2(oi, k15.closes, cfg), h3: csH3(k15, oi, cfg),
    st: csStructure(k15.closes, cfg), thrust: csThrust(k15, cfg), brk: csBreakout(k15, cfg),
    regime: csRegime(k60, cfg),
  };
  const comp = csComposite(sigs, sigs.regime, cfg);
  const baseDir = comp.finalDir, baseScore = comp.score;

  const opt = btcOptionSignals(enriched.options, nowMs);
  const funding = btcFundingSignals(enriched.venues);
  const basis = btcBasisSignals(enriched.basis);
  const posTilt = btcPositioningTilt(opt, funding, basis);
  const vol = btcVolRegime(opt);

  // Combinação: o posicionamento confirma/veta o backbone; quando o backbone é
  // neutro mas o posicionamento é forte, propõe fade (contra-crowding).
  let dir = baseDir, score = baseScore;
  const t = posTilt.tilt;
  if (baseDir !== 0) {
    const agree = Math.sign(t) === Math.sign(baseDir);
    score += (agree ? 1 : -1) * Math.abs(t) * BTC_CFG.tiltScoreMax;
    if (!agree && Math.abs(t) >= BTC_CFG.tiltFlipMin && baseScore < cfg.scoreThreshold) dir = 0; // veto: crowding forte contra sinal fraco
  } else if (Math.abs(t) >= BTC_CFG.tiltFlipMin) {
    dir = t > 0 ? 1 : -1;
    score = Math.abs(t) * BTC_CFG.tiltScoreMax;
  }
  score = Math.max(0, score);

  const atr = csATR(k15.highs, k15.lows, k15.closes, 14) || 0;
  const price = k15.closes[k15.closes.length - 1];
  const plan = dir !== 0 ? csTradePlan(price, atr, dir, cfg.capital, k15, cfg.leverage, sigs.regime.type, cfg) : null;

  // Confiança: base do CryptoScan + ajuste por concordância, dispersão e vol.
  const nConfl = [sigs.h1, sigs.h2, sigs.h3, sigs.thrust, sigs.brk, sigs.st].filter(x => x.on).length;
  let confidence = csConfidence(score, plan, null, nConfl);
  if (dir !== 0 && Math.sign(t) === dir) confidence += 0.6; else if (dir !== 0 && t !== 0) confidence -= 0.5;
  if (funding.disp != null && funding.disp >= BTC_CFG.fundingDispHi) confidence -= 0.4; // venues discordam
  confidence += (vol.sizeMult - 1) * 2; // comprimido +, esticado −
  confidence = Math.max(1, Math.min(10, confidence));

  const setup = dir !== 0 ? csSetupType(sigs, dir) : (Math.abs(t) >= 0.3 ? 'Posicionamento (fade)' : 'Sem sinal');

  return {
    horizon: horizonKey, dir, score, confidence, setup,
    baseDir, baseScore, regime: sigs.regime.type, adx: sigs.regime.adx,
    opt, funding, basis, posTilt, vol, plan, price, atr,
  };
}
