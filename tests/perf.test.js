const test = require('node:test'), assert = require('node:assert/strict');
const P = require('../lib/perf.js');
const D = 86400000, close = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) < e, `${a} ≉ ${b}`);

test('twr: sem fluxos = retorno simples', () => {
  const r = P.twr([{ ts: 0, v: 100 }, { ts: D, v: 110 }, { ts: 2 * D, v: 99 }], []);
  close(r.total, -0.01); close(r.gain, -1);
});
test('twr: depósito não conta como performance', () => {
  // 100 → deposita 100 → 200 (0% de retorno) → 220 (+10%)
  const r = P.twr([{ ts: 0, v: 100 }, { ts: D, v: 200 }, { ts: 2 * D, v: 220 }], [{ ts: D, amt: 100 }]);
  close(r.total, 0.10, 1e-9); close(r.gain, 20);
});
test('twr: levantamento a meio do período (Modified Dietz)', () => {
  const r = P.twr([{ ts: 0, v: 1000 }, { ts: 10 * D, v: 600 }], [{ ts: 5 * D, amt: -500 }]);
  // ganho = 600-1000+500 = 100 ; base = 1000 + (-500*0.5) = 750
  close(r.total, 100 / 750, 1e-9);
});
test('twr: ignora snapshots inválidos e base nula', () => {
  const r = P.twr([{ ts: 0, v: 0 }, { ts: D, v: 10 }, { ts: 2 * D, v: NaN }], []);
  assert.equal(r.series.length, 2); assert.equal(r.rets[0].r, null);
});
test('drawdown', () => {
  const dd = P.drawdown([{ ts: 1, idx: 100 }, { ts: 2, idx: 120 }, { ts: 3, idx: 90 }, { ts: 4, idx: 105 }]);
  close(dd.max, 90 / 120 - 1); assert.equal(dd.maxTs, 3); assert.equal(dd.maxPeakTs, 2); close(dd.current, 105 / 120 - 1);
});
test('rebase benchmark', () => {
  const c = [{ t: 0, c: 10 }, { t: 86400, c: 15 }, { t: 172800, c: 20 }];
  const r = P.rebase(c, [0, D, 2 * D, 3 * D]);
  assert.deepEqual(r.map(x => x.idx), [100, 150, 200, 200]);
});
const mk = (rets, p0 = 100) => { let p = p0; return rets.map((r, i) => { p *= Math.exp(r); return { t: (i + 1) * 86400, c: p }; }).reduce((a, c) => a.concat(c), [{ t: 0, c: p0 }]); };
test('beta: ativo = 2× BTC ⇒ beta≈2, corr≈1', () => {
  const rb = Array.from({ length: 60 }, (_, i) => Math.sin(i) * 0.02);
  const r = P.betaSigma(mk(rb.map(x => 2 * x)), mk(rb));
  close(r.beta, 2, 1e-6); close(r.corr, 1, 1e-6);
});
test('beta: poucos dados ⇒ null', () => {
  assert.equal(P.betaSigma(mk([0.01, 0.02]), mk([0.01, 0.02])).beta, null);
});
test('choque encadeado e liquidação via BTC', () => {
  assert.deepEqual(P.shockMoves({ a: 1.5, b: 0.5, c: null }, -10), { a: -15, b: -5 });
  assert.equal(P.shockMoves({ a: 50 }, -10).a, -99);
  // long com liq 30% abaixo do mark, beta 1.5 ⇒ BTC −20%
  close(P.btcMoveToLiquidate({ liq: 70, mark: 100 }, 1.5), -20);
  // short com liq 40% acima, beta 2 ⇒ BTC +20%
  close(P.btcMoveToLiquidate({ liq: 140, mark: 100 }, 2), 20);
  assert.equal(P.btcMoveToLiquidate({ liq: 70, mark: 100 }, 0.05), null);
  close(P.liqSigmas(15, 0.05), 3);
});
test('funding carry: long paga, short recebe', () => {
  const r = P.fundingCarry([{ symbol: 'A', notional: 1000, long: true }, { symbol: 'B', notional: 1000, long: false }, { symbol: 'C', notional: 5, long: true }],
    { A: { rate: 0.0001, intervalH: 8 }, B: { rate: 0.0001, intervalH: 4 } });
  close(r.per[0].usdDay, -0.3); close(r.per[1].usdDay, 0.6); close(r.total, 0.3); assert.equal(r.per.length, 2);
});
const H = 3600000, t = (pnl, o, c, extra = {}) => ({ pnl, opened: o * H, closed: c * H, fees: 1, ...extra });
test('tradeStats', () => {
  const s = P.tradeStats([t(30, 0, 1), t(-10, 2, 3), t(-10, 4, 5), t(-10, 6, 7), t(20, 8, 10)]);
  assert.equal(s.n, 5); assert.equal(s.winRate, 0.4); close(s.total, 20); close(s.expectancy, 4);
  close(s.profitFactor, 50 / 30); close(s.payoff, 25 / 10); assert.equal(s.maxLosingStreak, 3); close(s.avgHoldMin, 72);
  close(s.fees, 5); close(s.feesPctOfGross, 0.1);
});
test('tradeStats: vazio e sem perdas', () => {
  assert.equal(P.tradeStats([]).n, 0); assert.equal(P.tradeStats([t(5, 0, 1)]).profitFactor, null);
});
test('groupStats e tiltCheck', () => {
  const trades = [t(10, 0, 1, { side: 'L' }), t(-5, 2, 3, { side: 'S' }), t(-20, 3.2, 4, { side: 'S' }), t(8, 10, 11, { side: 'L' })];
  const g = P.groupStats(trades, x => x.side);
  assert.equal(g.find(x => x.key === 'S').n, 2);
  const tc = P.tiltCheck(trades, 30);               // 3.2h abre 12 min após perda fechada às 3h
  assert.equal(tc.nAfter, 1); assert.equal(tc.avgAfter, -20);
});
test('fxExposure', () => {
  const r = P.fxExposure([{ ccy: 'USD', value: 60 }, { ccy: 'EUR', value: 40 }, { ccy: 'EUR', value: -5 }]);
  assert.equal(r[0].ccy, 'USD'); close(r[0].pct, 60);
});
test('lookThrough: sobreposição ETF + ação direta', () => {
  const lt = P.lookThrough(
    [{ label: 'VWCE', value: 1000, holdings: [{ symbol: 'AAPL', name: 'Apple', pct: 4 }, { symbol: 'MSFT', name: 'Microsoft', pct: 3.5 }] },
     { label: 'CSPX', value: 500, holdings: [{ symbol: 'AAPL', name: 'Apple', pct: 7 }] }],
    [{ symbol: 'AAPL', name: 'Apple', value: 200 }], 2000);
  const a = lt[0]; assert.equal(a.key, 'AAPL'); close(a.value, 200 + 40 + 35); assert.ok(a.overlap); assert.deepEqual(a.from, ['VWCE', 'CSPX']);
  close(a.pct, 275 / 2000 * 100);
});
test('income 12m', () => {
  const now = 400 * D, r = P.income([{ ts: now - 10 * D, amt: 5, ticker: 'A' }, { ts: now - 400 * D, amt: 99, ticker: 'A' }, { ts: now - 5 * D, amt: 2, ticker: 'B' }], now);
  close(r.total12m, 7); assert.equal(r.by[0].ticker, 'A');
});
