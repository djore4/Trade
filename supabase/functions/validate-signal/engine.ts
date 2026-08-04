/*
 * validate-signal / engine.ts
 * ===========================
 * Núcleo PURO (sem dependências Deno): port fiel do harness Python
 * (harness.py + evaluate.py). Testável em Node/Deno. index.ts trata só de
 * I/O (fetch Bybit + Deno.serve). Ver index.ts para a filosofia completa.
 */

// --------------------------------------------------------------------------- //
//  CONFIG — espelha harness.Config / harness.Costs                            //
// --------------------------------------------------------------------------- //

export interface Costs {
  taker_fee: number;      // Bybit taker por lado (0.055%)
  slippage: number;       // por lado, estimativa conservadora
  funding_per_8h: number; // funding médio pró-rateado a 8h (ajusta ao par)
}

export interface Config {
  adx_trend: number;      // acima => tendência
  adx_range: number;      // abaixo => range; entre os dois => no-trade
  atr_period: number;
  stop_atr_mult: number;  // stop = entry ∓ mult*ATR
  reward_R: number;       // target = reward_R * R
  max_hold_bars: number;  // timeout do triple-barrier (em velas)
  risk_per_trade: number;
  equity: number;
  min_conf: number;       // score mínimo para disparar
  costs: Costs;
}

export function defaultConfig(): Config {
  return {
    adx_trend: 25.0,
    adx_range: 20.0,
    atr_period: 14,
    stop_atr_mult: 1.5,
    reward_R: 1.5,
    max_hold_bars: 24,
    risk_per_trade: 0.01,
    equity: 10_000.0,
    min_conf: 0.34,
    costs: { taker_fee: 0.00055, slippage: 0.0002, funding_per_8h: 0.0001 },
  };
}

// --------------------------------------------------------------------------- //
//  Helpers de série (NaN = valor indefinido, tal como o pandas)               //
// --------------------------------------------------------------------------- //

const N = Number.NaN;
const isNum = (x: number) => Number.isFinite(x);

function sma(s: number[], n: number): number[] {
  const out = new Array(s.length).fill(N);
  let sum = 0, cnt = 0;
  for (let i = 0; i < s.length; i++) {
    const v = s[i];
    if (isNum(v)) { sum += v; cnt++; }
    if (i >= n) { const old = s[i - n]; if (isNum(old)) { sum -= old; cnt--; } }
    if (i >= n - 1 && cnt === n) out[i] = sum / n;
  }
  return out;
}

// ewm(span=n, adjust=False): alpha=2/(n+1), seed = primeiro valor (não NaN)
function ema(s: number[], n: number): number[] {
  const out = new Array(s.length).fill(N);
  const alpha = 2 / (n + 1);
  let prev = N;
  for (let i = 0; i < s.length; i++) {
    const v = s[i];
    if (!isNum(v)) { out[i] = prev; continue; }
    prev = isNum(prev) ? prev + alpha * (v - prev) : v;
    out[i] = prev;
  }
  return out;
}

// média de Wilder (RMA): ewm(alpha=1/n, adjust=False)
function wilder(s: number[], n: number): number[] {
  const out = new Array(s.length).fill(N);
  const alpha = 1 / n;
  let prev = N;
  for (let i = 0; i < s.length; i++) {
    const v = s[i];
    if (!isNum(v)) { out[i] = prev; continue; }
    prev = isNum(prev) ? prev + alpha * (v - prev) : v;
    out[i] = prev;
  }
  return out;
}

function rollingMin(s: number[], n: number): number[] {
  const out = new Array(s.length).fill(N);
  for (let i = n - 1; i < s.length; i++) {
    let m = Infinity, ok = true;
    for (let j = i - n + 1; j <= i; j++) { if (!isNum(s[j])) { ok = false; break; } if (s[j] < m) m = s[j]; }
    if (ok) out[i] = m;
  }
  return out;
}

