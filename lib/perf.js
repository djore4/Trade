/*
 * perf.js — cálculo PURO do Asset Manager (sem DOM nem rede). Corre no browser
 * (window.AMP) e em Node (require) — por isso é testável: `node --test tests/`.
 *
 * Conteúdo: retorno real (Modified Dietz encadeado), drawdown, benchmarks rebaseados,
 * beta/volatilidade vs BTC, choque encadeado, carry de funding, estatísticas do
 * diário de trades, exposição cambial e look-through de ETFs.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AMP = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const DAY = 86400000;
  const fin = x => typeof x === 'number' && isFinite(x);

  /* ── 1. retorno real e drawdown ───────────────────────────────────────── */
  // snaps: [{ts(ms), v}] valor total na moeda base; flows: [{ts(ms), amt}] (+ depósito, − levantamento).
  // Cada sub-período entre snapshots usa Modified Dietz (fluxos ponderados pelo tempo em carteira).
  function twr(snaps, flows) {
    const S = (snaps || []).filter(s => fin(s.ts) && fin(s.v)).sort((a, b) => a.ts - b.ts);
    const F = (flows || []).filter(f => fin(f.ts) && fin(f.amt)).sort((a, b) => a.ts - b.ts);
    const series = [], rets = [];
    if (!S.length) return { series, rets, total: null, flowsTotal: 0, gain: null };
    let idx = 100; series.push({ ts: S[0].ts, v: S[0].v, idx });
    let flowsTotal = 0;
    for (let i = 1; i < S.length; i++) {
      const a = S[i - 1], b = S[i], T = b.ts - a.ts;
      const fl = F.filter(f => f.ts > a.ts && f.ts <= b.ts);
      const net = fl.reduce((s, f) => s + f.amt, 0);
      flowsTotal += net;
      const wsum = fl.reduce((s, f) => s + f.amt * (T > 0 ? (b.ts - f.ts) / T : 0), 0);
      const denom = a.v + wsum;
      let r = null;
      if (denom > 0) r = (b.v - a.v - net) / denom;
      if (r != null && isFinite(r) && r > -1) idx *= 1 + r; else r = null;
      rets.push({ ts: b.ts, r });
      series.push({ ts: b.ts, v: b.v, idx });
    }
    const first = S[0], last = S[S.length - 1];
    return { series, rets, total: idx / 100 - 1, flowsTotal, gain: last.v - first.v - flowsTotal };
  }

  function drawdown(series) {
    let peak = -Infinity, peakTs = null, max = 0, mTs = null, mPeakTs = null;
    const dd = [];
    (series || []).forEach(p => {
      if (p.idx > peak) { peak = p.idx; peakTs = p.ts; }
      const d = peak > 0 ? p.idx / peak - 1 : 0;
      dd.push({ ts: p.ts, d });
      if (d < max) { max = d; mTs = p.ts; mPeakTs = peakTs; }
    });
    const cur = dd.length ? dd[dd.length - 1].d : 0;
    return { max, maxTs: mTs, maxPeakTs: mPeakTs, current: cur, series: dd };
  }

  // Volatilidade anualizada dos retornos por sub-período (normaliza pelo intervalo real).
  function annualVol(rets, series) {
    const xs = [];
    for (let i = 0; i < rets.length; i++) {
      const dt = (series[i + 1].ts - series[i].ts) / DAY;
      if (rets[i].r != null && dt > 0) xs.push(rets[i].r / Math.sqrt(dt));
    }
    if (xs.length < 5) return null;
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
    return sd * Math.sqrt(365);
  }

  // candles [{t(s), c}] → série rebaseada a 100 no instante t0 (ms), nos instantes `times` (ms)
  function rebase(candles, times) {
    const C = (candles || []).filter(c => fin(c.t) && fin(c.c)).sort((a, b) => a.t - b.t);
    if (!C.length || !times.length) return [];
    const at = ts => { let lo = 0, hi = C.length - 1, ans = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (C[m].t * 1000 <= ts) { ans = m; lo = m + 1; } else hi = m - 1; } return ans < 0 ? null : C[ans].c; };
    const base = at(times[0]) ?? C[0].c;
    return times.map(ts => { const c = at(ts); return { ts, idx: c == null ? null : c / base * 100 }; });
  }

  /* ── 3. beta / volatilidade / choque encadeado ────────────────────────── */
  const dayKey = t => Math.floor(t / 86400);
  function dailyReturns(candles) {
    const m = new Map();
    (candles || []).forEach(c => { if (fin(c.t) && fin(c.c) && c.c > 0) m.set(dayKey(c.t), c.c); });
    const keys = [...m.keys()].sort((a, b) => a - b), out = new Map();
    for (let i = 1; i < keys.length; i++) if (keys[i] === keys[i - 1] + 1) out.set(keys[i], Math.log(m.get(keys[i]) / m.get(keys[i - 1])));
    return out;
  }
  // beta = cov(a,b)/var(b) sobre dias comuns; sigmaD = desvio-padrão diário do ativo (retorno simples aprox.)
  function betaSigma(assetCandles, benchCandles, minN = 20) {
    const ra = dailyReturns(assetCandles), rb = dailyReturns(benchCandles);
    const xs = [], ys = [];
    ra.forEach((v, k) => { if (rb.has(k)) { xs.push(v); ys.push(rb.get(k)); } });
    const all = [...ra.values()];
    const sd = a => { if (a.length < 2) return null; const m = a.reduce((s, x) => s + x, 0) / a.length; return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
    const sigmaD = sd(all);
    if (xs.length < minN) return { beta: null, corr: null, sigmaD, n: xs.length };
    const mx = xs.reduce((s, x) => s + x, 0) / xs.length, my = ys.reduce((s, x) => s + x, 0) / ys.length;
    let cov = 0, vx = 0, vy = 0;
    for (let i = 0; i < xs.length; i++) { cov += (xs[i] - mx) * (ys[i] - my); vx += (xs[i] - mx) ** 2; vy += (ys[i] - my) ** 2; }
    return { beta: vy > 0 ? cov / vy : null, corr: vx > 0 && vy > 0 ? cov / Math.sqrt(vx * vy) : null, sigmaD, n: xs.length };
  }

  // choque do BTC (em %) → movimento (em %) de cada ativo = beta × choque (limitado a [-99, +500])
  function shockMoves(betas, shockPct) {
    const out = {};
    Object.keys(betas).forEach(id => { const b = betas[id]; if (fin(b)) out[id] = Math.max(-99, Math.min(500, b * shockPct)); });
    return out;
  }
  // que movimento do BTC liquida a posição? (null se beta fraco ou direção impossível)
  function btcMoveToLiquidate(pos, beta) {
    if (!fin(beta) || Math.abs(beta) < 0.15 || !(pos.liq > 0) || !(pos.mark > 0)) return null;
    const assetMove = (pos.liq / pos.mark - 1) * 100;
    const m = assetMove / beta;
    return fin(m) ? m : null;
  }
  // distância à liquidação medida em "dias de volatilidade" (distPct / σ diário em %)
  function liqSigmas(distPct, sigmaD) { return fin(distPct) && fin(sigmaD) && sigmaD > 0 ? distPct / (sigmaD * 100) : null; }

  // funding: rate por intervalo (fração, ex. 0.0001), intervalH horas. Long paga quando rate>0.
  function fundingCarry(positions, info) {
    let total = 0; const per = [];
    positions.forEach(p => {
      const i = info[p.symbol]; if (!i || !fin(i.rate)) return;
      const perDay = (24 / (i.intervalH || 8)) * i.rate * p.notional * (p.long ? -1 : 1);   // + recebe, − paga
      per.push({ symbol: p.symbol, usdDay: perDay, rate: i.rate, intervalH: i.intervalH || 8 });
      total += perDay;
    });
    return { total, per };
  }

  /* ── 2. diário de trades ──────────────────────────────────────────────── */
  // trade: { pnl, fees?, qty, entry, lev, opened(ms), closed(ms), side, symbol, tag? }
  function tradeStats(trades) {
    const T = (trades || []).filter(t => fin(t.pnl));
    const n = T.length;
    if (!n) return { n: 0 };
    const wins = T.filter(t => t.pnl > 0), losses = T.filter(t => t.pnl < 0);
    const sum = a => a.reduce((s, t) => s + t.pnl, 0);
    const gross = sum(wins), loss = -sum(losses);
    const hold = T.filter(t => fin(t.opened) && fin(t.closed) && t.closed >= t.opened).map(t => (t.closed - t.opened) / 60000);
    const sorted = [...T].sort((a, b) => a.closed - b.closed);
    let streak = 0, maxLoss = 0;
    sorted.forEach(t => { if (t.pnl < 0) { streak++; maxLoss = Math.max(maxLoss, streak); } else streak = 0; });
    const fees = T.reduce((s, t) => s + (fin(t.fees) ? t.fees : 0), 0);
    return {
      n, wins: wins.length, losses: losses.length, winRate: wins.length / n,
      total: sum(T), avgWin: wins.length ? gross / wins.length : 0, avgLoss: losses.length ? -loss / losses.length : 0,
      expectancy: sum(T) / n, profitFactor: loss > 0 ? gross / loss : null,
      payoff: wins.length && losses.length ? (gross / wins.length) / (loss / losses.length) : null,
      fees, feesPctOfGross: gross > 0 ? fees / gross : null,
      avgHoldMin: hold.length ? hold.reduce((a, b) => a + b, 0) / hold.length : null,
      maxLosingStreak: maxLoss, best: Math.max(...T.map(t => t.pnl)), worst: Math.min(...T.map(t => t.pnl)),
    };
  }
  function groupStats(trades, keyFn, minN = 1) {
    const g = new Map();
    (trades || []).forEach(t => { const k = keyFn(t); if (k == null) return; if (!g.has(k)) g.set(k, []); g.get(k).push(t); });
    return [...g].map(([k, arr]) => ({ key: k, ...tradeStats(arr) })).filter(r => r.n >= minN).sort((a, b) => b.n - a.n);
  }
  // "tilt": trades abertos pouco depois de uma perda vs. o resto.
  function tiltCheck(trades, windowMin = 30) {
    const S = [...(trades || [])].filter(t => fin(t.pnl) && fin(t.opened) && fin(t.closed)).sort((a, b) => a.opened - b.opened);
    const after = [], rest = [];
    S.forEach((t, i) => {
      const prev = S.slice(0, i).filter(p => p.closed <= t.opened).sort((a, b) => b.closed - a.closed)[0];
      if (prev && prev.pnl < 0 && (t.opened - prev.closed) / 60000 <= windowMin) after.push(t); else rest.push(t);
    });
    const avg = a => a.length ? a.reduce((s, t) => s + t.pnl, 0) / a.length : null;
    return { nAfter: after.length, avgAfter: avg(after), nRest: rest.length, avgRest: avg(rest) };
  }

  /* ── 5. exposição ──────────────────────────────────────────────────────── */
  function fxExposure(holdings) {
    const tot = holdings.reduce((s, h) => s + (h.value > 0 ? h.value : 0), 0);
    const m = new Map();
    holdings.forEach(h => { if (!(h.value > 0)) return; const c = h.ccy || '?'; m.set(c, (m.get(c) || 0) + h.value); });
    return [...m].map(([ccy, value]) => ({ ccy, value, pct: tot ? value / tot * 100 : 0 })).sort((a, b) => b.value - a.value);
  }
  const keyOf = (sym, name) => String(sym || name || '').toUpperCase().replace(/\.[A-Z]{1,3}$/, '').replace(/[^A-Z0-9]/g, '') || String(name || '').toLowerCase();
  // etfMap: { [ticker]: { holdings:[{symbol,name,pct}], coverage? } }; direct: ações diretas [{key?,symbol,name,value}]
  function lookThrough(etfs, direct, total) {
    const m = new Map();
    const add = (k, name, v, via) => { if (!m.has(k)) m.set(k, { key: k, name, direct: 0, viaEtf: 0, from: [] }); const e = m.get(k); if (via) { e.viaEtf += v; e.from.push(via); } else e.direct += v; };
    (direct || []).forEach(d => add(keyOf(d.symbol, d.name), d.name || d.symbol, d.value, null));
    (etfs || []).forEach(e => (e.holdings || []).forEach(h => { if (fin(h.pct) && h.pct > 0) add(keyOf(h.symbol, h.name), h.name || h.symbol, e.value * h.pct / 100, e.label); }));
    return [...m.values()].map(e => ({ ...e, value: e.direct + e.viaEtf, pct: total ? (e.direct + e.viaEtf) / total * 100 : 0, overlap: e.direct > 0 && e.viaEtf > 0 }))
      .sort((a, b) => b.value - a.value);
  }

  // dividendos [{ts, amt, ticker}] → soma 12m + por ticker
  function income(divs, now) {
    const t0 = (now || Date.now()) - 365 * DAY, by = new Map(); let tot = 0;
    (divs || []).forEach(d => { if (d.ts >= t0 && fin(d.amt)) { tot += d.amt; by.set(d.ticker, (by.get(d.ticker) || 0) + d.amt); } });
    return { total12m: tot, by: [...by].map(([ticker, amt]) => ({ ticker, amt })).sort((a, b) => b.amt - a.amt) };
  }

  return { twr, drawdown, annualVol, rebase, betaSigma, shockMoves, btcMoveToLiquidate, liqSigmas, fundingCarry,
    tradeStats, groupStats, tiltCheck, fxExposure, lookThrough, income, keyOf, dailyReturns };
});
