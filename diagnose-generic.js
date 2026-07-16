/* Generic site diagnostic — paste this whole file into the DevTools Console
   on ANY shop's category/search page (Cotton On, etc.) to see what the
   extension's generic scraper can find there. Copy the entire output back.

   It reads only; it changes nothing and submits nothing. */
(function () {
  const R = []; const log = (...a) => R.push(a.join(" "));
  const textOf = el => ((el && el.textContent) || "").replace(/\s+/g, " ").trim();
  const PRICE_RE = /(?:[$₩€£¥]\s?\d[\d,]*(?:\.\d{1,2})?|\d[\d,]*(?:\.\d{1,2})?\s?(?:원|USD|EUR|GBP))/;

  log("=== GENERIC SHOP DIAGNOSTIC ===");
  log("URL:", location.href);
  log("H1:", (document.querySelector("h1")?.textContent || "").trim().slice(0, 80));

  // 1) platform hints
  const html = document.documentElement.innerHTML;
  const hints = [];
  if (/cdn\.shopify\.com|\/cdn\/shop\//.test(html)) hints.push("Shopify");
  if (/demandware\.static|dwstatic|salesforce/i.test(html)) hints.push("Salesforce/Demandware");
  if (/Magento|mage\//i.test(html)) hints.push("Magento");
  if (/__NEXT_DATA__/.test(html)) hints.push("Next.js(__NEXT_DATA__)");
  if (/__NUXT__/.test(html)) hints.push("Nuxt");
  log("platform hints:", hints.join(", ") || "(none detected)");

  // 2) JSON-LD products
  let ldItems = 0, ldSample = null;
  document.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
    let d; try { d = JSON.parse(s.textContent); } catch (e) { return; }
    const nodes = Array.isArray(d) ? d : (d["@graph"] || [d]);
    nodes.forEach(n => {
      if (!n || typeof n !== "object") return;
      const t = [].concat(n["@type"] || []).join(",");
      if (/ItemList/i.test(t) && Array.isArray(n.itemListElement)) {
        ldItems += n.itemListElement.length;
        if (!ldSample) { const it = n.itemListElement[0]?.item || n.itemListElement[0]; ldSample = it; }
      }
    });
  });
  log("JSON-LD ItemList products:", ldItems);
  if (ldSample) log("  sample keys:", Object.keys(ldSample).join(", "),
    "| name:", ldSample.name, "| url:", ldSample.url || ldSample["@id"],
    "| offers:", JSON.stringify(ldSample.offers || "").slice(0, 80));

  // 3) DOM product-link density
  const ipLinks = document.querySelectorAll('a[href*="/product"], a[href*="/p/"], a[href*=".html"]').length;
  const allLinks = document.querySelectorAll("a[href]").length;
  log("product-ish links:", ipLinks, "/ total links:", allLinks);

  // 4) price-bearing leaf elements (what the generic tile-finder keys off)
  let priceLeaves = 0, priceSample = "";
  document.querySelectorAll("*").forEach(el => {
    if (el.children && el.children.length > 2) return;
    const t = textOf(el);
    if (t.length <= 40 && PRICE_RE.test(t)) { priceLeaves++; if (!priceSample) priceSample = t; }
  });
  log("price-bearing leaves:", priceLeaves, "| sample:", priceSample);

  // 5) what the extension would actually collect (if it's loaded on this page)
  if (window.SITES) {
    try {
      const a = window.SITES.active(location.href, document);
      const items = a.scrapeList(document, location.href);
      log("EXTENSION adapter:", a.id, "-> scraped:", items.length);
      if (items[0]) log("  sample:", JSON.stringify({ name: items[0].name, price: items[0].price, url: items[0].product_url, img: !!items[0].image_url }).slice(0, 200));
    } catch (e) { log("extension scrape error:", e.message); }
  } else {
    log("(extension not loaded on this page — install/allow-list it, or judge from the counts above)");
  }

  log("pagination links:", [...document.querySelectorAll('[class*="pagination" i] a, nav[aria-label*="page" i] a, a[rel="next"]')].length);
  log("=== END (copy everything above) ===");

  const text = R.join("\n");
  console.log(text);
  try { copy(text); console.log("(copied to clipboard)"); } catch (e) {}
  return text;
})();
