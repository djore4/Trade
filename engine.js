// Motor de cálculo — porta em JavaScript do backend testado (paridade de fórmulas).
// Puro, sem estado, sem rede. Escada, mNAV, perps (linear/inverso), fiscal, cenários.
'use strict';

const Engine = (() => {
  const DIAS_ISENCAO = 365;
  const TAXA_MV = 0.28;

  // ---------- datas ----------
  const parseDate = (s) => new Date((s || '').slice(0, 10) + 'T00:00:00Z');
  const hojeUTC = () => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); };
  const diasEntre = (a, b) => Math.round((b - a) / 86400000);
  const addDias = (d, n) => new Date(d.getTime() + n * 86400000);
  const iso = (d) => d.toISOString().slice(0, 10);

  // =========================================================
  // ESCADA DE QUEDAS + RESERVA + KILL-SWITCH
  // =========================================================
  function multiplicador(dd, e1, e2, e3) {
    if (dd >= e3) return 3;
    if (dd >= e2) return 2;
    if (dd >= e1) return 1;
    return 0;
  }

  function avaliaEscada(preco, high, base, total, gasto, maxTrig, usados, kill, killMotivo, e1, e2, e3) {
    const restante = Math.max(0, total - gasto);
    if (kill) return { drawdown_pct: null, multiplo: 0, sugestao: 0, reserva_restante: restante, estado: 'pausado',
      motivo: `Kill-switch ligado: ${killMotivo || 'tese em revisão — sem reforços'}` };
    if (!preco || !high || high <= 0) return { drawdown_pct: null, multiplo: 0, sugestao: 0, reserva_restante: restante, estado: 'sem_dados',
      motivo: 'Sem preço atual ou máximo da janela — atualiza os preços ou introduz manualmente.' };
    const dd = Math.max(0, (high - preco) / high * 100);
    const mult = multiplicador(dd, e1, e2, e3);
    if (mult === 0) return { drawdown_pct: round(dd, 2), multiplo: 0, sugestao: 0, reserva_restante: restante, estado: 'aguarda',
      motivo: `Queda ${dd.toFixed(1)}% < ${e1}% — só entra a compra base do calendário.` };
    if (usados >= maxTrig) return { drawdown_pct: round(dd, 2), multiplo: mult, sugestao: 0, reserva_restante: restante, estado: 'limite',
      motivo: `Limite de acionamentos atingido (${usados}/${maxTrig}).` };
    if (restante <= 0) return { drawdown_pct: round(dd, 2), multiplo: mult, sugestao: 0, reserva_restante: 0, estado: 'sem_reserva',
      motivo: 'Reserva esgotada — guarda munição para o fundo real.' };
    const bruto = mult * base;
    const sugestao = Math.min(bruto, restante);
    let motivo = `Queda ${dd.toFixed(1)}% arma ${mult}× a base (${base}€).`;
    if (sugestao < bruto) motivo += ` Limitado pela reserva restante (${restante.toFixed(0)}€).`;
    return { drawdown_pct: round(dd, 2), multiplo: mult, sugestao: round(sugestao, 2), reserva_restante: round(restante, 2), estado: 'armado', motivo };
  }

  // =========================================================
  // mNAV (MSTR)
  // =========================================================
  function mnav(mstrPreco, shares, btcTreasury, btcPreco, favoravel, travar) {
    if (!mstrPreco || !shares || !btcTreasury || !btcPreco || btcTreasury <= 0 || btcPreco <= 0)
      return { mnav: null, sinal: 'sem_dados', motivo: 'Faltam inputs (preço MSTR, ações, BTC em tesouraria ou preço BTC).' };
    const mcap = mstrPreco * shares;
    const valorBtc = btcTreasury * btcPreco;
    const m = mcap / valorBtc;
    let sinal, motivo;
    if (m <= favoravel) { sinal = 'favoravel'; motivo = `mNAV ${m.toFixed(2)}× ≤ ${favoravel}× — zona favorável (alavancagem a BTC sem prémio).`; }
    else if (m > travar) { sinal = 'travar'; motivo = `mNAV ${m.toFixed(2)}× > ${travar}× — prémio esticado, travar acumulação.`; }
    else { sinal = 'neutro'; motivo = `mNAV ${m.toFixed(2)}× entre ${favoravel}× e ${travar}× — neutro.`; }
    return { mnav: round(m, 3), market_cap: mcap, valor_btc: valorBtc, sinal, motivo };
  }

  // =========================================================
  // PERPS — linear e inverso (fórmulas distintas)
  // =========================================================
  function precoLiquidacao(direcao, contrato, entrada, alav, mmr = 0.005) {
    if (!entrada || !alav || alav <= 0) return null;
    const L = alav;
    if (contrato === 'linear') {
      return direcao === 'long' ? entrada * (1 - 1 / L + mmr) : entrada * (1 + 1 / L - mmr);
    }
    return direcao === 'long' ? entrada * L / (L + 1 - mmr * L) : entrada * L / (L - 1 + mmr * L);
  }

  function avaliaPerp(direcao, contrato, entrada, qtd, alav, funding, mark, mmr, eurusd) {
    const liq = precoLiquidacao(direcao, contrato, entrada, alav, mmr);
    const out = { liquidacao: liq != null ? round(liq, 6) : null, liquidacao_aprox: true, dist_liq_pct: null,
      pnl_bruto_usd: null, funding_usd: round(funding, 2), pnl_liq_usd: null, pnl_liq_eur: null, roi_margem_pct: null, margem_usd: null };
    if (mark && liq != null && mark > 0) out.dist_liq_pct = round((mark - liq) / mark * 100, 2);
    if (!mark || mark <= 0 || !entrada || entrada <= 0) return out;
    const sign = direcao === 'long' ? 1 : -1;
    let pnlBruto, margem;
    if (contrato === 'linear') {
      pnlBruto = (mark - entrada) * qtd * sign;
      margem = alav ? (entrada * qtd) / alav : null;
    } else {
      const pnlCoin = qtd * (1 / entrada - 1 / mark) * sign;
      pnlBruto = pnlCoin * mark;
      const margemCoin = alav ? (qtd / entrada) / alav : null;
      margem = margemCoin != null ? margemCoin * mark : null;
    }
    const pnlLiq = pnlBruto - funding;
    out.pnl_bruto_usd = round(pnlBruto, 2);
    out.pnl_liq_usd = round(pnlLiq, 2);
    out.pnl_liq_eur = round(pnlLiq * eurusd, 2);
    out.margem_usd = margem ? round(margem, 2) : null;
    if (margem) out.roi_margem_pct = round(pnlLiq / margem * 100, 2);
    return out;
  }

  function simulaSaidaPerp(p, precosSaida, eurusd) {
    return precosSaida.map((pr) => {
      const r = avaliaPerp(p.direcao, p.contrato, p.entrada, p.qtd, p.alavancagem, p.funding_acum, pr, p.mmr, eurusd);
      return { preco_saida: pr, pnl_liq_usd: r.pnl_liq_usd, pnl_liq_eur: r.pnl_liq_eur, roi_margem_pct: r.roi_margem_pct };
    });
  }

  // =========================================================
  // FISCAL — 365 dias + FIFO
  // =========================================================
  function _lotesRemanescentes(txs) {
    const ord = [...txs].sort((a, b) => (parseDate(a.data) - parseDate(b.data)) || (a.id - b.id));
    const lotes = [];
    for (const t of ord) {
      if (t.tipo === 'buy') {
        const taxasUnit = t.qtd ? (t.taxas || 0) / t.qtd : 0;
        lotes.push({ qtd: t.qtd, preco: t.preco, taxasUnit, data: parseDate(t.data) });
      } else if (t.tipo === 'sell') {
        let rem = t.qtd;
        for (const l of lotes) { if (rem <= 0) break; if (l.qtd <= 0) continue; const c = Math.min(l.qtd, rem); l.qtd -= c; rem -= c; }
      }
    }
    return lotes.filter((l) => l.qtd > 1e-12);
  }

  function estadoLotes(txs, hoje = hojeUTC()) {
    const lotes = _lotesRemanescentes(txs);
    let isento = 0, tributavel = 0, prox = null;
    const detalhe = lotes.map((l) => {
      const idade = diasEntre(l.data, hoje);
      const desbloqueia = addDias(l.data, DIAS_ISENCAO);
      if (idade >= DIAS_ISENCAO) isento += l.qtd; else { tributavel += l.qtd; if (!prox || desbloqueia < prox) prox = desbloqueia; }
      return { qtd: round(l.qtd, 12), preco: l.preco, data: iso(l.data), idade_dias: idade, isento: idade >= DIAS_ISENCAO, desbloqueia: iso(desbloqueia) };
    });
    return { lotes: detalhe, qtd_total: round(isento + tributavel, 12), qtd_isenta: round(isento, 12),
      qtd_tributavel: round(tributavel, 12), proximo_desbloqueio: prox ? iso(prox) : null };
  }

  function simulaVenda(txs, qtdVenda, precoVenda, hoje = hojeUTC()) {
    const lotes = _lotesRemanescentes(txs);
    const disponivel = lotes.reduce((s, l) => s + l.qtd, 0);
    if (qtdVenda > disponivel + 1e-9) return { erro: `Quantidade a vender (${qtdVenda}) excede o disponível (${round(disponivel, 8)}).` };
    let rem = qtdVenda, gIsento = 0, gTrib = 0; const detalhe = [];
    for (const l of lotes) {
      if (rem <= 0) break;
      const usa = Math.min(l.qtd, rem); rem -= usa;
      const idade = diasEntre(l.data, hoje);
      const custo = (l.preco + l.taxasUnit) * usa;
      const ganho = precoVenda * usa - custo;
      let impostoLote = 0;
      if (idade >= DIAS_ISENCAO) gIsento += ganho; else { gTrib += ganho; impostoLote = Math.max(0, ganho) * TAXA_MV; }
      detalhe.push({ data_lote: iso(l.data), idade_dias: idade, qtd: round(usa, 12), preco_lote: l.preco, ganho: round(ganho, 2), isento: idade >= DIAS_ISENCAO, imposto: round(impostoLote, 2) });
    }
    const imposto = Math.max(0, gTrib) * TAXA_MV;
    return { qtd_venda: qtdVenda, preco_venda: precoVenda, ganho_total: round(gIsento + gTrib, 2), ganho_isento: round(gIsento, 2),
      ganho_tributavel: round(gTrib, 2), imposto_estimado: round(imposto, 2), taxa: TAXA_MV, detalhe,
      aviso: 'Estimativa por FIFO com regra dos 365 dias. Não substitui contabilista.' };
  }

  // custo médio (não fiscal)
  function posicaoAtivo(txs) {
    const ord = [...txs].sort((a, b) => (parseDate(a.data) - parseDate(b.data)) || (a.id - b.id));
    let qtd = 0, custo = 0;
    for (const t of ord) {
      if (t.tipo === 'buy') { qtd += t.qtd; custo += t.qtd * t.preco + (t.taxas || 0); }
      else if (t.tipo === 'sell') { if (qtd > 0) { const cm = custo / qtd; custo -= Math.min(t.qtd, qtd) * cm; } qtd -= t.qtd; }
    }
    qtd = Math.max(0, qtd);
    return { qtd, custo_total: Math.max(0, custo), custo_medio: qtd > 1e-12 ? custo / qtd : null };
  }

  // =========================================================
  // CENÁRIOS — DCA linear vs DCA + reserva
  // =========================================================
  function _dcaLinear(precos, budget) {
    const n = precos.length, pp = n ? budget / n : 0;
    let unid = 0, inv = 0;
    for (const p of precos) if (p > 0) { unid += pp / p; inv += pp; }
    const pf = precos[precos.length - 1] || 0;
    return { investido: round(inv, 2), unidades: unid, preco_medio: unid ? round(inv / unid, 6) : null, valor_final: round(unid * pf, 2) };
  }
  function _dcaReserva(precos, budget, baseFrac, e1, e2, e3) {
    const n = precos.length, baseTotal = budget * baseFrac, reservaTotal = budget - baseTotal;
    const basePP = n ? baseTotal / n : 0;
    let unid = 0, inv = 0, reservaRest = reservaTotal, high = 0;
    for (const p of precos) {
      if (p <= 0) continue;
      high = Math.max(high, p);
      unid += basePP / p; inv += basePP;
      const dd = high ? (high - p) / high * 100 : 0;
      const mult = multiplicador(dd, e1, e2, e3);
      if (mult > 0 && reservaRest > 0) { const gasto = Math.min(mult * basePP, reservaRest); unid += gasto / p; inv += gasto; reservaRest -= gasto; }
    }
    const pf = precos[precos.length - 1] || 0;
    return { investido: round(inv, 2), reserva_por_gastar: round(reservaRest, 2), unidades: unid, preco_medio: unid ? round(inv / unid, 6) : null, valor_final: round(unid * pf, 2) };
  }
  function comparaCenarios(precos, budget, baseFrac, e1, e2, e3) {
    const linear = _dcaLinear(precos, budget), reserva = _dcaReserva(precos, budget, baseFrac, e1, e2, e3);
    const dv = (reserva.valor_final || 0) - (linear.valor_final || 0);
    const du = (reserva.unidades || 0) - (linear.unidades || 0);
    return { linear, reserva, diferenca: { valor_final: round(dv, 2), unidades: du, unidades_pct: linear.unidades ? round(du / linear.unidades * 100, 2) : null },
      aviso: 'Comparação RELATIVA de estratégias sobre a mesma trajetória. NÃO é previsão de retorno.' };
  }
  function trajetoriaSintetica(p0, periodos, cenario) {
    const fatores = { otimista: 1 + 0.9 / periodos, base: 1 + 0.2 / periodos, pessimista: 1 - 0.4 / periodos };
    const f = fatores[cenario] || fatores.base;
    const out = []; let p = p0;
    for (let i = 0; i < periodos; i++) { const onda = 1 + 0.12 * (i % 3 === 1 ? -1 : (i % 3 === 2 ? 1 : 0)); out.push(round(p * onda, 6)); p *= f; }
    return out;
  }

  function round(v, d) { const m = Math.pow(10, d); return Math.round((v + Number.EPSILON) * m) / m; }

  return { multiplicador, avaliaEscada, mnav, precoLiquidacao, avaliaPerp, simulaSaidaPerp,
    estadoLotes, simulaVenda, posicaoAtivo, comparaCenarios, trajetoriaSintetica, iso, hojeUTC };
})();
