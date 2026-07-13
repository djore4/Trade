// Consola de Investimentos — app estática (browser puro). Usa Store (localStorage),
// Engine (cálculo) e Data (APIs públicas). Local-first, PT-PT, sem backend.
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const main = $('#main');

const nf = new Intl.NumberFormat('pt-PT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nfN = new Intl.NumberFormat('pt-PT', { minimumFractionDigits: 0, maximumFractionDigits: 6 });
const eur = (v) => v == null ? '—' : nf.format(v) + ' €';
const usd = (v) => v == null ? '—' : '$' + nf.format(v);
const num = (v, d) => v == null ? '—' : (d === undefined ? nfN : new Intl.NumberFormat('pt-PT', { minimumFractionDigits: d, maximumFractionDigits: d })).format(v);
const pct = (v) => v == null ? '—' : nf.format(v) + '%';
const sgn = (v) => v == null ? '' : (v > 0 ? 'pos' : v < 0 ? 'neg' : 'dim');
const esc = (s) => (s ?? '').toString().replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const DISCLAIMER = 'Isto não é aconselhamento financeiro nem fiscal. A app apresenta cálculos e sinais da tua regra pré-definida e estima números fiscais — não substitui contabilista. Não executa ordens.';

// ---------- modal ----------
function modal(title, bodyHtml, onSave, saveLabel = 'Guardar') {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-bg"><div class="modal"><h3>${esc(title)}</h3>
    <div id="modal-body">${bodyHtml}</div>
    <div class="modal-actions"><button id="m-cancel">Cancelar</button>
    ${onSave ? `<button class="primary" id="m-save">${esc(saveLabel)}</button>` : ''}</div></div></div>`;
  $('#m-cancel').onclick = () => root.innerHTML = '';
  if (onSave) $('#m-save').onclick = () => { try { onSave(); root.innerHTML = ''; } catch (e) { alert('Erro: ' + e.message); } };
}
const mval = (id) => { const e = $('#' + id); return e ? e.value : ''; };
const mnum = (id) => { const v = parseFloat(mval(id)); return isNaN(v) ? null : v; };

// ---------- helpers de domínio ----------
const eurusd = () => parseFloat(Store.settings().eur_usd) || 0.92;
const S = () => Store.settings();
const escadas = () => [parseFloat(S().escada_1), parseFloat(S().escada_2), parseFloat(S().escada_3)];

function priceOf(sym) { return Store.prices()[sym.toUpperCase()] || {}; }
function toEur(v, moeda) { return v == null ? null : (moeda === 'USD' ? v * eurusd() : v); }

// ---------- router ----------
const views = {};
async function go(view) {
  $$('nav.side a').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
  main.innerHTML = '<div class="spinner">…</div>';
  try { await views[view](); } catch (e) { main.innerHTML = `<div class="note">Erro: ${esc(e.message)}</div>`; console.error(e); }
}
$$('nav.side a').forEach((a) => a.onclick = () => go(a.dataset.view));

// =====================================================================
// DASHBOARD
// =====================================================================
views.dashboard = function () {
  const fx = eurusd();
  const quad = {}; const owners = {};
  let totalSpot = 0, totalMstr = 0;
  for (const a of Store.assets()) {
    const pos = Engine.posicaoAtivo(Store.transactions(a.id));
    const pc = priceOf(a.simbolo);
    const valorEur = (pc.preco != null && pos.qtd > 0) ? pos.qtd * toEur(pc.preco, a.moeda) : 0;
    const custoEur = toEur(pos.custo_total, a.moeda) || 0;
    const q = a.quadrante || 'outros';
    quad[q] = (quad[q] || 0) + valorEur;
    const o = owners[a.owner] || (owners[a.owner] = { valor: 0, custo: 0 });
    o.valor += valorEur; o.custo += custoEur;
    if (a.quadrante === 'BTC-alavancado') totalMstr += valorEur; else totalSpot += valorEur;
  }
  let totalPpr = 0;
  for (const p of Store.pprs()) { totalPpr += p.valor; quad.PPR = (quad.PPR || 0) + p.valor;
    const o = owners[p.owner] || (owners[p.owner] = { valor: 0, custo: 0 }); o.valor += p.valor; o.custo += p.investido; }
  let margemRisco = 0;
  for (const p of Store.perps()) if (p.estado !== 'fechada' && p.margem) margemRisco += p.margem * fx;

  const total = totalSpot + totalMstr + totalPpr;
  const avisoConc = parseFloat(S().aviso_concentracao) || 40;
  const alloc = Object.entries(quad).sort((a, b) => b[1] - a[1]).map(([q, v]) => {
    const p = total > 0 ? v / total * 100 : 0; const alvo = parseFloat(S()['alvo_' + q] || 0) || 0;
    return `<tr><td>${esc(q)} ${p > avisoConc ? '<span class="badge red">concentração</span>' : ''}</td>
      <td class="num">${eur(v)}</td><td class="num">${pct(p)}</td><td class="num dim">${pct(alvo)}</td>
      <td class="num ${sgn(p - alvo)}">${p - alvo > 0 ? '+' : ''}${pct(p - alvo)}</td>
      <td style="width:120px"><div class="pill-alloc"><i style="width:${Math.min(100, p)}%"></i></div></td></tr>`;
  }).join('');
  const ownerRows = Object.entries(owners).map(([o, v]) => {
    const pnl = v.valor - v.custo;
    return `<tr><td class="sym">${esc(o)}</td><td class="num">${eur(v.valor)}</td><td class="num">${eur(v.custo)}</td>
      <td class="num ${sgn(pnl)}">${eur(pnl)}</td><td class="num ${sgn(pnl)}">${pct(v.custo > 0 ? pnl / v.custo * 100 : null)}</td></tr>`;
  }).join('');
  const pnlTotal = Object.values(owners).reduce((s, v) => s + (v.valor - v.custo), 0);

  main.innerHTML = `<h1>Dashboard</h1>
    <div class="sub">Base EUR · câmbio 1 USD = ${num(fx, 4)} € · dados no teu browser</div>
    <div class="grid cols-4">
      <div class="card"><div class="label">Cripto spot</div><div class="big num">${eur(totalSpot)}</div></div>
      <div class="card"><div class="label">MSTR (BTC alav.)</div><div class="big num">${eur(totalMstr)}</div></div>
      <div class="card"><div class="label">PPR</div><div class="big num">${eur(totalPpr)}</div><div class="small">titular Patrícia</div></div>
      <div class="card"><div class="label red">Margem inversos (risco)</div><div class="big num red">${eur(margemRisco)}</div><div class="small">fora do total</div></div>
    </div>
    <div class="grid cols-2" style="margin-top:14px">
      <div class="card"><div class="label">Valor total (EUR)</div><div class="big num">${eur(total)}</div></div>
      <div class="card"><div class="label">P&amp;L agregado</div><div class="big num ${sgn(pnlTotal)}">${eur(pnlTotal)}</div></div>
    </div>
    <h2>Alocação por quadrante vs alvo</h2>
    <div class="tbl-wrap"><table><thead><tr><th>Quadrante</th><th>Valor</th><th>Atual</th><th>Alvo</th><th>Desvio</th><th></th></tr></thead>
      <tbody>${alloc || '<tr><td colspan="6" class="dim">Sem posições. Adiciona transações em Lotes.</td></tr>'}</tbody></table></div>
    <h2>P&amp;L por titular</h2>
    <div class="tbl-wrap"><table><thead><tr><th>Titular</th><th>Valor</th><th>Custo</th><th>P&amp;L</th><th>P&amp;L %</th></tr></thead>
      <tbody>${ownerRows || '<tr><td colspan="5" class="dim">—</td></tr>'}</tbody></table></div>
    <div class="disclaimer">${esc(DISCLAIMER)}</div>`;
};

// =====================================================================
// TRACKER
// =====================================================================
function mnavSignal() {
  const mi = Store.mstrInputs(); const s = S();
  return Engine.mnav(priceOf('MSTR').preco, mi ? mi.shares_outstanding : null, mi ? mi.btc_treasury : null,
    priceOf('BTC').preco, parseFloat(s.mnav_favoravel), parseFloat(s.mnav_travar));
}
views.tracker = function () {
  const fx = eurusd(); const [e1, e2, e3] = escadas();
  const rows = Store.assets().map((a) => {
    const pos = Engine.posicaoAtivo(Store.transactions(a.id));
    const rb = Store.reserve(a.id); const pc = priceOf(a.simbolo);
    const precoEur = toEur(pc.preco, a.moeda);
    const cmEur = toEur(pos.custo_medio, a.moeda);
    const valorEur = precoEur != null ? pos.qtd * precoEur : null;
    const custoEur = toEur(pos.custo_total, a.moeda);
    const pnlEur = valorEur != null ? valorEur - custoEur : null;
    const pnlPct = (pnlEur != null && custoEur > 0) ? pnlEur / custoEur * 100 : null;
    const e = Engine.avaliaEscada(pc.preco, pc.high_60_90d, rb.base_amount, rb.total, rb.gasto, rb.max_triggers, rb.triggers_used, !!rb.killswitch, rb.killswitch_motivo, e1, e2, e3);
    const segCls = (n) => 'seg' + (e.multiplo >= n ? ' on' + n : '');
    const estBadge = { armado: 'green', aguarda: 'dim', pausado: 'red', sem_reserva: 'amber', limite: 'amber', sem_dados: 'dim' }[e.estado] || 'dim';
    let mnavCell = '';
    if (a.simbolo === 'MSTR') { const m = mnavSignal(); const mc = { favoravel: 'green', travar: 'red', neutro: 'amber', sem_dados: 'dim' }[m.sinal] || 'dim';
      mnavCell = m.mnav != null ? `<span class="badge ${mc}">mNAV ${num(m.mnav, 2)}×</span>` : '<span class="badge dim">mNAV s/dados</span>'; }
    return { a, e, html: `<tr>
      <td><span class="sym">${esc(a.simbolo)}</span> <span class="mini">${esc(a.quadrante || '')}</span> ${mnavCell}</td>
      <td class="num">${num(pos.qtd)}</td><td class="num dim">${cmEur != null ? eur(cmEur) : '—'}</td>
      <td class="num">${precoEur != null ? eur(precoEur) : '—'}</td>
      <td class="num ${e.drawdown_pct ? 'neg' : 'dim'}">${e.drawdown_pct != null ? '-' + pct(e.drawdown_pct) : '—'}</td>
      <td class="num">${eur(valorEur)}</td><td class="num ${sgn(pnlEur)}">${eur(pnlEur)}</td><td class="num ${sgn(pnlPct)}">${pct(pnlPct)}</td>
      <td><div class="ladder"><div class="${segCls(1)}"></div><div class="${segCls(2)}"></div><div class="${segCls(3)}"></div></div></td>
      <td><span class="badge ${estBadge}">${e.sugestao > 0 ? eur(e.sugestao) : esc(e.estado)}</span></td>
      <td><button class="small" data-preco="${a.id}">preço</button> <button class="small" data-reserva="${a.id}">reserva</button></td></tr>` };
  });

  main.innerHTML = `<h1>Tracker</h1>
    <div class="sub">Spot + MSTR · escada de quedas, reserva e sinal mNAV</div>
    <div class="toolbar"><button class="primary" id="refresh">↻ Atualizar preços (públicos)</button><span class="spinner" id="rst"></span>
      <button id="sync-saldos">↻ Saldos ao vivo (Bybit)</button><span class="spinner" id="sst"></span></div>
    <div class="tbl-wrap"><table><thead><tr><th>Ativo</th><th>Qtd</th><th>Custo médio</th><th>Preço</th><th>Queda</th><th>Valor</th><th>P&amp;L</th><th>P&amp;L %</th><th>Escada</th><th>Sugestão</th><th></th></tr></thead>
      <tbody>${rows.map((r) => r.html).join('') || '<tr><td colspan="11" class="dim">Sem ativos.</td></tr>'}</tbody></table></div>
    <div class="note">O P&amp;L por custo médio mostra 'como estás', NÃO serve para decidir vendas — usa a vista de Lotes (fiscal).</div>
    ${rows.filter((r) => r.e.motivo).map((r) => `<div class="mini">· <b>${esc(r.a.simbolo)}</b>: ${esc(r.e.motivo)}</div>`).join('')}
    <div id="tracker-live"></div>
    <div class="disclaimer">Sugestões seguem a TUA regra pré-definida (não são recomendações). Atualiza preços antes de decidir.</div>`;

  renderSaldosLive();
  $('#refresh').onclick = () => refreshPrecos($('#rst'));
  $('#sync-saldos').onclick = () => syncBybit($('#sst'));
  $$('[data-reserva]').forEach((b) => b.onclick = () => reservaModal(+b.dataset.reserva));
  $$('[data-preco]').forEach((b) => b.onclick = () => precoModal(Store.asset(+b.dataset.preco)));
};

function renderSaldosLive() {
  const el = $('#tracker-live'); if (!el) return;
  const cfg = (Store.settings().proxy_url || '').trim();
  if (!cfg) { el.innerHTML = ''; return; }
  const live = Store.live() || {}; const saldos = live.saldos || [];
  const ts = live.ts ? new Date(live.ts).toLocaleString('pt-PT') : '—';
  const rows = saldos.map((sld) => {
    const asset = Store.assets(true).find((a) => a.simbolo === String(sld.coin).toUpperCase());
    const manualQty = asset ? Engine.posicaoAtivo(Store.transactions(asset.id)).qtd : null;
    const diff = manualQty != null ? sld.qtd - manualQty : null;
    return `<tr><td class="sym">${esc(sld.coin)}</td>
      <td class="num">${num(sld.qtd)}</td><td class="num dim">${manualQty != null ? num(manualQty) : '—'}</td>
      <td class="num ${diff == null ? 'dim' : (Math.abs(diff) > 1e-6 ? 'amber' : 'pos')}">${diff != null ? num(diff) : '—'}</td>
      <td class="num dim">${sld.usd != null ? usd(sld.usd) : '—'}</td></tr>`;
  }).join('');
  el.innerHTML = `<h2>Saldos ao vivo (Bybit) <span class="mini">· ${ts}</span></h2>
    <div class="tbl-wrap"><table><thead><tr><th>Moeda</th><th>Qtd Bybit</th><th>Qtd manual</th><th>Diferença</th><th>Valor USD</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5" class="dim">Sem saldos (ou não sincronizado). Carrega em "Saldos ao vivo (Bybit)".</td></tr>'}</tbody></table></div>
    <div class="note info">Reconciliação: os lotes/custo médio para fiscalidade continuam a vir das tuas transações manuais (a Bybit não dá base de custo por lote). Usa a diferença para corrigir transações em falta.</div>`;
}

async function refreshPrecos(stEl) {
  stEl.textContent = 'a atualizar…';
  const dias = parseInt(S().janela_topo_dias) || 75; let okc = 0, fail = 0;
  for (const a of Store.assets()) {
    if (a.simbolo === 'MSTR' || a.quadrante === 'PPR') continue;
    const r = await Data.precoTopo(a.simbolo, dias);
    if (r.ok) { Store.setPrice(a.simbolo, r.preco, r.high_60_90d, r.fonte); okc++; } else fail++;
  }
  const fx = await Data.eurUsd(); if (fx.ok) { Store.setSetting('eur_usd', fx.eur_usd); Store.setSetting('eur_usd_fonte', fx.fonte); }
  const btc = await Data.precoBtc(); if (btc.ok) Store.setPrice('BTC', btc.preco, null, btc.fonte);
  const mstr = await Data.precoMstr(); if (mstr.ok) Store.setPrice('MSTR', mstr.preco, null, mstr.fonte);
  stEl.textContent = `${okc} ok, ${fail} manual · ${new Date().toLocaleTimeString('pt-PT')}`;
  go('tracker');
}

function precoModal(a) {
  const pc = priceOf(a.simbolo);
  modal(`Preço manual — ${a.simbolo}`, `
    <div class="row"><div><label class="fld">Preço atual (${a.moeda})</label><input id="pm-preco" value="${pc.preco ?? ''}"></div>
    <div><label class="fld">Máximo 60–90d (${a.moeda})</label><input id="pm-high" value="${pc.high_60_90d ?? ''}"></div></div>
    <div class="note">Override manual. Também podes usar "Atualizar preços" para os públicos.</div>`,
    () => { Store.setPrice(a.simbolo, mnum('pm-preco'), mnum('pm-high'), 'manual'); go('tracker'); });
}
function reservaModal(assetId) {
  const r = Store.reserve(assetId); const a = Store.asset(assetId);
  modal(`Reserva — ${a.simbolo}`, `
    <div class="row"><div><label class="fld">Compra base (€)</label><input id="r-base" value="${r.base_amount}"></div>
    <div><label class="fld">Reserva total (€)</label><input id="r-total" value="${r.total}"></div></div>
    <div class="row"><div><label class="fld">Já gasto (€)</label><input id="r-gasto" value="${r.gasto}"></div>
    <div><label class="fld">Máx. acionamentos</label><input id="r-max" value="${r.max_triggers}"></div>
    <div><label class="fld">Usados</label><input id="r-used" value="${r.triggers_used}"></div></div>
    <hr class="sep">
    <div class="row"><div><label class="fld">Kill-switch</label><select id="r-kill">
      <option value="0" ${!r.killswitch ? 'selected' : ''}>Desligado — queda de mercado (comprar)</option>
      <option value="1" ${r.killswitch ? 'selected' : ''}>Ligado — tese partida (pausar)</option></select></div></div>
    <div class="row"><div><label class="fld">Motivo do kill-switch</label><input id="r-motivo" value="${esc(r.killswitch_motivo || '')}"></div></div>
    <div class="note">Restante: <b>${eur(Math.max(0, r.total - r.gasto))}</b>. A app nunca sugere acima do restante.</div>`,
    () => { Store.updateReserve(assetId, { base_amount: mnum('r-base') || 0, total: mnum('r-total') || 0, gasto: mnum('r-gasto') || 0,
      max_triggers: mnum('r-max') || 0, triggers_used: mnum('r-used') || 0, killswitch: mval('r-kill') === '1' ? 1 : 0, killswitch_motivo: mval('r-motivo') }); go('tracker'); });
}

// =====================================================================
// LOTES & FISCAL
// =====================================================================
views.lotes = function () {
  const opts = Store.assets().map((a) => `<option value="${a.id}">${esc(a.simbolo)}</option>`).join('');
  const rows = Store.transactions().map((t) => { const a = Store.asset(t.asset_id);
    return `<tr><td class="sym">${esc(a ? a.simbolo : '?')}</td>
      <td><span class="badge ${t.tipo === 'buy' ? 'green' : 'red'}">${t.tipo === 'buy' ? 'compra' : 'venda'}</span></td>
      <td class="num">${esc(t.data)}</td><td class="num">${num(t.qtd)}</td><td class="num">${usd(t.preco)}</td>
      <td class="num dim">${num(t.taxas)}</td><td><button class="small danger" data-deltx="${t.id}">×</button></td></tr>`; }).join('');
  main.innerHTML = `<h1>Lotes &amp; Fiscal</h1>
    <div class="sub">Registo lote a lote · regra dos 365 dias · FIFO · Portugal</div>
    <div class="toolbar"><button class="primary" id="add-tx">+ Transação</button>
      <select id="lot-asset" style="width:auto">${opts}</select><button id="ver-lotes">Ver lotes &amp; simular venda</button></div>
    <div id="lot-panel"></div>
    <h2>Transações</h2>
    <div class="tbl-wrap"><table><thead><tr><th>Ativo</th><th>Tipo</th><th>Data</th><th>Qtd</th><th>Preço</th><th>Taxas</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="7" class="dim">Sem transações.</td></tr>'}</tbody></table></div>
    <div class="disclaimer">Derivados NÃO contam para os 365 dias e são tributados à parte. A Bybit reporta à AT (DAC8). Estimativas — não substituem contabilista.</div>`;
  $('#add-tx').onclick = () => txModal(opts);
  $('#ver-lotes').onclick = () => verLotes(+$('#lot-asset').value);
  $$('[data-deltx]').forEach((b) => b.onclick = () => { if (confirm('Apagar transação?')) { Store.deleteTx(+b.dataset.deltx); go('lotes'); } });
};
function txModal(opts) {
  const hoje = Engine.iso(Engine.hojeUTC());
  modal('Nova transação', `
    <div class="row"><div><label class="fld">Ativo</label><select id="t-asset">${opts}</select></div>
    <div><label class="fld">Tipo</label><select id="t-tipo"><option value="buy">Compra</option><option value="sell">Venda</option></select></div></div>
    <div class="row"><div><label class="fld">Data</label><input id="t-data" value="${hoje}"></div>
    <div><label class="fld">Quantidade</label><input id="t-qtd" placeholder="0"></div></div>
    <div class="row"><div><label class="fld">Preço unitário (moeda do ativo)</label><input id="t-preco" placeholder="0"></div>
    <div><label class="fld">Taxas</label><input id="t-taxas" value="0"></div></div>`,
    () => { Store.addTx({ asset_id: +mval('t-asset'), tipo: mval('t-tipo'), data: mval('t-data'), qtd: mnum('t-qtd') || 0, preco: mnum('t-preco') || 0, taxas: mnum('t-taxas') || 0 }); go('lotes'); });
}
function verLotes(assetId) {
  const a = Store.asset(assetId); const d = Engine.estadoLotes(Store.transactions(assetId));
  const lotes = d.lotes.map((l) => `<tr><td class="num">${esc(l.data)}</td><td class="num">${num(l.qtd)}</td><td class="num">${usd(l.preco)}</td>
    <td class="num">${l.idade_dias} d</td><td>${l.isento ? '<span class="badge green">isento</span>' : '<span class="badge amber">tributável</span>'}</td>
    <td class="num dim">${esc(l.desbloqueia)}</td></tr>`).join('');
  $('#lot-panel').innerHTML = `
    <div class="grid cols-3" style="margin:8px 0 4px">
      <div class="card"><div class="label">Qtd isenta (≥365d)</div><div class="big num pos">${num(d.qtd_isenta)}</div></div>
      <div class="card"><div class="label">Qtd tributável (28%)</div><div class="big num amber">${num(d.qtd_tributavel)}</div></div>
      <div class="card"><div class="label">Próximo desbloqueio</div><div class="big num">${d.proximo_desbloqueio || '—'}</div></div></div>
    <div class="tbl-wrap"><table><thead><tr><th>Data lote</th><th>Qtd</th><th>Preço</th><th>Idade</th><th>Estado</th><th>Desbloqueia</th></tr></thead>
      <tbody>${lotes || '<tr><td colspan="6" class="dim">Sem lotes em aberto.</td></tr>'}</tbody></table></div>
    <div class="row" style="margin-top:12px;align-items:flex-end">
      <div><label class="fld">Simular venda — qtd</label><input id="sv-qtd" placeholder="0"></div>
      <div><label class="fld">Preço de venda</label><input id="sv-preco" placeholder="0"></div>
      <div style="flex:0"><button class="primary" id="sv-go">Simular imposto (FIFO)</button></div></div>
    <div id="sv-out"></div>
    <div class="note">Derivados (perps) NÃO contam para os 365 dias e são tributados à parte.</div>
    <div class="note info">A Bybit reporta à AT (DAC8). Os teus dados são reportados.</div>`;
  $('#sv-go').onclick = () => {
    const r = Engine.simulaVenda(Store.transactions(assetId), mnum('sv-qtd'), mnum('sv-preco'));
    if (r.erro) { $('#sv-out').innerHTML = `<div class="note">${esc(r.erro)}</div>`; return; }
    const det = r.detalhe.map((x) => `<tr><td class="num">${esc(x.data_lote)}</td><td class="num">${num(x.qtd)}</td>
      <td class="num ${sgn(x.ganho)}">${num(x.ganho)}</td><td>${x.isento ? '<span class="badge green">isento</span>' : '<span class="badge amber">28%</span>'}</td>
      <td class="num ${x.imposto ? 'neg' : 'dim'}">${num(x.imposto)}</td></tr>`).join('');
    $('#sv-out').innerHTML = `<div class="grid cols-3" style="margin:10px 0">
      <div class="card"><div class="label">Ganho total</div><div class="big num ${sgn(r.ganho_total)}">${num(r.ganho_total)}</div></div>
      <div class="card"><div class="label">Ganho tributável</div><div class="big num amber">${num(r.ganho_tributavel)}</div><div class="small">isento: ${num(r.ganho_isento)}</div></div>
      <div class="card"><div class="label red">Imposto estimado (28%)</div><div class="big num neg">${num(r.imposto_estimado)}</div></div></div>
      <div class="tbl-wrap"><table><thead><tr><th>Lote</th><th>Qtd</th><th>Ganho</th><th>Estado</th><th>Imposto</th></tr></thead><tbody>${det}</tbody></table></div>
      <div class="note">${esc(r.aviso)}</div>`;
  };
}

// =====================================================================
// INVERSOS
// =====================================================================
views.inversos = function () {
  const fx = eurusd();
  const rows = Store.perps().map((p) => { const r = Engine.avaliaPerp(p.direcao, p.contrato, p.entrada, p.qtd, p.alavancagem, p.funding_acum, p.mark, p.mmr, fx);
    return `<tr><td><span class="sym">${esc(p.ativo)}</span> <span class="badge ${p.direcao === 'long' ? 'green' : 'red'}">${p.direcao}</span> <span class="badge dim">${p.contrato}</span></td>
      <td class="num">${p.entrada}</td><td class="num">${p.mark ?? '—'}</td>
      <td class="num red"><b>${r.liquidacao != null ? num(r.liquidacao, 4) : '—'}</b></td>
      <td class="num ${r.dist_liq_pct == null ? 'dim' : (Math.abs(r.dist_liq_pct) < 15 ? 'neg' : 'amber')}">${r.dist_liq_pct != null ? pct(r.dist_liq_pct) : '—'}</td>
      <td class="num">${p.alavancagem}×</td><td class="num dim">${num(r.funding_usd)}</td>
      <td class="num ${sgn(r.pnl_liq_usd)}">${r.pnl_liq_usd != null ? usd(r.pnl_liq_usd) : '—'}</td>
      <td class="num ${sgn(r.pnl_liq_eur)}">${r.pnl_liq_eur != null ? eur(r.pnl_liq_eur) : '—'}</td>
      <td class="num ${sgn(r.roi_margem_pct)}">${pct(r.roi_margem_pct)}</td>
      <td><button class="small" data-sim="${p.id}">sim</button> <button class="small" data-edit="${p.id}">edit</button> <button class="small danger" data-del="${p.id}">×</button></td></tr>`; }).join('');
  main.innerHTML = `<h1>Inversos &amp; alavancados</h1>
    <div class="sub">Liquidação sempre a vermelho · linear e inverso · funding subtraído</div>
    <div class="toolbar"><button class="primary" id="add-perp">+ Posição</button>
      <button id="sync-bybit">↻ Sincronizar da Bybit</button><span class="spinner" id="sync-st"></span></div>
    <div id="perp-live"></div>
    <h2>Posições manuais</h2>
    <div class="tbl-wrap"><table><thead><tr><th>Posição</th><th>Entrada</th><th>Mark</th><th>Liquidação</th><th>Dist.</th><th>Alav.</th><th>Funding</th><th>P&amp;L líq USD</th><th>P&amp;L líq EUR</th><th>ROI</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="11" class="dim">Sem posições.</td></tr>'}</tbody></table></div>
    <div id="perp-sim"></div>
    <div class="note">P&amp;L de derivados é SEPARADO do spot. Liquidação e funding são APROXIMAÇÕES (margem isolada; excluem taxas/margem de manutenção — na prática liquida antes).</div>`;
  renderPerpLive();
  $('#add-perp').onclick = () => perpModal();
  $('#sync-bybit').onclick = () => syncBybit($('#sync-st'));
  $$('[data-edit]').forEach((b) => b.onclick = () => perpModal(Store.perps().find((x) => x.id == b.dataset.edit)));
  $$('[data-del]').forEach((b) => b.onclick = () => { if (confirm('Apagar posição?')) { Store.deletePerp(+b.dataset.del); go('inversos'); } });
  $$('[data-sim]').forEach((b) => b.onclick = () => simPerp(Store.perps().find((x) => x.id == b.dataset.sim)));
};

// Sincroniza saldos + posições da Bybit (read-only, via proxy). Guarda snapshot
// separado do manual e re-renderiza os painéis "ao vivo" existentes.
async function syncBybit(stEl) {
  const cfg = (Store.settings().proxy_url || '').trim();
  if (!cfg) { if (stEl) stEl.textContent = 'proxy desligado'; alert('Liga o proxy read-only em Definições → Integrações.'); return; }
  if (stEl) stEl.textContent = 'a sincronizar…';
  const coins = [...new Set(Store.assets(true).map((a) => a.simbolo))];
  const [pos, sal] = await Promise.all([Data.posicoesLive(coins), Data.saldosSpot()]);
  if (pos.naoConfigurado || sal.naoConfigurado) { if (stEl) stEl.textContent = 'proxy desligado'; return; }
  const prev = Store.live() || {};
  Store.setLive({
    posicoes: pos.ok ? pos.posicoes : (prev.posicoes || []),
    saldos: sal.ok ? sal.saldos : (prev.saldos || []),
  });
  const errs = [pos.ok ? null : pos.erro, sal.ok ? null : sal.erro].filter(Boolean);
  if (stEl) stEl.textContent = `sincronizado ${new Date().toLocaleTimeString('pt-PT')}${errs.length ? ' · ' + errs.join('; ') : ''}`;
  if ($('#perp-live')) renderPerpLive();
  if ($('#tracker-live')) renderSaldosLive();
}

function renderPerpLive() {
  const el = $('#perp-live'); if (!el) return;
  const cfg = (Store.settings().proxy_url || '').trim();
  if (!cfg) { el.innerHTML = `<div class="note info">Portefólio ao vivo desligado. Liga o proxy read-only em <b>Definições → Integrações</b> para sincronizar posições da Bybit (sem pôr a chave no browser).</div>`; return; }
  const live = Store.live() || {}; const pos = live.posicoes || []; const fx = eurusd();
  const ts = live.ts ? new Date(live.ts).toLocaleString('pt-PT') : '—';
  const rows = pos.map((p) => {
    const pnlEur = p.pnl_usd != null ? p.pnl_usd * fx : null;
    const dist = (p.mark && p.liq) ? (p.mark - p.liq) / p.mark * 100 : null;
    return `<tr><td><span class="sym">${esc(p.ativo)}</span> <span class="badge ${p.direcao === 'long' ? 'green' : 'red'}">${p.direcao}</span> <span class="badge dim">${p.contrato}</span></td>
      <td class="num">${num(p.entrada, 6)}</td><td class="num">${num(p.mark, 6)}</td>
      <td class="num red"><b>${p.liq != null ? num(p.liq, 6) : '—'}</b></td>
      <td class="num ${dist == null ? 'dim' : (Math.abs(dist) < 15 ? 'neg' : 'amber')}">${dist != null ? pct(dist) : '—'}</td>
      <td class="num">${p.alavancagem ? p.alavancagem + '×' : '—'}</td><td class="num">${num(p.size)}</td>
      <td class="num ${sgn(p.pnl_usd)}">${p.pnl_usd != null ? usd(p.pnl_usd) : '—'}</td>
      <td class="num ${sgn(pnlEur)}">${pnlEur != null ? eur(pnlEur) : '—'}</td></tr>`;
  }).join('');
  el.innerHTML = `<h2>Ao vivo (Bybit) <span class="mini">· atualizado ${ts}</span></h2>
    <div class="tbl-wrap"><table><thead><tr><th>Posição</th><th>Entrada</th><th>Mark</th><th>Liquidação</th><th>Dist.</th><th>Alav.</th><th>Tamanho</th><th>P&amp;L USD</th><th>P&amp;L EUR</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="9" class="dim">Sem posições abertas (ou ainda não sincronizado). Carrega em "Sincronizar da Bybit".</td></tr>'}</tbody></table></div>
    <div class="mini">Valores autoritativos da Bybit (liqPrice, unrealisedPnl). Read-only — a app nunca coloca ordens.</div>`;
}
function perpModal(p) {
  const v = p || { ativo: '', direcao: 'long', contrato: 'inverse', entrada: '', qtd: '', margem: '', alavancagem: 2, funding_acum: 0, mmr: 0.005, mark: '', estado: 'aberta', owner: 'eu' };
  modal(p ? 'Editar posição' : 'Nova posição', `
    <div class="row"><div><label class="fld">Ativo</label><input id="p-ativo" value="${esc(v.ativo)}"></div>
    <div><label class="fld">Direção</label><select id="p-dir"><option value="long" ${v.direcao === 'long' ? 'selected' : ''}>long</option><option value="short" ${v.direcao === 'short' ? 'selected' : ''}>short</option></select></div>
    <div><label class="fld">Contrato</label><select id="p-contrato"><option value="linear" ${v.contrato === 'linear' ? 'selected' : ''}>linear (USDT)</option><option value="inverse" ${v.contrato === 'inverse' ? 'selected' : ''}>inverso (coin)</option></select></div></div>
    <div class="row"><div><label class="fld">Preço entrada</label><input id="p-entrada" value="${v.entrada}"></div>
    <div><label class="fld">Qtd <span class="mini">(linear: base; inverso: notional USD)</span></label><input id="p-qtd" value="${v.qtd}"></div></div>
    <div class="row"><div><label class="fld">Alavancagem</label><input id="p-alav" value="${v.alavancagem}"></div>
    <div><label class="fld">Margem (USD)</label><input id="p-margem" value="${v.margem ?? ''}"></div>
    <div><label class="fld">MMR</label><input id="p-mmr" value="${v.mmr}"></div></div>
    <div class="row"><div><label class="fld">Funding acumulado (USD)</label><input id="p-funding" value="${v.funding_acum}"></div>
    <div><label class="fld">Mark (manual)</label><input id="p-mark" value="${v.mark ?? ''}"></div></div>
    <div class="note">Liquidação aproximada (margem isolada; exclui taxas/margem de manutenção). Na prática liquida antes.</div>`,
    () => { const body = { ativo: mval('p-ativo'), direcao: mval('p-dir'), contrato: mval('p-contrato'), entrada: mnum('p-entrada') || 0,
      qtd: mnum('p-qtd') || 0, alavancagem: mnum('p-alav') || 1, margem: mnum('p-margem'), mmr: mnum('p-mmr') || 0.005,
      funding_acum: mnum('p-funding') || 0, mark: mnum('p-mark'), estado: v.estado || 'aberta', owner: v.owner || 'eu' };
      if (p) Store.updatePerp(p.id, body); else Store.addPerp(body); go('inversos'); });
}
function simPerp(p) {
  const base = p.mark || p.entrada; const precos = [0.8, 0.9, 1.0, 1.1, 1.2].map((f) => +(base * f).toPrecision(6));
  const sim = Engine.simulaSaidaPerp(p, precos, eurusd());
  const rows = sim.map((l) => `<tr><td class="num">${l.preco_saida}</td><td class="num ${sgn(l.pnl_liq_usd)}">${usd(l.pnl_liq_usd)}</td>
    <td class="num ${sgn(l.pnl_liq_eur)}">${eur(l.pnl_liq_eur)}</td><td class="num ${sgn(l.roi_margem_pct)}">${pct(l.roi_margem_pct)}</td></tr>`).join('');
  $('#perp-sim').innerHTML = `<h2>Simulação de saída — ${esc(p.ativo)} (${p.contrato})</h2>
    <div class="tbl-wrap"><table><thead><tr><th>Preço saída</th><th>P&amp;L líq USD</th><th>P&amp;L líq EUR</th><th>ROI margem</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  $('#perp-sim').scrollIntoView({ behavior: 'smooth' });
}

// =====================================================================
// CENÁRIOS
// =====================================================================
views.cenarios = function () {
  main.innerHTML = `<h1>Cenários — DCA linear vs DCA + reserva</h1>
    <div class="sub">Compara o RELATIVO entre estratégias sobre a MESMA trajetória. Não é previsão.</div>
    <div class="card">
      <div class="row"><div><label class="fld">Orçamento total (€)</label><input id="c-budget" value="6000"></div>
        <div><label class="fld">Fração base (0–1)</label><input id="c-base" value="0.6"></div></div>
      <div class="row"><div><label class="fld">Preço inicial</label><input id="c-p0" value="1.00"></div>
        <div><label class="fld">Períodos</label><input id="c-per" value="24"></div>
        <div><label class="fld">Cenário</label><select id="c-cen"><option value="base">base</option><option value="otimista">otimista</option><option value="pessimista">pessimista</option></select></div></div>
      <div class="row"><div><label class="fld">Ou trajetória própria (preços separados por vírgula) — opcional</label><input id="c-precos" placeholder="1.0, 0.85, 0.7, 0.9, 1.2 …"></div></div>
      <div class="toolbar" style="margin-top:12px"><button class="primary" id="c-go">Comparar</button></div></div>
    <div id="c-out"></div>`;
  $('#c-go').onclick = () => {
    const [e1, e2, e3] = escadas(); const budget = mnum('c-budget'); const baseFrac = mnum('c-base');
    let precos; const raw = mval('c-precos').trim();
    if (raw) precos = raw.split(',').map((x) => parseFloat(x.trim())).filter((x) => !isNaN(x));
    else precos = Engine.trajetoriaSintetica(mnum('c-p0'), mnum('c-per'), mval('c-cen'));
    if (!precos || precos.length < 2) { $('#c-out').innerHTML = '<div class="note">A trajetória precisa de pelo menos 2 preços.</div>'; return; }
    const r = Engine.comparaCenarios(precos, budget, baseFrac, e1, e2, e3); const L = r.linear, R = r.reserva, D = r.diferenca;
    $('#c-out').innerHTML = `<div class="grid cols-2" style="margin-top:16px">
      <div class="card"><div class="label">DCA linear</div><table>
        <tr><td>Investido</td><td class="num">${eur(L.investido)}</td></tr><tr><td>Unidades</td><td class="num">${num(L.unidades)}</td></tr>
        <tr><td>Preço médio</td><td class="num">${num(L.preco_medio)}</td></tr><tr><td>Valor final</td><td class="num">${eur(L.valor_final)}</td></tr></table></div>
      <div class="card"><div class="label">DCA + reserva</div><table>
        <tr><td>Investido</td><td class="num">${eur(R.investido)}</td></tr><tr><td>Unidades</td><td class="num">${num(R.unidades)}</td></tr>
        <tr><td>Preço médio</td><td class="num">${num(R.preco_medio)}</td></tr><tr><td>Valor final</td><td class="num">${eur(R.valor_final)}</td></tr>
        <tr><td>Reserva por gastar</td><td class="num dim">${eur(R.reserva_por_gastar)}</td></tr></table></div></div>
      <div class="card" style="margin-top:14px"><div class="label">Diferença (reserva − linear)</div>
        <div class="big num ${sgn(D.valor_final)}">${eur(D.valor_final)}</div>
        <div class="small">${num(D.unidades)} unidades · ${pct(D.unidades_pct)} mais unidades</div></div>
      <div class="note">${esc(r.aviso)}</div>`;
  };
};

// =====================================================================
// PPR
// =====================================================================
views.ppr = function () {
  const rows = Store.pprs().map((p) => { const pnl = p.valor - p.investido; const pnlPct = p.investido ? pnl / p.investido * 100 : null;
    return `<tr><td>${esc(p.nome)} <span class="badge dim">${esc(p.owner)}</span></td>
      <td class="num">${eur(p.investido)}</td><td class="num">${eur(p.valor)}</td>
      <td class="num ${sgn(pnl)}">${eur(pnl)}</td><td class="num ${sgn(pnlPct)}">${pct(pnlPct)}</td>
      <td class="num dim">${p.data_atualizacao || '—'}</td>
      <td><button class="small" data-editppr="${p.id}">edit</button> <button class="small" data-cot="${p.id}">↻ cotação</button></td></tr>`; }).join('');
  main.innerHTML = `<h1>PPR</h1>
    <div class="sub">Save &amp; Grow · titularidade distinta (Patrícia) · atualização manual</div>
    <div class="toolbar"><button class="primary" id="add-ppr">+ PPR</button></div>
    <div class="tbl-wrap"><table><thead><tr><th>Fundo</th><th>Investido</th><th>Valor</th><th>P&amp;L</th><th>P&amp;L %</th><th>Atualizado</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="7" class="dim">Sem PPR.</td></tr>'}</tbody></table></div>
    <div class="note info">PPR de titularidade DISTINTA (Patrícia). Não somar a mais-valia/dedução dela com a tua.</div>
    <div class="note">PPR tem fiscalidade própria (dedução à entrada com tetos; saída ~8,6% após 8 anos). Estimativa — não substitui contabilista.</div>`;
  $('#add-ppr').onclick = () => pprModal();
  $$('[data-editppr]').forEach((b) => b.onclick = () => pprModal(Store.pprs().find((x) => x.id == b.dataset.editppr)));
  $$('[data-cot]').forEach((b) => b.onclick = () => alert('Sem fonte pública fiável para o Save & Grow. Atualiza o valor manualmente (edit).'));
};
function pprModal(p) {
  const v = p || { nome: 'Save & Grow (Casa de Investimentos)', owner: 'patricia', investido: 0, valor: 0 };
  modal(p ? 'Editar PPR' : 'Novo PPR', `
    <div class="row"><div><label class="fld">Nome</label><input id="pp-nome" value="${esc(v.nome)}"></div></div>
    <div class="row"><div><label class="fld">Titular</label><input id="pp-owner" value="${esc(v.owner)}"></div></div>
    <div class="row"><div><label class="fld">Investido (€)</label><input id="pp-inv" value="${v.investido}"></div>
    <div><label class="fld">Valor atual (€)</label><input id="pp-val" value="${v.valor}"></div></div>`,
    () => { const body = { nome: mval('pp-nome'), owner: mval('pp-owner'), investido: mnum('pp-inv') || 0, valor: mnum('pp-val') || 0, data_atualizacao: Engine.iso(Engine.hojeUTC()) };
      if (p) Store.updatePpr(p.id, body); else Store.addPpr(body); go('ppr'); });
}

// =====================================================================
// DEFINIÇÕES
// =====================================================================
views.definicoes = function () {
  const s = S(); const mi = Store.mstrInputs() || {};
  const f = (k, lbl) => `<div><label class="fld">${lbl}</label><input id="s-${k}" value="${esc(s[k] ?? '')}"></div>`;
  main.innerHTML = `<h1>Definições</h1>
    <div class="sub">Câmbio, cadência DCA, escada, alvos e mNAV. Site estático: usa só dados PÚBLICOS. Sem chaves de API (uma chave secreta nunca pode viver no browser).</div>
    <h2>Câmbio &amp; estratégia</h2>
    <div class="card"><div class="row">${f('eur_usd', 'EUR/USD (1 USD = X €)')}${f('dca_cadencia', 'Cadência DCA')}${f('janela_topo_dias', 'Janela do topo (dias)')}</div>
      <div class="row" style="margin-top:10px">${f('escada_1', 'Escada 1× (% queda)')}${f('escada_2', 'Escada 2× (% queda)')}${f('escada_3', 'Escada 3× (% queda)')}</div>
      <div class="row" style="margin-top:10px">${f('mnav_favoravel', 'mNAV favorável ≤')}${f('mnav_travar', 'mNAV travar >')}${f('aviso_concentracao', 'Aviso concentração (%)')}</div></div>
    <h2>Alvos de alocação (%)</h2>
    <div class="card"><div class="row">${f('alvo_L1', 'L1')}${f('alvo_RWA', 'RWA')}${f('alvo_perp-DEX', 'perp-DEX')}${f('alvo_BTC-alavancado', 'BTC-alav.')}${f('alvo_PPR', 'PPR')}</div></div>
    <h2>Inputs mNAV (MSTR)</h2>
    <div class="card"><div class="row">
      <div><label class="fld">BTC em tesouraria</label><input id="mi-btc" value="${mi.btc_treasury ?? ''}"></div>
      <div><label class="fld">Ações em circulação</label><input id="mi-shares" value="${mi.shares_outstanding ?? ''}"></div>
      <div><label class="fld">Data</label><input id="mi-data" value="${mi.data ?? Engine.iso(Engine.hojeUTC())}"></div>
      <div style="flex:0"><button id="mi-save">Guardar mNAV</button></div></div>
      <div class="mini">Semi-manual: valores com data. O mNAV é calculado, não obtido.</div></div>
    <h2>Integrações — portefólio privado da Bybit (opcional)</h2>
    <div class="card">
      <div class="mini" style="margin-bottom:10px">Para ler saldos e posições da tua conta sem pôr o segredo no browser, usa um <b>proxy read-only</b> (Cloudflare Worker — vê <span class="num">proxy/README.md</span>). A chave Bybit vive no worker; aqui só entra o URL e um token de acesso ao proxy.</div>
      <div class="row"><div><label class="fld">URL do proxy</label><input id="s-proxy_url" value="${esc(s.proxy_url ?? '')}" placeholder="https://…workers.dev"></div></div>
      <div class="row" style="margin-top:10px"><div><label class="fld">Token do proxy (não é a chave Bybit)</label><input id="s-proxy_token" type="password" value="${esc(s.proxy_token ?? '')}" placeholder="token do worker"></div>
        <div style="flex:0"><button id="proxy-test">Testar ligação</button></div></div>
      <div id="proxy-st" class="mini" style="margin-top:8px"></div>
      <div class="note">Read-only: a app nunca coloca ordens. O worker só permite endpoints de leitura. Sem isto, o site funciona na mesma em modo manual.</div>
    </div>
    <h2>Dados &amp; backup</h2>
    <div class="card"><div class="mini" style="margin-bottom:10px">Os teus dados vivem no localStorage deste browser. Faz backup regularmente — limpar o browser apaga-os.</div>
      <div class="toolbar"><button id="b-export">⬇ Exportar backup (JSON)</button><button id="b-import">⬆ Importar backup</button><button class="danger" id="b-reset">Repor scaffold</button></div>
      <input type="file" id="b-file" accept="application/json" style="display:none"></div>
    <div class="toolbar" style="margin-top:18px"><button class="primary" id="s-save">Guardar definições</button><span class="spinner" id="s-st"></span></div>`;
  const keys = ['eur_usd', 'dca_cadencia', 'janela_topo_dias', 'escada_1', 'escada_2', 'escada_3', 'mnav_favoravel', 'mnav_travar', 'aviso_concentracao', 'alvo_L1', 'alvo_RWA', 'alvo_perp-DEX', 'alvo_BTC-alavancado', 'alvo_PPR', 'proxy_url', 'proxy_token'];
  $('#s-save').onclick = () => { const o = {}; keys.forEach((k) => o[k] = mval('s-' + k)); o.eur_usd_fonte = 'manual'; Store.setSettings(o); $('#s-st').textContent = 'guardado'; };
  $('#proxy-test').onclick = async () => {
    // guarda os valores atuais antes de testar (verificaChave lê das definições)
    Store.setSettings({ proxy_url: mval('s-proxy_url'), proxy_token: mval('s-proxy_token') });
    const st = $('#proxy-st'); st.textContent = 'a testar…';
    const r = await Data.verificaChave();
    if (!r.ok) { st.innerHTML = `<span class="red">falhou: ${esc(r.erro)}</span>`; return; }
    if (r.readonly) st.innerHTML = '<span class="pos">ligada · read-only ✓</span>';
    else st.innerHTML = `<span class="red">ligada, mas ${esc(r.aviso)}</span>`;
  };
  $('#mi-save').onclick = () => { Store.setMstrInputs({ btc_treasury: mnum('mi-btc'), shares_outstanding: mnum('mi-shares'), data: mval('mi-data') }); alert('Inputs mNAV guardados.'); };
  $('#b-export').onclick = () => { const blob = new Blob([Store.exportJSON()], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'consola-backup-' + Engine.iso(Engine.hojeUTC()) + '.json'; a.click(); };
  $('#b-import').onclick = () => $('#b-file').click();
  $('#b-file').onchange = (ev) => { const file = ev.target.files[0]; if (!file) return; const rd = new FileReader();
    rd.onload = () => { try { Store.importJSON(rd.result); alert('Backup importado.'); go('definicoes'); } catch (e) { alert('Ficheiro inválido: ' + e.message); } }; rd.readAsText(file); };
  $('#b-reset').onclick = () => { if (confirm('Repor o scaffold inicial? Isto apaga os teus dados neste browser.')) { Store.reset(); go('dashboard'); } };
};

// ---------- arranque ----------
go('dashboard');
