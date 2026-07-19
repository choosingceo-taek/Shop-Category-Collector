/* Lazy-grid diagnostic — for infinite-scroll shops whose product grid is NOT
   in the DOM until you scroll (Massimo Dutti, some Inditex/Next.js sites).

   Paste this whole file into the DevTools Console on the category page. It
   SCROLLS the page to the bottom a few times (like the extension does before
   scraping), waits for the grid to render, then reports what became visible —
   and, if the DOM still looks empty, dumps the keys of any embedded product
   JSON so the adapter can read the real data source instead of guessing.

   It reads and scrolls only; it changes nothing and submits nothing.
   Copy the entire output back. */
(async function () {
  const R = []; const log = (...a) => R.push(a.join(" "));
  const textOf = el => ((el && el.textContent) || "").replace(/\s+/g, " ").trim();
  const PRICE_RE = /(?:[$₩€£¥]\s?\d[\d,]*(?:\.\d{1,2})?|\d[\d,]*(?:\.\d{1,2})?\s?(?:원|USD|EUR|GBP))/;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  log("=== LAZY-GRID DIAGNOSTIC ===");
  log("URL:", location.href);

  // 1) counts BEFORE scrolling
  const countPrices = () => {
    let n = 0, sample = "";
    document.querySelectorAll("*").forEach(el => {
      if (el.children && el.children.length > 2) return;
      const t = textOf(el);
      if (t.length <= 40 && PRICE_RE.test(t)) { n++; if (!sample) sample = t; }
    });
    return { n, sample };
  };
  const countLinks = () =>
    document.querySelectorAll('a[href*="/product"], a[href*="/p/"], a[href*=".html"], a[href*="-p0"], a[href*="-l"]').length;

  const before = countPrices();
  log("BEFORE scroll — product-ish links:", countLinks(), "| price leaves:", before.n, "| total links:", document.querySelectorAll("a[href]").length);

  // 2) scroll to the bottom repeatedly until the height stops growing
  let lastH = 0, stable = 0;
  for (let i = 0; i < 40 && stable < 3; i++) {
    window.scrollTo(0, document.body.scrollHeight);
    await sleep(700);
    const h = document.body.scrollHeight;
    if (h === lastH) stable++; else { stable = 0; lastH = h; }
  }
  window.scrollTo(0, 0);
  await sleep(500);

  // 3) counts AFTER scrolling
  const after = countPrices();
  log("AFTER scroll  — product-ish links:", countLinks(), "| price leaves:", after.n, "| price sample:", after.sample);

  // 4) if the DOM is still empty, look for embedded product JSON
  if (after.n < 3) {
    log("-- DOM still sparse; scanning embedded JSON --");
    // 4a) __NEXT_DATA__ / other big JSON scripts
    document.querySelectorAll('script[type="application/json"], script#__NEXT_DATA__').forEach(s => {
      let d; try { d = JSON.parse(s.textContent); } catch (e) { return; }
      const hits = [];
      const walk = (o, path, depth) => {
        if (!o || typeof o !== "object" || depth > 8 || hits.length >= 4) return;
        if (Array.isArray(o)) {
          const looksProduct = o.length >= 3 && o.slice(0, 5).every(x => x && typeof x === "object" &&
            (("name" in x || "title" in x || "displayName" in x) && ("price" in x || "prices" in x || "priceValue" in x || "detail" in x)));
          if (looksProduct) { hits.push({ path, len: o.length, keys: Object.keys(o[0]).slice(0, 14) }); return; }
          o.slice(0, 6).forEach((x, i) => walk(x, path + "[" + i + "]", depth + 1));
        } else {
          for (const k in o) walk(o[k], path + "." + k, depth + 1);
        }
      };
      walk(d, (s.id ? "#" + s.id : "script"), 0);
      hits.forEach(h => log("  product array @", h.path, "— len:", h.len, "| item keys:", h.keys.join(", ")));
    });
    // 4b) window globals that are arrays of product-like objects
    for (const g of ["__NUXT__", "__PRELOADED_STATE__", "__INITIAL_STATE__", "dataLayer"]) {
      try { if (window[g]) log("  window." + g, "present (", typeof window[g], ")"); } catch (e) {}
    }
    // 4c) any <script> text mentioning a products payload
    const scripts = [...document.querySelectorAll("script")].map(s => s.textContent || "");
    const mentions = scripts.filter(t => /"products?"\s*:/.test(t)).length;
    log("  <script>s mentioning a products payload:", mentions);
  }

  // 5) what the extension would collect right now (if loaded)
  if (window.SITES) {
    try {
      const a = window.SITES.active(location.href, document);
      const items = a.scrapeList(document, location.href);
      log("EXTENSION adapter:", a.id, "-> scraped:", items.length);
      if (items[0]) log("  sample:", JSON.stringify({ name: items[0].name, price: items[0].price, url: items[0].product_url, img: !!items[0].image_url }).slice(0, 220));
    } catch (e) { log("extension scrape error:", e.message); }
  } else {
    log("(extension not loaded here — allow-list it, or judge from the counts above)");
  }

  log("=== END (copy everything above) ===");
  const text = R.join("\n");
  console.log(text);
  try { copy(text); console.log("(copied to clipboard)"); } catch (e) {}
  return text;
})();