function rollingMax(s: number[], n: number): number[] {
  const out = new Array(s.length).fill(N);
  for (let i = n - 1; i < s.length; i++) {
    let m = -Infinity, ok = true;
    for (let j = i - n + 1; j <= i; j++) { if (!isNum(s[j])) { ok = false; break; } if (s[j] > m) m = s[j]; }
    if (ok) out[i] = m;
  }
  return out;
}

function rollingSum(s: number[], n: number): number[] {
  const out = new Array(s.length).fill(N);
  for (let i = n - 1; i < s.length; i++) {
    let sum = 0, ok = true;
    for (let j = i - n + 1; j <= i; j++) { if (!isNum(s[j])) { ok = false; break; } sum += s[j]; }
    if (ok) out[i] = sum;
  }
  return out;
}

const diff = (s: number[]): number[] => s.map((v, i) => (i === 0 ? N : v - s[i - 1]));
const shift = (s: number[]): number[] => s.map((_, i) => (i === 0 ? N : s[i - 1]));
const sub = (a: number[], b: number[]): number[] => a.map((v, i) => v - b[i]);
const absArr = (a: number[]): number[] => a.map((v) => Math.abs(v));

function wma(s: number[], n: number): number[] {
  const out = new Array(s.length).fill(N);
  const wsum = (n * (n + 1)) / 2;
  for (let i = n - 1; i < s.length; i++) {
    let acc = 0, ok = true;
    for (let k = 0; k < n; k++) { const v = s[i - n + 1 + k]; if (!isNum(v)) { ok = false; break; } acc += v * (k + 1); }
    if (ok) out[i] = acc / wsum;
  }
  return out;
}

function hma(s: number[], n: number): number[] {
  const half = Math.floor(n / 2);
  const w1 = wma(s, half).map((v, i) => 2 * v - wma(s, n)[i]);
  return wma(w1, Math.trunc(Math.sqrt(n)));
}

function vwma(close: number[], vol: number[], n: number): number[] {
  const cv = close.map((c, i) => c * vol[i]);
  const num = rollingSum(cv, n), den = rollingSum(vol, n);
  return num.map((v, i) => v / den[i]);
}

function rsi(close: number[], n = 14): number[] {
  const d = diff(close);
  const up = wilder(d.map((v) => (isNum(v) ? Math.max(v, 0) : v)), n);
  const dn = wilder(d.map((v) => (isNum(v) ? Math.max(-v, 0) : v)), n);
  return up.map((u, i) => {
    const dv = dn[i];
    if (!isNum(u) || !isNum(dv)) return N;
    const rs = dv === 0 ? N : u / dv;
    return isNum(rs) ? 100 - 100 / (1 + rs) : N;
  });
}

function stoch(high: number[], low: number[], close: number[], k = 14, d = 3, smooth = 3): [number[], number[]] {
  const ll = rollingMin(low, k), hh = rollingMax(high, k);
  const raw = close.map((c, i) => {
    const rng = hh[i] - ll[i];
    return rng === 0 ? N : (100 * (c - ll[i])) / rng;
  });
  const kk = sma(raw, smooth);
  return [kk, sma(kk, d)];
}

function stochRsi(close: number[], n = 14, k = 3, d = 3): [number[], number[]] {
  const r = rsi(close, n);
  const ll = rollingMin(r, n), hh = rollingMax(r, n);
  const sr = r.map((v, i) => {
    const rng = hh[i] - ll[i];
    return rng === 0 ? N : (100 * (v - ll[i])) / rng;
  });
  const kk = sma(sr, k);
  return [kk, sma(kk, d)];
}

function williamsR(high: number[], low: number[], close: number[], n = 14): number[] {
  const hh = rollingMax(high, n), ll = rollingMin(low, n);
  return close.map((c, i) => {
    const rng = hh[i] - ll[i];
    return rng === 0 ? N : (-100 * (hh[i] - c)) / rng;
  });
}

function cci(high: number[], low: number[], close: number[], n = 20): number[] {
  const tp = high.map((h, i) => (h + low[i] + close[i]) / 3);
  const ma = sma(tp, n);
  const dev = tp.map((v, i) => Math.abs(v - ma[i]));
  const md = sma(dev, n);
  return tp.map((v, i) => {
    const denom = 0.015 * md[i];
    return denom === 0 ? N : (v - ma[i]) / denom;
  });
}

