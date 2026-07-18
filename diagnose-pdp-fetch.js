/* FETCHED-PDP diagnostic — run this in the DevTools Console while on ANY Cotton
   On category/search page. Unlike diagnose-pdp.js (which reads the LIVE page
   after JavaScript has rendered it), this reproduces exactly what the extension
   sees: it fetch()es a product page and inspects the RAW server HTML — because
   the extension collects colour/size/brand/composition by fetching each PDP,
   and Cotton On renders colour swatches + size buttons on the CLIENT (with JS),
   so they may be absent from the fetched HTML even though you can see them
   on-screen.

   It picks the first product link on the current page, fetches it, and reports
   where colour / size / brand / composition live in the raw HTML — so the
   adapter can be matched to reality with no selector guessing.

   Reads only; changes nothing, submits nothing. Copy the whole output back. */
(async function () {
  const R = []; const log = (...a) => R.push(a.join(" "));
  const cap = (s, n) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, n || 160);

  log("=== FETCHED-PDP DIAGNOSTIC (raw server HTML, no JS) ===");
  log("from category:", location.href);

  // 1) find a product page link on this grid
  const link = [...document.querySelectorAll('a[href*=".html"]')]
    .map(a => a.href).find(h => /\/AU\/.+\.html/i.test(h));
  if (!link) { log("NO product .html link found on this page — open a category grid first."); console.log(R.join("\n")); return; }
  log("fetching PDP:", link);

  let html = "";
  try {
    const res = await fetch(link, { credentials: "include" });
    log("HTTP status:", res.status, res.ok ? "OK" : "(not ok)");
    html = await res.text();
  } catch (e) { log("FETCH FAILED:", e && e.message); console.log(R.join("\n")); return; }
  log("raw HTML length:", html.length, "chars");

  const doc = new DOMParser().parseFromString(html, "text/html");
  const bodyText = (doc.body && doc.body.textContent) || "";

  // 2) title + brand-ish meta present in the server HTML
  log("\n[<title>]:", cap(doc.querySelector("title") && doc.querySelector("title").textContent, 120));
  log("[<h1>]:", cap(doc.querySelector("h1") && doc.querySelector("h1").textContent, 120));
  ["og:title", "og:brand", "product:brand", "brand", "og:site_name", "og:image:alt"].forEach(p => {
    const m = doc.querySelector(`meta[property="${p}"], meta[name="${p}"]`);
    if (m) log(`[meta ${p}]:`, cap(m.getAttribute("content"), 120));
  });

  // 3) JSON-LD / embedded product JSON in the RAW html
  log("\n[JSON-LD blocks]:", doc.querySelectorAll('script[type="application/ld+json"]').length);
  const varHit = [...doc.querySelectorAll("script:not([src])")]
    .filter(s => /variationAttributes|"attributeId"|"variants"|colorVariations/i.test(s.textContent || "")).length;
  log("[embedded variation JSON scripts]:", varHit);

  // 4) COLOUR in the raw html — the two forms we care about
  const colourLabel = bodyText.match(/colou?r\s*:?\s*[A-Za-z][A-Za-z0-9 .&/'-]{1,38}/i);
  log("\n[visible 'Colour: ...' text in raw HTML]:", colourLabel ? cap(colourLabel[0], 80) : "(NOT in raw HTML — client-rendered)");
  const rawColour = html.match(/colou?r\s*[:="'>]{1,3}\s*[A-Za-z][A-Za-z0-9 .&/'-]{1,38}/i);
  log("[any colour-ish token in raw HTML source]:", rawColour ? cap(rawColour[0], 80) : "(none)");

  // 4b) COLOUR SWATCHES — sibling PDP links sharing this product's slug.
  // This is how the extension counts/names colours, so dump them verbatim.
  const segs = new URL(link).pathname.split("/").filter(Boolean);
  const hi = segs.findIndex(s => /\.html$/i.test(s));
  const slug = hi > 0 ? segs[hi - 1] : (segs.slice(-2, -1)[0] || "");
  log("\n[product slug]:", slug);
  const swatch = [...doc.querySelectorAll(`a[href*="/${slug}/"]`)];
  const seen = new Set();
  const rows = [];
  swatch.forEach(a => {
    const href = a.getAttribute("href") || "";
    const m = href.match(/\/(\d[\w-]*)\.html/i);
    if (!m || seen.has(m[1])) return; seen.add(m[1]);
    const img = a.querySelector("img");
    rows.push(`  pid=${m[1]} | aria="${cap(a.getAttribute("aria-label"), 40)}" | title="${cap(a.getAttribute("title"), 40)}" | img-alt="${cap(img && img.getAttribute("alt"), 50)}"`);
  });
  log(`[sibling colour swatches sharing slug]: ${rows.length} distinct`);
  rows.slice(0, 20).forEach(r => log(r));

  // 5) SIZE in the raw html
  const sizeAria = [...doc.querySelectorAll("[aria-label]")]
    .map(e => e.getAttribute("aria-label")).filter(a => /^size\s+/i.test(a || "")).slice(0, 8);
  log("\n[size aria-labels in raw HTML]:", sizeAria.length, JSON.stringify(sizeAria));
  const rawSize = html.match(/"size"\s*[:=]\s*[\[{"][^\]}]{0,80}/i);
  log("[size token in raw HTML source]:", rawSize ? cap(rawSize[0], 80) : "(none)");

  // 6) COMPOSITION (this one already works — confirm it's here)
  const comp = bodyText.match(/(?:composition|material|fabric|main)[^.\n]{0,80}\d{1,3}\s?%[^.\n]{0,60}/i);
  log("\n[composition text in raw HTML]:", comp ? cap(comp[0], 100) : "(not found)");

  log("\n=== END (copy everything above) ===");
  const text = R.join("\n");
  console.log(text);
  try { copy(text); console.log("(copied to clipboard)"); } catch (e) {}
})();
