/* Massimo Dutti live capture — runs in the PAGE's world (world: "MAIN") at
   document_start, i.e. BEFORE the site's bundle runs. Inditex fetches every
   product's data through the itxrest `productsArray` API at load and virtualizes
   the grid (off-screen tiles leave the DOM), so the isolated content script —
   which runs at document_idle, after those calls — can neither see the DOM
   tiles nor the (cleared) resource-timing. Hooking fetch/XHR here captures each
   productsArray call's store/catalog + productIds as it happens and parks the
   running set on a data- attribute the isolated adapter reads. It only records
   URLs (ids), never bodies, and mutates nothing the page depends on. */
(function () {
  if (window.__mdCap) return;
  const cap = window.__mdCap = { sc: null, ids: Object.create(null) };

  function flush() {
    try {
      document.documentElement.setAttribute("data-md-capture",
        JSON.stringify({ sc: cap.sc, ids: Object.keys(cap.ids) }));
    } catch (e) {}
  }
  function handle(url) {
    url = String(url || "");
    if (!/itxrest/.test(url)) return;
    const s = url.match(/catalog\/store\/(\d+)\/(\d+)\//);
    if (s && !cap.sc) cap.sc = { store: s[1], catalog: s[2] };
    const pm = url.match(/productsArray[^]*?productIds=([\d%2Cc,]+)/i);
    if (pm) {
      let raw = pm[1]; try { raw = decodeURIComponent(raw); } catch (e) {}
      raw.split(",").forEach(x => { x = x.trim(); if (/^\d+$/.test(x)) cap.ids[x] = 1; });
    }
    if (s || pm) flush();
  }

  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (input, init) {
      try { handle(typeof input === "string" ? input : (input && input.url)); } catch (e) {}
      return origFetch.apply(this, arguments);
    };
  }
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try { handle(url); } catch (e) {}
    return origOpen.apply(this, arguments);
  };
})();
