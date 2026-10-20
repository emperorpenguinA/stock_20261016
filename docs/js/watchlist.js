// 監視リスト (このブラウザの localStorage に保存)。チャートのページと業績のページで共有する。
(function (root) {
  "use strict";

  const KEY = "chart-navi.watchlist";

  function load() {
    try {
      const v = JSON.parse(localStorage.getItem(KEY) || "[]");
      return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
    } catch (_) {
      return [];
    }
  }

  function save(list) {
    try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (_) { /* 保存できない環境でも画面上は使える */ }
  }

  function toggle(list, symbol) {
    const next = list.includes(symbol) ? list.filter((s) => s !== symbol) : [...list, symbol];
    save(next);
    return next;
  }

  root.Watchlist = { load, save, toggle };
})(window);
