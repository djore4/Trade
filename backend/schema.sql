-- =====================================================================
-- Consola de Investimentos — esquema SQLite (local-first)
-- Nada de segredos aqui. Chaves de API vivem apenas em variáveis de ambiente.
-- =====================================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Contas / fontes -----------------------------------------------------
CREATE TABLE IF NOT EXISTS accounts (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    nome    TEXT NOT NULL,
    tipo    TEXT NOT NULL,              -- spot | derivados | acao | ppr
    owner   TEXT NOT NULL DEFAULT 'eu'  -- titularidade (eu | patricia | ...)
);

-- Ativos --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS assets (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    simbolo    TEXT NOT NULL,
    nome       TEXT,
    moeda      TEXT NOT NULL DEFAULT 'USD',   -- moeda de cotação
    quadrante  TEXT,                          -- L1 | RWA | perp-DEX | BTC-alavancado | PPR
    account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
    owner      TEXT NOT NULL DEFAULT 'eu',
    ativo      INTEGER NOT NULL DEFAULT 1     -- 1 = listado, 0 = arquivado
);

-- Transações (base do FIFO e do relógio dos 365 dias) -----------------
CREATE TABLE IF NOT EXISTS transactions (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    tipo     TEXT NOT NULL,             -- buy | sell
    data     TEXT NOT NULL,             -- ISO YYYY-MM-DD
    qtd      REAL NOT NULL,
    preco    REAL NOT NULL,             -- preço unitário na moeda do ativo
    taxas    REAL NOT NULL DEFAULT 0
);

-- Posições alavancadas (perps) ----------------------------------------
CREATE TABLE IF NOT EXISTS perp_positions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ativo        TEXT NOT NULL,
    direcao      TEXT NOT NULL,          -- long | short
    contrato     TEXT NOT NULL,          -- linear | inverse
    entrada      REAL NOT NULL,          -- preço de entrada
    qtd          REAL NOT NULL DEFAULT 0,-- linear: qtd base; inverse: notional USD (contratos)
    margem       REAL,                   -- margem (informativa)
    alavancagem  REAL NOT NULL DEFAULT 1,
    funding_acum REAL NOT NULL DEFAULT 0,-- funding acumulado (USD, aprox)
    mmr          REAL NOT NULL DEFAULT 0.005, -- margem de manutenção (aprox)
    mark         REAL,                   -- preço mark (auto ou manual)
    estado       TEXT NOT NULL DEFAULT 'aberta', -- aberta | fechada
    owner        TEXT NOT NULL DEFAULT 'eu'
);

-- PPR -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ppr (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    nome              TEXT NOT NULL,
    owner             TEXT NOT NULL DEFAULT 'patricia',
    investido         REAL NOT NULL DEFAULT 0,   -- EUR
    valor             REAL NOT NULL DEFAULT 0,   -- EUR (valor atual)
    data_atualizacao  TEXT
);

-- Orçamento de reserva + motor comportamental por ativo ---------------
CREATE TABLE IF NOT EXISTS reserve_budget (
    asset_id          INTEGER PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
    base_amount       REAL NOT NULL DEFAULT 0,   -- € da compra base (calendário)
    total             REAL NOT NULL DEFAULT 0,   -- € total da reserva (preço)
    gasto             REAL NOT NULL DEFAULT 0,   -- € já gasto da reserva
    max_triggers      INTEGER NOT NULL DEFAULT 4,
    triggers_used     INTEGER NOT NULL DEFAULT 0,
    killswitch        INTEGER NOT NULL DEFAULT 0,-- 1 = pausar sugestões
    killswitch_motivo TEXT
);

-- Cache de preços -----------------------------------------------------
CREATE TABLE IF NOT EXISTS prices_cache (
    simbolo     TEXT PRIMARY KEY,
    preco       REAL,
    high_60_90d REAL,
    timestamp   TEXT,
    fonte       TEXT
);

-- Definições (chave/valor) --------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
    chave  TEXT PRIMARY KEY,
    valor  TEXT
);

-- Inputs manuais para o mNAV da MSTR ----------------------------------
CREATE TABLE IF NOT EXISTS mstr_inputs (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    btc_treasury       REAL,     -- nº de BTC em tesouraria
    shares_outstanding REAL,     -- ações em circulação
    data               TEXT
);
