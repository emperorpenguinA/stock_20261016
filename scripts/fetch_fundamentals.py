"""業績データを取得して docs/data/fundamentals.json に書き出す。

使い方:
    python scripts/fetch_fundamentals.py          # Yahoo Finance (yfinance) から取得
    python scripts/fetch_fundamentals.py --demo   # ネットワーク不要のデモデータを生成

年次の決算 (売上高・営業利益・純利益・EPS・配当・キャッシュフロー・自己資本など) と、
時価総額・PER・PBR・アナリスト予想EPS などを保存する。指標の計算と評価はブラウザ側
(docs/js/fundamentals.js) で行う。
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
MANUAL_FILE = ROOT / "config" / "fundamentals_manual.json"
OUTPUT_FILE = ROOT / "docs" / "data" / "fundamentals.json"

# 年次の表から拾う行 (見つかった最初の名前を使う)
ROWS = {
    "revenue": ["Total Revenue", "Operating Revenue"],
    "operatingIncome": ["Operating Income"],
    "netIncome": ["Net Income", "Net Income Common Stockholders"],
    "eps": ["Diluted EPS", "Basic EPS"],
    "operatingCF": ["Operating Cash Flow"],
    "freeCF": ["Free Cash Flow"],
    "equity": ["Stockholders Equity", "Common Stock Equity"],
    "totalAssets": ["Total Assets"],
    "cash": ["Cash And Cash Equivalents", "Cash Cash Equivalents And Short Term Investments"],
    "debt": ["Total Debt"],
}

INFO_KEYS = {
    "sector": "sector",
    "industry": "industry",
    "marketCap": "marketCap",
    "price": "currentPrice",
    "per": "trailingPE",
    "forwardPer": "forwardPE",
    "pbr": "priceToBook",
    "trailingEps": "trailingEps",
    "forwardEps": "forwardEps",
    "dividendRate": "dividendRate",
    "payoutRatio": "payoutRatio",
}


def num(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(f) or math.isinf(f) else f


def pick(df, names, col):
    for n in names:
        if n in df.index:
            return num(df.at[n, col])
    return None


def annual_rows(t) -> list[dict]:
    """古い順に最大4期分。売上高が取れた期だけを使う。"""
    inc, cf, bs = t.income_stmt, t.cashflow, t.balance_sheet
    cols = [c for c in inc.columns if pick(inc, ROWS["revenue"], c) is not None]
    cols = sorted(cols)[-4:]
    try:
        divs = t.dividends
    except Exception:  # noqa: BLE001
        divs = None
    years = []
    for c in cols:
        row = {"fy": c.date().isoformat()}
        for key in ("revenue", "operatingIncome", "netIncome", "eps"):
            row[key] = pick(inc, ROWS[key], c)
        for key in ("operatingCF", "freeCF"):
            row[key] = pick(cf, ROWS[key], c) if c in cf.columns else None
        for key in ("equity", "totalAssets", "cash", "debt"):
            row[key] = pick(bs, ROWS[key], c) if c in bs.columns else None
        # 1株配当: 決算期末までの1年間に権利落ちした配当の合計
        row["dps"] = None
        if divs is not None and len(divs):
            end = c.date()
            start = end - timedelta(days=365)
            total = sum(float(v) for d, v in divs.items() if start < d.date() <= end + timedelta(days=5))
            row["dps"] = round(total, 4) if total > 0 else 0.0
        years.append(row)
    return years


def estimates(t) -> dict:
    out = {}
    try:
        e = t.earnings_estimate
        for period, key in (("0y", "epsThisYear"), ("+1y", "epsNextYear")):
            if period in e.index and "avg" in e.columns:
                out[key] = num(e.at[period, "avg"])
                if key == "epsNextYear" and "numberOfAnalysts" in e.columns:
                    out["analysts"] = num(e.at[period, "numberOfAnalysts"])
    except Exception:  # noqa: BLE001 - 予想が無い銘柄も多い
        pass
    return {k: v for k, v in out.items() if v}


def fetch_real(tickers: list[dict]) -> list[dict]:
    import yfinance as yf

    results = []
    for tk in tickers:
        symbol = tk["symbol"]
        t = yf.Ticker(symbol)
        rec = {**tk, "currency": "JPY" if tk["market"] == "JP" else "USD"}
        try:
            info = t.info or {}
            for key, src in INFO_KEYS.items():
                rec[key] = info.get(src) if key in ("sector", "industry") else num(info.get(src))
            ms = num(info.get("firstTradeDateMilliseconds"))
            rec["firstTradeDate"] = datetime.fromtimestamp(ms / 1000, timezone.utc).date().isoformat() if ms else None
            rec["years"] = annual_rows(t)
            rec["estimates"] = estimates(t)
        except Exception as e:  # noqa: BLE001 - 1銘柄の失敗で全体を止めない
            print(f"[warn] {symbol}: {e}", file=sys.stderr)
            continue
        if not rec["years"]:
            print(f"[warn] {symbol}: 決算データなし", file=sys.stderr)
            continue
        results.append(rec)
        print(f"[ok] {symbol}: {len(rec['years'])} 期 / 時価総額 {rec.get('marketCap')} / 予想 {rec['estimates']}")
    return results


def fetch_demo(tickers: list[dict]) -> list[dict]:
    """銘柄ごとに成長・横ばい・減益などが混ざる疑似データ。"""
    results = []
    today = date.today()
    for i, tk in enumerate(tickers):
        rng = random.Random("fund" + tk["symbol"])
        jp = tk["market"] == "JP"
        growth = rng.choice([0.25, 0.15, 0.12, 0.05, -0.05])
        revenue = rng.uniform(2e10, 2e12) if jp else rng.uniform(5e9, 3e11)
        margin = rng.uniform(0.05, 0.3)
        shares = rng.uniform(1e7, 1e9)
        years = []
        dps = rng.uniform(5, 60) if jp else rng.uniform(0.2, 3)
        equity = revenue * rng.uniform(0.3, 1.0)
        for k in range(4):
            fy = date(today.year - 4 + k, 3 if jp else 12, 31)
            g = growth + rng.uniform(-0.04, 0.04)
            revenue *= 1 + g
            op = revenue * margin * (1 + rng.uniform(-0.05, 0.08))
            net = op * 0.68
            equity += net * 0.6
            dps *= 1 + max(-0.1, g * 0.5)
            years.append({
                "fy": fy.isoformat(), "revenue": revenue, "operatingIncome": op, "netIncome": net,
                "eps": net / shares, "operatingCF": op * rng.uniform(0.7, 1.3), "freeCF": op * rng.uniform(-0.4, 0.9),
                "equity": equity, "totalAssets": equity * rng.uniform(1.3, 3.5),
                "cash": equity * rng.uniform(0.1, 0.6), "debt": equity * rng.uniform(0, 0.8), "dps": round(dps, 2),
            })
        eps = years[-1]["eps"]
        per = rng.uniform(8, 45)
        price = eps * per
        results.append({
            **tk,
            "currency": "JPY" if jp else "USD",
            "sector": rng.choice(["Technology", "Industrials", "Consumer Cyclical", "Financial Services"]),
            "industry": "",
            "marketCap": price * shares,
            "price": price,
            "per": per,
            "forwardPer": per / (1 + growth),
            "pbr": price * shares / years[-1]["equity"],
            "trailingEps": eps,
            "forwardEps": eps * (1 + growth),
            "dividendRate": years[-1]["dps"],
            "payoutRatio": years[-1]["dps"] / eps if eps > 0 else None,
            "firstTradeDate": (today - timedelta(days=rng.choice([500, 900, 3000, 8000]))).isoformat(),
            "years": years,
            "estimates": {"epsThisYear": eps * (1 + growth), "epsNextYear": eps * (1 + growth) ** 2, "analysts": 5} if i % 3 else {},
        })
    return results


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--demo", action="store_true", help="デモデータを生成する")
    args = parser.parse_args()

    tickers = json.loads(TICKERS_FILE.read_text(encoding="utf-8"))
    stocks = fetch_demo(tickers) if args.demo else fetch_real(tickers)
    if not stocks:
        sys.exit("1銘柄も取得できませんでした")

    # 自動では取れない情報 (オーナー創業社長かどうか など) を手入力の設定から足す
    manual = json.loads(MANUAL_FILE.read_text(encoding="utf-8")) if MANUAL_FILE.exists() else {}
    for s in stocks:
        s["manual"] = manual.get(s["symbol"], {})

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "demo": args.demo,
        "stocks": stocks,
    }
    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_FILE.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{len(stocks)} 銘柄の業績を {OUTPUT_FILE.relative_to(ROOT)} に保存しました")


if __name__ == "__main__":
    main()
