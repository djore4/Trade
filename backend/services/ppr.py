"""PPR "Save & Grow" (Casa de Investimentos) — tentativa de cotação pública.

Não existe API pública fiável para este fundo. Tentamos, e se não der de forma
fiável, ficamos em modo MANUAL — nunca inventamos valores (§6, §11).
"""


def cotacao() -> dict:
    """Sem fonte pública fiável confirmada — devolve estado 'manual'.

    Deixado explicitamente como manual para não inventar cotações. Se no futuro
    houver um endpoint fiável do fundo, é aqui que se liga.
    """
    return {
        "ok": False,
        "manual": True,
        "erro": "Sem fonte pública fiável para o Save & Grow. Atualiza o valor manualmente.",
    }