function adx(high: number[], low: number[], close: number[], n = 14): [number[], number[], number[]] {
  const up = diff(high);
  const dnMove = diff(low).map((v) => -v);
  const plusDm = up.map((u, i) => (isNum(u) && isNum(dnMove[i]) && u > dnMove[i] && u > 0 ? u : 0));
  const minusDm = dnMove.map((dm, i) => (isNum(dm) && isNum(up[i]) && dm > up[i] && dm > 0 ? dm : 0));
  const prevClose = shift(close);
  const tr = high.map((h, i) => {
    const a = h - low[i];
    const b = isNum(prevClose[i]) ? Math.abs(h - prevClose[i]) : N;
    const c = isNum(prevClose[i]) ? Math.abs(low[i] - prevClose[i]) : N;
    return Math.max(a, isNum(b) ? b : -Infinity, isNum(c) ? c : -Infinity);
  });
  const atrW = wilder(tr, n);
  const plusDi = wilder(plusDm, n).map((v, i) => (atrW[i] === 0 ? N : (100 * v) / atrW[i]));
  const minusDi = wilder(minusDm, n).map((v, i) => (atrW[i] === 0 ? N : (100 * v) / atrW[i]));
  const dx = plusDi.map((p, i) => {
    const m = minusDi[i];
    const denom = p + m;
    return denom === 0 ? N : (100 * Math.abs(p - m)) / denom;
  });
  return [wilder(dx, n), plusDi, minusDi];
}

function macd(close: number[], fast = 12, slow = 26, sig = 9): [number[], number[], number[]] {
  const line = sub(ema(close, fast), ema(close, slow));
  const signal = ema(line, sig);
  return [line, signal, sub(line, signal)];
}

const momentum = (close: number[], n = 10): number[] => close.map((v, i) => (i < n ? N : v - close[i - n]));

function awesome(high: number[], low: number[]): number[] {
  const mp = high.map((h, i) => (h + low[i]) / 2);
  return sub(sma(mp, 5), sma(mp, 34));
}

function ultimate(high: number[], low: number[], close: number[], s = 7, m = 14, l = 28): number[] {
  const prev = shift(close);
  const bp = close.map((c, i) => (isNum(prev[i]) ? c - Math.min(low[i], prev[i]) : N));
  const tr = high.map((h, i) => (isNum(prev[i]) ? Math.max(h, prev[i]) - Math.min(low[i], prev[i]) : N));
  const avg = (p: number): number[] => {
    const bpSum = rollingSum(bp, p), trSum = rollingSum(tr, p);
    return bpSum.map((v, i) => (trSum[i] === 0 ? N : v / trSum[i]));
  };
  const a7 = avg(s), a14 = avg(m), a28 = avg(l);
  return a7.map((_, i) => (100 * (4 * a7[i] + 2 * a14[i] + a28[i])) / 7);
}

function bullBearPower(high: number[], low: number[], close: number[], n = 13): number[] {
  const e = ema(close, n);
  return high.map((h, i) => h - e[i] + (low[i] - e[i]));
}

function ichimokuBase(high: number[], low: number[], n = 26): number[] {
  const hh = rollingMax(high, n), ll = rollingMin(low, n);
  return hh.map((v, i) => (v + ll[i]) / 2);
}

function atr(high: number[], low: number[], close: number[], n = 14): number[] {
  const prevClose = shift(close);
  const tr = high.map((h, i) => {
    const a = h - low[i];
    const b = isNum(prevClose[i]) ? Math.abs(h - prevClose[i]) : -Infinity;
    const c = isNum(prevClose[i]) ? Math.abs(low[i] - prevClose[i]) : -Infinity;
    return Math.max(a, b, c);
  });
  return wilder(tr, n);
}

// --------------------------------------------------------------------------- //
//  compute_indicators — mesmo conjunto e ordem do harness.py                  //
// --------------------------------------------------------------------------- //

export interface Bars { ts: number[]; open: number[]; high: number[]; low: number[]; close: number[]; volume: number[]; }
export type Ind = Record<string, number[]>;

