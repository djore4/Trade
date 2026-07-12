// Consola de Investimentos — frontend (vanilla JS, sem build step).
// Local-first, PT-PT. Estética de consola. Sem floreados.
'use strict';

// ---------- helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const main = $('#main');

async function api(method, path, body) {
  const opt = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opt.body = JSON.stringify(body);
  const r = await fetch('/api' + path, opt);
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).detail || msg; } catch (e) {}
    throw new Error(msg);
  }
  return r.status === 204 ? null : r.json();
}
const GET = (p) => api('GET', p);

const nf = new Intl.NumberFormat('pt-PT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf4 = new Intl.NumberFormat('pt-PT', { minimumFractionDigits: 0, maximumFractionDigits: 6 });
function eur(v) { return v == null ? '—' : nf.format(v) + ' €'; }
function usd(v) { return v == null ? '—' : '$' + nf.format(v); }
function num(v, d) { return v == null ? '—' : (d === undefined ? nf4 : new Intl.NumberFormat('pt-PT', { minimumFractionDigits: d, maximumFractionDigits: d })).format(v); }
function pct(v) { return v == null ? '—' : nf.format(v) + '%'; }
function sign(v) { return v == null ? '' : (v > 0 ? 'pos' : v < 0 ? 'neg' : 'dim'); }
function esc(s) { return (s ?? '').toString().replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// ---------- modal ----------
function modal(title, bodyHtml, onSave, saveLabel = 'Guardar') {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-bg"><div class="modal">
    <h3>${esc(title)}</h3><div id="modal-body">${bodyHtml}</div>
    <div class="modal-actions">
      <button id="m-cancel">Cancelar</button>
      ${onSave ? `<button class="primary" id="m-save">${esc(saveLabel)}</button>` : ''}
    </div></div></div>`;
  $('#m-cancel').onclick = () => root.innerHTML = '';
  if (onSave) $('#m-save').onclick = async () => {
    try { await onSave(); root.innerHTML = ''; } catch (e) { alert('Erro: ' + e.message); }
  };
}
function closeModal() { $('#modal-root').innerHTML = ''; }
function mval(id) { const e = $('#' + id); return e ? e.value : ''; }
function mnum(id) { const v = parseFloat(mval(id)); return isNaN(v) ? null : v; }

// ---------- router ----------
const views = {};
let assetsCache = [];

async function go(view) {
  $$('nav.side a').forEach(a => a.classList.toggle('active', a.dataset.view === view));
  main.innerHTML = '<div class="spinner">A carregar…</div>';
  try { await views[view](); }
  catch (e) { main.innerHTML = `<div class="note">Erro ao carregar: ${esc(e.message)}</div>`; }
}
$$('nav.side a').forEach(a => a.onclick = () => go(a.dataset.view));

// =====================================================================
// DASHBOARD
// =====================================================================
views.dashboard = async function () {
  const d = await GET('/dashboard');
  const b = d.buckets;
  const alloc = d.alocacao.map(a => `
    <tr>
      <td>${esc(a.quadrante)} ${a.concentracao ? '<span class="badge red">concentração</span>' : ''}</td>
      <td class="num">${eur(a.valor_eur)}</td>
      <td class="num">${pct(a.pct)}</td>
      <td class="num dim">${pct(a.alvo_pct)}</td>
      <td class="num ${sign(a.desvio)}">${a.desvio > 0 ? '+' : ''}${pct(a.desvio)}</td>
      <td style="width:120px"><div class="pill-alloc"><i style="width:${Math.min(100, a.pct)}%"></i></div></td>
    </tr>`).join('');
  const owners = d.por_titular.map(o => `
    <tr><td class="sym">${esc(o.owner)}</td>
      <td class="num">${eur(o.valor_eur)}</td>
      <td class="num">${eur(o.custo_eur)}</td>
      <td class="num ${sign(o.pnl_eur)}">${eur(o.pnl_eur)}</td>
      <td class="num ${sign(o.pnl_pct)}">${pct(o.pnl_pct)}</td></tr>`).join('');

  main.innerHTML = `
    <h1>Dashboard</h1>
    <div class="sub">Base EUR · câmbio 1 USD = ${num(d.eur_usd, 4)} €</div>
    <div class="grid cols-4">
      <div class="card"><div class="label">Cripto spot</div><div class="big num">${eur(b.cripto_spot)}</div></div>
      <div class="card"><div class="label">MSTR (BTC alav.)</div><div class="big num">${eur(b.mstr_btc_alavancado)}</div></div>
      <div class="card"><div class="label">PPR</div><div class="big num">${eur(b.ppr)}</div><div class="small">titularidade Patrícia</div></div>
      <div class="card"><div class="label red">Margem inversos (em risco)</div><div class="big num red">${eur(b.margem_inversos_em_risco)}</div><div class="small">fora do total</div></div>
    </div>
    <div class="grid cols-2" style="margin-top:14px">
      <div class="card"><div class="label">Valor total (EUR)</div><div class="big num">${eur(d.total_eur)}</div></div>
      <div class="card"><div class="label">P&amp;L agregado</div><div class="big num ${sign(d.pnl_total_eur)}">${eur(d.pnl_total_eur)}</div></div>
    </div>

    <h2>Alocação por quadrante vs alvo</h2>
    <div class="tbl-wrap"><table>
      <thead><tr><th>Quadrante</th><th>Valor</th><th>Atual</th><th>Alvo</th><th>Desvio</th><th></th></tr></thead>
      <tbody>${alloc || '<tr><td colspan="6" class="dim">Sem posições. Adiciona transações no Tracker/Lotes.</td></tr>'}</tbody>
    </table></div>

    <h2>P&amp;L por titular</h2>
    <div class="tbl-wrap"><table>
      <thead><tr><th>Titular</th><th>Valor</th><th>Custo</th><th>P&amp;L</th><th>P&amp;L %</th></tr></thead>
      <tbody>${owners || '<tr><td colspan="5" class="dim">—</td></tr>'}</tbody>
    </table></div>

    <div class="disclaimer">${esc(d.disclaimer)}</div>`;
};

// =====================================================================
// TRACKER
// =====================================================================
views.tracker = async function () {
  const d = await GET('/tracker');
  const rows = d.ativos.map(a => {
    const e = a.escada;
    const segCls = (n) => 'seg' + (e.multiplo >= n ? ' on' + n : '');
    const estadoBadge = {
      armado: 'green', aguarda: 'dim', pausado: 'red', sem_reserva: 'amber',
      limite: 'amber', sem_dados: 'dim'
    }[e.estado] || 'dim';
    let mnavCell = '';
    if (a.mnav) {
      const mc = { favoravel: 'green', travar: 'red', neutro: 'amber', sem_dados: 'dim' }[a.mnav.sinal] || 'dim';
      mnavCell = a.mnav.mnav != null ? `<span class="badge ${mc}">mNAV ${num(a.mnav.mnav, 2)}×</span>` : `<span class="badge dim">mNAV s/dados</span>`;
    }
    return `<tr>
      <td><span class="sym">${esc(a.simbolo)}</span> <span class="mini">${esc(a.quadrante || '')}</span> ${mnavCell}</td>
      <td class="num">${num(a.qtd)}</td>
      <td class="num dim">${a.custo_medio_eur != null ? eur(a.custo_medio_eur) : '—'}</td>
      <td class="num">${a.preco_eur != null ? eur(a.preco_eur) : '—'}</td>
      <td class="num ${e.drawdown_pct ? 'neg' : 'dim'}">${e.drawdown_pct != null ? '-' + pct(e.drawdown_pct) : '—'}</td>
      <td class="num">${eur(a.valor_eur)}</td>
      <td class="num ${sign(a.pnl_eur)}">${eur(a.pnl_eur)}</td>
      <td class="num ${sign(a.pnl_pct)}">${pct(a.pnl_pct)}</td>
      <td><div class="ladder"><div class="${segCls(1)}"></div><div class="${segCls(2)}"></div><div class="${segCls(3)}"></div></div></td>
      <td><span class="badge ${estadoBadge}">${e.sugestao > 0 ? eur(e.sugestao) : esc(e.estado)}</span></td>
      <td><button class="small" data-reserva="${a.asset_id}">reserva</button></td>
    </tr>`;
  }).join('');

  main.innerHTML = `
    <h1>Tracker</h1>
    <div class="sub">Spot + MSTR · escada de quedas, reserva e sinal mNAV</div>
    <div class="toolbar">
      <button class="primary" id="refresh">↻ Atualizar preços</button>
      <span class="spinner" id="refresh-st"></span>
    </div>
    <div class="tbl-wrap"><table>
      <thead><tr><th>Ativo</th><th>Qtd</th><th>Custo médio</th><th>Preço</th><th>Queda</th><th>Valor</th>
        <th>P&amp;L</th><th>P&amp;L %</th><th>Escada</th><th>Sugestão</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="11" class="dim">Sem ativos.</td></tr>'}</tbody>
    </table></div>
    <div class="note">${esc(d.aviso_custo_medio)}</div>
    ${d.ativos.filter(a => a.escada.motivo).map(a => `<div class="mini">· <b>${esc(a.simbolo)}</b>: ${esc(a.escada.motivo)}</div>`).join('')}
    <div class="disclaimer">Sugestões seguem a TUA regra pré-definida (não são recomendações). Números de mercado podem estar desatualizados — atualiza preços.</div>`;

  $('#refresh').onclick = async () => {
    $('#refresh-st').textContent = 'a atualizar…';
    try { const r = await api('POST', '/refresh-precos'); $('#refresh-st').textContent = 'atualizado ' + new Date().toLocaleTimeString('pt-PT'); await go('tracker'); }
    catch (e) { $('#refresh-st').textContent = 'falhou: ' + e.message; }
  };
  $$('[data-reserva]').forEach(btn => btn.onclick = () => reservaModal(+btn.dataset.reserva, d.ativos.find(x => x.asset_id == btn.dataset.reserva)));
};

function reservaModal(assetId, a) {
  const r = a.reserva;
  modal(`Reserva — ${a.simbolo}`, `
    <div class="row">
      <div><label class="fld">Compra base (€)</label><input id="r-base" value="${r.base_amount}"></div>
      <div><label class="fld">Reserva total (€)</label><input id="r-total" value="${r.total}"></div>
    </div>
    <div class="row">
      <div><label class="fld">Já gasto (€)</label><input id="r-gasto" value="${r.gasto}"></div>
      <div><label class="fld">Máx. acionamentos</label><input id="r-max" value="${r.max_triggers}"></div>
      <div><label class="fld">Acionamentos usados</label><input id="r-used" value="${r.triggers_used}"></div>
    </div>
    <hr class="sep">
    <div class="row"><div>
      <label class="fld">Kill-switch (pausar reforços)</label>
      <select id="r-kill"><option value="0" ${!r.killswitch ? 'selected' : ''}>Desligado — queda de mercado (comprar)</option>
      <option value="1" ${r.killswitch ? 'selected' : ''}>Ligado — tese partida (pausar)</option></select>
    </div></div>
    <div class="row"><div><label class="fld">Motivo do kill-switch</label><input id="r-motivo" value="${esc(r.killswitch_motivo || '')}"></div></div>
    <div class="note">Restante: <b>${eur(Math.max(0, r.total - r.gasto))}</b>. A app nunca sugere acima do restante.</div>
  `, async () => {
    await api('PUT', '/reserve/' + assetId, {
      base_amount: mnum('r-base'), total: mnum('r-total'), gasto: mnum('r-gasto'),
      max_triggers: mnum('r-max'), triggers_used: mnum('r-used'),
      killswitch: mval('r-kill') === '1', killswitch_motivo: mval('r-motivo'),
    });
    await go('tracker');
  });
}

// =====================================================================
// LOTES & FISCAL
// =====================================================================
views.lotes = async function () {
  assetsCache = await GET('/assets');
  const txs = await GET('/transactions');
  const opts = assetsCache.map(a => `<option value="${a.id}">${esc(a.simbolo)}</option>`).join('');
  const rows = txs.map(t => `<tr>
    <td class="sym">${esc(t.simbolo)}</td>
    <td><span class="badge ${t.tipo === 'buy' ? 'green' : 'red'}">${t.tipo === 'buy' ? 'compra' : 'venda'}</span></td>
    <td class="num">${esc(t.data)}</td>
    <td class="num">${num(t.qtd)}</td>
    <td class="num">${usd(t.preco)}</td>
    <td class="num dim">${num(t.taxas)}</td>
    <td><button class="small danger" data-deltx="${t.id}">×</button></td></tr>`).join('');

  main.innerHTML = `
    <h1>Lotes &amp; Fiscal</h1>
    <div class="sub">Registo lote a lote · regra dos 365 dias · FIFO · Portugal</div>
    <div class="toolbar">
      <button class="primary" id="add-tx">+ Transação</button>
      <select id="lot-asset" style="width:auto">${opts}</select>
      <button id="ver-lotes">Ver lotes &amp; simular venda</button>
    </div>
    <div id="lot-panel"></div>
    <h2>Transações</h2>
    <div class="tbl-wrap"><table>
      <thead><tr><th>Ativo</th><th>Tipo</th><th>Data</th><th>Qtd</th><th>Preço</th><th>Taxas</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="7" class="dim">Sem transações.</td></tr>'}</tbody>
    </table></div>
    <div class="disclaimer">Derivados NÃO contam para os 365 dias e são tributados à parte. A Bybit reporta à AT (DAC8). Estimativas — não substituem contabilista.</div>`;

  $('#add-tx').onclick = () => txModal(opts);
  $('#ver-lotes').onclick = () => verLotes(+$('#lot-asset').value);
  $$('[data-deltx]').forEach(b => b.onclick = async () => { if (confirm('Apagar transação?')) { await api('DELETE', '/transactions/' + b.dataset.deltx); go('lotes'); } });
};

function txModal(opts) {
  const hoje = new Date().toISOString().slice(0, 10);
  modal('Nova transação', `
    <div class="row">
      <div><label class="fld">Ativo</label><select id="t-asset">${opts}</select></div>
      <div><label class="fld">Tipo</label><select id="t-tipo"><option value="buy">Compra</option><option value="sell">Venda</option></select></div>
    </div>
    <div class="row">
      <div><label class="fld">Data</label><input id="t-data" value="${hoje}"></div>
      <div><label class="fld">Quantidade</label><input id="t-qtd" placeholder="0"></div>
    </div>
    <div class="row">
      <div><label class="fld">Preço unitário (moeda do ativo)</label><input id="t-preco" placeholder="0"></div>
      <div><label class="fld">Taxas</label><input id="t-taxas" value="0"></div>
    </div>
  `, async () => {
    await api('POST', '/transactions', {
      asset_id: +mval('t-asset'), tipo: mval('t-tipo'), data: mval('t-data'),
      qtd: mnum('t-qtd'), preco: mnum('t-preco'), taxas: mnum('t-taxas') || 0,
    });
    await go('lotes');
  });
}

async function verLotes(assetId) {
  const d = await GET('/lots/' + assetId);
  const lotes = d.lotes.map(l => `<tr>
    <td class="num">${esc(l.data)}</td>
    <td class="num">${num(l.qtd)}</td>
    <td class="num">${usd(l.preco)}</td>
    <td class="num">${l.idade_dias} d</td>
    <td>${l.isento ? '<span class="badge green">isento</span>' : '<span class="badge amber">tributável</span>'}</td>
    <td class="num dim">${esc(l.desbloqueia)}</td></tr>`).join('');
  $('#lot-panel').innerHTML = `
    <div class="grid cols-3" style="margin:8px 0 4px">
      <div class="card"><div class="label">Qtd isenta (≥365d)</div><div class="big num pos">${num(d.qtd_isenta)}</div></div>
      <div class="card"><div class="label">Qtd tributável (28%)</div><div class="big num amber">${num(d.qtd_tributavel)}</div></div>
      <div class="card"><div class="label">Próximo desbloqueio</div><div class="big num">${d.proximo_desbloqueio || '—'}</div></div>
    </div>
    <div class="tbl-wrap"><table>
      <thead><tr><th>Data lote</th><th>Qtd</th><th>Preço</th><th>Idade</th><th>Estado</th><th>Desbloqueia</th></tr></thead>
      <tbody>${lotes || '<tr><td colspan="6" class="dim">Sem lotes em aberto.</td></tr>'}</tbody></table></div>
    <div class="row" style="margin-top:12px;align-items:flex-end">
      <div><label class="fld">Simular venda — qtd</label><input id="sv-qtd" placeholder="0"></div>
      <div><label class="fld">Preço de venda</label><input id="sv-preco" placeholder="0"></div>
      <div style="flex:0"><button class="primary" id="sv-go">Simular imposto (FIFO)</button></div>
    </div>
    <div id="sv-out"></div>
    <div class="note">${esc(d.nota_derivados)}</div>
    <div class="note info">${esc(d.nota_dac8)}</div>`;
  $('#sv-go').onclick = async () => {
    try {
      const r = await api('POST', '/lots/' + assetId + '/simular-venda', { qtd: mnum('sv-qtd'), preco: mnum('sv-preco') });
      const det = r.detalhe.map(x => `<tr><td class="num">${esc(x.data_lote)}</td><td class="num">${num(x.qtd)}</td>
        <td class="num ${sign(x.ganho)}">${num(x.ganho)}</td><td>${x.isento ? '<span class="badge green">isento</span>' : '<span class="badge amber">28%</span>'}</td>
        <td class="num ${x.imposto ? 'neg' : 'dim'}">${num(x.imposto)}</td></tr>`).join('');
      $('#sv-out').innerHTML = `
        <div class="grid cols-3" style="margin:10px 0">
          <div class="card"><div class="label">Ganho total</div><div class="big num ${sign(r.ganho_total)}">${num(r.ganho_total)}</div></div>
          <div class="card"><div class="label">Ganho tributável</div><div class="big num amber">${num(r.ganho_tributavel)}</div><div class="small">isento: ${num(r.ganho_isento)}</div></div>
          <div class="card"><div class="label red">Imposto estimado (28%)</div><div class="big num neg">${num(r.imposto_estimado)}</div></div>
        </div>
        <div class="tbl-wrap"><table><thead><tr><th>Lote</th><th>Qtd</th><th>Ganho</th><th>Estado</th><th>Imposto</th></tr></thead><tbody>${det}</tbody></table></div>
        <div class="note">${esc(r.aviso)}</div>`;
    } catch (e) { $('#sv-out').innerHTML = `<div class="note">${esc(e.message)}</div>`; }
  };
}

// =====================================================================
// INVERSOS
// =====================================================================
views.inversos = async function () {
  const d = await GET('/perps');
  const rows = d.posicoes.map(p => `<tr>
    <td><span class="sym">${esc(p.ativo)}</span> <span class="badge ${p.direcao === 'long' ? 'green' : 'red'}">${p.direcao}</span> <span class="badge dim">${p.contrato}</span></td>
    <td class="num">${p.entrada}</td>
    <td class="num">${p.mark ?? '—'}</td>
    <td class="num red"><b>${p.liquidacao != null ? num(p.liquidacao, 4) : '—'}</b></td>
    <td class="num ${p.dist_liq_pct == null ? 'dim' : (Math.abs(p.dist_liq_pct) < 15 ? 'neg' : 'amber')}">${p.dist_liq_pct != null ? pct(p.dist_liq_pct) : '—'}</td>
    <td class="num">${p.alavancagem}×</td>
    <td class="num dim">${num(p.funding_usd)}</td>
    <td class="num ${sign(p.pnl_liq_usd)}">${p.pnl_liq_usd != null ? usd(p.pnl_liq_usd) : '—'}</td>
    <td class="num ${sign(p.pnl_liq_eur)}">${p.pnl_liq_eur != null ? eur(p.pnl_liq_eur) : '—'}</td>
    <td class="num ${sign(p.roi_margem_pct)}">${pct(p.roi_margem_pct)}</td>
    <td><button class="small" data-simperp="${p.id}">sim</button> <button class="small" data-editperp="${p.id}">edit</button> <button class="small danger" data-delperp="${p.id}">×</button></td>
  </tr>`).join('');

  main.innerHTML = `
    <h1>Inversos &amp; alavancados</h1>
    <div class="sub">Liquidação sempre visível a vermelho · linear e inverso · funding subtraído</div>
    <div class="toolbar"><button class="primary" id="add-perp">+ Posição</button></div>
    <div class="tbl-wrap"><table>
      <thead><tr><th>Posição</th><th>Entrada</th><th>Mark</th><th>Liquidação</th><th>Dist.</th><th>Alav.</th><th>Funding</th><th>P&amp;L líq USD</th><th>P&amp;L líq EUR</th><th>ROI</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="11" class="dim">Sem posições.</td></tr>'}</tbody></table></div>
    <div id="perp-sim"></div>
    <div class="note">${esc(d.aviso)}</div>`;

  $('#add-perp').onclick = () => perpModal();
  $$('[data-editperp]').forEach(b => b.onclick = () => perpModal(d.posicoes.find(x => x.id == b.dataset.editperp)));
  $$('[data-delperp]').forEach(b => b.onclick = async () => { if (confirm('Apagar posição?')) { await api('DELETE', '/perps/' + b.dataset.delperp); go('inversos'); } });
  $$('[data-simperp]').forEach(b => b.onclick = () => simPerp(d.posicoes.find(x => x.id == b.dataset.simperp)));
};

function perpModal(p) {
  const v = p || { ativo: '', direcao: 'long', contrato: 'inverse', entrada: '', qtd: '', margem: '', alavancagem: 2, funding_acum: 0, mmr: 0.005, mark: '' };
  modal(p ? 'Editar posição' : 'Nova posição', `
    <div class="row">
      <div><label class="fld">Ativo</label><input id="p-ativo" value="${esc(v.ativo)}"></div>
      <div><label class="fld">Direção</label><select id="p-dir"><option value="long" ${v.direcao === 'long' ? 'selected' : ''}>long</option><option value="short" ${v.direcao === 'short' ? 'selected' : ''}>short</option></select></div>
      <div><label class="fld">Contrato</label><select id="p-contrato"><option value="linear" ${v.contrato === 'linear' ? 'selected' : ''}>linear (USDT)</option><option value="inverse" ${v.contrato === 'inverse' ? 'selected' : ''}>inverso (coin)</option></select></div>
    </div>
    <div class="row">
      <div><label class="fld">Preço entrada</label><input id="p-entrada" value="${v.entrada}"></div>
      <div><label class="fld">Qtd <span class="mini">(linear: base; inverso: notional USD)</span></label><input id="p-qtd" value="${v.qtd}"></div>
    </div>
    <div class="row">
      <div><label class="fld">Alavancagem</label><input id="p-alav" value="${v.alavancagem}"></div>
      <div><label class="fld">Margem (USD)</label><input id="p-margem" value="${v.margem ?? ''}"></div>
      <div><label class="fld">MMR</label><input id="p-mmr" value="${v.mmr}"></div>
    </div>
    <div class="row">
      <div><label class="fld">Funding acumulado (USD)</label><input id="p-funding" value="${v.funding_acum}"></div>
      <div><label class="fld">Mark (manual)</label><input id="p-mark" value="${v.mark ?? ''}"></div>
    </div>
    <div class="note">Liquidação é aproximada (margem isolada; exclui taxas/margem de manutenção). Na prática liquida antes.</div>
  `, async () => {
    const body = {
      ativo: mval('p-ativo'), direcao: mval('p-dir'), contrato: mval('p-contrato'),
      entrada: mnum('p-entrada'), qtd: mnum('p-qtd') || 0, alavancagem: mnum('p-alav') || 1,
      margem: mnum('p-margem'), mmr: mnum('p-mmr') || 0.005, funding_acum: mnum('p-funding') || 0,
      mark: mnum('p-mark'),
    };
    if (p) await api('PUT', '/perps/' + p.id, body); else await api('POST', '/perps', body);
    await go('inversos');
  });
}

function simPerp(p) {
  const base = p.mark || p.entrada;
  const precos = [0.8, 0.9, 1.0, 1.1, 1.2].map(f => +(base * f).toPrecision(6));
  api('POST', '/perps/' + p.id + '/simular', { precos_saida: precos }).then(r => {
    const rows = r.simulacao.map(l => `<tr><td class="num">${l.preco_saida}</td>
      <td class="num ${sign(l.pnl_liq_usd)}">${usd(l.pnl_liq_usd)}</td>
      <td class="num ${sign(l.pnl_liq_eur)}">${eur(l.pnl_liq_eur)}</td>
      <td class="num ${sign(l.roi_margem_pct)}">${pct(l.roi_margem_pct)}</td></tr>`).join('');
    $('#perp-sim').innerHTML = `<h2>Simulação de saída — ${esc(p.ativo)} (${p.contrato})</h2>
      <div class="tbl-wrap"><table><thead><tr><th>Preço saída</th><th>P&amp;L líq USD</th><th>P&amp;L líq EUR</th><th>ROI margem</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    $('#perp-sim').scrollIntoView({ behavior: 'smooth' });
  }).catch(e => alert(e.message));
}

