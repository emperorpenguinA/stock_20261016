(function () {
  "use strict";

  const A = window.Analysis;
  const $ = (id) => document.getElementById(id);
  const state = { stocks: [], results: [], selected: null, style: "balanced", market: "ALL", query: "", custom: null };
  let charts = [];

  // ---- フォーマット ----
  function fmtPrice(v, currency) {
    if (v == null || isNaN(v)) return "—";
    const digits = currency === "USD" ? 2 : v < 100 ? 1 : 0;
    const s = v.toLocaleString("ja-JP", { minimumFractionDigits: digits, maximumFractionDigits: digits });
    return currency === "USD" ? `$${s}` : currency === "JPY" ? `¥${s}` : s;
  }
  function fmtPct(v) {
    if (v == null || isNaN(v)) return "—";
    return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
  }
  function cls(v) { return v > 0 ? "up" : v < 0 ? "down" : ""; }
  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  function badge(r) { return `<span class="badge ${r.key}">${r.label}</span>`; }

  // ---- データ ----
  function toBars(raw) {
    return raw.map((b) => ({ time: b[0], open: b[1], high: b[2], low: b[3], close: b[4], volume: b[5] }));
  }

  function recompute() {
    state.results = state.stocks
      .map((s) => ({ stock: s, result: A.analyze(s.barsObj, state.style) }))
      .filter((x) => x.result.ok)
      .sort((a, b) => b.result.score - a.result.score);
    if (state.custom) state.custom.result = A.analyze(state.custom.stock.barsObj, state.style);
  }

  function visibleResults() {
    const q = state.query.trim().toLowerCase();
    return state.results.filter(({ stock }) =>
      (state.market === "ALL" || stock.market === state.market) &&
      (!q || stock.name.toLowerCase().includes(q) || stock.symbol.toLowerCase().includes(q))
    );
  }

  function findEntry(symbol) {
    if (state.custom && state.custom.stock.symbol === symbol) return state.custom;
    return state.results.find((x) => x.stock.symbol === symbol);
  }

  // ---- 描画: 注目銘柄・ランキング ----
  function renderPicks() {
    const top = visibleResults().filter((x) => x.result.score >= 58).slice(0, 3);
    const el = $("picks");
    if (!top.length) {
      el.innerHTML = `<p class="muted">現在の条件では「買い」以上の銘柄はありません。様子見が無難な地合いです。</p>`;
      return;
    }
    el.innerHTML = top.map(({ stock, result }) => {
      const reasons = result.signals.filter((s) => s.weighted > 0).slice(0, 3);
      return `<button class="pick" data-symbol="${esc(stock.symbol)}">
        <div class="pick-top">
          <div><div class="pick-name">${esc(stock.name)}</div><div class="code muted">${esc(stock.symbol)}</div></div>
          <div class="pick-score">${result.score}</div>
        </div>
        <div class="pick-price">${fmtPrice(result.last.close, stock.currency)} <span class="${cls(result.last.changePct)}">${fmtPct(result.last.changePct)}</span> ${badge(result.rating)}</div>
        <ul>${reasons.map((s) => `<li>${esc(s.text)}</li>`).join("")}</ul>
      </button>`;
    }).join("");
  }

  function renderRanking() {
    const rows = visibleResults();
    const tbody = $("ranking").querySelector("tbody");
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="muted">該当する銘柄がありません</td></tr>`;
      return;
    }
    tbody.innerHTML = rows.map(({ stock, result }, i) => `
      <tr data-symbol="${esc(stock.symbol)}" class="${state.selected === stock.symbol ? "selected" : ""}">
        <td>${i + 1}</td>
        <td><div class="name">${esc(stock.name)}</div><div class="code">${esc(stock.symbol)}</div></td>
        <td><div class="scorecell"><b>${result.score}</b>${badge(result.rating)}</div></td>
        <td class="num">${fmtPrice(result.last.close, stock.currency)}</td>
        <td class="num ${cls(result.last.changePct)}">${fmtPct(result.last.changePct)}</td>
        <td class="num hide-sm ${cls(result.last.ret1m)}">${fmtPct(result.last.ret1m)}</td>
        <td class="num hide-sm">${result.last.rsi != null ? result.last.rsi.toFixed(0) : "—"}</td>
      </tr>`).join("");
  }

  // ---- 描画: 詳細 ----
  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

  function series(times, values) {
    const out = [];
    values.forEach((v, i) => { if (v != null) out.push({ time: times[i], value: v }); });
    return out;
  }

  function destroyCharts() { charts.forEach((c) => c.remove()); charts = []; }

  function renderCharts(stock, result) {
    destroyCharts();
    const LW = window.LightweightCharts;
    const ind = result.indicators;
    const bars = stock.barsObj;
    const times = bars.map((b) => b.time);
    const C = {
      text: cssVar("--muted"), grid: cssVar("--grid"), border: cssVar("--border"),
      up: cssVar("--up"), down: cssVar("--down"), sma5: cssVar("--sma5"), sma25: cssVar("--sma25"),
      sma75: cssVar("--sma75"), bb: cssVar("--bb"), accent: cssVar("--accent"),
    };
    const base = (height) => ({
      autoSize: true,
      height,
      layout: { background: { color: "transparent" }, textColor: C.text, fontSize: 11 },
      grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
      rightPriceScale: { borderColor: C.border, minimumWidth: 70 },
      timeScale: { borderColor: C.border },
      crosshair: { mode: LW.CrosshairMode.Normal },
      localization: { locale: "ja-JP", dateFormat: "yyyy/MM/dd" },
    });

    const main = LW.createChart($("chart-main"), base(340));
    const candles = main.addCandlestickSeries({
      upColor: C.up, downColor: C.down, borderUpColor: C.up, borderDownColor: C.down, wickUpColor: C.up, wickDownColor: C.down,
    });
    candles.setData(bars.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));
    const line = (color, data, opts = {}) => {
      const s = main.addLineSeries({ color, lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, ...opts });
      s.setData(data);
      return s;
    };
    line(C.bb, series(times, ind.bb.upper), { lineStyle: LW.LineStyle.Dotted, lineWidth: 1 });
    line(C.bb, series(times, ind.bb.lower), { lineStyle: LW.LineStyle.Dotted, lineWidth: 1 });
    line(C.sma5, series(times, ind.sma5));
    line(C.sma25, series(times, ind.sma25));
    line(C.sma75, series(times, ind.sma75));
    const vol = main.addHistogramSeries({ priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    main.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    vol.setData(bars.map((b) => ({ time: b.time, value: b.volume, color: (b.close >= b.open ? C.up : C.down) + "55" })));
    const L = result.last;
    if (L.stopLoss) candles.createPriceLine({ price: L.stopLoss, color: C.down, lineStyle: LW.LineStyle.Dashed, lineWidth: 1, title: "損切り目安" });
    if (L.target) candles.createPriceLine({ price: L.target, color: C.up, lineStyle: LW.LineStyle.Dashed, lineWidth: 1, title: "利確目安" });

    // ゴールデン/デッドクロスのマーカー
    const markers = [];
    for (let i = 1; i < times.length; i++) {
      const a0 = ind.sma5[i - 1], b0 = ind.sma25[i - 1], a1 = ind.sma5[i], b1 = ind.sma25[i];
      if ([a0, b0, a1, b1].some((v) => v == null)) continue;
      if (a0 <= b0 && a1 > b1) markers.push({ time: times[i], position: "belowBar", color: C.up, shape: "arrowUp", text: "GC" });
      if (a0 >= b0 && a1 < b1) markers.push({ time: times[i], position: "aboveBar", color: C.down, shape: "arrowDown", text: "DC" });
    }
    candles.setMarkers(markers);

    const rsiChart = LW.createChart($("chart-rsi"), base(110));
    const rsiS = rsiChart.addLineSeries({ color: C.accent, lineWidth: 1.5, priceLineVisible: false });
    rsiS.setData(series(times, ind.rsi14));
    rsiS.createPriceLine({ price: 70, color: C.down, lineStyle: LW.LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false });
    rsiS.createPriceLine({ price: 30, color: C.up, lineStyle: LW.LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false });
    rsiS.applyOptions({ autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }) });

    const macdChart = LW.createChart($("chart-macd"), base(110));
    const hist = macdChart.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false });
    hist.setData(ind.macd.hist.map((v, i) => (v == null ? null : { time: times[i], value: v, color: (v >= 0 ? C.up : C.down) + "99" })).filter(Boolean));
    macdChart.addLineSeries({ color: C.accent, lineWidth: 1.5, priceLineVisible: false }).setData(series(times, ind.macd.line));
    macdChart.addLineSeries({ color: C.sma5, lineWidth: 1, priceLineVisible: false }).setData(series(times, ind.macd.signal));

    charts = [main, rsiChart, macdChart];
    // 3つのチャートの表示範囲を同期
    let syncing = false;
    charts.forEach((c) => c.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (syncing || !range) return;
      syncing = true;
      charts.forEach((o) => o !== c && o.timeScale().setVisibleLogicalRange(range));
      syncing = false;
    }));
    const n = times.length;
    main.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - 130), to: n + 2 });

    $("legend").innerHTML = [
      ["--sma5", "5日線"], ["--sma25", "25日線"], ["--sma75", "75日線"], ["--bb", "ボリンジャー ±2σ"],
    ].map(([v, t]) => `<span><i style="background:var(${v})"></i>${t}</span>`).join("") +
      `<span>▲GC ゴールデンクロス / ▼DC デッドクロス</span>`;
  }

  function renderDetail() {
    const entry = state.selected && findEntry(state.selected);
    if (!entry) return;
    const { stock, result } = entry;
    const L = result.last;
    $("d-name").textContent = stock.name;
    $("d-symbol").textContent = `${stock.symbol}${stock.market ? " ・ " + (stock.market === "JP" ? "日本株" : stock.market === "US" ? "米国株" : stock.market) : ""} ・ ${L.date} 時点`;
    $("d-score").innerHTML = `<div class="big">${result.score}<small class="muted" style="font-size:.9rem"> /100</small></div>${badge(result.rating)}`;
    const stat = (k, v, c = "") => `<div class="stat"><div class="k">${k}</div><div class="v ${c}">${v}</div></div>`;
    $("d-stats").innerHTML = [
      stat("終値", fmtPrice(L.close, stock.currency)),
      stat("前日比", fmtPct(L.changePct), cls(L.changePct)),
      stat("1ヶ月", fmtPct(L.ret1m), cls(L.ret1m)),
      stat("3ヶ月", fmtPct(L.ret3m), cls(L.ret3m)),
      stat("1年高値", fmtPrice(L.yearHigh, stock.currency)),
      stat("1年安値", fmtPrice(L.yearLow, stock.currency)),
      stat("損切り目安", fmtPrice(L.stopLoss, stock.currency), "down"),
      stat("利確目安", fmtPrice(L.target, stock.currency), "up"),
    ].join("");
    $("d-signals").innerHTML = result.signals.map((s) => `
      <li><span class="pts ${cls(s.weighted)}">${s.weighted > 0 ? "+" : ""}${s.weighted.toFixed(1)}</span>
      <span class="cat">${A.CATEGORY_LABELS[s.category]}</span><span>${esc(s.text)}</span></li>`).join("");
    renderCharts(stock, result);
  }

  function select(symbol, scroll) {
    state.selected = symbol;
    renderRanking();
    renderDetail();
    if (scroll && window.matchMedia("(max-width: 900px)").matches) $("detail").scrollIntoView({ behavior: "smooth" });
  }

  function renderAll() {
    renderPicks();
    renderRanking();
    renderDetail();
  }

  // ---- イベント ----
  function bind() {
    const styleSel = $("style");
    styleSel.innerHTML = Object.entries(A.STYLES).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join("");
    styleSel.addEventListener("change", () => { state.style = styleSel.value; recompute(); renderAll(); });
    $("market").addEventListener("change", (e) => { state.market = e.target.value; renderPicks(); renderRanking(); });
    $("search").addEventListener("input", (e) => { state.query = e.target.value; renderPicks(); renderRanking(); });
    $("ranking").addEventListener("click", (e) => { const tr = e.target.closest("tr[data-symbol]"); if (tr) select(tr.dataset.symbol, true); });
    $("picks").addEventListener("click", (e) => { const b = e.target.closest("[data-symbol]"); if (b) select(b.dataset.symbol, true); });
    $("csv-file").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      const err = $("csv-error");
      err.hidden = true;
      if (!file) return;
      try {
        const bars = A.parseCsv(await file.text());
        const name = $("csv-name").value.trim() || file.name.replace(/\.csv$/i, "");
        const stock = { symbol: `CSV: ${file.name}`, name, market: "", currency: "", barsObj: bars };
        const result = A.analyze(bars, state.style);
        if (!result.ok) throw new Error(result.error);
        state.custom = { stock, result };
        select(stock.symbol, false);
        $("detail").scrollIntoView({ behavior: "smooth" });
      } catch (ex) {
        err.textContent = `読み込めませんでした: ${ex.message}`;
        err.hidden = false;
      }
    });
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", renderDetail);
  }

  async function init() {
    bind();
    try {
      const res = await fetch("data/prices.json", { cache: "no-cache" });
      if (!res.ok) throw new Error(res.status);
      const data = await res.json();
      state.stocks = data.stocks.map((s) => ({ ...s, barsObj: toBars(s.bars) }));
      $("demo-notice").hidden = !data.demo;
      const latest = state.stocks.reduce((m, s) => (s.barsObj.length && s.barsObj[s.barsObj.length - 1].time > m ? s.barsObj[s.barsObj.length - 1].time : m), "");
      $("updated").textContent = `データ: ${latest} 終値まで ・ 更新 ${new Date(data.generated_at).toLocaleString("ja-JP")}`;
    } catch (ex) {
      $("picks").innerHTML = `<p class="error">株価データを読み込めませんでした (${esc(ex.message)})。ローカルで開く場合は簡易サーバー経由で表示してください。</p>`;
      return;
    }
    recompute();
    if (state.results.length) state.selected = state.results[0].stock.symbol;
    renderAll();
  }

  init();
})();
