"""M1 — Dashboard: valor total EUR por bucket, alocação vs alvo, P&L por titular."""
from fastapi import APIRouter

from ..db import connect
from ..common import get_settings, eur_usd, posicao_ativo, DISCLAIMER

router = APIRouter(prefix="/api", tags=["dashboard"])


@router.get("/dashboard")
def dashboard():
    s = get_settings()
    fx = eur_usd(s)
    conn = connect()

    # --- ativos spot + MSTR ---
    assets = conn.execute("SELECT * FROM assets WHERE ativo = 1").fetchall()
    quadrantes = {}   # quadrante -> valor EUR
    por_owner = {}    # owner -> {valor, custo}
    total_spot = 0.0
    total_mstr = 0.0

    for a in assets:
        pos = posicao_ativo(conn, a["id"])
        pc = conn.execute("SELECT preco FROM prices_cache WHERE simbolo = ?", (a["simbolo"],)).fetchone()
        preco = pc["preco"] if pc else None
        if preco is None or pos["qtd"] <= 0:
            valor_eur = 0.0
        else:
            valor_eur = pos["qtd"] * (preco * fx if a["moeda"] == "USD" else preco)
        custo_eur = pos["custo_total"] * fx if a["moeda"] == "USD" else pos["custo_total"]

        quad = a["quadrante"] or "outros"
        quadrantes[quad] = quadrantes.get(quad, 0.0) + valor_eur

        o = por_owner.setdefault(a["owner"], {"valor": 0.0, "custo": 0.0})
        o["valor"] += valor_eur
        o["custo"] += custo_eur

        if a["quadrante"] == "BTC-alavancado":
            total_mstr += valor_eur
        else:
            total_spot += valor_eur

    # --- PPR (titularidade separada) ---
    total_ppr = 0.0
    for r in conn.execute("SELECT * FROM ppr").fetchall():
        total_ppr += r["valor"]
        quadrantes["PPR"] = quadrantes.get("PPR", 0.0) + r["valor"]
        o = por_owner.setdefault(r["owner"], {"valor": 0.0, "custo": 0.0})
        o["valor"] += r["valor"]
        o["custo"] += r["investido"]

    # --- margem em risco nos inversos (FORA do total) ---
    margem_risco_eur = 0.0
    for p in conn.execute("SELECT * FROM perp_positions WHERE estado = 'aberta'").fetchall():
        if p["margem"]:
            margem_risco_eur += p["margem"] * fx  # margem em USD -> EUR
    conn.close()

    total = total_spot + total_mstr + total_ppr  # margem dos inversos fica fora

    # --- alocação vs alvo + aviso de concentração ---
    aviso_conc = float(s.get("aviso_concentracao", "40"))
    alocacao = []
    for quad, valor in sorted(quadrantes.items(), key=lambda x: -x[1]):
        pct = (valor / total * 100) if total > 0 else 0
        alvo = float(s.get(f"alvo_{quad}", "0") or 0)
        alocacao.append({
            "quadrante": quad,
            "valor_eur": round(valor, 2),
            "pct": round(pct, 2),
            "alvo_pct": alvo,
            "desvio": round(pct - alvo, 2),
            "concentracao": pct > aviso_conc,
        })

    owners = []
    for owner, v in por_owner.items():
        pnl = v["valor"] - v["custo"]
        owners.append({
            "owner": owner,
            "valor_eur": round(v["valor"], 2),
            "custo_eur": round(v["custo"], 2),
            "pnl_eur": round(pnl, 2),
            "pnl_pct": round(pnl / v["custo"] * 100, 2) if v["custo"] > 0 else None,
        })

    pnl_total = sum(o["pnl_eur"] for o in owners)

    return {
        "eur_usd": fx,
        "buckets": {
            "cripto_spot": round(total_spot, 2),
            "mstr_btc_alavancado": round(total_mstr, 2),
            "ppr": round(total_ppr, 2),
            "margem_inversos_em_risco": round(margem_risco_eur, 2),  # fora do total
        },
        "total_eur": round(total, 2),
        "pnl_total_eur": round(pnl_total, 2),
        "alocacao": alocacao,
        "por_titular": owners,
        "disclaimer": DISCLAIMER,
    }
