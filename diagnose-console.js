/* Walmart live diagnostic — paste this whole file into the DevTools Console
   while on a Walmart CATEGORY / SEARCH page (the same page you'd run the
   extension on). It mirrors the extension's extractor and prints a report.
   Copy the ENTIRE console output back to the developer.

   It reads only; it changes nothing and submits nothing. */
(function () {
  const R = []; const log = (...a) => R.push(a.join(" "));

  // --- same helpers as sites.js ---
  function sliceBalanced(str, start) {
    const open = str[start], close = open === "{" ? "}" : "]";
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < str.length; i++) {
      const c = str[i];
      if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; }
      else if (c === '"') inStr = true;
      else if (c === open) depth++;
      else if (c === close) { depth--; if (depth === 0) return str.slice(start, i + 1); }
    }
    return null;
  }
  function jsonBlobs() {
    const out = []; const push = t => { if (t) { try { out.push(JSON.parse(t)); } catch (e) {} } };
    const nx = document.getElementById("__NEXT_DATA__"); if (nx) push(nx.textContent);
    document.querySelectorAll('script[type="application/json"], script[type="application/ld+json"]').forEach(s => push(s.textContent));
    const KEYS = ["__WML_REDUX_INITIAL_STATE__", "__PRELOADED_STATE__", "__INITIAL_STATE__", "__APOLLO_STATE__", "__NUXT__"];
    document.querySelectorAll("script:not([src])").forEach(s => {
      const t = s.textContent; if (!t || t.length > 4000000) return;
      for (const k of KEYS) { const i = t.indexOf(k); if (i < 0) continue; const eq = t.indexOf("=", i); if (eq < 0) continue;
        const b = t.indexOf("{", eq); if (b < 0) continue; const o = sliceBalanced(t, b); if (o) push(o); }
    });
    return out;
  }
  function looksProduct(x) {
    if (!x || typeof x !== "object" || Array.isArray(x)) return false;
    const name = x.name || x.title || x.productName || x.displayName;
    const url = x.canonicalUrl || x.productPageUrl || x.productUrl || x.url || x.seoUrl;
    const id = x.usItemId || x.productId || x.id || x.itemId || x.sku;
    return !!name && !!(url || id) && !!(url || x.priceInfo || x.price || x.primaryOffer || x.imageInfo || x.image);
  }
  function collect(obj, d, acc) {
    if (!obj || d > 12) return acc;
    if (Array.isArray(obj)) { const h = obj.filter(looksProduct); if (h.length && h.length >= Math.max(2, obj.length * 0.5)) acc.push(h); obj.forEach(v => collect(v, d + 1, acc)); }
    else if (typeof obj === "object") for (const k in obj) collect(obj[k], d + 1, acc);
    return acc;
  }
  function findNumber(obj, keys, d) {
    d = d || 0; if (!obj || d > 12) return null;
    if (typeof obj === "object") { for (const k in obj) if (keys.includes(k) && typeof obj[k] === "number" && obj[k] > 0) return obj[k];
      for (const k in obj) { const r = findNumber(obj[k], keys, d + 1); if (r) return r; } }
    return null;
  }

  // --- run ---
  log("=== WALMART EXTRACTION DIAGNOSTIC ===");
  log("URL:", location.href);
  log("H1:", ((document.querySelector("h1") || {}).textContent || "").trim().slice(0, 80));
  const blobs = jsonBlobs();
  log("data blobs found:", blobs.length,
    "| __NEXT_DATA__:", !!document.getElementById("__NEXT_DATA__"),
    "| json scripts:", document.querySelectorAll('script[type="application/json"]').length);

  const arrays = []; blobs.forEach(b => collect(b, 0, arrays));
  const flat = [].concat.apply([], arrays);
  const seen = new Set(); const items = flat.filter(x => { const k = String(x.usItemId || x.productId || x.id || x.canonicalUrl || x.name); if (seen.has(k)) return false; seen.add(k); return true; });
  log("product arrays:", arrays.length, "| total product objects:", flat.length, "| deduped:", items.length);

  if (items.length) {
    const s0 = items[0];
    log("--- sample product keys:", Object.keys(s0).join(", "));
    log("--- sample values the extension reads:");
    log("    name        =", s0.name || s0.title || s0.productName || "(none)");
    log("    price        =", JSON.stringify(s0.priceInfo || s0.price || s0.primaryOffer || "(none)").slice(0, 120));
    log("    product_url  =", s0.canonicalUrl || s0.productUrl || s0.url || "(none)");
    log("    image_url    =", (s0.imageInfo && (s0.imageInfo.thumbnailUrl || (s0.imageInfo.allImages && s0.imageInfo.allImages[0] && s0.imageInfo.allImages[0].url))) || s0.image || s0.imageUrl || "(none)");
    log("    id           =", s0.usItemId || s0.productId || s0.id || "(none)");
  } else {
    log("!! NO PRODUCTS via JSON. DOM fallback tiles with /ip/ links:",
      document.querySelectorAll('a[href*="/ip/"]').length);
    log("!! If the number above is > 0, the extension's DOM fallback should still work.");
  }

  const pages = findNumber(blobs, ["maxPage", "numberOfPages", "totalPages", "pageCount"]);
  const total = findNumber(blobs, ["totalResultCount", "totalCount", "recordCount"]);
  const size = findNumber(blobs, ["pageSize", "resultsPerPage", "perPage"]);
  log("pagination: maxPage/numberOfPages =", pages, "| totalResults =", total, "| pageSize =", size,
    "| derived pages =", (total && size) ? Math.ceil(total / size) : "n/a");
  log("=== END (copy everything above) ===");

  const text = R.join("\n");
  console.log(text);
  try { copy(text); console.log("(also copied to clipboard)"); } catch (e) {}
  return text;
})();
