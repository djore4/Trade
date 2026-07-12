"""Fiscalidade cripto spot (Portugal) — §3.

Regras modeladas:
  - Lote a lote: cada compra é um lote com a sua data de aquisição e relógio
    de 365 dias.
  - >= 365 dias detido -> mais-valia ISENTA; < 365 dias -> tributada a 28%.
  - FIFO: vendas consomem os lotes mais antigos primeiro.

A app ESTIMA. Não substitui contabilista. O P&L por custo médio (tracker) NÃO
serve para decidir vendas — usa esta vista de lotes.
"""
from datetime import date, datetime, timedelta

TAXA_MAIS_VALIAS = 0.28
DIAS_ISENCAO = 365


def _d(s: str) -> date:
    return datetime.strptime(s[:10], "%Y-%m-%d").date()


def estado_lotes(transacoes: list, hoje: date = None) -> dict:
    """Reconstrói o estado FIFO dos lotes a partir do histórico.

    transacoes: lista de dicts com tipo, data, qtd, preco, taxas (ordenados ou não).
    Devolve lotes remanescentes (com qtd restante e data) + agregados isento/tributável.
    """
    hoje = hoje or date.today()
    txs = sorted(transacoes, key=lambda t: (_d(t["data"]), t["id"]))

    lotes = []  # cada: {qtd, preco, taxas_unit, data}
    for t in txs:
        if t["tipo"] == "buy":
            taxas_unit = (t.get("taxas", 0) or 0) / t["qtd"] if t["qtd"] else 0
            lotes.append({"qtd": t["qtd"], "preco": t["preco"], "taxas_unit": taxas_unit, "data": _d(t["data"])})
        elif t["tipo"] == "sell":
            restante = t["qtd"]
            for lote in lotes:
                if restante <= 0:
                    break
                if lote["qtd"] <= 0:
                    continue
                consumido = min(lote["qtd"], restante)
                lote["qtd"] -= consumido
                restante -= consumido
            # se restante > 0, venda a descoberto/erro de dados — ignora excesso

    lotes = [l for l in lotes if l["qtd"] > 1e-12]

    isento = 0.0
    tributavel = 0.0
    prox_desbloqueio = None
    for l in lotes:
        idade = (hoje - l["data"]).days
        if idade >= DIAS_ISENCAO:
            isento += l["qtd"]
        else:
            tributavel += l["qtd"]
            desbloqueio = l["data"] + timedelta(days=DIAS_ISENCAO)
            if prox_desbloqueio is None or desbloqueio < prox_desbloqueio:
                prox_desbloqueio = desbloqueio

    return {
        "lotes": [
            {
                "qtd": round(l["qtd"], 12),
                "preco": l["preco"],
                "data": l["data"].isoformat(),
                "idade_dias": (hoje - l["data"]).days,
                "isento": (hoje - l["data"]).days >= DIAS_ISENCAO,
                "desbloqueia": (l["data"] + timedelta(days=DIAS_ISENCAO)).isoformat(),
            }
            for l in lotes
        ],
        "qtd_total": round(isento + tributavel, 12),
        "qtd_isenta": round(isento, 12),
        "qtd_tributavel": round(tributavel, 12),
        "proximo_desbloqueio": prox_desbloqueio.isoformat() if prox_desbloqueio else None,
    }


def simula_venda(transacoes: list, qtd_venda: float, preco_venda: float, hoje: date = None) -> dict:
    """Simula uma venda hoje por FIFO e estima o imposto.

    Ganho por lote = (preco_venda - preco_lote) * qtd - taxas proporcionais.
    Lotes >= 365 dias: ganho isento. Lotes < 365 dias: 28% sobre ganho positivo.
    """
    hoje = hoje or date.today()
    txs = sorted(transacoes, key=lambda t: (_d(t["data"]), t["id"]))

    lotes = []
    for t in txs:
        if t["tipo"] == "buy":
            taxas_unit = (t.get("taxas", 0) or 0) / t["qtd"] if t["qtd"] else 0
            lotes.append({"qtd": t["qtd"], "preco": t["preco"], "taxas_unit": taxas_unit, "data": _d(t["data"])})
        elif t["tipo"] == "sell":
            restante = t["qtd"]
            for lote in lotes:
                if restante <= 0:
                    break
                consumido = min(lote["qtd"], restante)
                lote["qtd"] -= consumido
                restante -= consumido
    lotes = [l for l in lotes if l["qtd"] > 1e-12]

    disponivel = sum(l["qtd"] for l in lotes)
    if qtd_venda > disponivel + 1e-9:
        return {"erro": f"Quantidade a vender ({qtd_venda}) excede o disponível ({round(disponivel, 8)})."}

    restante = qtd_venda
    ganho_isento = 0.0
    ganho_tributavel = 0.0
    detalhe = []
    for l in lotes:
        if restante <= 0:
            break
        usa = min(l["qtd"], restante)
        restante -= usa
        idade = (hoje - l["data"]).days
        custo = (l["preco"] + l["taxas_unit"]) * usa
        receita = preco_venda * usa
        ganho = receita - custo
        if idade >= DIAS_ISENCAO:
            ganho_isento += ganho
            imposto_lote = 0.0
        else:
            ganho_tributavel += ganho
            imposto_lote = max(0.0, ganho) * TAXA_MAIS_VALIAS
        detalhe.append({
            "data_lote": l["data"].isoformat(),
            "idade_dias": idade,
            "qtd": round(usa, 12),
            "preco_lote": l["preco"],
            "ganho": round(ganho, 2),
            "isento": idade >= DIAS_ISENCAO,
            "imposto": round(imposto_lote, 2),
        })

    imposto = max(0.0, ganho_tributavel) * TAXA_MAIS_VALIAS
    return {
        "qtd_venda": qtd_venda,
        "preco_venda": preco_venda,
        "ganho_total": round(ganho_isento + ganho_tributavel, 2),
        "ganho_isento": round(ganho_isento, 2),
        "ganho_tributavel": round(ganho_tributavel, 2),
        "imposto_estimado": round(imposto, 2),
        "taxa": TAXA_MAIS_VALIAS,
        "detalhe": detalhe,
        "aviso": "Estimativa por FIFO com regra dos 365 dias. Não substitui contabilista.",
    }
