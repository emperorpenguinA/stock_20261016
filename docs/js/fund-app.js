(function () {
  "use strict";

  const F = window.Fundamentals;
  const $ = (id) => document.getElementById(id);
  const state = { stocks: [], results: [], selected: null, market: "ALL", group: "ALL", cond: "ALL", query: "", view: "ranking", watch: [] };

  const STATUS = {
    pass: { icon: "✓", cls: "st-pass", label: "満たす" },
    partial: { icon: "△", cls: "st-partial", label: "一部" },
    fail: { icon: "×", cls: "st-fail", label: "満たさない" },
    unknown: { icon: "?", cls: "st-unknown", label: "未確認" },
    na: { icon: "−", cls: "st-unknown", label: "対象外" },
    info: { icon: "i", cls: "st-info", label: "参考" },
  };

  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  function badge(r) { return `<span class="badge ${r.key}">${r.label}</span>`; }
  function cls(v) { return v > 0 ? "up" : v < 0 ? "down" : ""; }
  const pct = (v, d = 1) => F.pctText(v, d);
  const pctPlain = (v, d = 1) => (v == null ? "—" : `${(v * 100).toFixed(d)}%`);
  const times = (v, d = 1) => (v == null ? "—" : `${v.toFixed(d)}倍`);
  function fmtPrice(v, currency) {
    if (v == null || isNaN(v)) return "—";
    const digits = currency === "USD" ? 2 : v < 100 ? 1 : 0;
    const s = v.toLocaleString("ja-JP", { minimumFractionDigits: digits, maximumFractionDigits: digits });
    return currency === "USD" ? `$${s}` : `¥${s}`;
  }
  function growthMark(v) {
    return v === true ? `<span class="st st-pass" title="すべてクリア">✓</span>` : v === false ? `<span class="st st-fail">×</span>` : `<span class="st st-unknown" title="データ不足">?</span>`;
  }

  // ---- 絞り込み ----
  function matchesCond(r) {
    const e = r.result;
    switch (state.cond) {
      case "select3": return e.select4.passed >= 3;
      case "growth": return e.growthAll;
      case "value": return e.checks.some((c) => c.group === "value" && c.status === "pass");
      case "future": return e.future && e.future.upside >= 0.2;
      default: return true;
    }
  }
  function visibleResults() {
    const q = state.query.trim().toLowerCase();
    return state.results.filter((r) =>
      (state.market === "ALL" || r.stock.market === state.market) &&
      (state.group === "ALL" || (r.stock.groups || []).includes(state.group)) &&
      matchesCond(r) &&
      (!q || r.stock.name.toLowerCase().includes(q) || r.stock.symbol.toLowerCase().includes(q))
    );
  }
  function watchResults() {
    const order = new Map(state.watch.map((s, i) => [s, i]));
    return visibleResults().filter((x) => order.has(x.stock.symbol)).sort((a, b) => order.get(a.stock.symbol) - order.get(b.stock.symbol));
  }

  function starButton(symbol) {
    const on = state.watch.includes(symbol);
    return `<button type="button" class="star${on ? " on" : ""}" data-star="${esc(symbol)}" aria-pressed="${on}" title="${on ? "監視リストから外す" : "監視リストに追加"}">${on ? "★" : "☆"}</button>`;
  }
  function toggleWatch(symbol) {
    state.watch = Watchlist.toggle(state.watch, symbol);
    renderRanking();
    renderStar();
  }

  // ---- 描画 ----
  function renderPicks() {
    const top = visibleResults().filter((x) => x.result.rating.label === "有望").slice(0, 3);
    const el = $("picks");
    if (!top.length) {
      el.innerHTML = `<p class="muted">現在の条件では「有望」の銘柄はありません。</p>`;
      return;
    }
    el.innerHTML = top.map(({ stock, result }) => {
      const good = result.checks.filter((c) => c.status === "pass" && c.points).slice(0, 3);
      return `<button class="pick" data-symbol="${esc(stock.symbol)}">
        <div class="pick-top">
          <div><div class="pick-name">${esc(stock.name)}</div><div class="code muted">${esc(stock.symbol)}</div></div>
          <div class="pick-score">${result.score}</div>
        </div>
        <div class="pick-price">${badge(result.rating)} 4条件 ${result.select4.passed}/${result.select4.total}${result.growthAll ? ' <span class="tag">成長株の基準クリア</span>' : ""}</div>
        <ul>${good.map((c) => `<li>${esc(c.label)}</li>`).join("")}</ul>
      </button>`;
    }).join("");
  }

  function renderRanking() {
    const watchView = state.view === "watch";
    const rows = watchView ? watchResults() : visibleResults();
    $("watch-count").textContent = state.watch.length ? `(${state.watch.length})` : "";
    document.querySelectorAll("#view-tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.view === state.view)));
    $("watch-help").hidden = !watchView;
    $("watch-help").textContent = watchView ? "監視リストはチャートのページと共通です。ここで業績の良い銘柄を入れておき、チャートのページで買い時 (5日線突破の初動) を待ちましょう。" : "";
    const tbody = $("ranking").querySelector("tbody");
    if (!rows.length) {
      const msg = watchView && !state.watch.length ? "まだ銘柄がありません。☆ を押すと監視リストに追加できます。" : "該当する銘柄がありません";
      tbody.innerHTML = `<tr><td colspan="8" class="muted">${msg}</td></tr>`;
      return;
    }
    tbody.innerHTML = rows.map(({ stock, result }, i) => {
      const m = result.metrics;
      return `<tr data-symbol="${esc(stock.symbol)}" class="${state.selected === stock.symbol ? "selected" : ""}">
        <td>${i + 1}</td>
        <td class="star-col">${starButton(stock.symbol)}</td>
        <td><div class="name">${esc(stock.name)}</div><div class="code">${esc(stock.symbol)}</div></td>
        <td><div class="scorecell"><b>${result.score ?? "—"}</b>${badge(result.rating)}</div></td>
        <td class="num">${result.select4.passed}/${result.select4.total}</td>
        <td>${growthMark(result.growthAll ? true : result.checks.some((c) => c.group === "growth" && c.status === "fail") ? false : null)}</td>
        <td class="num">${m.pp != null ? m.pp.toFixed(1) : "—"}</td>
        <td class="num hide-sm ${result.future ? cls(result.future.upside) : ""}">${result.future ? pct(result.future.upside, 0) : "—"}</td>
      </tr>`;
    }).join("");
  }

  function renderStar() {
    const btn = $("d-star");
    btn.hidden = !state.selected;
    if (!state.selected) return;
    const on = state.watch.includes(state.selected);
    btn.textContent = on ? "★" : "☆";
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-pressed", String(on));
    btn.title = on ? "監視リストから外す" : "監視リストに追加";
  }

  function renderDetail() {
    const entry = state.results.find((x) => x.stock.symbol === state.selected);
    if (!entry) return;
    const { stock, result } = entry;
    const m = result.metrics;
    const cur = stock.currency;
    $("d-name").textContent = stock.name;
    renderStar();
    const sector = [stock.sector, stock.industry].filter(Boolean).join(" / ");
    $("d-symbol").textContent = `${stock.symbol} ・ ${stock.market === "JP" ? "日本株" : "米国株"}${sector ? " ・ " + sector : ""}`;
    $("d-chart-link").href = `index.html#${encodeURIComponent(stock.symbol)}`;
    $("d-score").innerHTML = `<div class="big">${result.score ?? "—"}<small class="muted" style="font-size:.9rem"> /100</small></div>${badge(result.rating)}
      <div class="muted cov">判定できた項目 ${result.coverage.known}/${result.coverage.total}</div>`;

    const stat = (k, v, c = "") => `<div class="stat"><div class="k">${k}</div><div class="v ${c}">${v}</div></div>`;
    $("d-stats").innerHTML = [
      stat("株価", fmtPrice(stock.price, cur)),
      stat("時価総額", F.okuText(stock.marketCap, cur)),
      stat("PER (実績)", times(m.per)),
      stat("PER (予想)", times(m.forwardPer)),
      stat("PBR", times(m.pbr, 2)),
      stat("ROE", pctPlain(m.roe)),
      stat("営業利益率", pctPlain(m.opMargin)),
      stat("自己資本比率", pctPlain(m.equityRatio, 0)),
      stat("配当利回り", pctPlain(m.divYield, 2)),
      stat("売上成長 (年平均)", pct(m.revCagr), cls(m.revCagr)),
      stat("EPS成長 (年平均)", pct(m.epsCagr), cls(m.epsCagr)),
      stat("PEG", m.peg != null ? m.peg.toFixed(2) : "—"),
      stat("ネットキャッシュ比率", m.netCash != null ? pctPlain(m.netCash, 0) : "—"),
    ].join("");

    const f = result.future;
    $("d-future").innerHTML = f ? `<div class="scn scn-up future">
        <div class="scn-h">将来の株価の目安 (来期EPS × 今のPER)</div>
        <p><b>${fmtPrice(f.price, cur)}</b> (今の株価から <span class="${cls(f.upside)}">${pct(f.upside)}</span>)</p>
        <p class="muted">今期EPS ${f.thisEps.toFixed(1)} → 来期EPS ${f.nextEps.toFixed(1)}、PER ${f.per.toFixed(1)}倍のまま評価された場合。根拠: ${esc(f.basis)}</p>
      </div>` : "";

    $("d-checks").innerHTML = Object.entries(F.GROUPS).map(([key, title]) => {
      const items = result.checks.filter((c) => c.group === key);
      if (!items.length) return "";
      return `<div class="check-group"><div class="check-title">${title}</div><ul class="checks">${items.map((c) => {
        const st = STATUS[c.status];
        return `<li><span class="st ${st.cls}" title="${st.label}">${st.icon}</span><div><div class="check-label">${esc(c.label)}</div><div class="muted check-detail">${esc(c.detail)}</div></div></li>`;
      }).join("")}</ul></div>`;
    }).join("");

    renderFinTable(stock, result);
  }

  function renderFinTable(stock, result) {
    const years = stock.years || [];
    const cur = stock.currency;
    const head = `<tr><th></th>${years.map((y) => `<th class="num">${y.fy.slice(0, 7).replace("-", "/")}期</th>`).join("")}</tr>`;
    const money = (v) => F.okuText(v, cur);
    const perShare = (v) => (v == null ? "—" : cur === "USD" ? v.toFixed(2) : v.toFixed(1));
    const growthCell = (series, i) => {
      const g = i > 0 ? series[i - 1] : null;
      return g == null ? "" : `<div class="yoy ${cls(g)}">${pct(g, 0)}</div>`;
    };
    const row = (label, key, fmt, series) =>
      `<tr><th>${label}</th>${years.map((y, i) => `<td class="num">${fmt(y[key])}${series ? growthCell(series, i) : ""}</td>`).join("")}</tr>`;
    const g = result.growth;
    $("d-fin").innerHTML = years.length
      ? `<thead>${head}</thead><tbody>
        ${row("売上高", "revenue", money, g.rev)}
        ${row("営業利益", "operatingIncome", money, g.op)}
        ${row("純利益", "netIncome", money)}
        ${row("EPS", "eps", perShare, g.eps)}
        ${row("1株配当", "dps", perShare, g.dps)}
        ${row("営業CF", "operatingCF", money)}
        ${row("フリーCF", "freeCF", money)}
      </tbody>`
      : `<tbody><tr><td class="muted">決算データがありません</td></tr></tbody>`;
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

  function bind() {
    const on = (id, ev, fn) => $(id).addEventListener(ev, fn);
    on("market", "change", (e) => { state.market = e.target.value; renderPicks(); renderRanking(); });
    on("group", "change", (e) => { state.group = e.target.value; renderPicks(); renderRanking(); });
    on("cond", "change", (e) => { state.cond = e.target.value; renderPicks(); renderRanking(); });
    on("search", "input", (e) => { state.query = e.target.value; renderPicks(); renderRanking(); });
    on("ranking", "click", (e) => {
      const star = e.target.closest("[data-star]");
      if (star) { toggleWatch(star.dataset.star); return; }
      const tr = e.target.closest("tr[data-symbol]");
      if (tr) select(tr.dataset.symbol, true);
    });
    on("picks", "click", (e) => { const b = e.target.closest("[data-symbol]"); if (b) select(b.dataset.symbol, true); });
    on("d-star", "click", () => state.selected && toggleWatch(state.selected));
    on("view-tabs", "click", (e) => {
      const b = e.target.closest("button[data-view]");
      if (!b) return;
      state.view = b.dataset.view;
      renderRanking();
    });
  }

  async function init() {
    state.watch = Watchlist.load();
    bind();
    try {
      const res = await fetch("data/fundamentals.json", { cache: "no-cache" });
      if (!res.ok) throw new Error(res.status);
      const data = await res.json();
      state.stocks = data.stocks;
      $("demo-notice").hidden = !data.demo;
      $("updated").textContent = `業績データ更新 ${new Date(data.generated_at).toLocaleString("ja-JP")}`;
    } catch (ex) {
      $("picks").innerHTML = `<p class="error">業績データを読み込めませんでした (${esc(ex.message)})。</p>`;
      return;
    }
    state.results = state.stocks
      .map((s) => ({ stock: s, result: F.evaluate(s) }))
      .sort((a, b) => (b.result.score ?? -1) - (a.result.score ?? -1));
    const fromHash = decodeURIComponent(location.hash.slice(1));
    state.selected = state.results.some((x) => x.stock.symbol === fromHash) ? fromHash : state.results[0] && state.results[0].stock.symbol;
    renderAll();
  }

  init();
})();
