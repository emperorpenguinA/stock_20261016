// 業績データ (年次決算・株価指標) から銘柄を評価する。
// 参考資料のチェック項目を、自動で判定できるものは判定し、できないものは「未確認」として示す。
// ブラウザでは window.Fundamentals、Node では module.exports として使える。
(function (root) {
  "use strict";

  const GROUPS = {
    select4: "銘柄選定の4条件",
    growth: "成長株の基準 (3期連続)",
    statements: "決算書のチェック",
    value: "割安かどうか",
    future: "将来の株価",
    quality: "その他の指標",
  };

  function ratio(a, b) {
    return a != null && b != null && b !== 0 ? a / b : null;
  }

  // 前期比 (前期が0以下だと意味がないので null)
  function growthSeries(years, key) {
    const out = [];
    for (let i = 1; i < years.length; i++) {
      const prev = years[i - 1][key], cur = years[i][key];
      out.push(prev != null && cur != null && prev > 0 ? cur / prev - 1 : null);
    }
    return out;
  }

  function cagr(first, last, n) {
    return first != null && last != null && first > 0 && last > 0 && n > 0 ? (last / first) ** (1 / n) - 1 : null;
  }

  function pctText(v, digits = 1) {
    return v == null ? "—" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(digits)}%`;
  }

  function okuText(v, currency) {
    if (v == null) return "—";
    if (currency === "USD") return v >= 1e9 ? `$${(v / 1e9).toFixed(1)}B` : `$${(v / 1e6).toFixed(0)}M`;
    return v >= 1e12 ? `${(v / 1e12).toFixed(2)}兆円` : `${Math.round(v / 1e8).toLocaleString("ja-JP")}億円`;
  }

  // 3期連続で threshold 以上伸びているか (判定に必要な期数が無ければ null)
  function consecutive(series, threshold) {
    const last3 = series.slice(-3);
    if (last3.length < 3 || last3.some((v) => v == null)) return null;
    return last3.every((v) => v >= threshold);
  }

  function evaluate(rec, now = new Date()) {
    const years = rec.years || [];
    const last = years[years.length - 1] || {};
    const cur = rec.currency;
    const checks = [];
    const add = (group, label, status, detail, points = 0) => checks.push({ group, label, status, detail, points });

    const rev = growthSeries(years, "revenue");
    const op = growthSeries(years, "operatingIncome");
    const eps = growthSeries(years, "eps");
    const dps = growthSeries(years, "dps");

    // ---- 銘柄選定の4条件 ----
    const listed = rec.firstTradeDate ? new Date(rec.firstTradeDate + "T00:00:00Z") : null;
    if (!listed) add("select4", "上場2年目〜3年目", "unknown", "上場日が分かりません", 10);
    else if (listed.getUTCFullYear() < 2001) add("select4", "上場2年目〜3年目", "fail", "上場から長い (データの開始が " + rec.firstTradeDate.slice(0, 4) + "年)", 10);
    else {
      const y = (now - listed) / (365.25 * 86400000);
      const nth = Math.floor(y) + 1;
      add("select4", "上場2年目〜3年目", nth >= 2 && nth <= 3 ? "pass" : "fail",
        `上場 ${rec.firstTradeDate.replace(/-/g, "/")} (${nth}年目)。上場のメリットが数字に出やすい時期`, 10);
    }
    if (cur !== "JPY") add("select4", "時価総額500億円以下", "na", "日本株のみの基準", 10);
    else if (rec.marketCap == null) add("select4", "時価総額500億円以下", "unknown", "時価総額が分かりません", 10);
    else add("select4", "時価総額500億円以下", rec.marketCap <= 5e10 ? "pass" : "fail", `時価総額 ${okuText(rec.marketCap, cur)}。小さい会社の方が株価2倍になりやすい`, 10);
    const owner = rec.manual && rec.manual.ownerCeo;
    add("select4", "オーナー創業社長", owner === true ? "pass" : owner === false ? "fail" : "unknown",
      owner == null ? "自動では判定できません (config/fundamentals_manual.json で設定)" : rec.manual.note || (owner ? "創業者が社長" : "創業社長ではない"), 10);
    const revLast = rev[rev.length - 1];
    const rev3 = consecutive(rev, 0);
    if (revLast == null) add("select4", "売上が伸びている", "unknown", "売上高の推移が分かりません", 10);
    else add("select4", "売上が伸びている", revLast > 0 ? "pass" : "fail",
      `直近の売上高 前期比 ${pctText(revLast)}${rev3 ? " (3期連続で増収)" : ""}。利益ではなく売上を見る`, 10);

    // ---- 成長株の基準 (3期連続) ----
    const growthRule = (label, series, threshold) => {
      const r = consecutive(series, threshold);
      const detail = series.length ? `前期比 ${series.slice(-3).map((v) => pctText(v, 0)).join(" → ")}` : "データ不足";
      add("growth", label, r == null ? "unknown" : r ? "pass" : "fail", r == null ? `判定には4期分の決算が必要 (${detail})` : detail, 5);
      return r;
    };
    const g1 = growthRule("売上高 +10%以上", rev, 0.1);
    const g2 = growthRule("営業利益 +10%以上", op, 0.1);
    const g3 = growthRule("EPS +10%以上", eps, 0.1);
    const g4 = growthRule("1株配当 +2.5%以上", dps, 0.025);
    const growthAll = [g1, g2, g3, g4].every((v) => v === true);

    // ---- 決算書のチェック ----
    if (last.operatingCF == null) add("statements", "営業CFがプラス", "unknown", "データなし", 5);
    else add("statements", "営業CFがプラス", last.operatingCF > 0 ? "pass" : "fail", `営業CF ${okuText(last.operatingCF, cur)} (本業で現金を稼げているか)`, 5);
    if (last.freeCF == null) add("statements", "フリーCFがプラス", "unknown", "データなし", 5);
    else add("statements", "フリーCFがプラス", last.freeCF > 0 ? "pass" : "fail", `フリーCF ${okuText(last.freeCF, cur)} (自由に使えるお金)`, 5);
    const payout = rec.payoutRatio ?? ratio(last.dps, last.eps);
    add("statements", "配当性向", "info",
      payout == null ? "データなし" : `${(payout * 100).toFixed(0)}% (目安: 成熟企業 40〜60%、成長企業 0〜30%)`);

    // ---- 割安かどうか ----
    const perUsed = rec.forwardPer ?? rec.per;
    const pp = perUsed != null && rec.pbr != null && perUsed > 0 && rec.pbr > 0 ? perUsed * rec.pbr : null;
    const epsLast = eps[eps.length - 1];
    if (pp == null) add("value", "PER×PBR が15.5以下", "unknown", "PER か PBR が分かりません (赤字の場合も)", 10);
    else if (epsLast != null && epsLast < 0) add("value", "PER×PBR が15.5以下", "fail", `PER×PBR = ${pp.toFixed(1)}。ただし直近は減益 (EPS ${pctText(epsLast)}) のため割安とはみなさない`, 10);
    else add("value", "PER×PBR が15.5以下", pp <= 15.5 ? "pass" : pp < 22.5 ? "partial" : "fail",
      `PER ${perUsed.toFixed(1)}倍 × PBR ${rec.pbr.toFixed(2)}倍 = ${pp.toFixed(1)} (市川校長流 15.5以下 / バフェット流 22.5未満)`, 10);

    // ---- 将来の株価 (将来EPS × 今のPER) ----
    const epsCagr = years.length >= 2 ? cagr(years[0].eps, last.eps, years.length - 1) : null;
    const est = rec.estimates || {};
    const thisEps = est.epsThisYear ?? rec.forwardEps ?? rec.trailingEps;
    const g = epsCagr == null ? null : Math.max(-0.3, Math.min(0.5, epsCagr));
    const nextEps = est.epsNextYear ?? (thisEps != null && g != null ? thisEps * (1 + g) : null);
    let future = null;
    if (rec.price && thisEps > 0 && nextEps != null) {
      const per0 = rec.price / thisEps;
      const price = nextEps * per0;
      future = {
        price,
        upside: price / rec.price - 1,
        per: per0,
        thisEps,
        nextEps,
        basis: est.epsNextYear ? `アナリスト予想 (${est.analysts || "?"}人) の来期EPS` : `過去${years.length - 1}年のEPS成長率 ${pctText(g)} が続くと仮定`,
      };
      add("future", "将来の株価に上昇余地", future.upside >= 0.2 ? "pass" : future.upside >= 0.1 ? "partial" : "fail",
        `来期EPS ${nextEps.toFixed(1)} × 今のPER ${per0.toFixed(1)}倍 = ${future.price.toFixed(0)} (${pctText(future.upside)})。根拠: ${future.basis}`, 10);
    } else {
      add("future", "将来の株価に上昇余地", "unknown", "EPS の予想を立てられません (赤字・データ不足)", 10);
    }

    // ---- その他の指標 ----
    const roe = ratio(last.netIncome, last.equity);
    const equityRatio = ratio(last.equity, last.totalAssets);
    const opMargin = ratio(last.operatingIncome, last.revenue);
    const revCagr = years.length >= 2 ? cagr(years[0].revenue, last.revenue, years.length - 1) : null;
    const peg = rec.per != null && epsCagr != null && epsCagr > 0 ? rec.per / (epsCagr * 100) : null;
    const divYield = rec.dividendRate != null && rec.price ? rec.dividendRate / rec.price : null;
    const netCash = last.cash != null && last.debt != null && rec.marketCap ? (last.cash - last.debt) / rec.marketCap : null;
    if (roe == null) add("quality", "ROE 10%以上", "unknown", "データなし", 5);
    else add("quality", "ROE 10%以上", roe >= 0.1 ? "pass" : "fail", `ROE ${(roe * 100).toFixed(1)}% (株主のお金でどれだけ稼いだか)`, 5);
    if (peg == null) add("quality", "PEG 1倍以下", "unknown", "利益が伸びていない、またはデータ不足", 5);
    else add("quality", "PEG 1倍以下", peg <= 1 ? "pass" : peg <= 1.5 ? "partial" : "fail", `PEG ${peg.toFixed(2)} (PER ÷ EPS成長率。成長の割に安いか)`, 5);
    if (equityRatio == null) add("quality", "自己資本比率", "info", "データなし");
    else add("quality", "自己資本比率", "info", `${(equityRatio * 100).toFixed(0)}% (40%以上だと財務が安定。銀行などは低くなる)`);

    // 判定できた項目だけで点数を出す
    let earned = 0, possible = 0;
    for (const c of checks) {
      if (!c.points || c.status === "unknown" || c.status === "na" || c.status === "info") continue;
      possible += c.points;
      earned += c.status === "pass" ? c.points : c.status === "partial" ? c.points / 2 : 0;
    }
    const score = possible ? Math.round((earned / possible) * 100) : null;
    const scored = checks.filter((c) => c.points);
    const coverage = { known: scored.filter((c) => ["pass", "fail", "partial"].includes(c.status)).length, total: scored.length };
    const select4 = checks.filter((c) => c.group === "select4");

    return {
      score,
      rating: rating(score, coverage),
      checks,
      coverage,
      select4: { passed: select4.filter((c) => c.status === "pass").length, total: select4.length },
      growthAll,
      future,
      metrics: { roe, equityRatio, opMargin, revCagr, epsCagr, peg, divYield, netCash, pp, per: rec.per, forwardPer: rec.forwardPer, pbr: rec.pbr, payout },
      growth: { rev, op, eps, dps },
    };
  }

  function rating(score, coverage) {
    if (score == null || coverage.known < coverage.total / 2) return { key: "hold", label: "判定材料不足" };
    if (score >= 75) return { key: "strong-buy", label: "有望" };
    if (score >= 55) return { key: "buy", label: "良好" };
    if (score >= 40) return { key: "hold", label: "普通" };
    return { key: "sell", label: "注意" };
  }

  const api = { GROUPS, evaluate, growthSeries, cagr, pctText, okuText };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Fundamentals = api;
})(typeof window !== "undefined" ? window : globalThis);
