"""Taxa de câmbio EUR/USD com cache e override manual (§6).

Devolvemos "1 USD = X EUR" para converter ativos cotados em USD para a base EUR.
Fonte pública gratuita; se falhar, o utilizador mantém o override manual.
"""
from datetime import datetime, timezone

import httpx

TIMEOUT = 8.0


def usd_para_eur() -> dict:
    """Obtém 1 USD -> EUR de uma fonte pública. Degrada para manual."""
    try:
        with httpx.Client(timeout=TIMEOUT) as c:
            # Frankfurter (BCE), sem chave
            r = c.get("https://api.frankfurter.app/latest", params={"from": "USD", "to": "EUR"})
            r.raise_for_status()
            j = r.json()
            taxa = float(j["rates"]["EUR"])
        return {
            "ok": True,
            "eur_usd": taxa,
            "fonte": "frankfurter/BCE",
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
    except Exception as e:
        return {"ok": False, "erro": f"Câmbio indisponível ({type(e).__name__}). Mantém o override manual."}