export function computeIndicators(b: Bars): Ind {
  const { high: h, low: l, close: c, volume: v } = b;
  const [stochK] = stoch(h, l, c);
  const [srsiK] = stochRsi(c);
  const [mLine, mSig, mHist] = macd(c);
  const [adxV, plusDi, minusDi] = adx(h, l, c);
  return {
    rsi: rsi(c),
    stoch_k: stochK,
    srsi_k: srsiK,
    wr: williamsR(h, l, c),
    cci: cci(h, l, c),
    uo: ultimate(h, l, c),
    ao: awesome(h, l),
    bbp: bullBearPower(h, l, c),
    mom: momentum(c),
    macd: mLine,
    macd_sig: mSig,
    macd_hist: mHist,
    adx: adxV,
    plus_di: plusDi,
    minus_di: minusDi,
    ema50: ema(c, 50),
    ema200: ema(c, 200),
    ichi: ichimokuBase(h, l),
    vwma20: vwma(c, v, 20),
    hma9: hma(c, 9),
    atr: atr(h, l, c),
    close: c.slice(),
  };
}

// dropna(): índices onde TODAS as colunas computadas são finitas (igual ao pandas)
function validRows(ind: Ind, len: number): number[] {
  const keys = Object.keys(ind);
  const rows: number[] = [];
  for (let i = 0; i < len; i++) {
    let ok = true;
    for (const k of keys) { if (!isNum(ind[k][i])) { ok = false; break; } }
    if (ok) rows.push(i);
  }
  return rows;
}

// --------------------------------------------------------------------------- //
//  Motor: regime + score condicionado + sinal (port de generate_signal)       //
// --------------------------------------------------------------------------- //

export type Row = Record<string, number>;

export function regimeOf(row: Row, cfg: Config): string {
  const a = row.adx;
  if (!isNum(a)) return "na";
  if (a >= cfg.adx_trend) return "trend";
  if (a <= cfg.adx_range) return "range";
  return "chop"; // zona morta => no-trade
}

function trendDir(row: Row): number {
  let votes = 0;
  votes += row.close > row.ema50 ? 1 : -1;
  votes += row.ema50 > row.ema200 ? 1 : -1;
  votes += row.macd > row.macd_sig ? 1 : -1;
  votes += row.plus_di > row.minus_di ? 1 : -1;
  if (votes >= 2) return 1;
  if (votes <= -2) return -1;
  return 0;
}

// Família osciladores como UM voto de mean-reversion (evita contar 5x)
function oscMeanrev(row: Row): number {
  let extUp = 0, extDn = 0;
  const bands: [string, number, number][] = [
    ["rsi", 70, 30], ["stoch_k", 80, 20], ["srsi_k", 80, 20], ["cci", 100, -100], ["uo", 70, 30],
  ];
  for (const [k, hi, lo] of bands) {
    const val = row[k];
    if (!isNum(val)) continue;
    if (val >= hi) extUp++;
    else if (val <= lo) extDn++;
  }
  if (isNum(row.wr)) {
    if (row.wr >= -20) extUp++;
    else if (row.wr <= -80) extDn++;
  }
  if (extUp - extDn >= 2) return -1; // overbought => fade (short)
  if (extDn - extUp >= 2) return 1;  // oversold => fade (long)
  return 0;
}

function oscMeanrevStrength(row: Row): number {
  let up = 0, dn = 0;
  const bands: [string, number, number][] = [
    ["rsi", 70, 30], ["stoch_k", 80, 20], ["srsi_k", 80, 20], ["cci", 100, -100], ["uo", 70, 30],
  ];
  for (const [k, hi, lo] of bands) {
    const v = row[k];
    if (!isNum(v)) continue;
    if (v >= hi) up++;
    else if (v <= lo) dn++;
  }
  return Math.abs(up - dn);
}

// Em tendência, osciladores só validam TIMING (pullback), não invertem
function oscTiming(row: Row, direction: number): boolean {
  if (direction > 0) return isNum(row.rsi) ? row.rsi < 70 : true;
  if (direction < 0) return isNum(row.rsi) ? row.rsi > 30 : true;
  return false;
}

