"""全銘柄スクリーニングの対象銘柄 (東証の内国株式 + S&P 500) の一覧を作る。

使い方:
    python scripts/build_universe.py OUT.json

- 東証: 日本取引所グループ (JPX) が公開している「東証上場銘柄一覧」から、
  プライム・スタンダード・グロースの内国株式だけを取り出す (ETF・REIT などは除く)
- 米国: S&P 500 の構成銘柄 (github.com/datasets/s-and-p-500-companies)
- config/tickers.json の銘柄は区分 (groups) を引き継ぐ
"""

from __future__ import annotations

import csv
import io
import json
import re
import sys
import urllib.request
from urllib.parse import urljoin
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# 東証上場銘柄一覧のページ。ファイルの場所は更新のたびに変わることがあるので、ページからリンクを探す
JPX_PAGE = "https://www.jpx.co.jp/markets/statistics-equities/misc/01.html"
SP500_URL = "https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv"
SEGMENTS = {"プライム（内国株式）": "プライム", "スタンダード（内国株式）": "スタンダード", "グロース（内国株式）": "グロース"}


def download(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60) as res:
        return res.read()


def jpx_stocks() -> list[dict]:
    import pandas as pd

    page = download(JPX_PAGE).decode("utf-8", "replace")
    links = re.findall(r'href="([^"]+data_j\.xlsx?)"', page) or re.findall(r'href="([^"]+\.xlsx?)"', page)
    if not links:
        raise RuntimeError("東証上場銘柄一覧のファイルが見つかりません")
    url = urljoin(JPX_PAGE, links[0])
    df = pd.read_excel(io.BytesIO(download(url)), dtype=str)
    out = []
    for _, r in df.iterrows():
        seg = SEGMENTS.get(str(r["市場・商品区分"]).strip())
        if not seg:
            continue
        code = str(r["コード"]).strip()
        out.append({
            "symbol": f"{code}.T",
            "name": str(r["銘柄名"]).strip(),
            "market": "JP",
            "segment": seg,
            "sector": str(r.get("33業種区分", "")).strip(),
        })
    return out


def sp500_stocks() -> list[dict]:
    rows = csv.DictReader(io.StringIO(download(SP500_URL).decode("utf-8")))
    return [
        {
            "symbol": r["Symbol"].strip().replace(".", "-"),  # BRK.B → BRK-B (Yahoo の表記)
            "name": r["Security"].strip(),
            "market": "US",
            "segment": "S&P500",
            "sector": r["GICS Sector"].strip(),
        }
        for r in rows
    ]


def main() -> None:
    out_path = Path(sys.argv[1])
    curated = {t["symbol"]: t for t in json.loads((ROOT / "config" / "tickers.json").read_text(encoding="utf-8"))}
    stocks: dict[str, dict] = {}
    for fetch in (jpx_stocks, sp500_stocks):
        try:
            for s in fetch():
                stocks[s["symbol"]] = s
        except Exception as e:  # noqa: BLE001 - 片方の一覧が取れなくても続ける
            print(f"[warn] {fetch.__name__}: {e}", file=sys.stderr)
    # 一覧に無い手動の銘柄も入れ、区分を引き継ぐ
    for sym, t in curated.items():
        base = stocks.setdefault(sym, {"symbol": sym, "name": t["name"], "market": t["market"], "segment": "", "sector": ""})
        base["groups"] = t.get("groups", [])
    if len(stocks) <= len(curated):
        sys.exit("銘柄一覧を取得できませんでした")
    out_path.write_text(json.dumps(list(stocks.values()), ensure_ascii=False), encoding="utf-8")
    jp = sum(1 for s in stocks.values() if s["market"] == "JP")
    print(f"{len(stocks)} 銘柄 (日本 {jp} / 米国 {len(stocks) - jp}) を {out_path} に保存しました")


if __name__ == "__main__":
    main()
