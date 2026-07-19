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
  const URL_OVERRIDE = "https://www.massimodutti.com/itxrest/3/catalog/store/34009527/30359506/productsArray?languageId=-1&appId=1&productIds=61729768,61734054,61735799,62585081,62051931,63092758,62412107,61734215,62051916,61733905,62681552,61729603,61729841,61729277,61729278,61729276,61733717,61735907,62904656,62408388";   // <- paste your full productsArray URL here (empty = auto-detect from Network timing)

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

  // PROBE 2 — the real data lives under bundleProductSummaries[0].detail
  // (product.detail.colors/composition are empty for these bundle products).
  // Dig into price, image (xmedia), colors, sizes, and product URL there.
  const p = products[0];
  log("");
  log("--- product[0]: id=", j(p.id), "| name=", j(p.name, 100));
  log("    productUrl:", j(p.productUrl, 200));
  log("    productUrlParam:", j(p.productUrlParam, 200));
  log("    onSpecial:", j(p.onSpecial), "| isBuyable:", j(p.isBuyable), "| mainColorid:", j(p.mainColorid));
  log("    bundleColors:", j(p.bundleColors, 400));
  log("    family/subFamily(EN):", j(p.familyNameEN), "/", j(p.subFamilyNameEN), "| tags:", j(p.tags, 200));

  const bps = p.bundleProductSummaries || [];
  log("--- bundleProductSummaries length:", bps.length);
  const bd = (bps[0] && bps[0].detail) || {};
  log("--- bps[0] keys:", keys(bps[0]));
  log("--- bps[0].detail keys:", keys(bd));
  log("    bps[0].detail.reference:", j(bd.reference), "| displayReference:", j(bd.displayReference));

  const colors = bd.colors || [];
  log("--- bps[0].detail.colors length:", colors.length);
  colors.slice(0, 3).forEach((c, i) => {
    log("  color[" + i + "] keys:", keys(c));
    log("  color[" + i + "]: id=", j(c.id), "| name=", j(c.name), "| price=", j(c.price), "| oldPrice=", j(c.oldPrice), "| colorId=", j(c.colorId));
    // price can also sit on the color as a nested object or on sizes
    ["priceUnavailable", "originalPrice", "salePrice", "productPrice"].forEach(k => { if (c[k] != null) log("    color[" + i + "]." + k + ":", j(c[k], 120)); });
    // xmedia / image → how to build an absolute URL
    log("    color[" + i + "].image:", j(c.image, 300));
    log("    color[" + i + "].xmedia:", j(c.xmedia, 600));
    const sizes = c.sizes || [];
    log("    color[" + i + "] sizes count:", sizes.length);
    if (sizes[0]) {
      log("    size[0] keys:", keys(sizes[0]));
      log("    size[0]:", j(sizes[0], 400));
    }
  });

  // composition (confirmed present here) — show final shape we'll parse
  log("--- bps[0].detail.composition:", j(bd.composition, 500));
  if (colors[0]) log("--- color[0].composition:", j(colors[0].composition, 500));

  // IMAGE URL structure — the last unknown. image.url is just "/712" (a color
  // code), so the absolute CDN URL is built from xmedia / xmediaDefaultSet.
  log("");
  log("--- IMAGE STRUCTURE ---");
  log("    bps[0].detail.defaultImageType:", j(bd.defaultImageType));
  log("    bps[0].detail.xmediaDefaultSet:", j(bd.xmediaDefaultSet, 500));
  log("    bps[0].detail.xmedia:", j(bd.xmedia, 1200));
  if (colors[0]) log("    color[0].image (full):", j(colors[0].image, 600));
  // grab any absolute http image URL anywhere under the product (proves the CDN base)
  const imgs = new Set();
  (function walkImg(o, depth) {
    if (!o || typeof o !== "object" || depth > 8 || imgs.size >= 4) return;
    for (const k in o) {
      const v = o[k];
      if (typeof v === "string" && /^https?:\/\/[^"']+\.(?:jpg|jpeg|png|webp)/i.test(v)) imgs.add(v);
      else if (typeof v === "object") walkImg(v, depth + 1);
    }
  })(p, 0);
  log("    absolute image URLs found in product JSON:", imgs.size ? [...imgs].join("  |  ") : "(none — must build from xmedia path + CDN base)");

  // ENUMERATION — can the adapter re-collect every loaded batch? List all
  // productsArray requests the page already made (after a full scroll).
  const paUrls = (performance.getEntriesByType("resource") || [])
    .map(e => e.name).filter(n => /productsArray/i.test(n));
  const idCount = paUrls.reduce((n, u) => n + ((u.match(/productIds=([^&]+)/) || [,""])[1].split(",").filter(Boolean).length), 0);
  log("");
  log("--- ENUMERATION: productsArray requests in perf timing:", paUrls.length, "| total productIds across them:", idCount);
  // also: does a grid product link carry the id? (fallback path for detail fetch)
  const a = document.querySelector('a[href*="' + String(p.id) + '"], a[href*="' + String(p.productUrlParam) + '"]');
  log("--- sample grid product link:", a ? j(a.getAttribute("href"), 200) : "(no <a> href contains the product id)");

  // hunt any price-ish key anywhere under bps[0] so we don't miss the real one
  const seen = new Set();
  (function walk(o, path, depth) {
    if (!o || typeof o !== "object" || depth > 6) return;
    for (const k in o) {
      if (/price|oldprice|amount|discount/i.test(k) && typeof o[k] !== "object" && !seen.has(path + "." + k)) {
        seen.add(path + "." + k);
        if (seen.size <= 25) log("    [price-ish] " + path + "." + k + " =", j(o[k], 80));
      }
      if (typeof o[k] === "object") walk(o[k], path + "." + k, depth + 1);
    }
  })(bps[0], "bps[0]", 0);

  // second product: confirm the SAME paths hold (not accidental on [0])
  log("");
  const p2 = products[1], bd2 = (p2.bundleProductSummaries && p2.bundleProductSummaries[0] && p2.bundleProductSummaries[0].detail) || {};
  const c2 = (bd2.colors || [])[0] || {};
  log("--- product[1] sanity: name=", j(p2.name, 60), "| colors=", (bd2.colors || []).length,
      "| color[0].price=", j(c2.price), "| oldPrice=", j(c2.oldPrice), "| composition=", j(bd2.composition, 200));

  log("=== END (copy everything above) ===");
  const text = R.join("\n");
  console.log(text);
  try { copy(text); console.log("(copied to clipboard)"); } catch (e) {}
  return text;
})();
