// Verbatim copy of the scoring functions from index.html (lines ~1778-1889).
// Used ONLY by test_parity.py to prove the Python port in factors.py matches
// the live JS. If index.html's engine changes, update this file and re-run the
// parity test. Do not edit the logic here to "fix" a mismatch — fix the port.

const trdClamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function trdEma(vals, period) {
  if (!vals || vals.length < period) return null;
  const k = 2 / (period + 1);
  let e = vals.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < vals.length; i++) e = vals[i] * k + e * (1 - k);
  return e;
}

function trdRsi(vals, period = 14) {
  if (!vals || vals.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = vals[i] - vals[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let ag = gain / period, al = loss / period;
  for (let i = period + 1; i < vals.length; i++) {
    const d = vals[i] - vals[i - 1];
    ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (al === 0) return 100;
  const rs = ag / al;
  return 100 - 100 / (1 + rs);
}

function trdFMomLong(chg) {
  if (chg <= 0) return trdClamp(50 + chg * 3, 5, 50);
  if (chg <= 6) return trdClamp(50 + chg * 7, 50, 92);
  return trdClamp(92 - (chg - 6) * 2.5, 45, 92);
}
function trdFRsiLong(rsi) {
  if (rsi == null) return 50;
  if (rsi < 30) return 62;
  if (rsi < 45) return 56;
  if (rsi <= 65) return trdClamp(70 + (rsi - 45), 70, 90);
  if (rsi <= 75) return 58;
  return trdClamp(45 - (rsi - 75) * 2, 15, 45);
}
function trdFFundLong(fr) {
  return trdClamp(50 - fr * 500, 8, 88);
}
function trdFVol(turn) {
  if (!turn || turn <= 0) return 0;
  return trdClamp((Math.log10(turn) - 6) / 3 * 100, 0, 100);
}
function trdBreakout(c, side) {
  if (c.hi == null || c.lo == null || !c.price) return 50;
  if (side === 'short') {
    const d = (c.price - c.lo) / c.price * 100;
    return trdClamp(92 - d * 9, 10, 95);
  }
  const d = (c.hi - c.price) / c.price * 100;
  return trdClamp(92 - d * 9, 10, 95);
}
function trdOiFactor(c, side) {
  if (c.oiChg == null) return 50;
  const up = c.chg > 0, oiUp = c.oiChg > 0;
  if (side === 'short') {
    if (!up && oiUp) return trdClamp(62 + c.oiChg * 2, 62, 95);
    if (!up && !oiUp) return trdClamp(52 + c.oiChg * 0.5, 42, 60);
    if (up && oiUp)  return trdClamp(40 - c.oiChg, 12, 42);
    return 46;
  }
  if (up && oiUp)  return trdClamp(62 + c.oiChg * 2, 62, 95);
  if (up && !oiUp) return trdClamp(52 + c.oiChg * 0.5, 42, 60);
  if (!up && oiUp) return trdClamp(40 - c.oiChg, 12, 42);
  return 46;
}

const TRD_W = { mom: 0.15, trend: 0.17, rsi: 0.12, fund: 0.12, vol: 0.11, brk: 0.16, oi: 0.17 };

function trdTrend(c, side) {
  if (c.ef == null || c.es == null || !c.es) return 50;
  const a = (c.price - c.ef) / c.es * 100, b = (c.ef - c.es) / c.es * 100;
  const bull = trdClamp(50 + a * 8 + b * 12, 0, 100);
  return side === 'short' ? 100 - bull : bull;
}

function trdScore(c, side) {
  const mom   = side === 'short' ? trdFMomLong(-c.chg) : trdFMomLong(c.chg);
  const trend = trdTrend(c, side);
  const rsi   = side === 'short' ? trdFRsiLong(c.rsi == null ? null : 100 - c.rsi) : trdFRsiLong(c.rsi);
  const fund  = side === 'short' ? trdClamp(50 + c.fr * 500, 8, 88) : trdFFundLong(c.fr);
  const vol   = trdFVol(c.turnover);
  const brk   = trdBreakout(c, side);
  const oi    = trdOiFactor(c, side);
  let final = mom * TRD_W.mom + trend * TRD_W.trend + rsi * TRD_W.rsi + fund * TRD_W.fund
            + vol * TRD_W.vol + brk * TRD_W.brk + oi * TRD_W.oi;
  if (c.volSpike >= 1.8) final += trdClamp((c.volSpike - 1.8) * 4, 0, 8);
  return { final: Math.round(trdClamp(final, 0, 100)), mom, trend, rsi, fund, vol, brk, oi };
}

// Read test cases from stdin (JSON array of {c, side}) and emit results.
let input = '';
process.stdin.on('data', d => input += d);
process.stdin.on('end', () => {
  const cases = JSON.parse(input);
  const out = cases.map(({ c, side }) => {
    const s = trdScore(c, side);
    return {
      score: s,
      ema9: trdEma(c._closes || [], 9),
      ema21: trdEma(c._closes || [], 21),
      rsi14: trdRsi(c._closes || [], 14),
    };
  });
  process.stdout.write(JSON.stringify(out));
});
