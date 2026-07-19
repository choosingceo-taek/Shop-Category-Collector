/* Inditex / API-driven grid diagnostic — for shops (Massimo Dutti, etc.) whose
   product grid is NOT in the page HTML: it's fetched from a JSON API and, in
   Massimo Dutti's case, mirrored into the analytics `dataLayer`. The generic /
   lazy diagnostics found 0 prices here, so this one hunts down the REAL data
   source: (1) the product array inside window.dataLayer, (2) the product/category
   API URL the page called, (3) a sample of product links + how prices render.

   Paste the whole file into the DevTools Console on the category page. It reads
   only; it changes nothing and submits nothing. Copy the entire output back. */
(function () {
  const R = []; const log = (...a) => R.push(a.join(" "));
  const short = v => { try { return JSON.stringify(v).slice(0, 300); } catch (e) { return String(v).slice(0, 300); } };

  log("=== INDITEX / API-GRID DIAGNOSTIC ===");
  log("URL:", location.href);

  // ---- 1) window.dataLayer — find product/impression arrays -----------------
  const productArrays = [];
  const scanForProducts = (o, path, depth) => {
    if (!o || typeof o !== "object" || depth > 6 || productArrays.length >= 6) return;
    if (Array.isArray(o)) {
      const looks = o.length >= 2 && o.slice(0, 4).every(x => x && typeof x === "object" &&
        ("name" in x || "title" in x || "productName" in x || "item_name" in x));
      if (looks) { productArrays.push({ path, len: o.length, sample: o[0] }); return; }
      o.slice(0, 8).forEach((x, i) => scanForProducts(x, path + "[" + i + "]", depth + 1));
    } else {
      for (const k in o) { try { scanForProducts(o[k], path + "." + k, depth + 1); } catch (e) {} }
    }
  };
  try {
    if (window.dataLayer) {
      log("window.dataLayer:", Array.isArray(window.dataLayer) ? ("array len " + window.dataLayer.length) : typeof window.dataLayer);
      scanForProducts(window.dataLayer, "dataLayer", 0);
    } else log("window.dataLayer: (absent)");
  } catch (e) { log("dataLayer scan error:", e.message); }
  // other common page globals
  for (const g of ["__NUXT__", "__INITIAL_STATE__", "__PRELOADED_STATE__", "__APP_CONTEXT__", "itxsc", "MangoUI"]) {
    try { if (window[g]) { log("window." + g + ":", typeof window[g]); scanForProducts(window[g], g, 0); } } catch (e) {}
  }
  if (productArrays.length) {
    productArrays.forEach(p => {
      log("  PRODUCT ARRAY @", p.path, "— len:", p.len);
      log("    item keys:", Object.keys(p.sample).join(", "));
      log("    item sample:", short(p.sample));
    });
  } else {
    log("  (no product array found in page globals)");
  }

  // ---- 2) product/category API the page fetched (resource timings) ----------
  try {
    const res = performance.getEntriesByType("resource").map(e => e.name);
    const api = res.filter(u => /itxrest|\/catalog\/|\/category\/|\/product|\/plp|\/grid|search.*product|productlist/i.test(u));
    log("API-ish requests seen:", api.length);
    [...new Set(api)].slice(0, 8).forEach(u => log("   ", u.slice(0, 200)));
  } catch (e) { log("resource-timing error:", e.message); }

  // ---- 3) product links: learn the URL pattern ------------------------------
  const anchors = [...document.querySelectorAll("a[href]")].map(a => a.getAttribute("href"));
  const prod = anchors.filter(h => h && /(-l\d{5,}|-p\d{5,}|\/product|\d{7,}\.html|\/[a-z0-9-]+-\d{6,})/i.test(h));
  log("product-looking anchors:", prod.length, "of", anchors.length, "total");
  [...new Set(prod)].slice(0, 8).forEach(h => log("   ", h.slice(0, 120)));

  // ---- 4) how prices render (broad scan: symbol OR currency word OR nn,nn) ---
  const PRICE_BROAD = /(?:[$€£¥]\s?\d[\d.,]*|\d[\d.,]*\s?(?:USD|EUR|GBP)|\d{1,4}[.,]\d{2}\b)/;
  let priced = 0; const psamples = [];
  document.querySelectorAll("*").forEach(el => {
    if (priced >= 5 || (el.children && el.children.length > 1)) return;
    const t = ((el.textContent || "").replace(/\s+/g, " ").trim());
    if (t.length <= 30 && PRICE_BROAD.test(t)) { priced++; psamples.push(t + "  <" + el.tagName.toLowerCase() + ">"); }
  });
  log("broad price-ish leaves:", priced);
  psamples.forEach(s => log("   ", s));

  log("=== END (copy everything above) ===");
  const text = R.join("\n");
  console.log(text);
  try { copy(text); console.log("(copied to clipboard)"); } catch (e) {}
  return text;
})();