// =====================================================================
// CENÁRIOS
// =====================================================================
views.cenarios = async function () {
  main.innerHTML = `
    <h1>Cenários — DCA linear vs DCA + reserva</h1>
    <div class="sub">Compara o RELATIVO entre estratégias sobre a MESMA trajetória. Não é previsão.</div>
    <div class="card">
      <div class="row">
        <div><label class="fld">Orçamento total (€)</label><input id="c-budget" value="6000"></div>
        <div><label class="fld">Fração base (0–1)</label><input id="c-base" value="0.6"></div>
      </div>
      <div class="row">
        <div><label class="fld">Preço inicial</label><input id="c-p0" value="1.00"></div>
        <div><label class="fld">Períodos</label><input id="c-per" value="24"></div>
        <div><label class="fld">Cenário</label><select id="c-cen"><option value="base">base</option><option value="otimista">otimista</option><option value="pessimista">pessimista</option></select></div>
      </div>
      <div class="row"><div><label class="fld">Ou trajetória própria (preços separados por vírgula) — opcional</label><input id="c-precos" placeholder="1.0, 0.85, 0.7, 0.9, 1.2 …"></div></div>
      <div class="toolbar" style="margin-top:12px"><button class="primary" id="c-go">Comparar</button></div>
    </div>
    <div id="c-out"></div>`;
  $('#c-go').onclick = async () => {
    const body = { budget: mnum('c-budget'), base_frac: mnum('c-base') };
    const precos = mval('c-precos').trim();
    if (precos) body.precos = precos.split(',').map(x => parseFloat(x.trim())).filter(x => !isNaN(x));
    else { body.preco_inicial = mnum('c-p0'); body.periodos = mnum('c-per'); body.cenario = mval('c-cen'); }
    try {
      const r = await api('POST', '/scenarios/comparar', body);
      const L = r.linear, R = r.reserva, D = r.diferenca;
      $('#c-out').innerHTML = `
        <div class="grid cols-2" style="margin-top:16px">
          <div class="card"><div class="label">DCA linear</div>
            <table><tr><td>Investido</td><td class="num">${eur(L.investido)}</td></tr>
            <tr><td>Unidades</td><td class="num">${num(L.unidades)}</td></tr>
            <tr><td>Preço médio</td><td class="num">${num(L.preco_medio)}</td></tr>
            <tr><td>Valor final</td><td class="num">${eur(L.valor_final)}</td></tr></table></div>
          <div class="card"><div class="label">DCA + reserva</div>
            <table><tr><td>Investido</td><td class="num">${eur(R.investido)}</td></tr>
            <tr><td>Unidades</td><td class="num">${num(R.unidades)}</td></tr>
            <tr><td>Preço médio</td><td class="num">${num(R.preco_medio)}</td></tr>
            <tr><td>Valor final</td><td class="num">${eur(R.valor_final)}</td></tr>
            <tr><td>Reserva por gastar</td><td class="num dim">${eur(R.reserva_por_gastar)}</td></tr></table></div>
        </div>
        <div class="card" style="margin-top:14px"><div class="label">Diferença (reserva − linear)</div>
          <div class="big num ${sign(D.valor_final)}">${eur(D.valor_final)}</div>
          <div class="small">${num(D.unidades)} unidades · ${pct(D.unidades_pct)} mais unidades</div></div>
        <div class="note">${esc(r.aviso)}</div>`;
    } catch (e) { $('#c-out').innerHTML = `<div class="note">${esc(e.message)}</div>`; }
  };
};

