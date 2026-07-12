// Obtenção de dados PÚBLICOS do lado do cliente (site estático). Sem chaves,
// sem segredos. Tudo degrada com elegância para entrada manual: qualquer falha
// (rede, CORS) devolve {ok:false, erro} e o módulo continua a funcionar manual.
'use strict';

const Data = (() => {
  const TIMEOUT = 9000;
  async function jget(url) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT);
    try {
      const r = await fetch(url, { signal: ctrl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } finally { clearTimeout(t); }
  }

  // Preço spot + máximo da janela (Bybit público, CORS permitido)
  async function precoTopo(simbolo, dias = 75) {
    const par = simbolo.toUpperCase() + 'USDT';
    try {
      const tk = await jget(`https://api.bybit.com/v5/market/tickers?category=spot&symbol=${par}`);
      if (tk.retCode !== 0 || !tk.result.list.length) return { ok: false, erro: `Sem ticker para ${par}.` };
      const preco = parseFloat(tk.result.list[0].lastPrice);
      let high = null;
      try {
        const kl = await jget(`https://api.bybit.com/v5/market/kline?category=spot&symbol=${par}&interval=D&limit=${Math.min(dias, 200)}`);
        if (kl.retCode === 0) high = Math.max(...kl.result.list.map((r) => parseFloat(r[2])));
      } catch (e) { /* mantém high anterior */ }
      return { ok: true, simbolo: simbolo.toUpperCase(), preco, high_60_90d: high, fonte: 'bybit-public' };
    } catch (e) { return { ok: false, erro: `Bybit indisponível (${e.name}). Usa entrada manual.` }; }
  }

  // BTC via Bybit público (CORS ok) — para o mNAV
  async function precoBtc() {
    try {
      const tk = await jget('https://api.bybit.com/v5/market/tickers?category=spot&symbol=BTCUSDT');
      if (tk.retCode !== 0) throw new Error('sem BTC');
      return { ok: true, preco: parseFloat(tk.result.list[0].lastPrice), fonte: 'bybit-public' };
    } catch (e) { return { ok: false, erro: `Preço BTC indisponível (${e.name}). Introduz manualmente.` }; }
  }

  // EUR/USD via Frankfurter/BCE (CORS ok)
  async function eurUsd() {
    try {
      const j = await jget('https://api.frankfurter.app/latest?from=USD&to=EUR');
      return { ok: true, eur_usd: parseFloat(j.rates.EUR), fonte: 'frankfurter/BCE' };
    } catch (e) { return { ok: false, erro: `Câmbio indisponível (${e.name}). Mantém o override manual.` }; }
  }

  // MSTR via Yahoo — pode ser bloqueado por CORS; degrada para manual
  async function precoMstr() {
    try {
      const j = await jget('https://query1.finance.yahoo.com/v8/finance/chart/MSTR?range=1d&interval=1d');
      const p = j.chart.result[0].meta.regularMarketPrice;
      return { ok: true, preco: parseFloat(p), fonte: 'yahoo' };
    } catch (e) { return { ok: false, erro: `Cotação MSTR indisponível (${e.name}). Introduz manualmente.` }; }
  }

  return { precoTopo, precoBtc, eurUsd, precoMstr };
})();
