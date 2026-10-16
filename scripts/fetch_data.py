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
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

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


# 取引所の現地時刻での取引時間 (引けは少し余裕を持たせる)
MARKET_HOURS = {
    "JP": (ZoneInfo("Asia/Tokyo"), time(9, 0), time(15, 45)),
    "US": (ZoneInfo("America/New_York"), time(9, 30), time(16, 15)),
}


def drop_unfinished_bar(rows: list[list], market: str, now: datetime | None = None) -> list[list]:
    """当日の日足は、取引時間中 (寄り付き〜引け) に取得した場合は確定前なので捨てる。"""
    if not rows or market not in MARKET_HOURS:
        return rows
    tz, open_at, close_at = MARKET_HOURS[market]
    now = (now or datetime.now(tz)).astimezone(tz)
    if rows[-1][0] == now.date().isoformat() and open_at <= now.time() < close_at:
        return rows[:-1]
    return rows


def fill_missing_daily(ticker, df):
    """直近の日足で始値〜終値が欠けている行を、その日の1時間足から作り直す。

    日本株は日付が変わった直後などに、Yahoo が前の取引日の日足を出来高だけ入った状態
    (始値〜終値が NaN) で返すことがある。そのまま捨てると最新の取引日が欠けてしまう。
    """
    price_cols = ["Open", "High", "Low", "Close"]
    recent = df.tail(5)
    missing = recent.index[recent[price_cols].isna().all(axis=1)]
    if len(missing) == 0:
        return df
    hourly = ticker.history(period="5d", interval="1h", auto_adjust=True).dropna(subset=price_cols)
    df = df.copy()
    for idx in missing:
        day = hourly[hourly.index.date == idx.date()]
        if day.empty:
            continue
        df.loc[idx, "Open"] = day["Open"].iloc[0]
        df.loc[idx, "High"] = day["High"].max()
        df.loc[idx, "Low"] = day["Low"].min()
        df.loc[idx, "Close"] = day["Close"].iloc[-1]
        if not df.loc[idx, "Volume"] > 0:
            df.loc[idx, "Volume"] = day["Volume"].sum()
        print(f"[fix] {ticker.ticker} {idx.date()}: 欠けていた日足を1時間足から補完")
    return df


def fetch_real(tickers: list[dict]) -> list[dict]:
    import yfinance as yf

    results = []
    for t in tickers:
        symbol = t["symbol"]
        stock = {**t, "currency": "JPY" if t["market"] == "JP" else "USD"}
        try:
            ticker = yf.Ticker(symbol)
            for key, (interval, period) in INTERVALS.items():
                df = ticker.history(period=period, interval=interval, auto_adjust=True)
                if key == "daily":
                    df = fill_missing_daily(ticker, df)
                stock[key] = to_rows(df)
            stock["daily"] = drop_unfinished_bar(stock["daily"], t["market"])
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
