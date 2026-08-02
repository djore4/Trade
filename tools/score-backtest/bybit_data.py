"""Historical data acquisition for the score backtest.

Two sources, same output shape:

* `fetch_bybit_dataset(...)` pulls real hourly klines, funding history and
  open-interest history from the Bybit v5 public API. Run it anywhere the API
  is reachable (it is blocked from the Claude Code web sandbox by egress
  policy). Results are cached to a JSON file so the backtest is reproducible.

* `synthetic_dataset(...)` fabricates a plausible multi-symbol panel with a
  mild, known momentum/funding signal baked in, so the pipeline can be
  exercised offline. Clearly labelled as synthetic in every report.

Dataset schema (JSON):
{
  "meta": {"source": "bybit"|"synthetic", "interval": "60", "generated": <ms>},
  "symbols": {
    "BTCUSDT": {
      "start_ms": <int>, "step_ms": 3600000,
      "open": [...], "high": [...], "low": [...], "close": [...],
      "turnover": [...],          # per-bar quote turnover (USD)
      "oi": [...],                # open interest (contracts or USD), per bar
      "funding": [[ts_ms, rate], ...]   # sparse funding events (rate as fraction)
    }, ...
  }
}
All per-bar arrays share the same length and the same `start_ms`/`step_ms` grid.
"""

from __future__ import annotations

import json
import math
import os
import random
import time
from pathlib import Path
from typing import Optional

import requests

BYBIT = "https://api.bybit.com"
HOUR_MS = 3_600_000
CA_BUNDLE = "/root/.ccr/ca-bundle.crt"


def _session() -> requests.Session:
    s = requests.Session()
    if os.path.exists(CA_BUNDLE):
        s.verify = CA_BUNDLE  # trust the agent-proxy CA when present
    return s


# ── Live Bybit ───────────────────────────────────────────────────────────────

def _get(sess, path, params):
    r = sess.get(f"{BYBIT}{path}", params=params, timeout=30)
    r.raise_for_status()
    d = r.json()
    if d.get("retCode") not in (0, None):
        raise RuntimeError(f"Bybit {path} retCode={d.get('retCode')} {d.get('retMsg')}")
    return d.get("result", {})


def _paged_klines(sess, symbol, interval, start_ms, end_ms):
    """Page backwards through /v5/market/kline (max 1000/bar)."""
    rows = []
    cursor_end = end_ms
    while cursor_end > start_ms:
        res = _get(sess, "/v5/market/kline", {
            "category": "linear", "symbol": symbol, "interval": interval,
            "start": start_ms, "end": cursor_end, "limit": 1000,
        })
        lst = res.get("list", [])
        if not lst:
            break
        rows.extend(lst)                     # newest -> oldest
        oldest = int(lst[-1][0])
        if oldest <= start_ms or len(lst) < 1000:
            break
        cursor_end = oldest - 1
        time.sleep(0.12)
    # de-dup + sort ascending by open time
    by_ts = {int(r[0]): r for r in rows}
    return [by_ts[t] for t in sorted(by_ts)]


def _paged_oi(sess, symbol, start_ms, end_ms):
    rows = []
    cursor = None
    for _ in range(50):
        params = {"category": "linear", "symbol": symbol,
                  "intervalTime": "1h", "startTime": start_ms,
                  "endTime": end_ms, "limit": 200}
        if cursor:
            params["cursor"] = cursor
        res = _get(sess, "/v5/market/open-interest", params)
        rows.extend(res.get("list", []))
        cursor = res.get("nextPageCursor")
        if not cursor:
            break
        time.sleep(0.12)
    return {int(x["timestamp"]): float(x["openInterest"]) for x in rows}


def _funding(sess, symbol, start_ms, end_ms):
    rows = []
    cursor_end = end_ms
    for _ in range(50):
        res = _get(sess, "/v5/market/funding/history", {
            "category": "linear", "symbol": symbol,
            "startTime": start_ms, "endTime": cursor_end, "limit": 200,
        })
        lst = res.get("list", [])
        if not lst:
            break
        rows.extend(lst)
        oldest = int(lst[-1]["fundingRateTimestamp"])
        if oldest <= start_ms or len(lst) < 200:
            break
        cursor_end = oldest - 1
        time.sleep(0.12)
    fr = sorted({int(x["fundingRateTimestamp"]): float(x["fundingRate"]) for x in rows}.items())
    return [[ts, rate] for ts, rate in fr]


def top_liquid_symbols(sess, n=40, min_turnover=3e6):
    """Mirror the scanner's universe: USDT perps, no leveraged tokens, liquid."""
    res = _get(sess, "/v5/market/tickers", {"category": "linear"})
    out = []
    for t in res.get("list", []):
        sym = t["symbol"]
        if not sym.endswith("USDT"):
            continue
        coin = sym[:-4]
        if any(ch.isdigit() for ch in coin):
            continue
        turn = float(t.get("turnover24h") or 0)
        if turn < min_turnover:
            continue
        out.append((sym, turn))
    out.sort(key=lambda x: -x[1])
    return [s for s, _ in out[:n]]