// =====================================================================
// PPR
// =====================================================================
views.ppr = async function () {
  const d = await GET('/ppr');
  const rows = d.pprs.map(p => `<tr>
    <td>${esc(p.nome)} <span class="badge dim">${esc(p.owner)}</span></td>
    <td class="num">${eur(p.investido)}</td>
    <td class="num">${eur(p.valor)}</td>
    <td class="num ${sign(p.pnl)}">${eur(p.pnl)}</td>
    <td class="num ${sign(p.pnl_pct)}">${pct(p.pnl_pct)}</td>
    <td class="num dim">${p.data_atualizacao || '—'}</td>
    <td><button class="small" data-editppr="${p.id}">edit</button> <button class="small" data-cotppr="${p.id}">↻ cotação</button></td></tr>`).join('');
  main.innerHTML = `
    <h1>PPR</h1>
    <div class="sub">Save &amp; Grow · titularidade distinta (Patrícia) · atualização manual</div>
    <div class="toolbar"><button class="primary" id="add-ppr">+ PPR</button></div>
    <div class="tbl-wrap"><table>
      <thead><tr><th>Fundo</th><th>Investido</th><th>Valor</th><th>P&amp;L</th><th>P&amp;L %</th><th>Atualizado</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="7" class="dim">Sem PPR.</td></tr>'}</tbody></table></div>
    <div class="note info">${esc(d.nota_titularidade)}</div>
    <div class="note">${esc(d.nota_fiscal)}</div>`;
  $('#add-ppr').onclick = () => pprModal();
  $$('[data-editppr]').forEach(b => b.onclick = () => pprModal(d.pprs.find(x => x.id == b.dataset.editppr)));
  $$('[data-cotppr]').forEach(b => b.onclick = async () => {
    const r = await api('POST', '/ppr/' + b.dataset.cotppr + '/atualizar-cotacao');
    alert(r.ok ? 'Cotação atualizada.' : (r.erro || 'Sem fonte automática — atualiza manualmente.'));
  });
};

