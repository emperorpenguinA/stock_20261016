"""株価データを取得して docs/data/prices.json に書き出す。

使い方:
    python scripts/fetch_data.py          # Yahoo Finance (yfinance) から取得
    python scripts/fetch_data.py --demo   # ネットワーク不要のデモデータを生成

指標の計算と銘柄のスコアリングはブラウザ側 (docs/js/analysis.js) で行うため、
ここでは日足の OHLCV だけを保存する。
"""

from __future__ import annotations

import argparse
import json
import math
import random
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TICKERS_FILE = ROOT / "config" / "tickers.json"
OUTPUT_FILE = ROOT / "docs" / "data" / "prices.json"


def load_tickers() -> list[dict]:
    return json.loads(TICKERS_FILE.read_text(encoding="utf-8"))


def fetch_real(tickers: list[dict], period: str) -> list[dict]:
    import yfinance as yf

    results = []
    for t in tickers:
        symbol = t["symbol"]
        try:
            df = yf.Ticker(symbol).history(period=period, interval="1d", auto_adjust=True)
        except Exception as e:  # noqa: BLE001 - 1銘柄の失敗で全体を止めない
            print(f"[warn] {symbol}: {e}", file=sys.stderr)
            continue
        df = df.dropna(subset=["Open", "High", "Low", "Close"])
        if df.empty:
            print(f"[warn] {symbol}: データなし", file=sys.stderr)
            continue
        bars = [
            [
                idx.strftime("%Y-%m-%d"),
                round(float(row.Open), 4),
                round(float(row.High), 4),
                round(float(row.Low), 4),
                round(float(row.Close), 4),
                int(row.Volume) if not math.isnan(row.Volume) else 0,
            ]
            for idx, row in df.iterrows()
        ]
        results.append({**t, "currency": "JPY" if t["market"] == "JP" else "USD", "bars": bars})
        print(f"[ok] {symbol}: {len(bars)} 本")
    return results


def fetch_demo(tickers: list[dict], days: int = 260) -> list[dict]:
    """銘柄ごとに異なる値動き (上昇・下降・レンジ) を持つ疑似データ。"""
    results = []
    end = date.today()
    dates: list[date] = []
    d = end
    while len(dates) < days:
        if d.weekday() < 5:
            dates.append(d)
        d -= timedelta(days=1)
    dates.reverse()

    for i, t in enumerate(tickers):
        rng = random.Random(t["symbol"])
        price = rng.uniform(1000, 9000) if t["market"] == "JP" else rng.uniform(50, 600)
        drift = rng.uniform(-0.0015, 0.002)
        vol = rng.uniform(0.01, 0.025)
        base_volume = rng.uniform(1e6, 2e7)
        bars = []
        for j, day in enumerate(dates):
            # 途中でトレンドが転換する銘柄も混ぜる
            if j == days * 2 // 3 and i % 3 == 0:
                drift = -drift * 1.5
            ret = drift + rng.gauss(0, vol)
            open_ = price * (1 + rng.gauss(0, vol / 3))
            close = price * (1 + ret)
            high = max(open_, close) * (1 + abs(rng.gauss(0, vol / 2)))
            low = min(open_, close) * (1 - abs(rng.gauss(0, vol / 2)))
            volume = int(base_volume * (1 + abs(ret) * 30) * rng.uniform(0.6, 1.4))
            nd = 0 if t["market"] == "JP" else 2
            bars.append([day.isoformat(), round(open_, nd), round(high, nd), round(low, nd), round(close, nd), volume])
            price = close
        results.append({**t, "currency": "JPY" if t["market"] == "JP" else "USD", "bars": bars})
    return results


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--demo", action="store_true", help="デモデータを生成する")
    parser.add_argument("--period", default="1y", help="取得期間 (yfinance の period 指定)")
    args = parser.parse_args()

    tickers = load_tickers()
    stocks = fetch_demo(tickers) if args.demo else fetch_real(tickers, args.period)
    if not stocks:
        sys.exit("1銘柄も取得できませんでした")

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "demo": args.demo,
        "stocks": stocks,
    }
    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_FILE.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{len(stocks)} 銘柄を {OUTPUT_FILE.relative_to(ROOT)} に保存しました")


if __name__ == "__main__":
    main()
