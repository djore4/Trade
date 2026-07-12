"""Testes do motor: escada, fiscal (365d/FIFO), perps (linear+inverso), cenários."""
import sys
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.engine import ladder, tax, perp, mnav, scenarios


# --- escada de quedas -------------------------------------------------
def test_multiplicador():
    assert ladder.multiplicador(10, 15, 25, 35) == 0
    assert ladder.multiplicador(15, 15, 25, 35) == 1
    assert ladder.multiplicador(26, 15, 25, 35) == 2
    assert ladder.multiplicador(40, 15, 25, 35) == 3


def test_reserva_limita_sugestao():
    # base 100€, queda 40% -> 3x = 300€, mas só restam 120€ de reserva
    r = ladder.avalia(60, 100, 100, 200, 80, 4, 0, False, None, 15, 25, 35)
    assert r["multiplo"] == 3
    assert r["sugestao"] == 120  # limitado pela reserva restante (200-80)
    assert r["estado"] == "armado"


def test_killswitch_pausa():
    r = ladder.avalia(60, 100, 100, 200, 0, 4, 0, True, "tese partida", 15, 25, 35)
    assert r["estado"] == "pausado"
    assert r["sugestao"] == 0


def test_limite_acionamentos():
    r = ladder.avalia(60, 100, 100, 500, 0, 3, 3, False, None, 15, 25, 35)
    assert r["estado"] == "limite"


# --- fiscal: 365 dias + FIFO -----------------------------------------
def test_estado_lotes_365():
    hoje = date(2026, 1, 1)
    txs = [
        {"id": 1, "tipo": "buy", "data": "2024-06-01", "qtd": 10, "preco": 1, "taxas": 0},  # >365d
        {"id": 2, "tipo": "buy", "data": "2025-11-01", "qtd": 5, "preco": 2, "taxas": 0},   # <365d
    ]
    est = tax.estado_lotes(txs, hoje)
    assert est["qtd_isenta"] == 10
    assert est["qtd_tributavel"] == 5
    assert est["proximo_desbloqueio"] == "2026-11-01"


def test_fifo_consome_mais_antigo():
    hoje = date(2026, 1, 1)
    txs = [
        {"id": 1, "tipo": "buy", "data": "2024-06-01", "qtd": 10, "preco": 1, "taxas": 0},
        {"id": 2, "tipo": "buy", "data": "2025-11-01", "qtd": 10, "preco": 2, "taxas": 0},
        {"id": 3, "tipo": "sell", "data": "2025-12-01", "qtd": 4, "preco": 3, "taxas": 0},  # consome do lote 1
    ]
    est = tax.estado_lotes(txs, hoje)
    assert est["qtd_isenta"] == 6   # 10 - 4 do lote antigo
    assert est["qtd_tributavel"] == 10


def test_simula_venda_isento_vs_tributavel():
    hoje = date(2026, 1, 1)
    txs = [
        {"id": 1, "tipo": "buy", "data": "2024-06-01", "qtd": 10, "preco": 1, "taxas": 0},  # isento
        {"id": 2, "tipo": "buy", "data": "2025-11-01", "qtd": 10, "preco": 1, "taxas": 0},  # tributável
    ]
    # vender 15 a preço 3: 10 do lote isento (ganho 20, imposto 0) + 5 do tributável (ganho 10, 28%)
    r = tax.simula_venda(txs, 15, 3, hoje)
    assert r["ganho_isento"] == 20
    assert r["ganho_tributavel"] == 10
    assert abs(r["imposto_estimado"] - 2.8) < 1e-9


def test_venda_excede_disponivel():
    r = tax.simula_venda([{"id": 1, "tipo": "buy", "data": "2024-01-01", "qtd": 5, "preco": 1, "taxas": 0}], 10, 2)
    assert "erro" in r


# --- perps: linear e inverso -----------------------------------------
def test_liquidacao_linear_long():
    # long 5x -> liq ~ entrada*(1 - 1/5 + mmr)
    liq = perp.preco_liquidacao("long", "linear", 100, 5, 0.005)
    assert abs(liq - 80.5) < 1e-6


def test_liquidacao_inverso_long_menor_que_entrada():
    liq = perp.preco_liquidacao("long", "inverse", 100, 5, 0.005)
    assert liq < 100  # long liquida abaixo da entrada


def test_pnl_linear_vs_inverso_usam_formulas_distintas():
    fx = 0.9
    lin = perp.avalia("long", "linear", 100, 1, 2, 0, 110, 0.005, fx)
    inv = perp.avalia("long", "inverse", 100, 100, 2, 0, 110, 0.005, fx)
    # linear: margem = 100*1/2 = 50 USD -> ROI = 10/50 = 20%
    assert abs(lin["margem_usd"] - 50) < 1e-6
    assert abs(lin["roi_margem_pct"] - 20) < 1e-6
    # inverso: coin-margined -> margem = (100/100)/2 * mark = 55 USD -> ROI != linear
    assert abs(inv["margem_usd"] - 55) < 1e-6
    assert abs(inv["roi_margem_pct"] - 20) > 1.0  # payoff não-linear na margem
    # liquidações distintas (fórmulas diferentes)
    assert lin["liquidacao"] != inv["liquidacao"]


def test_funding_subtraido():
    r = perp.avalia("long", "linear", 100, 1, 2, 3, 110, 0.005, 1.0)
    assert r["pnl_bruto_usd"] == 10
    assert r["pnl_liq_usd"] == 7  # 10 - 3 funding


# --- mNAV -------------------------------------------------------------
def test_mnav_favoravel():
    r = mnav.calcula(mstr_preco=100, shares_outstanding=1_000_000, btc_treasury=1000, btc_preco=95_000, favoravel=1.1, travar=2.0)
    # market cap 100M / (1000*95000=95M) = 1.05 -> favorável
    assert r["sinal"] == "favoravel"


# --- cenários ---------------------------------------------------------
def test_cenarios_mesma_trajetoria():
    precos = [1.0, 0.8, 0.7, 0.9, 1.1, 1.0]
    r = scenarios.compara(precos, 6000, 0.6, 15, 25, 35)
    assert "linear" in r and "reserva" in r
    assert r["linear"]["investido"] > 0
    # a reserva deve ter destacado capital nas quedas
    assert r["reserva"]["unidades"] > 0
    assert "NÃO é previsão" in r["aviso"]
