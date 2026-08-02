"""Prove factors.py reproduces the live JS engine exactly.

Generates thousands of randomized candidate snapshots, runs each through both
the Python port (factors.py) and the verbatim JS (js_reference.js, executed
with Node), and asserts the outputs match to floating-point tolerance. If Node
is unavailable the JS leg is skipped and only internal invariants are checked.

Run:  python3 test_parity.py
"""

from __future__ import annotations

import json
import math
import random
import shutil
import subprocess
from pathlib import Path

import factors as F

HERE = Path(__file__).parent
JS = HERE / "js_reference.js"
TOL = 1e-9


def random_case(rng: random.Random):
    """A random candidate + random price series, spanning edge cases."""
    n = rng.choice([0, 5, 21, 22, 50, 120])          # include too-short series
    price0 = rng.uniform(0.0001, 60000)
    closes = []
    p = price0
    for _ in range(n):
        p *= 1 + rng.uniform(-0.05, 0.05)
        closes.append(p)
    price = closes[-1] if closes else rng.uniform(0.01, 60000)
    ef = F.trd_ema(closes, 9)
    es = F.trd_ema(closes, 21)
    rsi = F.trd_rsi(closes, 14)
    c = F.Cand(
        symbol="TESTUSDT", coin="TEST", price=price,
        chg=rng.uniform(-30, 30),
        fr=rng.uniform(-0.2, 0.2),                    # funding %, wide range
        turnover=rng.choice([0, rng.uniform(1e5, 5e9)]),
        oi_usd=rng.uniform(0, 1e8),
        ef=ef, es=es, rsi=rsi,
        hi=(max(closes) * rng.uniform(1.0, 1.1) if closes else None),
        lo=(min(closes) * rng.uniform(0.9, 1.0) if closes else None),
        vol_spike=rng.choice([1.0, 1.5, 1.8, 2.5, 4.0]),
        oi_chg=rng.choice([None, rng.uniform(-40, 40)]),
    )
    return c, closes


def cand_to_js(c: F.Cand, closes):
    return {
        "symbol": c.symbol, "price": c.price, "chg": c.chg, "fr": c.fr,
        "turnover": c.turnover, "ef": c.ef, "es": c.es, "rsi": c.rsi,
        "hi": c.hi, "lo": c.lo, "volSpike": c.vol_spike,
        "oiChg": c.oi_chg, "_closes": closes,
    }


def approx(a, b) -> bool:
    if a is None or b is None:
        return a is None and b is None
    if isinstance(a, float) and (math.isnan(a) or math.isnan(b)):
        return math.isnan(a) and math.isnan(b)
    return abs(a - b) <= TOL + 1e-6 * max(abs(a), abs(b))


def main() -> int:
    rng = random.Random(42)
    N = 4000
    cases = [random_case(rng) for _ in range(N)]

    node = shutil.which("node")
    js_out = None
    if node and JS.exists():
        payload = []
        for c, closes in cases:
            for side in ("long", "short"):
                payload.append({"c": cand_to_js(c, closes), "side": side})
        proc = subprocess.run(
            [node, str(JS)], input=json.dumps(payload),
            capture_output=True, text=True, check=True,
        )
        js_out = json.loads(proc.stdout)
    else:
        print("Node not found — running Python-only invariant checks.")

    mismatches = 0
    checked = 0
    k = 0
    for c, closes in cases:
        for side in ("long", "short"):
            py = F.trd_score(c, side)
            # Internal invariants (always run).
            assert 0 <= py.final <= 100
            for name in ("mom", "trend", "rsi", "fund", "vol", "brk", "oi"):
                v = getattr(py, name)
                assert 0 <= v <= 100, f"{name}={v} out of range"

            if js_out is not None:
                j = js_out[k]
                js = j["score"]
                pairs = [
                    ("final", py.final, js["final"]),
                    ("mom", py.mom, js["mom"]),
                    ("trend", py.trend, js["trend"]),
                    ("rsi", py.rsi, js["rsi"]),
                    ("fund", py.fund, js["fund"]),
                    ("vol", py.vol, js["vol"]),
                    ("brk", py.brk, js["brk"]),
                    ("oi", py.oi, js["oi"]),
                    ("ema9", c.ef, j["ema9"]),
                    ("ema21", c.es, j["ema21"]),
                    ("rsi14", c.rsi, j["rsi14"]),
                ]
                for label, a, b in pairs:
                    checked += 1
                    if not approx(a, b):
                        mismatches += 1
                        if mismatches <= 10:
                            print(f"MISMATCH {label}: py={a} js={b} "
                                  f"(chg={c.chg} fr={c.fr} side={side})")
            k += 1

    print(f"\ncases={N} side-evals={N*2}")
    if js_out is not None:
        print(f"value comparisons vs JS: {checked}, mismatches: {mismatches}")
        if mismatches:
            print("PARITY FAILED")
            return 1
        print("PARITY OK — Python port matches the live JS exactly.")
    else:
        print("Invariants OK (no JS parity leg).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
