// チャート分析と銘柄スコアリング。
// 月足・週足で大きなトレンドを確認し、日足のローソク足 (高値・安値、抵抗線/サポートライン、
// ボックス、安値切り上がり)・移動平均線・出来高で買い時/売り時を判定する。
// RSI・MACD・ボリンジャーバンドは補助指標として小さめの重みで加味する。
// ブラウザでは window.Analysis、Node では module.exports として使える。
(function (root) {
  "use strict";

  const TIMEFRAMES = {
    daily: { label: "日足", ma: [5, 25, 75], unit: "日", swingK: 5, lookback: 120 },
    weekly: { label: "週足", ma: [13, 26, 52], unit: "週", swingK: 3, lookback: 104 },
    monthly: { label: "月足", ma: [12, 24, 60], unit: "ヶ月", swingK: 2, lookback: 120 },
  };

  // ---- 基本指標 ------------------------------------------------------

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
    const start = values.findIndex((v) => v != null);
    if (start < 0 || values.length - start < n) return out;
    let prev = 0;
    for (let j = start; j < start + n; j++) prev += values[j];
    prev /= n;
    out[start + n - 1] = prev;
    const k = 2 / (n + 1);
    for (let i = start + n; i < values.length; i++) {
      prev = values[i] * k + prev * (1 - k);
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
    const sig = ema(line, signal);
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

  // ---- ローソク足の形 ------------------------------------------------

  // 前後 k 本の中で一番高い/安い足を高値/安値 (山・谷) とする
  function findSwings(bars, k) {
    const highs = [], lows = [];
    for (let i = k; i < bars.length - k; i++) {
      let isHigh = true, isLow = true;
      for (let j = i - k; j <= i + k; j++) {
        if (j === i) continue;
        if (bars[j].high > bars[i].high || (j < i && bars[j].high === bars[i].high)) isHigh = false;
        if (bars[j].low < bars[i].low || (j < i && bars[j].low === bars[i].low)) isLow = false;
      }
      if (isHigh) highs.push({ i, time: bars[i].time, price: bars[i].high });
      if (isLow) lows.push({ i, time: bars[i].time, price: bars[i].low });
    }
    return { highs, lows };
  }

  // 2回以上同じ水準で反発している高値/安値を抵抗線/サポートラインとして束ねる
  function findLevels(points, tolerance) {
    const sorted = [...points].sort((a, b) => a.price - b.price);
    const groups = [];
    for (const p of sorted) {
      const g = groups[groups.length - 1];
      if (g && p.price <= g.base * (1 + tolerance)) g.points.push(p);
      else groups.push({ base: p.price, points: [p] });
    }
    return groups
      .filter((g) => g.points.length >= 2)
      .map((g) => ({
        price: g.points.reduce((s, p) => s + p.price, 0) / g.points.length,
        touches: g.points.length,
        lastIndex: Math.max(...g.points.map((p) => p.i)),
      }));
  }

  // 一定の高値と安値の間で上下している「ボックス相場」を探す。
  // 直近 recent 本を除いた期間で箱を作り、直近の足がその上限/下限を抜けたかを見る。
  function findBox(bars, swings, { window = 40, recent = 3, maxWidth = 0.2, touchTol = 0.03 } = {}) {
    const end = bars.length - 1 - recent;
    const start = end - window + 1;
    if (start < 0) return null;
    let upper = -Infinity, lower = Infinity;
    for (let i = start; i <= end; i++) {
      upper = Math.max(upper, bars[i].high);
      lower = Math.min(lower, bars[i].low);
    }
    if ((upper - lower) / lower > maxWidth) return null;
    const inRange = (p) => p.i >= start && p.i <= end;
    const topTouches = swings.highs.filter((p) => inRange(p) && p.price >= upper * (1 - touchTol)).length;
    const bottomTouches = swings.lows.filter((p) => inRange(p) && p.price <= lower * (1 + touchTol)).length;
    if (topTouches < 2 || bottomTouches < 2) return null;
    return { start, end, startTime: bars[start].time, endTime: bars[bars.length - 1].time, upper, lower, topTouches, bottomTouches };
  }

  // 直近 bars 本の価格帯別出来高。最も出来高が積み上がった価格帯 (しこり) を返す。
  function volumeProfile(bars, count = 60, bins = 24) {
    const slice = bars.slice(-count);
    if (slice.length < 10) return null;
    const lo = Math.min(...slice.map((b) => b.low));
    const hi = Math.max(...slice.map((b) => b.high));
    if (hi <= lo) return null;
    const step = (hi - lo) / bins;
    const vols = new Array(bins).fill(0);
    for (const b of slice) {
      const typical = (b.high + b.low + b.close) / 3;
      vols[Math.min(bins - 1, Math.floor((typical - lo) / step))] += b.volume;
    }
    let poc = 0;
    vols.forEach((v, i) => { if (v > vols[poc]) poc = i; });
    return {
      bins: vols.map((v, i) => ({ low: lo + i * step, high: lo + (i + 1) * step, volume: v })),
      poc: { low: lo + poc * step, high: lo + (poc + 1) * step, price: lo + (poc + 0.5) * step },
    };
  }

  // 高値・安値の更新状況と移動平均線の向きからトレンドを判定する
  function trendState(bars, ind, swings) {
    const L = bars.length - 1;
    const close = bars[L].close;
    const H = swings.highs, Lw = swings.lows;
    const lastHigh = H[H.length - 1], prevHigh = H[H.length - 2];
    const lastLow = Lw[Lw.length - 1], prevLow = Lw[Lw.length - 2];
    const mid = ind.maMid[L], midPrev = ind.maMid[Math.max(0, L - 3)];
    const maUp = mid != null && midPrev != null && mid > midPrev;
    const maDown = mid != null && midPrev != null && mid < midPrev;
    let dir = 0, text = "もみ合い";
    if (lastHigh && close > lastHigh.price) { dir = 1; text = "直近の高値を上抜け (上昇トレンド)"; }
    else if (lastLow && close < lastLow.price) { dir = -1; text = "直近の安値を下抜け (下落トレンド)"; }
    else if (prevHigh && prevLow && lastHigh.price > prevHigh.price && lastLow.price > prevLow.price) { dir = 1; text = "高値・安値とも切り上げ (上昇トレンド)"; }
    else if (prevHigh && prevLow && lastHigh.price < prevHigh.price && lastLow.price < prevLow.price) { dir = -1; text = "高値・安値とも切り下げ (下落トレンド)"; }
    else if (mid != null && close > mid && maUp) { dir = 1; text = "中期線が上向きで株価はその上"; }
    else if (mid != null && close < mid && maDown) { dir = -1; text = "中期線が下向きで株価はその下"; }
    return { dir, text, maUp, maDown, aboveMid: mid != null && close > mid, lastHigh, lastLow, enough: mid != null };
  }

  // ---- 時間足ごとの分析 ----------------------------------------------

  function analyzeTimeframe(bars, tfKey) {
    const tf = TIMEFRAMES[tfKey];
    const closes = bars.map((b) => b.close);
    const highs = bars.map((b) => b.high);
    const lows = bars.map((b) => b.low);
    const volumes = bars.map((b) => b.volume);
    const [s, m, l] = tf.ma;
    const ind = {
      closes, highs, lows, volumes,
      maShort: sma(closes, s),
      maMid: sma(closes, m),
      maLong: sma(closes, l),
      rsi14: rsi(closes, 14),
      macd: macd(closes),
      bb: bollinger(closes, 20, 2),
      atr14: atr(highs, lows, closes, 14),
      vol20: sma(volumes, 20),
    };
    const swings = findSwings(bars, tf.swingK);
    const from = Math.max(0, bars.length - tf.lookback);
    const recent = { highs: swings.highs.filter((p) => p.i >= from), lows: swings.lows.filter((p) => p.i >= from) };
    const tol = tfKey === "daily" ? 0.02 : 0.04;
    const close = bars.length ? bars[bars.length - 1].close : 0;
    const resistances = findLevels(recent.highs, tol);
    const supports = findLevels(recent.lows, tol);
    return {
      tf: tfKey,
      bars,
      ind,
      swings,
      levels: {
        resistance: resistances.filter((r) => r.price > close).sort((a, b) => a.price - b.price)[0] || null,
        support: supports.filter((r) => r.price < close).sort((a, b) => b.price - a.price)[0] || null,
        all: [...resistances.map((r) => ({ ...r, kind: "resistance" })), ...supports.map((r) => ({ ...r, kind: "support" }))],
      },
      box: tfKey === "daily" ? findBox(bars, swings) : null,
      profile: volumeProfile(bars, tfKey === "daily" ? 60 : tfKey === "weekly" ? 26 : 24),
      trend: bars.length > 2 ? trendState(bars, ind, swings) : null,
    };
  }

  // ---- スコアリング --------------------------------------------------

  const CATEGORY_LABELS = { longterm: "月足・週足", candle: "ローソク足", ma: "移動平均線", volume: "出来高", aux: "補助指標" };

  const STYLES = {
    standard: { label: "標準 (ローソク足・移動平均線・出来高)", weights: { longterm: 1, candle: 1, ma: 1, volume: 1, aux: 0.4 } },
    trend: { label: "順張り (長期トレンド重視)", weights: { longterm: 1.5, candle: 1.2, ma: 1, volume: 1, aux: 0.2 } },
    reversal: { label: "逆張り (売られすぎの反発狙い)", weights: { longterm: 0.6, candle: 0.8, ma: 0.6, volume: 1, aux: 1.6 } },
  };

  function pct(a, b) {
    return b ? (a / b - 1) * 100 : null;
  }

  function rating(score) {
    if (score >= 80) return { key: "strong-buy", label: "強い買い" };
    if (score >= 62) return { key: "buy", label: "買い" };
    if (score >= 40) return { key: "hold", label: "様子見" };
    if (score >= 25) return { key: "sell", label: "売り" };
    return { key: "strong-sell", label: "強い売り" };
  }

  function fmt(v) {
    return v >= 1000 ? Math.round(v).toLocaleString("ja-JP") : v.toFixed(v >= 100 ? 1 : 2);
  }

  // data: { daily, weekly, monthly } それぞれ [{time, open, high, low, close, volume}] (古い順)
  function analyze(data, styleKey = "standard") {
    const bars = data.daily;
    if (!bars || bars.length < 30) return { ok: false, error: "分析には最低30本の日足が必要です" };

    const tfs = {
      daily: analyzeTimeframe(bars, "daily"),
      weekly: analyzeTimeframe(data.weekly || [], "weekly"),
      monthly: analyzeTimeframe(data.monthly || [], "monthly"),
    };
    const D = tfs.daily, ind = D.ind;
    const L = bars.length - 1;
    const close = bars[L].close, prevClose = bars[L - 1].close;
    const signals = [];
    const patterns = [];
    const add = (category, points, text) => signals.push({ category, points, text });

    // 1) 月足・週足で大きなトレンドを確認する
    for (const [key, size] of [["monthly", 6], ["weekly", 6]]) {
      const t = tfs[key].trend;
      const label = TIMEFRAMES[key].label;
      const midN = TIMEFRAMES[key].ma[1];
      if (!t || !t.enough) { add("longterm", 0, `${label}: データ不足のため判定できません`); continue; }
      if (t.dir > 0) add("longterm", size, `${label}が上昇トレンド: ${t.text}`);
      else if (t.dir < 0) add("longterm", -size, `${label}が下落トレンド: ${t.text}`);
      else add("longterm", 0, `${label}はもみ合い`);
      if (t.maUp && t.aboveMid) add("longterm", 2, `${label}の${midN}${TIMEFRAMES[key].unit}線が上向き (相場全体が上昇基調で勝率が上がりやすい)`);
      else if (t.maDown && !t.aboveMid) add("longterm", -2, `${label}の${midN}${TIMEFRAMES[key].unit}線が下向き`);
    }

    // 2) ローソク足: 高値・安値、抵抗線/サポートライン、ボックス、安値切り上がり、ヒゲ
    const dt = D.trend;
    if (dt.lastHigh && close > dt.lastHigh.price && prevClose <= dt.lastHigh.price) {
      add("candle", 10, `日足が直近の高値 ${fmt(dt.lastHigh.price)} を上抜け (新たな上昇トレンド)`);
    } else if (dt.lastLow && close < dt.lastLow.price && prevClose >= dt.lastLow.price) {
      add("candle", -10, `日足が直近の安値 ${fmt(dt.lastLow.price)} を下抜け (下落トレンド入り)`);
    } else if (dt.dir > 0) add("candle", 3, `日足: ${dt.text}`);
    else if (dt.dir < 0) add("candle", -3, `日足: ${dt.text}`);

    const box = D.box;
    if (box) {
      if (close > box.upper) {
        add("candle", 14, `ボックス相場 (${fmt(box.lower)}〜${fmt(box.upper)}) の上限を上抜け`);
        patterns.push("ボックス上抜け");
      } else if (close < box.lower) {
        add("candle", -14, `ボックス相場 (${fmt(box.lower)}〜${fmt(box.upper)}) の下限を割り込み (損切りが出やすい)`);
      } else {
        add("candle", 0, `ボックス相場 (${fmt(box.lower)}〜${fmt(box.upper)}) の中: 上限を上抜けたら買い候補`);
      }
    }

    // 2回以上反発した抵抗線/サポートラインのブレイク (ボックスと重複する場合は省略)
    const prevMax = Math.max(...bars.slice(-4, -1).map((b) => b.close));
    const prevMin = Math.min(...bars.slice(-4, -1).map((b) => b.close));
    const brokeRes = D.levels.all.filter((l) => l.kind === "resistance" && close > l.price && prevMax <= l.price);
    const brokeSup = D.levels.all.filter((l) => l.kind === "support" && close < l.price && prevMin >= l.price);
    if (!box && brokeRes.length) add("candle", 8, `抵抗線 ${fmt(brokeRes[0].price)} (${brokeRes[0].touches}回反落) を上抜け`);
    if (!box && brokeSup.length) add("candle", -8, `サポートライン ${fmt(brokeSup[0].price)} (${brokeSup[0].touches}回反発) を割り込み`);

    const lows = D.swings.lows.slice(-3);
    const highs = D.swings.highs.slice(-3);
    if (lows.length >= 2 && lows[lows.length - 1].price > lows[lows.length - 2].price && close > lows[lows.length - 1].price) {
      const three = lows.length === 3 && lows[1].price > lows[0].price;
      const text = `安値切り上がり (${lows.map((p) => fmt(p.price)).join(" → ")})`;
      // 切り上がった安値が確定した直後が買い時。時間が経っていれば状態として小さく加点する
      if (L - lows[lows.length - 1].i <= 15) {
        add("candle", three ? 10 : 8, `${text}: 切り上がりが確認できた直後`);
        patterns.push("安値切り上がり");
      } else {
        add("candle", 3, text);
      }
    } else if (highs.length >= 2 && highs[highs.length - 1].price < highs[highs.length - 2].price && close < highs[highs.length - 1].price) {
      add("candle", -4, `高値切り下がり (${highs.slice(-2).map((p) => fmt(p.price)).join(" → ")})`);
    }

    const b = bars[L];
    const body = Math.abs(b.close - b.open), range = b.high - b.low;
    const upperWick = b.high - Math.max(b.open, b.close), lowerWick = Math.min(b.open, b.close) - b.low;
    const avgBody = bars.slice(-21, -1).reduce((s, x) => s + Math.abs(x.close - x.open), 0) / 20;
    if (range > 0) {
      if (lowerWick >= range * 0.5 && lowerWick >= body * 2) add("candle", 5, "長い下ヒゲ: 下値で買い支えられている");
      else if (upperWick >= range * 0.5 && upperWick >= body * 2) add("candle", -5, "長い上ヒゲ: 上値で売りに押し戻されている");
      else if (b.close > b.open && body >= avgBody * 1.8) add("candle", 5, "大陽線: 強い買い");
      else if (b.close < b.open && body >= avgBody * 1.8) add("candle", -5, "大陰線: 強い売り");
    }

    // 3) 移動平均線
    const s5 = ind.maShort, s25 = ind.maMid, s75 = ind.maLong;
    if (s5[L] != null && s5[L - 2] != null) {
      const slope = (s5[L] - s5[L - 2]) / s5[L - 2];
      const crossedUp = close > s5[L] && [1, 2].some((i) => bars[L - i].close <= s5[L - i]);
      const crossedDown = close < s5[L] && [1, 2].some((i) => bars[L - i].close >= s5[L - i]);
      if (crossedUp && slope >= -0.002) add("ma", 10, "5日線が横ばい〜上向きの中、株価が5日線を上抜け (買い時サイン)");
      else if (crossedDown && slope <= 0.002) add("ma", -10, "5日線が横ばい〜下向きの中、株価が5日線を下抜け (売り時サイン)");
      else if (close > s5[L] && slope > 0) add("ma", 2, "株価が上向きの5日線の上で推移");
      else if (close < s5[L] && slope < 0) add("ma", -2, "株価が下向きの5日線の下で推移");
    }
    if (s25[L] != null && s75[L] != null) {
      if (s5[L] > s25[L] && s25[L] > s75[L]) add("ma", 4, "パーフェクトオーダー (5日 > 25日 > 75日)");
      else if (s5[L] < s25[L] && s25[L] < s75[L]) add("ma", -4, "逆パーフェクトオーダー (5日 < 25日 < 75日)");
    }
    const gc = recentCross(s5, s25, 5);
    if (gc) {
      if (gc.dir > 0) add("ma", 6, `ゴールデンクロス (5日線が25日線を上抜け, ${gc.barsAgo}日前)`);
      else add("ma", -6, `デッドクロス (5日線が25日線を下抜け, ${gc.barsAgo}日前)`);
    }
    const weeklyUp = tfs.weekly.trend && tfs.weekly.trend.dir > 0;
    if (weeklyUp && s25[L] != null && close > s25[L] && close <= s25[L] * 1.03 && s25[L] > s25[L - 5]) {
      add("ma", 6, "上昇トレンド中の押し目 (上向きの25日線付近まで調整)");
      patterns.push("上昇トレンド中の押し目");
    }

    // 4) 出来高
    const v = ind.volumes[L], v20 = ind.vol20[L - 1];
    if (v20 && v > v20 * 1.5) {
      if (close >= b.open && close >= prevClose) add("volume", 8, `出来高が20日平均の${(v / v20).toFixed(1)}倍の陽線 (上昇の勢いが強い)`);
      else add("volume", -8, `出来高が20日平均の${(v / v20).toFixed(1)}倍の陰線 (下落の勢いが強い)`);
    }
    const prof = D.profile;
    if (prof) {
      if (close > prof.poc.high) add("volume", 4, `出来高が多い価格帯 (${fmt(prof.poc.price)}付近) より株価が上: 上値が軽い`);
      else if (close < prof.poc.low) add("volume", -5, `出来高が多い価格帯 (${fmt(prof.poc.price)}付近) より株価が下: やれやれ売りが出やすい`);
      else add("volume", 0, `出来高が多い価格帯 (${fmt(prof.poc.price)}付近) の中で推移`);
    }

    // 5) 補助指標
    const r = ind.rsi14[L];
    if (r != null) {
      if (r < 30) add("aux", 8, `RSI ${r.toFixed(0)}: 売られすぎ`);
      else if (r > 75) add("aux", -8, `RSI ${r.toFixed(0)}: 買われすぎ`);
    }
    const mc = recentCross(ind.macd.line, ind.macd.signal, 5);
    if (mc) add("aux", mc.dir * 6, `MACDがシグナルを${mc.dir > 0 ? "上" : "下"}抜け (${mc.barsAgo}日前)`);
    if (ind.bb.lower[L] != null) {
      if (close < ind.bb.lower[L]) add("aux", 5, "ボリンジャーバンド -2σ 割れ (行き過ぎた下落)");
      else if (close > ind.bb.upper[L]) add("aux", -5, "ボリンジャーバンド +2σ 超え (短期的に過熱)");
    }

    const style = STYLES[styleKey] || STYLES.standard;
    let raw = 0;
    for (const s of signals) {
      s.weighted = s.points * style.weights[s.category];
      raw += s.weighted;
    }
    // 加点が重なるほど伸びが緩やかになるようにし、100点に張り付かないようにする
    const score = Math.round(50 + 50 * Math.tanh(raw / 65));
    const order = Object.keys(CATEGORY_LABELS);
    signals.sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category) || Math.abs(b.weighted) - Math.abs(a.weighted));

    const atrNow = ind.atr14[L];
    const ret = (n) => (L - n >= 0 ? pct(close, bars[L - n].close) : null);
    // 損切り目安: 直近の安値 (サポート) と 2×ATR のうち近い方
    const supportStop = dt.lastLow && dt.lastLow.price < close ? dt.lastLow.price * 0.99 : null;
    const atrStop = atrNow != null ? close - 2 * atrNow : null;
    const stopLoss = supportStop != null && atrStop != null ? Math.max(supportStop, atrStop) : supportStop ?? atrStop;
    const target = D.levels.resistance ? D.levels.resistance.price : atrNow != null ? close + 3 * atrNow : null;

    return {
      ok: true,
      score,
      rating: rating(score),
      signals,
      patterns,
      timeframes: tfs,
      trends: { monthly: tfs.monthly.trend, weekly: tfs.weekly.trend, daily: dt },
      last: {
        date: b.time,
        close,
        change: close - prevClose,
        changePct: pct(close, prevClose),
        ret1m: ret(21),
        ret3m: ret(63),
        rsi: r,
        yearHigh: Math.max(...ind.highs.slice(-250)),
        yearLow: Math.min(...ind.lows.slice(-250)),
        atr: atrNow,
        stopLoss,
        target,
      },
    };
  }

  // ---- 日足から週足・月足を作る (CSV 用) ------------------------------

  function aggregate(bars, keyFn) {
    const out = [];
    for (const b of bars) {
      const key = keyFn(b.time);
      const cur = out[out.length - 1];
      if (cur && cur.time === key) {
        cur.high = Math.max(cur.high, b.high);
        cur.low = Math.min(cur.low, b.low);
        cur.close = b.close;
        cur.volume += b.volume;
      } else {
        out.push({ time: key, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume });
      }
    }
    return out;
  }
  function weekKey(t) {
    const d = new Date(t + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // その週の月曜日
    return d.toISOString().slice(0, 10);
  }
  const toWeekly = (bars) => aggregate(bars, weekKey);
  const toMonthly = (bars) => aggregate(bars, (t) => t.slice(0, 8) + "01");

  // CSV (Date,Open,High,Low,Close,Volume) を日足 bars に変換。列名の大小や日本語にもある程度対応。
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
      close: header.includes("close") ? header.indexOf("close") : find("close", "終値"),
      volume: find("volume", "出来高"),
    };
    for (const k of ["time", "open", "high", "low", "close"]) {
      if (idx[k] < 0) throw new Error(`CSVに「${k}」列が見つかりません (必要な列: Date, Open, High, Low, Close, Volume)`);
    }
    const bars = [];
    for (const line of lines.slice(1)) {
      const c = line.split(",").map((x) => x.trim().replace(/"/g, ""));
      const num = (i) => (i >= 0 ? parseFloat((c[i] || "").replace(/[^0-9.\-eE]/g, "")) : 0);
      const m = (c[idx.time] || "").match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
      if (!m) continue;
      const bar = {
        time: `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`,
        open: num(idx.open), high: num(idx.high), low: num(idx.low), close: num(idx.close), volume: num(idx.volume) || 0,
      };
      if ([bar.open, bar.high, bar.low, bar.close].some(isNaN)) continue;
      bars.push(bar);
    }
    bars.sort((a, b) => (a.time < b.time ? -1 : 1));
    return bars;
  }

  const api = {
    TIMEFRAMES, STYLES, CATEGORY_LABELS,
    sma, ema, rsi, macd, bollinger, atr, recentCross,
    findSwings, findLevels, findBox, volumeProfile, trendState, analyzeTimeframe, analyze,
    toWeekly, toMonthly, parseCsv,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Analysis = api;
})(typeof window !== "undefined" ? window : globalThis);
