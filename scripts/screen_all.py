"""全銘柄スクリーニング用のデータを作る。

使い方:
    python scripts/screen_all.py UNIVERSE.json OUT_DIR CACHE_DIR [--fund-limit N] [--fund-minutes M]
    python scripts/screen_all.py --demo OUT_DIR CACHE_DIR      # ネットワーク不要のデモ

- 株価: 全銘柄の日足 (1年)・週足 (5年)・月足 (10年) をまとめて取得し、
  OUT_DIR/stocks/<銘柄>.json に保存する (チャートのページが必要なときに読み込む)
- 業績: 1回の実行で N 銘柄ずつ、取得日の古い順に取り直す (Yahoo への負荷を抑えるため)。
  結果は CACHE_DIR/fund_cache.json に貯め、全銘柄分を OUT_DIR/fund/<銘柄>.json に書き出す
- 一覧用の要約 (screen.json) は scripts/summarize_screen.js が作る
"""

from __future__ import annotations

import argparse
import json
import random
import sys
import time
from datetime import date, datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fetch_data  # noqa: E402
import fetch_fundamentals  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
CHUNK = 200


def safe_name(symbol: str) -> str:
    return symbol.replace("/", "_")


def bulk_prices(universe: list[dict]) -> dict[str, dict]:
    import yfinance as yf

    symbols = [s["symbol"] for s in universe]
    out: dict[str, dict] = {s: {} for s in symbols}
    for key, (interval, period) in fetch_data.INTERVALS.items():
        for i in range(0, len(symbols), CHUNK):
            chunk = symbols[i:i + CHUNK]
            t0 = time.time()
            try:
                data = yf.download(chunk, period=period, interval=interval, group_by="ticker",
                                   auto_adjust=True, threads=True, progress=False)
            except Exception as e:  # noqa: BLE001
                print(f"[warn] download {key} {i}: {e}", file=sys.stderr)
                continue
            got = 0
            for sym in chunk:
                try:
                    df = data[sym] if len(chunk) > 1 else data
                except KeyError:
                    continue
                rows = fetch_data.to_rows(df)
                if rows:
                    out[sym][key] = rows
                    got += 1
            print(f"[{key}] {i + len(chunk)}/{len(symbols)} 取得 {got} 銘柄 ({time.time() - t0:.0f}秒)")
    return out


