// Persistência local no browser (localStorage). Os dados são teus e ficam na tua
// máquina/browser. Export/import JSON para backup (o browser pode ser limpo).
// Sem segredos: nunca guardamos chaves de API aqui.
'use strict';

const Store = (() => {
  const KEY = 'consola_investimentos_v1';

  const DEFAULT_SETTINGS = {
    eur_usd: '0.92', eur_usd_fonte: 'manual', dca_cadencia: 'quinzenal', janela_topo_dias: '75',
    escada_1: '15', escada_2: '25', escada_3: '35', mnav_favoravel: '1.1', mnav_travar: '2.0',
    alvo_L1: '30', alvo_RWA: '15', 'alvo_perp-DEX': '15', 'alvo_BTC-alavancado': '25', alvo_PPR: '15',
    aviso_concentracao: '40',
  };

  function seed() {
    // Scaffold da carteira (§1). Sem valores inventados: quantidades/preços/cotações a 0.
    return {
      accounts: [
        { id: 1, nome: 'Bybit', tipo: 'spot', owner: 'eu' },
        { id: 2, nome: 'Bybit (derivados)', tipo: 'derivados', owner: 'eu' },
        { id: 3, nome: 'Trading 212', tipo: 'acao', owner: 'eu' },
        { id: 4, nome: 'PPR', tipo: 'ppr', owner: 'patricia' },
      ],
      assets: [
        { id: 1, simbolo: 'ADA', nome: 'Cardano', moeda: 'USD', quadrante: 'L1', account_id: 1, owner: 'eu', ativo: 1 },
        { id: 2, simbolo: 'NEAR', nome: 'NEAR Protocol', moeda: 'USD', quadrante: 'L1', account_id: 1, owner: 'eu', ativo: 1 },
        { id: 3, simbolo: 'ONDO', nome: 'Ondo Finance', moeda: 'USD', quadrante: 'RWA', account_id: 1, owner: 'eu', ativo: 1 },
        { id: 4, simbolo: 'HYPE', nome: 'Hyperliquid', moeda: 'USD', quadrante: 'perp-DEX', account_id: 1, owner: 'eu', ativo: 1 },
        { id: 5, simbolo: 'JUP', nome: 'Jupiter', moeda: 'USD', quadrante: 'perp-DEX', account_id: 1, owner: 'eu', ativo: 1 },
        { id: 6, simbolo: 'MSTR', nome: 'MicroStrategy (BTC alavancado)', moeda: 'USD', quadrante: 'BTC-alavancado', account_id: 3, owner: 'eu', ativo: 1 },
      ],
      transactions: [],
      perps: [],
      ppr: [{ id: 1, nome: 'Save & Grow (Casa de Investimentos)', owner: 'patricia', investido: 0, valor: 0, data_atualizacao: null }],
      reserve: {
        1: rb(1), 2: rb(2), 3: rb(3), 4: rb(4), 5: rb(5), 6: rb(6),
      },
      prices: {}, // simbolo -> {preco, high_60_90d, timestamp, fonte}
      mstr_inputs: null, // {btc_treasury, shares_outstanding, data}
      settings: { ...DEFAULT_SETTINGS },
      _seq: { asset: 6, tx: 0, perp: 0, ppr: 1, account: 4 },
    };
  }
  function rb(asset_id) {
    return { asset_id, base_amount: 0, total: 0, gasto: 0, max_triggers: 4, triggers_used: 0, killswitch: 0, killswitch_motivo: null };
  }

  let state = load();

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) { const s = seed(); localStorage.setItem(KEY, JSON.stringify(s)); return s; }
      const s = JSON.parse(raw);
      // garante definições novas
      s.settings = { ...DEFAULT_SETTINGS, ...(s.settings || {}) };
      return s;
    } catch (e) { return seed(); }
  }
  function save() { localStorage.setItem(KEY, JSON.stringify(state)); }
  function get() { return state; }

  const nextId = (k) => { state._seq[k] = (state._seq[k] || 0) + 1; return state._seq[k]; };

  // ----- settings -----
  const settings = () => state.settings;
  const setSetting = (k, v) => { state.settings[k] = String(v); save(); };
  const setSettings = (obj) => { Object.assign(state.settings, obj); save(); };

  // ----- assets -----
  const assets = (incArquivados = false) => state.assets.filter((a) => incArquivados || a.ativo);
  const asset = (id) => state.assets.find((a) => a.id === id);
  function addAsset(a) {
    const id = nextId('asset'); state.assets.push({ id, ativo: 1, ...a, simbolo: a.simbolo.toUpperCase() });
    state.reserve[id] = rb(id); save(); return id;
  }
  function updateAsset(id, a) { const x = asset(id); if (x) Object.assign(x, a, { simbolo: a.simbolo.toUpperCase() }); save(); }
  function archiveAsset(id) { const x = asset(id); if (x) x.ativo = 0; save(); }

  // ----- accounts -----
  const accounts = () => state.accounts;

  // ----- transactions -----
  const transactions = (assetId) => state.transactions.filter((t) => !assetId || t.asset_id === assetId);
  function addTx(t) { const id = nextId('tx'); state.transactions.push({ id, ...t }); save(); return id; }
  function updateTx(id, t) { const x = state.transactions.find((r) => r.id === id); if (x) Object.assign(x, t); save(); }
  function deleteTx(id) { state.transactions = state.transactions.filter((r) => r.id !== id); save(); }

  // ----- perps -----
  const perps = () => state.perps;
  function addPerp(p) { const id = nextId('perp'); state.perps.push({ id, ...p, ativo: p.ativo.toUpperCase() }); save(); return id; }
  function updatePerp(id, p) { const x = state.perps.find((r) => r.id === id); if (x) Object.assign(x, p, { ativo: p.ativo.toUpperCase() }); save(); }
  function deletePerp(id) { state.perps = state.perps.filter((r) => r.id !== id); save(); }

  // ----- ppr -----
  const pprs = () => state.ppr;
  function addPpr(p) { const id = nextId('ppr'); state.ppr.push({ id, ...p }); save(); return id; }
  function updatePpr(id, p) { const x = state.ppr.find((r) => r.id === id); if (x) Object.assign(x, p); save(); }
  function deletePpr(id) { state.ppr = state.ppr.filter((r) => r.id !== id); save(); }

  // ----- reserve -----
  const reserve = (assetId) => state.reserve[assetId] || (state.reserve[assetId] = rb(assetId));
  function updateReserve(assetId, r) { Object.assign(reserve(assetId), r); save(); }

  // ----- prices -----
  const prices = () => state.prices;
  function setPrice(simbolo, preco, high, fonte) {
    const s = simbolo.toUpperCase(); const cur = state.prices[s] || {};
    state.prices[s] = { preco: preco != null ? preco : cur.preco, high_60_90d: high != null ? high : cur.high_60_90d,
      timestamp: new Date().toISOString(), fonte }; save();
  }

  // ----- mstr inputs -----
  const mstrInputs = () => state.mstr_inputs;
  function setMstrInputs(m) { state.mstr_inputs = m; save(); }

  // ----- backup -----
  function exportJSON() { return JSON.stringify(state, null, 2); }
  function importJSON(txt) { const s = JSON.parse(txt); s.settings = { ...DEFAULT_SETTINGS, ...(s.settings || {}) }; state = s; save(); }
  function reset() { state = seed(); save(); }

  return { get, save, settings, setSetting, setSettings, assets, asset, addAsset, updateAsset, archiveAsset,
    accounts, transactions, addTx, updateTx, deleteTx, perps, addPerp, updatePerp, deletePerp,
    pprs, addPpr, updatePpr, deletePpr, reserve, updateReserve, prices, setPrice, mstrInputs, setMstrInputs,
    exportJSON, importJSON, reset };
})();
