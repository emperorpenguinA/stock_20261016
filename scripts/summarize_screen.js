// 全銘柄スクリーニングの一覧データ (screen.json) を作る。
// ページと同じ採点ロジック (docs/js/analysis.js・fundamentals.js) を Node で動かす。
//
// 使い方: node scripts/summarize_screen.js OUT_DIR
"use strict";

const fs = require("fs");
const path = require("path");
const A = require("../docs/js/analysis.js");
const F = require("../docs/js/fundamentals.js");

const outDir = process.argv[2];
if (!outDir) {
  console.error("usage: node scripts/summarize_screen.js OUT_DIR");
  process.exit(1);
}

const toBars = (raw) => (raw || []).map((b) => ({ time: b[0], open: b[1], high: b[2], low: b[3], close: b[4], volume: b[5] }));
const round = (v, d = 4) => (v == null || !isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

// 業績データの株価指標を、最新の終値で計算し直す (業績は数日〜10日に1回の取得のため)
function refreshValuation(rec, close) {
  if (!close || !rec.price) return rec;
  const k = close / rec.price;
  return {
    ...rec,
    price: close,
    marketCap: rec.shares ? rec.shares * close : rec.marketCap != null ? rec.marketCap * k : null,
    per: rec.per != null ? rec.per * k : null,
    forwardPer: rec.forwardPer != null ? rec.forwardPer * k : null,
    pbr: rec.pbr != null ? rec.pbr * k : null,
  };
}

const files = fs.readdirSync(path.join(outDir, "stocks")).filter((f) => f.endsWith(".json"));
const rows = [];
let fundCount = 0;
for (const f of files) {
  const s = JSON.parse(fs.readFileSync(path.join(outDir, "stocks", f), "utf8"));
  const data = { daily: toBars(s.daily), weekly: toBars(s.weekly), monthly: toBars(s.monthly) };
  let tech;
  try {
    tech = A.analyze(data);
  } catch (e) {
    console.error(`[warn] ${s.symbol}: ${e.message}`);
    continue;
  }
  if (!tech.ok) continue;
  const row = {
    s: s.symbol, n: s.name, m: s.market, g: s.segment || "", sec: s.sector || "", grp: s.groups || [],
    c: tech.last.close, ch: round(tech.last.changePct, 2), r1: round(tech.last.ret1m, 2), d: tech.last.date,
    ts: tech.score, sh: tech.shodou ? 1 : 0,
    tm: tech.trends.monthly && tech.trends.monthly.enough ? tech.trends.monthly.dir : null,
    tw: tech.trends.weekly && tech.trends.weekly.enough ? tech.trends.weekly.dir : null,
    td: tech.trends.daily ? tech.trends.daily.dir : null,
    pt: tech.patterns,
  };
  const fundFile = path.join(outDir, "fund", f);
  if (fs.existsSync(fundFile)) {
    let rec = JSON.parse(fs.readFileSync(fundFile, "utf8"));
    rec = refreshValuation(rec, tech.last.close);
    fs.writeFileSync(fundFile, JSON.stringify(rec));
    const e = F.evaluate(rec);
    Object.assign(row, {
      mc: rec.marketCap != null ? Math.round(rec.marketCap) : null,
      fs: e.score, fr: e.rating.label, s4: e.select4.passed, ga: e.growthAll ? 1 : 0,
      pp: round(e.metrics.pp, 1), up: e.future ? round(e.future.upside, 3) : null,
      rv: round(e.growth.rev[e.growth.rev.length - 1], 3),
      roe: round(e.metrics.roe, 3), per: round(rec.per, 1), ld: rec.firstTradeDate || null, fa: rec.fetchedAt || null,
    });
    fundCount++;
  }
  rows.push(row);
}

rows.sort((a, b) => b.ts - a.ts);
const meta = fs.existsSync(path.join(outDir, "screen_meta.json")) ? JSON.parse(fs.readFileSync(path.join(outDir, "screen_meta.json"), "utf8")) : {};
fs.writeFileSync(path.join(outDir, "screen.json"), JSON.stringify({ ...meta, generated_at: meta.generated_at || new Date().toISOString(), rows }));
console.log(`${rows.length} 銘柄 (業績あり ${fundCount}) を ${path.join(outDir, "screen.json")} に保存しました`);