def update_fund_cache(universe: list[dict], cache: dict, limit: int, minutes: float) -> int:
    """取得日の古い (または未取得の) 銘柄から順に、業績を取り直す。"""
    order = sorted(universe, key=lambda s: (cache.get(s["symbol"], {}).get("fetchedAt", ""), random.random()))
    deadline = time.time() + minutes * 60
    done = failures = 0
    for s in order[:limit]:
        if time.time() > deadline:
            print("[fund] 時間切れのため次回に回します")
            break
        try:
            rec = fetch_fundamentals.fetch_one({k: s[k] for k in ("symbol", "name", "market") if k in s})
            cache[s["symbol"]] = {"fetchedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"), "rec": rec}
            done += 1
            failures = 0
        except Exception as e:  # noqa: BLE001
            msg = f"{type(e).__name__}: {e}"
            print(f"[warn] fund {s['symbol']}: {msg}", file=sys.stderr)
            # 取得できなかった銘柄も、すぐに取り直さないよう取得日だけ記録する
            cache.setdefault(s["symbol"], {})["fetchedAt"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
            failures += 1
            if "RateLimit" in msg or "Too Many Requests" in msg or failures >= 20:
                print("[fund] Yahoo から制限されたため中断し、次回に回します")
                break
        time.sleep(0.3)
    return done


def demo_data(out_dir: Path, cache_dir: Path) -> None:
    """既存のデモ株価・業績を使い、銘柄を増やした疑似データを作る。"""
    prices = {s["symbol"]: s for s in fetch_data.fetch_demo(json.loads(fetch_data.TICKERS_FILE.read_text(encoding="utf-8")))}
    funds = {s["symbol"]: s for s in fetch_fundamentals.fetch_demo(json.loads(fetch_data.TICKERS_FILE.read_text(encoding="utf-8")))}
    seg = ["プライム", "スタンダード", "グロース"]
    stocks, fund_out = {}, {}
    for i in range(300):
        base = list(prices.values())[i % len(prices)]
        jp = base["market"] == "JP"
        sym = f"{9000 + i}.T" if jp else f"DEMO{i}"
        stocks[sym] = {**base, "symbol": sym, "name": f"デモ銘柄{i}", "segment": seg[i % 3] if jp else "S&P500",
                       "sector": random.Random(i).choice(["情報・通信業", "電気機器", "サービス業", "小売業"])}
        f = list(funds.values())[i % len(funds)]
        fund_out[sym] = {**f, "symbol": sym, "name": stocks[sym]["name"]}
    write_outputs(out_dir, stocks, fund_out, demo=True)


def write_outputs(out_dir: Path, stocks: dict[str, dict], funds: dict[str, dict], demo: bool = False) -> None:
    (out_dir / "stocks").mkdir(parents=True, exist_ok=True)
    (out_dir / "fund").mkdir(parents=True, exist_ok=True)
    for sym, s in stocks.items():
        (out_dir / "stocks" / f"{safe_name(sym)}.json").write_text(json.dumps(s, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    for sym, f in funds.items():
        (out_dir / "fund" / f"{safe_name(sym)}.json").write_text(json.dumps(f, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    meta = {"generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "stocks": len(stocks), "fund": len(funds), "demo": demo}
    (out_dir / "screen_meta.json").write_text(json.dumps(meta), encoding="utf-8")
    print(f"株価 {len(stocks)} 銘柄 / 業績 {len(funds)} 銘柄を {out_dir} に保存しました")


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--demo", action="store_true")
    p.add_argument("paths", nargs="+")
    p.add_argument("--fund-limit", type=int, default=450)
    p.add_argument("--fund-minutes", type=float, default=30)
    a = p.parse_args()
    if a.demo:
        out_dir, cache_dir = map(Path, a.paths)
        demo_data(out_dir, cache_dir)
        return
    universe_path, out_dir, cache_dir = map(Path, a.paths)
    universe = json.loads(universe_path.read_text(encoding="utf-8"))
    meta = {s["symbol"]: s for s in universe}

    # 株価
    prices = bulk_prices(universe)
    stocks = {}
    for sym, bars in prices.items():
        daily = fetch_data.drop_unfinished_bar(bars.get("daily", []), meta[sym]["market"])
        if len(daily) < 30:
            continue
        m = meta[sym]
        stocks[sym] = {**m, "currency": "JPY" if m["market"] == "JP" else "USD",
                       "daily": daily, "weekly": bars.get("weekly", []), "monthly": bars.get("monthly", [])}

    # 業績 (少しずつ取り直してキャッシュに貯める)
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_file = cache_dir / "fund_cache.json"
    cache = json.loads(cache_file.read_text(encoding="utf-8")) if cache_file.exists() else {}
    # 毎日取得している主要銘柄の業績はそのまま使う
    curated = ROOT / "docs" / "data" / "fundamentals.json"
    if curated.exists():
        cur = json.loads(curated.read_text(encoding="utf-8"))
        if not cur.get("demo"):
            for rec in cur["stocks"]:
                cache[rec["symbol"]] = {"fetchedAt": cur["generated_at"], "rec": rec}
    done = update_fund_cache([s for s in universe if s["symbol"] in stocks], cache, a.fund_limit, a.fund_minutes)
    cache_file.write_text(json.dumps(cache, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    with_rec = sum(1 for v in cache.values() if "rec" in v)
    print(f"[fund] 今回 {done} 銘柄を更新 / キャッシュ {with_rec} 銘柄")

    manual_file = ROOT / "config" / "fundamentals_manual.json"
    manual = json.loads(manual_file.read_text(encoding="utf-8")) if manual_file.exists() else {}
    funds = {}
    for sym, v in cache.items():
        if sym in stocks and "rec" in v:
            funds[sym] = {**v["rec"], **{k: meta[sym][k] for k in ("segment", "groups") if k in meta[sym]},
                          "fetchedAt": v["fetchedAt"], "manual": manual.get(sym, {})}
    write_outputs(out_dir, stocks, funds)


if __name__ == "__main__":
    main()
