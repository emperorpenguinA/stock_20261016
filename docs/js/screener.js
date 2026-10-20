(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const PAGE = 100;
  const state = { rows: [], watch: [], shown: PAGE };
  const CHECKS = ["f-shodou", "f-trend", "f-growth", "f-rev", "f-value", "f-small", "f-ipo"];
  const SELECTS = ["f-seg", "f-sector", "f-sort", "f-ts", "f-fs"];

  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  function cls(v) { return v > 0 ? "up" : v < 0 ? "down" : ""; }
  function fmtPct(v) { return v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`; }
  function techBadge(score) {
    const r = score >= 80 ? ["strong-buy", "強い買い"] : score >= 62 ? ["buy", "買い"] : score >= 40 ? ["hold", "様子見"] : score >= 25 ? ["sell", "売り"] : ["strong-sell", "強い売り"];
    return `<span class="badge ${r[0]}">${r[1]}</span>`;
  }
  function fundBadge(label) {
    const key = { 有望: "strong-buy", 良好: "buy", 普通: "hold", 注意: "sell" }[label] || "hold";
    return `<span class="badge ${key}">${esc(label)}</span>`;
  }
  function arrow(d) {
    return d == null ? `<span class="trend none">―</span>` : d > 0 ? `<span class="trend up">↑</span>` : d < 0 ? `<span class="trend down">↓</span>` : `<span class="trend flat">→</span>`;
  }
  function mcText(v, market) {
    if (v == null) return "—";
    if (market === "US") return v >= 1e9 ? `$${(v / 1e9).toFixed(0)}B` : `$${(v / 1e6).toFixed(0)}M`;
    return v >= 1e12 ? `${(v / 1e12).toFixed(1)}兆円` : `${Math.round(v / 1e8).toLocaleString("ja-JP")}億円`;
  }
  // 上場2年目〜3年目 (データの開始が2001年より前なら上場からの年数は分からない)
  function nthYear(ld) {
    if (!ld || ld < "2001") return null;
    return Math.floor((Date.now() - Date.parse(ld + "T00:00:00Z")) / (365.25 * 86400000)) + 1;
  }

  function val(id) { return $(id).value; }
  function on(id) { return $(id).checked; }

  function filtered() {
    const q = val("f-q").trim().toLowerCase();
    const seg = val("f-seg"), sector = val("f-sector"), ts = +val("f-ts"), fs = +val("f-fs");
    const rows = state.rows.filter((r) => {
      if (seg !== "ALL" && r.g !== seg) return false;
      if (sector !== "ALL" && r.sec !== sector) return false;
      if (q && !r.n.toLowerCase().includes(q) && !r.s.toLowerCase().includes(q)) return false;
      if (on("f-shodou") && !r.sh) return false;
      if (on("f-trend") && !(r.tm > 0 && r.tw > 0)) return false;
      if (ts && r.ts < ts) return false;
      if (on("f-growth") && !r.ga) return false;
      if (on("f-rev") && !(r.rv > 0)) return false;
      if (on("f-value") && !(r.pp != null && r.pp <= 15.5)) return false;
      if (on("f-small") && !(r.m === "JP" && r.mc != null && r.mc <= 5e10)) return false;
      if (on("f-ipo")) { const n = nthYear(r.ld); if (!(n >= 2 && n <= 3)) return false; }
      if (fs && !(r.fs >= fs)) return false;
      return true;
    });
    const sort = val("f-sort");
    const key = {
      total: (r) => r.ts + (r.fs ?? 40),
      ts: (r) => r.ts,
      fs: (r) => r.fs ?? -1,
      "mc-asc": (r) => (r.mc == null ? -Infinity : -r.mc),
      r1: (r) => r.r1 ?? -Infinity,
      up: (r) => r.up ?? -Infinity,
    }[sort];
    return rows.sort((a, b) => key(b) - key(a));
  }

  function starButton(symbol) {
    const onw = state.watch.includes(symbol);
    return `<button type="button" class="star${onw ? " on" : ""}" data-star="${esc(symbol)}" aria-pressed="${onw}" title="${onw ? "監視リストから外す" : "監視リストに追加"}">${onw ? "★" : "☆"}</button>`;
  }

  function render() {
    const rows = filtered();
    $("count").textContent = `${state.rows.length.toLocaleString("ja-JP")} 銘柄中 ${rows.length.toLocaleString("ja-JP")} 銘柄が条件に合っています`;
    const tbody = $("table").querySelector("tbody");
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="10" class="muted">条件に合う銘柄がありません。条件をゆるめてみてください。</td></tr>`;
      $("more").hidden = true;
      return;
    }
    const sym = (s) => encodeURIComponent(s);
    tbody.innerHTML = rows.slice(0, state.shown).map((r) => `
      <tr>
        <td class="star-col">${starButton(r.s)}</td>
        <td><div class="name">${esc(r.n)}</div><div class="code">${esc(r.s)} ・ ${esc(r.g || r.m)}${r.sh ? ' <span class="tag">初動</span>' : ""}${r.ga ? ' <span class="tag">成長株</span>' : ""}</div></td>
        <td><div class="scorecell"><b>${r.ts}</b>${techBadge(r.ts)}</div></td>
        <td class="trends">${arrow(r.tm)}${arrow(r.tw)}${arrow(r.td)}</td>
        <td>${r.fs != null ? `<div class="scorecell"><b>${r.fs}</b>${fundBadge(r.fr)}</div>` : '<span class="muted" title="業績はまだ取得していません">—</span>'}</td>
        <td class="num hide-sm">${r.s4 != null ? `${r.s4}/4` : "—"}</td>
        <td class="num hide-sm">${r.pp != null ? r.pp.toFixed(1) : "—"}</td>
        <td class="num">${mcText(r.mc, r.m)}</td>
        <td class="num hide-sm ${cls(r.r1)}">${fmtPct(r.r1)}</td>
        <td class="links"><a href="index.html#${sym(r.s)}">チャート</a> <a href="fundamentals.html#${sym(r.s)}">業績</a></td>
      </tr>`).join("");
    $("more").hidden = rows.length <= state.shown;
    $("more").textContent = `さらに表示 (残り ${(rows.length - state.shown).toLocaleString("ja-JP")} 銘柄)`;
  }

  const PRESETS = {
    "shodou-growth": { "f-shodou": true, "f-growth": true },
    "small-growth": { "f-small": true, "f-rev": true, "f-trend": true },
    "value-trend": { "f-value": true, "f-trend": true },
    ipo: { "f-ipo": true, "f-fs": "55" },
  };
  function applyPreset(name) {
    CHECKS.forEach((id) => ($(id).checked = false));
    $("f-ts").value = "0";
    $("f-fs").value = "0";
    for (const [id, v] of Object.entries(PRESETS[name] || {})) {
      if (typeof v === "boolean") $(id).checked = v; else $(id).value = v;
    }
    state.shown = PAGE;
    render();
  }

  function bind() {
    const rerender = () => { state.shown = PAGE; render(); };
    CHECKS.concat(SELECTS).forEach((id) => $(id).addEventListener("change", rerender));
    $("f-q").addEventListener("input", rerender);
    $("more").addEventListener("click", () => { state.shown += PAGE; render(); });
    $("presets").addEventListener("click", (e) => { const b = e.target.closest("[data-preset]"); if (b) applyPreset(b.dataset.preset); });
    $("table").addEventListener("click", (e) => {
      const star = e.target.closest("[data-star]");
      if (!star) return;
      state.watch = Watchlist.toggle(state.watch, star.dataset.star);
      render();
    });
  }

  async function init() {
    state.watch = Watchlist.load();
    bind();
    try {
      const res = await fetch("data/screen.json", { cache: "no-cache" });
      if (!res.ok) throw new Error(res.status);
      const data = await res.json();
      state.rows = data.rows;
      $("updated").textContent = `データ更新 ${new Date(data.generated_at).toLocaleString("ja-JP")}`;
      if (data.demo) {
        $("demo-notice").hidden = false;
        $("demo-notice").textContent = "現在表示しているのはデモ用の疑似データです。";
      }
    } catch (ex) {
      $("count").innerHTML = `<span class="error">全銘柄のデータを読み込めませんでした (${esc(ex.message)})。初回の作成には時間がかかります。</span>`;
      return;
    }
    const sectors = [...new Set(state.rows.map((r) => r.sec).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ja"));
    $("f-sector").insertAdjacentHTML("beforeend", sectors.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join(""));
    render();
  }

  init();
})();
