"""株価データを取得して docs/data/prices.json に書き出す。

使い方:
    python scripts/fetch_data.py          # Yahoo Finance (yfinance) から取得
    python scripts/fetch_data.py --demo   # ネットワーク不要のデモデータを生成

指標の計算と銘柄のスコアリングはブラウザ側 (docs/js/analysis.js) で行うため、
ここでは日足・週足・月足の OHLCV だけを保存する。
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


# 時間足ごとの取得期間。月足60ヶ月線・週足52週線が引けるだけの長さを取る。
INTERVALS = {"daily": ("1d", "1y"), "weekly": ("1wk", "5y"), "monthly": ("1mo", "10y")}


def to_rows(df) -> list[list]:
    df = df.dropna(subset=["Open", "High", "Low", "Close"])
    return [
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


def fetch_real(tickers: list[dict]) -> list[dict]:
    import yfinance as yf

    results = []
    for t in tickers:
        symbol = t["symbol"]
        stock = {**t, "currency": "JPY" if t["market"] == "JP" else "USD"}
        try:
            ticker = yf.Ticker(symbol)
            for key, (interval, period) in INTERVALS.items():
                stock[key] = to_rows(ticker.history(period=period, interval=interval, auto_adjust=True))
        except Exception as e:  # noqa: BLE001 - 1銘柄の失敗で全体を止めない
            print(f"[warn] {symbol}: {e}", file=sys.stderr)
            continue
        if not stock["daily"]:
            print(f"[warn] {symbol}: データなし", file=sys.stderr)
            continue
        results.append(stock)
        print(f"[ok] {symbol}: 日足 {len(stock['daily'])} / 週足 {len(stock['weekly'])} / 月足 {len(stock['monthly'])} 本")
    return results


def aggregate(rows: list[list], key) -> list[list]:
    out: list[list] = []
    for d, o, h, l, c, v in rows:
        k = key(date.fromisoformat(d)).isoformat()
        if out and out[-1][0] == k:
            cur = out[-1]
            cur[2], cur[3], cur[4], cur[5] = max(cur[2], h), min(cur[3], l), c, cur[5] + v
        else:
            out.append([k, o, h, l, c, v])
    return out


def fetch_demo(tickers: list[dict], years: int = 10) -> list[dict]:
    """銘柄ごとに異なる値動き (上昇・下降・レンジ) を持つ疑似データ。"""
    results = []
    end = date.today()
    dates: list[date] = []
    d = end
    while len(dates) < years * 261:
        if d.weekday() < 5:
            dates.append(d)
        d -= timedelta(days=1)
    dates.reverse()
    n = len(dates)

    for i, t in enumerate(tickers):
        rng = random.Random(t["symbol"])
        price = rng.uniform(1000, 9000) if t["market"] == "JP" else rng.uniform(50, 600)
        drift = rng.uniform(-0.0004, 0.0008)
        vol = rng.uniform(0.01, 0.02)
        base_volume = rng.uniform(1e6, 2e7)
        rows = []
        for j, day in enumerate(dates):
            # 数ヶ月ごとにトレンドやボックス相場が入れ替わるようにする
            if j % 120 == 0:
                drift = rng.choice([1, 1, -1, 0]) * rng.uniform(0.0003, 0.0015)
            if j == n - 200 and i % 3 == 0:
                drift = -drift
            ret = drift + rng.gauss(0, vol)
            open_ = price * (1 + rng.gauss(0, vol / 3))
            close = price * (1 + ret)
            high = max(open_, close) * (1 + abs(rng.gauss(0, vol / 2)))
            low = min(open_, close) * (1 - abs(rng.gauss(0, vol / 2)))
            volume = int(base_volume * (1 + abs(ret) * 30) * rng.uniform(0.6, 1.4))
            nd = 0 if t["market"] == "JP" else 2
            rows.append([day.isoformat(), round(open_, nd), round(high, nd), round(low, nd), round(close, nd), volume])
            price = close
        weekly = aggregate(rows, lambda x: x - timedelta(days=x.weekday()))
        monthly = aggregate(rows, lambda x: x.replace(day=1))
        results.append({
            **t,
            "currency": "JPY" if t["market"] == "JP" else "USD",
            "daily": rows[-250:],
            "weekly": weekly[-261:],
            "monthly": monthly,
        })
    return results


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--demo", action="store_true", help="デモデータを生成する")
    args = parser.parse_args()

    tickers = load_tickers()
    stocks = fetch_demo(tickers) if args.demo else fetch_real(tickers)
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