def fetch_bybit_dataset(days=45, n_symbols=40, out_path="dataset.json",
                        symbols: Optional[list] = None) -> dict:
    sess = _session()
    end_ms = int(time.time() * 1000)
    start_ms = end_ms - days * 24 * HOUR_MS
    syms = symbols or top_liquid_symbols(sess, n=n_symbols)
    data = {"meta": {"source": "bybit", "interval": "60",
                     "generated": end_ms, "days": days}, "symbols": {}}
    for i, sym in enumerate(syms):
        try:
            kl = _paged_klines(sess, sym, "60", start_ms, end_ms)
            if len(kl) < 60:
                continue
            grid_start = int(kl[0][0])
            data["symbols"][sym] = {
                "start_ms": grid_start, "step_ms": HOUR_MS,
                "open":     [float(r[1]) for r in kl],
                "high":     [float(r[2]) for r in kl],
                "low":      [float(r[3]) for r in kl],
                "close":    [float(r[4]) for r in kl],
                "volume":   [float(r[5]) for r in kl],   # base volume (kline idx 5)
                "turnover": [float(r[6]) for r in kl],
                "oi":       _oi_to_grid(_paged_oi(sess, sym, start_ms, end_ms),
                                        grid_start, len(kl)),
                "funding":  _funding(sess, sym, start_ms, end_ms),
            }
            print(f"[{i+1}/{len(syms)}] {sym}: {len(kl)} bars")
        except Exception as e:  # noqa: BLE001 — keep going on a bad symbol
            print(f"[{i+1}/{len(syms)}] {sym}: SKIP ({e})")
        time.sleep(0.15)
    Path(out_path).write_text(json.dumps(data))
    print(f"Saved {len(data['symbols'])} symbols -> {out_path}")
    return data


def _oi_to_grid(oi_map: dict, start_ms: int, n: int) -> list:
    """Align sparse OI timestamps onto the hourly bar grid (forward-fill)."""
    out = [None] * n
    if not oi_map:
        return out
    keys = sorted(oi_map)
    j = 0
    last = None
    for i in range(n):
        t = start_ms + i * HOUR_MS
        while j < len(keys) and keys[j] <= t + HOUR_MS // 2:
            last = oi_map[keys[j]]
            j += 1
        out[i] = last
    return out


# ── Synthetic (offline demo) ─────────────────────────────────────────────────

def synthetic_dataset(n_symbols=30, days=45, seed=7, out_path=None) -> dict:
    """Fabricate a panel with a mild, known edge so the pipeline shows signal.

    Baked-in truths (so a correct backtest should recover them):
      * momentum persistence: a positive trend bias autocorrelates hour to hour;
      * funding tilt: strongly negative funding slightly precedes up-moves.
    Everything else is noise. Numbers are synthetic and must not be read as a
    verdict on the real strategy.
    """
    rng = random.Random(seed)
    n = days * 24
    end_ms = int(time.time() * 1000)
    start_ms = end_ms - n * HOUR_MS
    data = {"meta": {"source": "synthetic", "interval": "60",
                     "generated": end_ms, "days": days}, "symbols": {}}
    for s in range(n_symbols):
        sym = f"SYN{s:02d}USDT"
        price = rng.uniform(0.5, 40000)
        trend = rng.uniform(-0.0008, 0.0008)      # per-symbol drift
        opens, highs, lows, closes, turns, vols, ois = [], [], [], [], [], [], []
        funding = []
        oi = rng.uniform(1e6, 5e7)
        mom = 0.0
        for i in range(n):
            # funding event every 8h; sometimes strongly negative (the tilt)
            if i % 8 == 0:
                base = rng.gauss(0, 0.0004)
                if rng.random() < 0.15:
                    base = -abs(rng.uniform(0.0006, 0.0025))   # deep-negative
                funding.append([start_ms + i * HOUR_MS, base])
                cur_fund = base
            # mild momentum persistence + funding-led drift
            drift = trend + 0.35 * mom - 40 * cur_fund * 0.0  # keep funding subtle
            fund_kick = -cur_fund * 6.0                       # neg funding -> up
            ret = rng.gauss(drift + fund_kick * 0.02, 0.012)
            mom = 0.55 * mom + 0.45 * ret
            o = price
            price = max(1e-6, price * (1 + ret))
            hi = max(o, price) * (1 + abs(rng.gauss(0, 0.003)))
            lo = min(o, price) * (1 - abs(rng.gauss(0, 0.003)))
            vol = abs(rng.gauss(1, 0.4))
            turnover = max(1e5, (5e6 + 2e7 * vol) * (1 + abs(ret) * 8))
            base_vol = turnover / price                       # base volume
            oi *= 1 + rng.gauss(0.5 * ret, 0.01)              # OI tracks flow
            opens.append(o); highs.append(hi); lows.append(lo); closes.append(price)
            turns.append(turnover); vols.append(base_vol); ois.append(max(1e5, oi))
        data["symbols"][sym] = {
            "start_ms": start_ms, "step_ms": HOUR_MS,
            "open": opens, "high": highs, "low": lows, "close": closes,
            "volume": vols, "turnover": turns, "oi": ois, "funding": funding,
        }
    if out_path:
        Path(out_path).write_text(json.dumps(data))
    return data


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description="Fetch or fabricate a backtest dataset.")
    ap.add_argument("--source", choices=["bybit", "synthetic"], default="synthetic")
    ap.add_argument("--days", type=int, default=45)
    ap.add_argument("--symbols", type=int, default=30)
    ap.add_argument("--out", default="dataset.json")
    a = ap.parse_args()
    if a.source == "bybit":
        fetch_bybit_dataset(days=a.days, n_symbols=a.symbols, out_path=a.out)
    else:
        synthetic_dataset(n_symbols=a.symbols, days=a.days, out_path=a.out)
        print(f"Synthetic dataset -> {a.out}")
