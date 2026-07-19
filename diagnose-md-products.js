/* Massimo Dutti productsArray schema probe — the grid data is served by
   Inditex's itxrest `productsArray` endpoint (full product objects: name,
   price, colors, sizes, composition, images) in one JSON call. This script
   fetches that endpoint same-origin and reports its EXACT field shape so the
   adapter parses the real schema instead of guessing.

   HOW TO USE
   1. Open a Massimo Dutti category page and scroll a bit so the grid loads.
   2. Open DevTools > Network, filter: productsArray  (or paste your own URL below).
   3. Paste this whole file into the DevTools Console. It reads only; it
      changes nothing and submits nothing.
   4. Copy the ENTIRE output back.

   If you already have the productsArray URL, set URL_OVERRIDE below. Otherwise
   the script grabs the most recent productsArray request from the page's
   Resource Timing and re-fetches it. */
(async function () {
  const URL_OVERRIDE = "";   // <- optionally paste your full productsArray URL here

  const R = []; const log = (...a) => R.push(a.join(" "));
  const j = (v, n) => { try { return JSON.stringify(v).slice(0, n || 400); } catch (e) { return String(v).slice(0, n || 400); } };
  const keys = o => (o && typeof o === "object") ? Object.keys(o).join(", ") : "(" + typeof o + ")";

  log("=== MASSIMO DUTTI productsArray PROBE ===");
  log("page:", location.href);

  // find the productsArray URL: override -> Resource Timing (recently loaded)
  let url = URL_OVERRIDE;
  if (!url) {
    const hits = (performance.getEntriesByType("resource") || [])
      .map(e => e.name).filter(n => /productsArray/i.test(n));
    url = hits[hits.length - 1] || "";
  }
  if (!url) {
    log("!! No productsArray URL found. Set URL_OVERRIDE at the top of the script");
    log("   (copy it from Network tab, filter: productsArray), then re-run.");
    console.log(R.join("\n")); return R.join("\n");
  }
  log("productsArray URL:", url.slice(0, 200));

  let data;
  try {
    const res = await fetch(url, { credentials: "include", headers: { Accept: "application/json" } });
    log("fetch status:", res.status);
    if (!res.ok) { log("!! non-OK — re-copy a fresh URL from Network tab."); console.log(R.join("\n")); return R.join("\n"); }
    data = await res.json();
  } catch (e) { log("!! fetch failed:", e.message); console.log(R.join("\n")); return R.join("\n"); }

  log("top-level type:", Array.isArray(data) ? "array" : typeof data, "| top keys:", keys(data));
  const products = Array.isArray(data) ? data
    : (data.products || data.productsArray || data.items || []);
  log("products count:", products.length);
  if (!products.length) { log("!! no products array — full dump:", j(data, 1200)); console.log(R.join("\n")); return R.join("\n"); }

  // full schema walk of one representative product
  const p = products[0];
  log("");
  log("--- product[0] full keys:", keys(p));
  log("    id:", j(p.id, 60), "| name:", j(p.name, 120), "| nameEn:", j(p.nameEn, 80));

  const d = p.detail || p;
  log("--- detail keys:", keys(d));
  // price fields anywhere under detail (Inditex nests price on color/size, sometimes at detail)
  ["price", "oldPrice", "minPrice", "maxPrice", "displayDiscountPercentage", "priceUnavailable"].forEach(k => {
    if (d[k] != null) log("    detail." + k + ":", j(d[k], 80));
  });
  log("--- seo:", j(p.seo || d.seo, 300));
  log("--- family/section:", "familyName=", j(p.familyName || d.familyName), "| sectionName=", j(p.sectionName || d.sectionName), "| subfamily=", j(p.subFamilyName || d.subFamilyName));

  // colors -> sizes -> price
  const colors = d.colors || p.colors || [];
  log("--- colors count:", colors.length);
  if (colors[0]) {
    const c = colors[0];
    log("    color[0] keys:", keys(c));
    log("    color[0]:", "id=", j(c.id), "| name=", j(c.name), "| price=", j(c.price), "| oldPrice=", j(c.oldPrice));
    log("    color[0].image:", j(c.image, 400));
    log("    color[0].xmedia:", j(c.xmedia, 500));
    const sizes = c.sizes || [];
    log("    color[0] sizes count:", sizes.length);
    if (sizes[0]) {
      log("    size[0] keys:", keys(sizes[0]));
      log("    size[0]:", j(sizes[0], 400));
    }
  }

  // composition / care — Inditex uses several shapes; find whichever exists
  ["composition", "care", "xmedia", "compositionByZones", "attributes", "productAttributes"].forEach(k => {
    if (d[k] != null) log("--- detail." + k + ":", j(d[k], 700));
    if (p[k] != null && p[k] !== d[k]) log("--- product." + k + ":", j(p[k], 700));
  });

  // any deep field whose key mentions composition/fabric/fiber/material
  const found = new Set();
  (function walk(o, path, depth) {
    if (!o || typeof o !== "object" || depth > 6) return;
    for (const k in o) {
      if (/composit|fabric|fiber|fibre|material|yarn/i.test(k) && !found.has(path + "." + k)) {
        found.add(path + "." + k);
        log("    [fiber-ish] " + path + "." + k + " =", j(o[k], 300));
      }
      if (typeof o[k] === "object") walk(o[k], path + "." + k, depth + 1);
    }
  })(p, "product[0]", 0);

  // image URL: show how to build an absolute src from xmedia paths
  log("");
  log("--- IMAGE URL SAMPLES (first 2 products) ---");
  products.slice(0, 2).forEach((pp, i) => {
    const dd = pp.detail || pp; const cc = (dd.colors || [])[0] || {};
    log("  p[" + i + "] image:", j(cc.image, 200));
    log("  p[" + i + "] xmedia[0]:", j((cc.xmedia || [])[0], 300));
  });

  // second product to confirm fields are consistent (not accidental on [0])
  log("");
  log("--- product[1] sanity: keys=", keys(products[1]), "| name=", j(products[1] && products[1].name, 80));

  log("=== END (copy everything above) ===");
  const text = R.join("\n");
  console.log(text);
  try { copy(text); console.log("(copied to clipboard)"); } catch (e) {}
  return text;
})();
