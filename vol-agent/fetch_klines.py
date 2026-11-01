"""Download histórico de klines da Bybit V5 (endpoint público, sem auth).

Uso:  python fetch_klines.py --symbols BTCUSDT ETHUSDT --interval 60 --days 1095
Grava data/<SYMBOL>_<interval>.parquet
"""
import argparse
import time
from pathlib import Path

import polars as pl
import requests

BASE = "https://api.bybit.com/v5/market/kline"


def fetch(symbol: str, interval: str, days: int, category: str) -> pl.DataFrame:
    end = int(time.time() * 1000)
    start = end - days * 86_400_000
    rows, cursor = [], end
    while cursor > start:
        r = requests.get(BASE, params={
            "category": category, "symbol": symbol, "interval": interval,
            "end": cursor, "limit": 1000}, timeout=15)
        r.raise_for_status()
        data = r.json()
        if data.get("retCode") != 0:
            raise RuntimeError(data)
        batch = data["result"]["list"]  # mais recente primeiro
        if not batch:
            break
        rows.extend(batch)
        oldest = int(batch[-1][0])
        if oldest >= cursor:
            break
        cursor = oldest - 1
        time.sleep(0.12)  # margem para o rate limit
    df = pl.DataFrame(rows, schema=["ts", "open", "high", "low", "close", "volume", "turnover"],
                      orient="row")
    return (df.with_columns(pl.col("ts").cast(pl.Int64),
                            pl.col(["open", "high", "low", "close", "volume", "turnover"]).cast(pl.Float64))
              .filter(pl.col("ts") >= start)
              .unique("ts").sort("ts")
              .with_columns(pl.from_epoch("ts", time_unit="ms").alias("time")))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbols", nargs="+", default=["BTCUSDT", "ETHUSDT"])
    ap.add_argument("--interval", default="60")
    ap.add_argument("--days", type=int, default=1095)
    ap.add_argument("--category", default="spot", choices=["spot", "linear"])
    a = ap.parse_args()
    Path("data").mkdir(exist_ok=True)
    for s in a.symbols:
        df = fetch(s, a.interval, a.days, a.category)
        out = Path("data") / f"{s}_{a.interval}.parquet"
        df.write_parquet(out)
        print(f"{s}: {df.height} barras, {df['time'].min()} → {df['time'].max()} → {out}")