export interface Signal {
  direction: string; dir: number; regime: string; confidence: number;
  entry: number; stop: number; target: number; atr: number; size_units: number; rationale: string;
}

export function generateSignal(row: Row, cfg: Config): Signal | null {
  const reg = regimeOf(row, cfg);
  if (reg === "na" || reg === "chop") return null;

  let d: number, conf: number, rationale: string;
  if (reg === "trend") {
    d = trendDir(row);
    if (d === 0 || !oscTiming(row, d)) return null;
    conf = Math.min(1.0, (row.adx - cfg.adx_trend) / 25 + 0.4);
    rationale = "tendência: segue direção estrutural, entrada em não-esticado";
  } else {
    d = oscMeanrev(row);
    if (d === 0) return null;
    conf = Math.min(1.0, 0.4 + 0.15 * oscMeanrevStrength(row));
    rationale = "range: fade de extremo de osciladores para a média";
  }

  if (conf < cfg.min_conf) return null;

  const entry = row.close;
  const a = row.atr;
  if (!isNum(a) || a <= 0) return null;
  const stop = entry - d * cfg.stop_atr_mult * a;
  const target = entry + d * cfg.reward_R * cfg.stop_atr_mult * a;
  const stopDist = Math.abs(entry - stop);
  const size = (cfg.equity * cfg.risk_per_trade) / stopDist;

  return {
    direction: d > 0 ? "long" : "short",
    dir: d,
    regime: reg,
    confidence: round(conf, 3),
    entry: round(entry, 6),
    stop: round(stop, 6),
    target: round(target, 6),
    atr: round(a, 6),
    size_units: round(size, 4),
    rationale,
  };
}

// --------------------------------------------------------------------------- //
//  Triple-barrier líquido de custos (port de evaluate_trade + funding FIX)    //
// --------------------------------------------------------------------------- //

export interface TradeResult { status: string; net_pct: number; realized_R: number; bars: number; }

export function evaluateTrade(b: Bars, i: number, sig: Signal, cfg: Config, barMinutes: number): TradeResult | null {
  if (i + 1 >= b.close.length) return null;
  const d = sig.dir;
  const entry = b.open[i + 1];
  const stop = entry - d * cfg.stop_atr_mult * sig.atr;
  const target = entry + d * cfg.reward_R * cfg.stop_atr_mult * sig.atr;
  const stopDist = Math.abs(entry - stop);

  let outcome = "scratch";
  let exitPx: number | null = null;
  let bars = 0;
  const end = Math.min(i + 1 + cfg.max_hold_bars, b.close.length);
  for (let j = i + 1; j < end; j++) {
    bars = j - i;
    const hi = b.high[j], lo = b.low[j];
    if (d > 0) {
      if (lo <= stop) { outcome = "loss"; exitPx = stop; break; }
      if (hi >= target) { outcome = "win"; exitPx = target; break; }
    } else {
      if (hi >= stop) { outcome = "loss"; exitPx = stop; break; }
      if (lo <= target) { outcome = "win"; exitPx = target; break; }
    }
  }
  if (exitPx === null) exitPx = b.close[end - 1];

  const grossPct = (d * (exitPx - entry)) / entry;
  const c = cfg.costs;
  const perSide = c.taker_fee + c.slippage;
  // FIX (ponto 2): funding pró-rateado pelos MINUTOS REAIS da vela, não bars≈horas.
  // horas_no_trade = bars * barMinutes / 60 ; funding = funding_per_8h * horas/8.
  const hoursHeld = (bars * barMinutes) / 60;
  const funding = c.funding_per_8h * (hoursHeld / 8.0);
  const netPct = grossPct - 2 * perSide - funding;
  const realizedR = stopDist ? (netPct * entry) / stopDist : 0.0;
  return { status: outcome, net_pct: netPct, realized_R: realizedR, bars };
}

// --------------------------------------------------------------------------- //
//  Backtest + estatística honesta (port de backtest / _stats)                 //
// --------------------------------------------------------------------------- //

