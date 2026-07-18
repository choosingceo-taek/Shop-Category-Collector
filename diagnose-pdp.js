/* Product-detail-page diagnostic — paste this whole file into the DevTools
   Console while on a single PRODUCT page (e.g. a Cotton On .html product page)
   to see where colour / size / brand / composition actually live. Copy the
   entire output back so the adapter's detail extractor can be matched exactly
   (no selector guessing — project rule).

   It reads only; changes nothing, submits nothing. */
(function () {
  const R = []; const log = (...a) => R.push(a.join(" "));
  const cap = (s, n) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, n || 120);

  log("=== PRODUCT PAGE DIAGNOSTIC ===");
  log("URL:", location.href);
  log("title:", cap(document.querySelector("h1")?.textContent, 100));

  // 1) JSON-LD blocks — do any carry brand / color / size / offers?
  const lds = [...document.querySelectorAll('script[type="application/ld+json"]')];
  log("\n[JSON-LD blocks]:", lds.length);
  lds.forEach((s, i) => {
    let d; try { d = JSON.parse(s.textContent); } catch (e) { log(`  #${i} PARSE ERROR`); return; }
    [].concat(d && d["@graph"] ? d["@graph"] : d).forEach(n => {
      if (!n || typeof n !== "object") return;
      const t = [].concat(n["@type"] || []).join(",");
      log(`  #${i} @type=${t} | keys: ${Object.keys(n).join(", ")}`);
      if (/Product/i.test(t)) {
        log(`      name=${cap(n.name, 60)} | brand=${cap(JSON.stringify(n.brand), 60)}`);
        log(`      color=${cap(JSON.stringify(n.color), 80)} | size=${cap(JSON.stringify(n.size), 80)}`);
        if (n.hasVariant) log(`      hasVariant[0]=${cap(JSON.stringify([].concat(n.hasVariant)[0]), 120)}`);
        if (n.offers) log(`      offers=${cap(JSON.stringify(n.offers), 100)}`);
      }
    });
  });

  // 2) brand-ish meta
  log("\n[meta]:");
  ["og:brand", "product:brand", "brand", "og:site_name"].forEach(p => {
    const m = document.querySelector(`meta[property="${p}"], meta[name="${p}"]`);
    if (m) log(`  ${p} = ${cap(m.getAttribute("content"), 60)}`);
  });

  // 3) embedded JS objects that mention variation/colour/size
  let hitVar = 0;
  document.querySelectorAll("script:not([src])").forEach(s => {
    const t = s.textContent || "";
    if (/variationAttributes|"attributeId"|colorVariations|"variants"/.test(t)) {
      hitVar++;
      if (hitVar <= 1) {
        const m = t.match(/.{0,40}(?:variationAttributes|attributeId).{0,120}/);
        log("\n[embedded variation JSON] sample:", cap(m && m[0], 180));
      }
    }
  });
  log("[embedded variation JSON] scripts hit:", hitVar);

  // 4) DOM colour/size swatch candidates
  function scan(label, sel) {
    const els = [...document.querySelectorAll(sel)].slice(0, 12);
    const vals = els.map(e => cap(e.getAttribute("aria-label") || e.getAttribute("title") ||
      e.getAttribute("data-attr-value") || e.getAttribute("data-value") ||
      (e.children.length ? "" : e.textContent), 30)).filter(Boolean);
    log(`\n[DOM ${label}] "${sel}" -> ${document.querySelectorAll(sel).length} els; sample: ${JSON.stringify(vals.slice(0, 8))}`);
  }
  scan("colour-A", '[class*="colour" i] [aria-label], [class*="color" i] [aria-label]');
  scan("colour-B", '[class*="swatch" i]');
  scan("colour-C", '[data-attr="color"] *, [data-variation-attribute*="color" i] *');
  scan("size-A", '[class*="size" i] button, [class*="size" i] [aria-label]');
  scan("size-B", '[data-attr="size"] *, [data-variation-attribute*="size" i] *');

  // 5) composition text presence
  const body = document.body ? document.body.textContent : "";
  const comp = body.match(/(?:composition|material|fabric)[^.\n]{0,80}\d{1,3}\s?%[^.\n]{0,60}/i);
  log("\n[composition text]:", comp ? cap(comp[0], 100) : "(not found in page text)");

  log("\n=== END (copy everything above) ===");
  const text = R.join("\n");
  console.log(text);
  try { copy(text); console.log("(copied to clipboard)"); } catch (e) {}
  return text;
})();
