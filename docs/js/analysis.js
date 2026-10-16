// テクニカル指標の計算と、チャート形状にもとづく銘柄スコアリング。
// ブラウザでは window.Analysis、Node では module.exports として使える。
(function (root) {
  "use strict";

  // ---- 指標 ----------------------------------------------------------

  function sma(values, n) {
    const out = new Array(values.length).fill(null);
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      sum += values[i];
      if (i >= n) sum -= values[i - n];
      if (i >= n - 1) out[i] = sum / n;
    }
    return out;
  }

  function ema(values, n) {
    const out = new Array(values.length).fill(null);
    const k = 2 / (n + 1);
    let prev = null;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v == null) continue;
      if (prev == null) {
        // 最初の n 本の単純平均を起点にする
        const start = i;
        if (values.length - start < n) break;
        let s = 0;
        for (let j = start; j < start + n; j++) s += values[j];
        prev = s / n;
        out[start + n - 1] = prev;
        i = start + n - 1;
        continue;
      }
      prev = v * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  }

  // Wilder の RSI
  function rsi(closes, n = 14) {
    const out = new Array(closes.length).fill(null);
    if (closes.length <= n) return out;
    let gain = 0, loss = 0;
    for (let i = 1; i <= n; i++) {
      const d = closes[i] - closes[i - 1];
      if (d >= 0) gain += d; else loss -= d;
    }
    gain /= n; loss /= n;
    out[n] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    for (let i = n + 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      gain = (gain * (n - 1) + Math.max(d, 0)) / n;
      loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
      out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }
    return out;
  }

  function macd(closes, fast = 12, slow = 26, signal = 9) {
    const ef = ema(closes, fast);
    const es = ema(closes, slow);
    const line = closes.map((_, i) => (ef[i] != null && es[i] != null ? ef[i] - es[i] : null));
    const firstIdx = line.findIndex((v) => v != null);
    const sig = new Array(closes.length).fill(null);
    if (firstIdx >= 0) {
      const s = ema(line.slice(firstIdx), signal);
      s.forEach((v, j) => (sig[firstIdx + j] = v));
    }
    const hist = line.map((v, i) => (v != null && sig[i] != null ? v - sig[i] : null));
    return { line, signal: sig, hist };
  }

  function bollinger(closes, n = 20, k = 2) {
    const mid = sma(closes, n);
    const upper = new Array(closes.length).fill(null);
    const lower = new Array(closes.length).fill(null);
    for (let i = n - 1; i < closes.length; i++) {
      let v = 0;
      for (let j = i - n + 1; j <= i; j++) v += (closes[j] - mid[i]) ** 2;
      const sd = Math.sqrt(v / n);
      upper[i] = mid[i] + k * sd;
      lower[i] = mid[i] - k * sd;
    }
    return { mid, upper, lower };
  }

  function atr(highs, lows, closes, n = 14) {
    const tr = closes.map((c, i) =>
      i === 0
        ? highs[i] - lows[i]
        : Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]))
    );
    const out = new Array(closes.length).fill(null);
    if (closes.length < n) return out;
    let a = tr.slice(0, n).reduce((s, v) => s + v, 0) / n;
    out[n - 1] = a;
    for (let i = n; i < closes.length; i++) {
      a = (a * (n - 1) + tr[i]) / n;
      out[i] = a;
    }
    return out;
  }

  // 直近 lookback 本以内に a が b を上抜け(+1)/下抜け(-1)したか。新しいものを優先。
  function recentCross(a, b, lookback) {
    const last = a.length - 1;
    for (let i = last; i > last - lookback && i > 0; i--) {
      if (a[i] == null || b[i] == null || a[i - 1] == null || b[i - 1] == null) continue;
      if (a[i - 1] <= b[i - 1] && a[i] > b[i]) return { dir: 1, barsAgo: last - i };
      if (a[i - 1] >= b[i - 1] && a[i] < b[i]) return { dir: -1, barsAgo: last - i };
    }
    return null;
  }

  function computeIndicators(bars) {
    const closes = bars.map((b) => b.close);
    const highs = bars.map((b) => b.high);
    const lows = bars.map((b) => b.low);
    const volumes = bars.map((b) => b.volume);
    return {
      closes, highs, lows, volumes,
      sma5: sma(closes, 5),
      sma25: sma(closes, 25),
      sma75: sma(closes, 75),
      rsi14: rsi(closes, 14),
      macd: macd(closes),
      bb: bollinger(closes, 20, 2),
      atr14: atr(highs, lows, closes, 14),
      vol20: sma(volumes, 20),
    };
  }

  // ---- スコアリング --------------------------------------------------

  // 投資スタイルごとのカテゴリ重み
  const STYLES = {
    balanced: { label: "バランス", weights: { trend: 1, momentum: 1, reversal: 1, volume: 1 } },
    trend: { label: "順張り (トレンドフォロー)", weights: { trend: 1.5, momentum: 1.3, reversal: 0.4, volume: 1 } },
    reversal: { label: "逆張り (押し目・反発狙い)", weights: { trend: 0.5, momentum: 0.8, reversal: 2, volume: 1 } },
  };

  const CATEGORY_LABELS = { trend: "トレンド", momentum: "モメンタム", reversal: "反発/過熱", volume: "出来高" };

  function pct(a, b) {
    return b ? (a / b - 1) * 100 : null;
  }

  function rating(score) {
    if (score >= 70) return { key: "strong-buy", label: "強い買い" };
    if (score >= 58) return { key: "buy", label: "買い" };
    if (score >= 42) return { key: "hold", label: "様子見" };
    if (score >= 30) return { key: "sell", label: "売り" };
    return { key: "strong-sell", label: "強い売り" };
  }

  // bars: [{time, open, high, low, close, volume}] (古い順)
  function analyze(bars, styleKey = "balanced") {
    if (bars.length < 30) {
      return { ok: false, error: "分析には最低30本の日足が必要です" };
    }
    const ind = computeIndicators(bars);
    const L = bars.length - 1;
    const close = ind.closes[L];
    const prevClose = ind.closes[L - 1];
    const signals = [];
    const add = (category, points, text) => signals.push({ category, points, text });

    // トレンド
    const s5 = ind.sma5[L], s25 = ind.sma25[L], s75 = ind.sma75[L];
    if (s25 != null) {
      if (close > s25) add("trend", 10, "株価が25日移動平均線の上にあり、短中期の上昇基調");
      else add("trend", -10, "株価が25日移動平均線の下にあり、短中期の下落基調");
      const s25Prev = ind.sma25[L - 5];
      if (s25Prev != null) {
        if (s25 > s25Prev) add("trend", 5, "25日移動平均線が上向き");
        else add("trend", -5, "25日移動平均線が下向き");
      }
    }
    if (s25 != null && s75 != null) {
      if (s5 > s25 && s25 > s75) add("trend", 12, "移動平均線がパーフェクトオーダー (5日 > 25日 > 75日)");
      else if (s5 < s25 && s25 < s75) add("trend", -12, "移動平均線が逆パーフェクトオーダー (5日 < 25日 < 75日)");
      else if (s25 > s75) add("trend", 5, "25日線が75日線より上で中期トレンドは上向き");
      else add("trend", -5, "25日線が75日線より下で中期トレンドは下向き");
    }
    const gc = recentCross(ind.sma5, ind.sma25, 5);
    if (gc) {
      if (gc.dir > 0) add("trend", 15, `ゴールデンクロス発生 (5日線が25日線を上抜け, ${gc.barsAgo}日前)`);
      else add("trend", -15, `デッドクロス発生 (5日線が25日線を下抜け, ${gc.barsAgo}日前)`);
    }
    const year = ind.highs.slice(-250);
    const yearHigh = Math.max(...year);
    const yearLow = Math.min(...ind.lows.slice(-250));
    if (close >= yearHigh * 0.97 && s25 != null && close > s25) {
      add("trend", 6, "直近1年の高値圏 (高値更新・ブレイク期待)");
    }

    // モメンタム (MACD)
    const m = ind.macd;
    if (m.line[L] != null && m.signal[L] != null) {
      const mc = recentCross(m.line, m.signal, 5);
      if (mc && mc.dir > 0) add("momentum", 12, `MACDがシグナルを上抜け (${mc.barsAgo}日前)`);
      else if (mc && mc.dir < 0) add("momentum", -12, `MACDがシグナルを下抜け (${mc.barsAgo}日前)`);
      else if (m.line[L] > m.signal[L]) add("momentum", 5, "MACDがシグナルより上で買い優勢");
      else add("momentum", -5, "MACDがシグナルより下で売り優勢");
      if (m.line[L] > 0) add("momentum", 4, "MACDがゼロより上 (上昇局面)");
      else add("momentum", -4, "MACDがゼロより下 (下落局面)");
    }

    // 反発/過熱 (RSI・ボリンジャーバンド)
    const r = ind.rsi14[L];
    const rPrev = ind.rsi14[L - 3];
    if (r != null) {
      if (r < 30) add("reversal", 12, `RSI ${r.toFixed(0)}: 売られすぎで反発の可能性`);
      else if (r > 75) add("reversal", -12, `RSI ${r.toFixed(0)}: 買われすぎで反落に注意`);
      else if (r > 70) add("reversal", -7, `RSI ${r.toFixed(0)}: やや過熱気味`);
      else if (r < 45 && rPrev != null && r > rPrev + 3) add("reversal", 6, `RSI ${r.toFixed(0)}: 低水準から持ち直し`);
      else if (r >= 50 && r <= 65) add("momentum", 3, `RSI ${r.toFixed(0)}: 過熱感のない上昇余地`);
    }
    const bbU = ind.bb.upper[L], bbL = ind.bb.lower[L];
    if (bbL != null) {
      if (close < bbL) add("reversal", 8, "ボリンジャーバンド -2σ を下回り、行き過ぎた下落");
      else if (close > bbU) add("reversal", -6, "ボリンジャーバンド +2σ を上回り、短期的に過熱");
    }

    // 出来高
    const v = ind.volumes[L], v20 = ind.vol20[L - 1];
    if (v20 && v > v20 * 1.5) {
      if (close >= bars[L].open && close >= prevClose) add("volume", 8, `出来高が20日平均の${(v / v20).toFixed(1)}倍で陽線 (買いが集まっている)`);
      else add("volume", -8, `出来高が20日平均の${(v / v20).toFixed(1)}倍で陰線 (売り圧力が強い)`);
    }

    const style = STYLES[styleKey] || STYLES.balanced;
    let raw = 0;
    for (const s of signals) {
      s.weighted = s.points * style.weights[s.category];
      raw += s.weighted;
    }
    const score = Math.max(0, Math.min(100, Math.round(50 + (raw * 50) / 60)));
    signals.sort((a, b) => Math.abs(b.weighted) - Math.abs(a.weighted));

    const atrNow = ind.atr14[L];
    const ret = (n) => (L - n >= 0 ? pct(close, ind.closes[L - n]) : null);

    return {
      ok: true,
      score,
      rating: rating(score),
      signals,
      indicators: ind,
      last: {
        date: bars[L].time,
        close,
        change: close - prevClose,
        changePct: pct(close, prevClose),
        ret1m: ret(21),
        ret3m: ret(63),
        rsi: r,
        yearHigh,
        yearLow,
        atr: atrNow,
        // ATR を使った参考ライン
        stopLoss: atrNow != null ? close - 2 * atrNow : null,
        target: atrNow != null ? close + 3 * atrNow : null,
      },
    };
  }

  // CSV (Date,Open,High,Low,Close,Volume) を bars に変換。列名の大小や日本語にもある程度対応。
  function parseCsv(text) {
    const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) throw new Error("CSVにデータ行がありません");
    const header = lines[0].split(",").map((h) => h.trim().toLowerCase().replace(/"/g, ""));
    const find = (...names) => header.findIndex((h) => names.some((n) => h === n || h.includes(n)));
    const idx = {
      time: find("date", "日付"),
      open: find("open", "始値"),
      high: find("high", "高値"),
      low: find("low", "安値"),
      close: find("adj close", "close", "終値"),
      volume: find("volume", "出来高"),
    };
    if (header.includes("close")) idx.close = header.indexOf("close");
    for (const k of ["time", "open", "high", "low", "close"]) {
      if (idx[k] < 0) throw new Error(`CSVに「${k}」列が見つかりません (必要な列: Date, Open, High, Low, Close, Volume)`);
    }
    const bars = [];
    for (const line of lines.slice(1)) {
      const c = line.split(",").map((x) => x.trim().replace(/"/g, ""));
      const num = (i) => (i >= 0 ? parseFloat(c[i].replace(/[^0-9.\-eE]/g, "")) : 0);
      const time = c[idx.time].replace(/\//g, "-").slice(0, 10);
      const bar = { time, open: num(idx.open), high: num(idx.high), low: num(idx.low), close: num(idx.close), volume: num(idx.volume) || 0 };
      if (!/^\d{4}-\d{1,2}-\d{1,2}$/.test(time) || [bar.open, bar.high, bar.low, bar.close].some(isNaN)) continue;
      const [y, mo, d] = time.split("-");
      bar.time = `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
      bars.push(bar);
    }
    bars.sort((a, b) => (a.time < b.time ? -1 : 1));
    return bars;
  }

  const api = { sma, ema, rsi, macd, bollinger, atr, recentCross, computeIndicators, analyze, parseCsv, STYLES, CATEGORY_LABELS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Analysis = api;
})(typeof window !== "undefined" ? window : globalThis);