export interface Trade { ts: number; direction: string; regime: string; confidence: number; status: string; net_pct: number; realized_R: number; bars: number; }

export interface Stats {
  label: string; n: number; win_rate?: number; avg_R?: number; expectancy_R?: number;
  profit_factor?: number; total_return_pct?: number; max_dd_pct?: number; warn?: string;
}

function stats(t: Trade[], label: string): Stats {
  const n = t.length;
  if (n === 0) return { label, n: 0 };
  const wins = t.filter((x) => x.status === "win").length;
  const winRate = wins / n;
  const avgR = t.reduce((s, x) => s + x.realized_R, 0) / n;
  const grossWin = t.filter((x) => x.net_pct > 0).reduce((s, x) => s + x.net_pct, 0);
  const grossLoss = -t.filter((x) => x.net_pct < 0).reduce((s, x) => s + x.net_pct, 0);
  const pf = grossLoss > 0 ? grossWin / grossLoss : Infinity;
  let eq = 1, peak = 1, maxDd = 0;
  for (const x of t) {
    eq *= 1 + x.net_pct;
    if (eq > peak) peak = eq;
    const dd = eq / peak - 1;
    if (dd < maxDd) maxDd = dd;
  }
  return {
    label, n,
    win_rate: round(winRate, 3),
    avg_R: round(avgR, 3),
    expectancy_R: round(avgR, 3),
    profit_factor: Number.isFinite(pf) ? round(pf, 2) : null as unknown as number,
    total_return_pct: round(eq - 1, 4),
    max_dd_pct: round(maxDd, 4),
    warn: n < 30 ? "amostra pequena, não fiável" : "",
  };
}

export interface BacktestOut {
  n: number; msg?: string; cut_date?: string;
  all?: Stats; is?: Stats; oos?: Stats;
}

export function backtest(b: Bars, cfg: Config, barMinutes: number, oosFrac = 0.35): { res: BacktestOut; trades: Trade[] } {
  const ind = computeIndicators(b);
  const rows = validRows(ind, b.close.length);
  const trades: Trade[] = [];
  for (const i of rows) {
    const row: Row = {};
    for (const k of Object.keys(ind)) row[k] = ind[k][i];
    const sig = generateSignal(row, cfg);
    if (!sig) continue;
    const res = evaluateTrade(b, i, sig, cfg, barMinutes);
    if (!res) continue;
    trades.push({ ts: b.ts[i], direction: sig.direction, regime: sig.regime, confidence: sig.confidence, ...res });
  }
  if (trades.length === 0) return { res: { n: 0, msg: "Nenhum sinal disparou com esta config." }, trades: [] };

  trades.sort((a, z) => a.ts - z.ts);
  const split = Math.trunc(b.close.length * (1 - oosFrac));
  const cut = b.ts[split];
  return {
    res: {
      n: trades.length,
      cut_date: new Date(cut).toISOString(),
      all: stats(trades, "TODOS"),
      is: stats(trades.filter((x) => x.ts < cut), "IN-SAMPLE"),
      oos: stats(trades.filter((x) => x.ts >= cut), "OUT-OF-SAMPLE"),
    },
    trades,
  };
}

export function round(x: number, d: number): number {
  const f = 10 ** d;
  return Math.round(x * f) / f;
}

// timeframe -> [interval Bybit, minutos por vela]
export const TF_MAP: Record<string, [string, number]> = {
  "1m": ["1", 1], "3m": ["3", 3], "5m": ["5", 5], "15m": ["15", 15], "30m": ["30", 30],
  "1h": ["60", 60], "2h": ["120", 120], "4h": ["240", 240], "6h": ["360", 360], "12h": ["720", 720],
  "1d": ["D", 1440],
  // aliases numéricos (como o index.html usa: '15', '60')
  "1": ["1", 1], "3": ["3", 3], "5": ["5", 5], "15": ["15", 15], "30": ["30", 30],
  "60": ["60", 60], "120": ["120", 120], "240": ["240", 240], "360": ["360", 360], "720": ["720", 720],
  "D": ["D", 1440],
};
