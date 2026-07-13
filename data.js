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

  // ===================================================================
  // API PRIVADA da Bybit — via proxy pessoal READ-ONLY (nunca a chave no
  // browser). URL + token vivem nas Definições. Tudo degrada para manual.
  // ===================================================================
  function _proxy() {
    const s = (typeof Store !== 'undefined') ? Store.settings() : {};
    return { url: (s.proxy_url || '').trim(), token: (s.proxy_token || '').trim() };
  }

  async function bybitPrivado(path, params = {}) {
    const { url, token } = _proxy();
    if (!url || !token) return { ok: false, naoConfigurado: true, erro: 'Proxy não configurado (Definições → Integrações).' };
    const qs = new URLSearchParams({ path, ...params }).toString();
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    try {
      const r = await fetch(url + (url.includes('?') ? '&' : '?') + qs, {
        headers: { 'X-Proxy-Token': token }, signal: ctrl.signal,
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return { ok: false, erro: j.erro || `Proxy HTTP ${r.status}` };
      if (j.retCode !== 0) return { ok: false, erro: j.retMsg || `Bybit retCode ${j.retCode}` };
      return { ok: true, result: j.result };
    } catch (e) {
      return { ok: false, erro: `Proxy indisponível (${e.name}). Portefólio fica manual.` };
    } finally { clearTimeout(t); }
  }

  const _WRITE_RE = /(trade|order|transfer|withdraw|create|cancel|exchange)/i;
  async function verificaChave() {
    const r = await bybitPrivado('/v5/user/query-api');
    if (!r.ok) return r;
    const perms = r.result.permissions || {};
    const todas = Object.values(perms).flat().filter(Boolean);
    const escrita = todas.filter((p) => _WRITE_RE.test(p));
    return {
      ok: true, readonly: escrita.length === 0, permissoes: perms, escrita,
      aviso: escrita.length ? `A chave tem permissões potencialmente de escrita: ${escrita.join(', ')}. Cria uma chave SÓ DE LEITURA.` : null,
    };
  }

  function _mapPos(p, contrato) {
    return {
      ativo: p.symbol,
      direcao: String(p.side || '').toLowerCase() === 'sell' ? 'short' : 'long',
      contrato,
      entrada: parseFloat(p.avgPrice) || null,
      size: parseFloat(p.size) || 0,
      alavancagem: parseFloat(p.leverage) || null,
      mark: parseFloat(p.markPrice) || null,
      liq: parseFloat(p.liqPrice) || null,
      pnl_usd: p.unrealisedPnl != null && p.unrealisedPnl !== '' ? parseFloat(p.unrealisedPnl) : null,
      valor_pos: parseFloat(p.positionValue) || null,
      fonte: 'bybit',
    };
  }

  // Posições abertas: linear (USDT) + inverso (por coin base). settleCoins
  // vem dos símbolos conhecidos para saber que inversos consultar.
  async function posicoesLive(settleCoins = []) {
    const out = []; const erros = [];
    const lin = await bybitPrivado('/v5/position/list', { category: 'linear', settleCoin: 'USDT' });
    if (lin.ok) (lin.result.list || []).forEach((p) => { if (parseFloat(p.size) > 0) out.push(_mapPos(p, 'linear')); });
    else if (!lin.naoConfigurado) erros.push('linear: ' + lin.erro);
    else return lin; // proxy não configurado

    const coins = [...new Set([...settleCoins, 'BTC'].map((c) => String(c).toUpperCase()))];
    for (const coin of coins) {
      const inv = await bybitPrivado('/v5/position/list', { category: 'inverse', settleCoin: coin });
      if (inv.ok) (inv.result.list || []).forEach((p) => { if (parseFloat(p.size) > 0) out.push(_mapPos(p, 'inverse')); });
    }
    return { ok: true, posicoes: out, erros };
  }

  async function saldosSpot() {
    const r = await bybitPrivado('/v5/account/wallet-balance', { accountType: 'UNIFIED' });
    if (!r.ok) return r;
    const acc = (r.result.list || [])[0] || {};
    const saldos = (acc.coin || [])
      .map((c) => ({ coin: c.coin, qtd: parseFloat(c.walletBalance) || 0, usd: c.usdValue != null && c.usdValue !== '' ? parseFloat(c.usdValue) : null }))
      .filter((c) => c.qtd > 0);
    return { ok: true, saldos };
  }

  return { precoTopo, precoBtc, eurUsd, precoMstr, verificaChave, posicoesLive, saldosSpot };
})();