function pprModal(p) {
  const v = p || { nome: 'Save & Grow (Casa de Investimentos)', owner: 'patricia', investido: 0, valor: 0 };
  modal(p ? 'Editar PPR' : 'Novo PPR', `
    <div class="row"><div><label class="fld">Nome</label><input id="pp-nome" value="${esc(v.nome)}"></div></div>
    <div class="row"><div><label class="fld">Titular</label><input id="pp-owner" value="${esc(v.owner)}"></div></div>
    <div class="row">
      <div><label class="fld">Investido (€)</label><input id="pp-inv" value="${v.investido}"></div>
      <div><label class="fld">Valor atual (€)</label><input id="pp-val" value="${v.valor}"></div>
    </div>
  `, async () => {
    const body = { nome: mval('pp-nome'), owner: mval('pp-owner'), investido: mnum('pp-inv') || 0, valor: mnum('pp-val') || 0 };
    if (p) await api('PUT', '/ppr/' + p.id, body); else await api('POST', '/ppr', body);
    await go('ppr');
  });
}

// =====================================================================
// DEFINIÇÕES
// =====================================================================
views.definicoes = async function () {
  const s = await GET('/settings');
  const st = await GET('/integrations/status');
  const mi = await GET('/mstr-inputs');
  const f = (k, lbl) => `<div><label class="fld">${lbl}</label><input id="s-${k}" value="${esc(s[k] ?? '')}"></div>`;
  const intg = Object.entries(st).map(([k, v]) => {
    let badge = v.ligada ? '<span class="badge green">ligada</span>' : '<span class="badge dim">manual</span>';
    if (k === 'bybit' && v.ligada) badge = v.readonly === false ? '<span class="badge red">verificar permissões!</span>' : v.readonly ? '<span class="badge green">ligada · read-only</span>' : '<span class="badge amber">ligada</span>';
    return `<tr><td class="sym">${k}</td><td>${badge}</td><td class="mini">${esc(v.fonte || v.aviso || '')}</td></tr>`;
  }).join('');

  main.innerHTML = `
    <h1>Definições</h1>
    <div class="sub">Câmbio, cadência DCA, escada, alvos e integrações. As chaves de API vivem em <span class="num">.env</span> — nunca são mostradas aqui.</div>

    <h2>Câmbio &amp; estratégia</h2>
    <div class="card"><div class="row">
      ${f('eur_usd', 'EUR/USD (1 USD = X €)')}
      ${f('dca_cadencia', 'Cadência DCA')}
      ${f('janela_topo_dias', 'Janela do topo (dias)')}
    </div><div class="row" style="margin-top:10px">
      ${f('escada_1', 'Escada 1× (% queda)')}
      ${f('escada_2', 'Escada 2× (% queda)')}
      ${f('escada_3', 'Escada 3× (% queda)')}
    </div><div class="row" style="margin-top:10px">
      ${f('mnav_favoravel', 'mNAV favorável ≤')}
      ${f('mnav_travar', 'mNAV travar >')}
      ${f('aviso_concentracao', 'Aviso concentração (%)')}
    </div></div>

    <h2>Alvos de alocação (%)</h2>
    <div class="card"><div class="row">
      ${f('alvo_L1', 'L1')}${f('alvo_RWA', 'RWA')}${f('alvo_perp-DEX', 'perp-DEX')}${f('alvo_BTC-alavancado', 'BTC-alav.')}${f('alvo_PPR', 'PPR')}
    </div></div>

    <h2>Inputs mNAV (MSTR)</h2>
    <div class="card"><div class="row">
      <div><label class="fld">BTC em tesouraria</label><input id="mi-btc" value="${mi.btc_treasury ?? ''}"></div>
      <div><label class="fld">Ações em circulação</label><input id="mi-shares" value="${mi.shares_outstanding ?? ''}"></div>
      <div><label class="fld">Data</label><input id="mi-data" value="${mi.data ?? new Date().toISOString().slice(0,10)}"></div>
      <div style="flex:0"><button id="mi-save">Guardar mNAV</button></div>
    </div><div class="mini">Semi-manual: valores com data de atualização. O mNAV é calculado, não obtido.</div></div>

    <h2>Integrações</h2>
    <div class="tbl-wrap"><table><thead><tr><th>Fonte</th><th>Estado</th><th>Nota</th></tr></thead><tbody>${intg}</tbody></table></div>
    <div class="note">Read-only: a app nunca coloca ordens nem move fundos. Cria chaves Bybit SÓ DE LEITURA.</div>

    <div class="toolbar" style="margin-top:18px"><button class="primary" id="s-save">Guardar definições</button><span class="spinner" id="s-st"></span></div>`;

  const keys = ['eur_usd', 'dca_cadencia', 'janela_topo_dias', 'escada_1', 'escada_2', 'escada_3',
    'mnav_favoravel', 'mnav_travar', 'aviso_concentracao', 'alvo_L1', 'alvo_RWA', 'alvo_perp-DEX', 'alvo_BTC-alavancado', 'alvo_PPR'];
  $('#s-save').onclick = async () => {
    const valores = {}; keys.forEach(k => valores[k] = mval('s-' + k));
    valores['eur_usd_fonte'] = 'manual';
    await api('PUT', '/settings', { valores });
    $('#s-st').textContent = 'guardado';
  };
  $('#mi-save').onclick = async () => {
    await api('POST', '/mstr-inputs', { btc_treasury: mnum('mi-btc'), shares_outstanding: mnum('mi-shares'), data: mval('mi-data') });
    alert('Inputs mNAV guardados.');
  };
};

// ---------- arranque ----------
go('dashboard');
