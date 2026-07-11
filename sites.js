/* Site-adapter layer — the extension's per-site knowledge lives here.
   The engine (content.js) is site-agnostic: it asks SITES.active(url) for an
   adapter and drives whatever it returns. Add a new store = add one adapter
   object to ADAPTERS below. Nothing else in the engine needs to change.

   Adapter contract:
     id            : string
     label         : string (shown in popup)
     match(url)    : bool  — does this adapter handle the current URL?
     context(doc)  : { brand, category, totalPages, page }  (popup display)
     scrapeList(doc, url) : [normalized item, ...]  (one page)
     totalPages(doc)      : number | null            (display hint only)
     nextPageUrl(url, page): string | null           (null = no more pages)
     fetchDetail(url)     : Promise<{composition, colorways, design, reason}>
     buildWorkbook(items, ctx) : Promise<{ bytes, kept, dropped }>  (how to export)
     templateUrl          : string | null  (extension resource to fetch, or null)

   Normalized item shape produced by scrapeList / consumed by buildWorkbook:
     { brand, name, price, product_url, image_url, category, department, id,
       fabric_composition? }
*/
(function (root) {
  "use strict";

  // ---------------------------------------------------------------------------
  // Generic embedded-data helpers (shared by every adapter)
  // ---------------------------------------------------------------------------

  // Collect every parseable JSON object a page (or fetched HTML doc) ships.
  // Order of reliability: __NEXT_DATA__ > typed JSON scripts > inline state vars.
  // Content scripts run in an isolated world, so page-set window.__STATE__ globals
  // are NOT visible here — that's why we also regex the inline <script> text.
  function jsonBlobs(doc) {
    const out = [];
    const push = txt => { if (txt) { try { out.push(JSON.parse(txt)); } catch (e) {} } };

    const nx = doc.getElementById && doc.getElementById("__NEXT_DATA__");
    if (nx) push(nx.textContent);

    (doc.querySelectorAll
      ? doc.querySelectorAll('script[type="application/json"], script[type="application/ld+json"]')
      : []).forEach(s => push(s.textContent));

    const STATE_KEYS = [
      "__WML_REDUX_INITIAL_STATE__", "__PRELOADED_STATE__",
      "__INITIAL_STATE__", "__APOLLO_STATE__", "__NUXT__",
    ];
    (doc.querySelectorAll ? doc.querySelectorAll("script:not([src])") : []).forEach(s => {
      const t = s.textContent;
      if (!t || t.length > 4000000) return;
      for (const key of STATE_KEYS) {
        const i = t.indexOf(key);
        if (i === -1) continue;
        const eq = t.indexOf("=", i);
        if (eq === -1) continue;
        const brace = t.indexOf("{", eq);
        if (brace === -1) continue;
        const obj = sliceBalanced(t, brace);
        if (obj) push(obj);
      }
    });
    return out;
  }

  // Return the substring starting at `start` ('{' or '[') through its matching
  // close, respecting strings/escapes. Robust to trailing "; window.x=..." junk.
  function sliceBalanced(str, start) {
    const open = str[start], close = open === "{" ? "}" : "]";
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < str.length; i++) {
      const c = str[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === open) depth++;
      else if (c === close) { depth--; if (depth === 0) return str.slice(start, i + 1); }
    }
    return null;
  }

  // Does an object look like a product record? Tolerant across schemas.
  function looksProduct(x) {
    if (!x || typeof x !== "object" || Array.isArray(x)) return false;
    const name = x.name || x.title || x.productName || x.displayName;
    const url = x.canonicalUrl || x.productPageUrl || x.productUrl || x.url || x.seoUrl;
    const id = x.usItemId || x.productId || x.id || x.itemId || x.sku;
    const priceish = x.priceInfo || x.price || x.primaryOffer || x.offerPrice;
    const imgish = x.imageInfo || x.image || x.imageUrl || x.thumbnail;
    return !!name && !!(url || id) && !!(url || priceish || imgish);
  }

  // Walk any JSON and collect ALL arrays that are mostly product records.
  // Walmart splits results across several `itemStacks[].items`, so we merge them.
  function collectProductArrays(obj, depth, acc) {
    if (!obj || depth > 12) return acc;
    if (Array.isArray(obj)) {
      const hits = obj.filter(looksProduct);
      if (hits.length && hits.length >= Math.max(2, obj.length * 0.5)) acc.push(hits);
      for (const v of obj) collectProductArrays(v, depth + 1, acc);
    } else if (typeof obj === "object") {
      for (const k in obj) collectProductArrays(obj[k], depth + 1, acc);
    }
    return acc;
  }

  // Deep-find spec objects shaped {name, value} whose name matches `keys`.
  function findKeyedValue(obj, keys, depth) {
    depth = depth || 0;
    if (!obj || depth > 12) return "";
    if (Array.isArray(obj)) {
      for (const v of obj) { const r = findKeyedValue(v, keys, depth + 1); if (r) return r; }
      return "";
    }
    if (typeof obj === "object") {
      const nm = obj.name || obj.displayName || obj.key;
      const val = obj.value != null ? obj.value : obj.values;
      if (nm && val && keys.some(k => String(nm).toLowerCase() === k.toLowerCase())) {
        return Array.isArray(val) ? val.join(", ") : String(val);
      }
      for (const k in obj) { const r = findKeyedValue(obj[k], keys, depth + 1); if (r) return r; }
    }
    return "";
  }

  // Find a numeric value for any of `keys` anywhere in the JSON (first hit wins).
  function findNumber(obj, keys, depth) {
    depth = depth || 0;
    if (!obj || depth > 12) return null;
    if (typeof obj === "object") {
      for (const k in obj) {
        if (keys.includes(k) && typeof obj[k] === "number" && obj[k] > 0) return obj[k];
      }
      for (const k in obj) { const r = findNumber(obj[k], keys, depth + 1); if (r) return r; }
    }
    return null;
  }

  const uniqBy = (arr, keyFn) => {
    const seen = new Set(), out = [];
    for (const x of arr) { const k = keyFn(x); if (k && seen.has(k)) continue; if (k) seen.add(k); out.push(x); }
    return out;
  };

  // Expose shared helpers so adapters (and tests) can reuse them.
  const shared = { jsonBlobs, sliceBalanced, looksProduct, collectProductArrays,
    findKeyedValue, findNumber, uniqBy };

  // ---------------------------------------------------------------------------
  // Walmart adapter
  // ---------------------------------------------------------------------------
  const walmart = (function () {
    const ORIGIN = "https://www.walmart.com";
    const abs = u => !u ? "" : /^https?:/.test(u) ? u : ORIGIN + (u[0] === "/" ? u : "/" + u);

    const priceVal = cand => {
      if (cand == null) return "";
      if (typeof cand === "object") return cand.price || cand.priceString || "";
      return cand;
    };
    // current (sale) price shown on the shelf
    function priceOf(it) {
      const p = it.priceInfo || it.primaryOffer || {};
      return priceVal(p.linePrice || p.currentPrice || p.offerPrice || p.linePriceDisplay ||
        (p.currentPrice && p.currentPrice.price) || it.price);
    }
    // original / list price (the struck-through "was" price); "" when not on sale
    function wasPriceOf(it) {
      const p = it.priceInfo || it.primaryOffer || {};
      return priceVal(p.wasPrice || p.listPrice || p.originalPrice || p.strikethroughPrice ||
        p.comparisonPrice || (p.priceRange && p.priceRange.wasPrice));
    }
    function imageOf(it) {
      const im = it.imageInfo || {};
      return im.thumbnailUrl || (im.allImages && im.allImages[0] && im.allImages[0].url) ||
        it.image || it.imageUrl || it.thumbnail || "";
    }
    function brandOf(doc, it) {
      const named = (it && (it.brand || (it.brandName))) || "";
      if (named) return named;
      const h = ((doc.querySelector && doc.querySelector("h1")) || {}).textContent || "";
      const m = h.match(/(Time and Tru|Terra & Sky|No Boundaries|Wonder Nation|Weekend Academy|Free Assembly)/i);
      if (m) return m[1];
      const facet = (new URLSearchParams((doc.location || location).search).get("facet") || "");
      return facet.replace(/.*brand:/i, "").split("||")[0] || "";
    }
    // Category from the page heading, with the brand stripped so the cell holds
    // ONLY the category: "Time and Tru Leggings in Time and Tru" -> "Leggings".
    function categoryOf(doc, brand) {
      const h1 = (doc.querySelector && doc.querySelector("h1")) || {};
      let t = (h1.textContent || "").replace(/\(\d[\d,]*\).*/, "").trim();
      t = t.split("|")[0].trim();                                    // drop "... | Walmart" title tail
      t = t.replace(/\s+in\s+[A-Za-z][^,]*$/i, "").trim();          // drop "... in <brand/dept>"
      const b = String(brand || "").trim();
      if (b && t.toLowerCase().startsWith(b.toLowerCase() + " ")) { // drop leading brand
        t = t.slice(b.length).trim();
      }
      return t;
    }
    // Best-effort colorways from the list JSON (variant swatches). Full color
    // lists usually live on the product page; this catches what the shelf ships.
    function colorwaysOf(it) {
      const names = [];
      const pull = arr => { if (Array.isArray(arr)) arr.forEach(v => {
        const n = v && (v.name || v.value || v.swatchName || v.variantName || v.colorName);
        if (n) names.push(String(n));
      }); };
      pull(it.variantList); pull(it.variants); pull(it.colorVariants);
      if (Array.isArray(it.variantCriteria)) it.variantCriteria.forEach(c => {
        if (/colou?r/i.test((c && c.name) || "")) pull(c.variantList || c.values);
      });
      const uniq = [...new Set(names.map(s => s.trim()).filter(Boolean))];
      return uniq.length ? uniq.join("; ") : "";
    }

    // Walmart's MAIN results live in `searchResult.itemStacks[].items` (browse
    // pages use the same key). We scope to that container ONLY — reading every
    // `itemStacks` anywhere also pulls the "you might also like / explore more"
    // recommendation modules that inflate the count (e.g. 106 vs 11 real, or
    // 308 vs 81). Falls back to any itemStacks if the container isn't found.
    function stacksItems(sr) {
      const out = [];
      if (sr && Array.isArray(sr.itemStacks)) {
        sr.itemStacks.forEach(st => { if (st && Array.isArray(st.items)) out.push(...st.items.filter(looksProduct)); });
      }
      return out;
    }
    // Find the ONE main results container (searchResult / browseResult). Item
    // list, page count and result total are all read from here — never from the
    // whole page — so recommendation modules can't inflate any of them.
    function mainContainer(blobs) {
      let found = null;
      const walk = (o, d) => {
        if (found || !o || d > 14 || typeof o !== "object") return;
        if (Array.isArray(o)) { for (const v of o) { walk(v, d + 1); if (found) return; } return; }
        if (o.searchResult && Array.isArray(o.searchResult.itemStacks)) { found = o.searchResult; return; }
        if (o.browseResult && Array.isArray(o.browseResult.itemStacks)) { found = o.browseResult; return; }
        for (const k in o) { walk(o[k], d + 1); if (found) return; }
      };
      blobs.forEach(b => { if (!found) walk(b, 0); });
      return found;
    }
    function resultsFromStacks(blobs) {
      const c = mainContainer(blobs);
      if (c) return stacksItems(c);
      // fallback: any itemStacks (older/other layouts) — may include carousels
      const any = [];
      const walk = (o, d) => {
        if (!o || d > 14 || typeof o !== "object") return;
        if (Array.isArray(o)) { o.forEach(v => walk(v, d + 1)); return; }
        if (Array.isArray(o.itemStacks)) any.push(...stacksItems(o));
        for (const k in o) walk(o[k], d + 1);
      };
      blobs.forEach(b => walk(b, 0));
      return any;
    }

    // Is this an actual results page (search/browse grid present)? A 404 or any
    // non-results page has no main container — the engine uses this to detect
    // "walked past the last page" and end collection cleanly.
    function isResultsPage(doc) {
      doc = doc || document;
      return !!mainContainer(jsonBlobs(doc));
    }

    function scrapeList(doc, url) {
      doc = doc || document;
      const blobs = jsonBlobs(doc);
      const container = mainContainer(blobs);
      // On a 404 / "This page couldn't be found" page there's no results container;
      // don't scrape it (its recommendation carousels would be mistaken for results).
      if (!container) {
        const body = (doc.body && doc.body.textContent) || "";
        if (/couldn.t be found|page not found|sorry about that/i.test(body)) return [];
      }
      let raw = container ? stacksItems(container) : [];
      // Broad merge-all sweep is a FIRST-PAGE-ONLY last resort: on page 1 the user
      // is looking at real results, so if the container moved we still collect.
      // During pagination (page 2+) a missing container means a non-results page
      // (e.g. Walmart's 404, which ships ~100 recommendation products in its JSON)
      // — sweeping there would pollute the job with carousel items.
      let urlPage = 1;
      try { urlPage = parseInt(new URL(url || "").searchParams.get("page") || "1"); } catch (e) {}
      if (!raw.length && urlPage <= 1) {
        const arrays = [];
        blobs.forEach(b => collectProductArrays(b, 0, arrays));
        raw = [].concat.apply([], arrays);
      }
      let items = uniqBy(raw,
        it => String(it.usItemId || it.productId || it.id || it.canonicalUrl || it.name));
      const category = categoryOf(doc, brandOf(doc, null));
      let out = items.map(it => ({
        brand: brandOf(doc, it),
        name: it.name || it.title || it.productName || "",
        price: priceOf(it),
        price_was: wasPriceOf(it),
        product_url: abs(it.canonicalUrl || it.productPageUrl || it.productUrl || it.url || it.seoUrl),
        image_url: imageOf(it),
        category,
        department: it.department || "",
        id: String(it.usItemId || it.productId || it.id || it.itemId || ""),
        colorways: colorwaysOf(it),
      })).filter(r => r.name && r.product_url);

      // DOM fallback if embedded JSON yielded nothing (structure changed / SSR off)
      if (!out.length && doc.querySelectorAll) {
        const brand = brandOf(doc, null);
        doc.querySelectorAll('[data-item-id], [data-testid="list-view"] [role="group"], div[data-testid="item-stack"] > div').forEach(tile => {
          const a = tile.querySelector('a[href*="/ip/"]');
          if (!a) return;
          const name = (tile.querySelector('[data-automation-id="product-title"], [data-testid="product-title"], span.w_iUH7') || {}).textContent;
          const price = (tile.querySelector('[data-automation-id="product-price"], [data-testid="product-price"]') || {}).textContent;
          if (!name) return;
          out.push({
            brand,
            name: name.trim(),
            price: (price || "").trim(),
            product_url: abs(a.getAttribute("href")),
            image_url: (tile.querySelector("img") || {}).src || "",
            category, department: "",
            id: tile.getAttribute && (tile.getAttribute("data-item-id") || ""),
          });
        });
        out = uniqBy(out, r => r.id || r.product_url);
      }
      return out;
    }

    function domPageLinks(doc) {
      const nums = [...(doc.querySelectorAll
        ? doc.querySelectorAll('nav[aria-label*="pagination" i] a, nav[aria-label*="pagination" i] button, ' +
            '[data-testid*="pagination" i] a, [data-testid*="pagination" i] button, ul.paginator a')
        : [])].map(a => parseInt((a.textContent || "").trim())).filter(n => !isNaN(n));
      return nums.length ? Math.max(...nums) : 0;
    }

    function totalPages(doc) {
      doc = doc || document;
      const c = mainContainer(jsonBlobs(doc));
      if (c) {
        const n = findNumber(c, ["maxPage", "numberOfPages", "totalPages", "pageCount"]);
        if (n) return n;
        const total = findNumber(c, ["totalResultCount", "totalCount", "recordCount", "itemCount"]);
        const size = findNumber(c, ["pageSize", "resultsPerPage", "perPage"]);
        if (total && size) return Math.ceil(total / size);
      }
      // JSON gave no page info — try the rendered pagination links (1 2 3 …).
      const dom = domPageLinks(doc);
      if (dom) return dom;
      // Unknown. Do NOT guess "1": three different Walmart layouts have shipped
      // no detectable page info while having more pages, which silently dropped
      // everything past page 1. Returning null makes the engine keep walking
      // pages until a non-results page (404) ends the run cleanly.
      return null;
    }

    function nextPageUrl(url, page) {
      // Walmart uses ?page=N on both /browse and /search. Preserve all other params.
      const u = new URL(url);
      u.searchParams.set("page", String(page + 1));
      return u.toString();
    }

    // Total number of results the site reports (e.g. "Results ... (43)"). Used as
    // a completeness target so we keep paginating until we've collected them all,
    // even when the page-count hint is wrong.
    function resultCount(doc) {
      doc = doc || document;
      const c = mainContainer(jsonBlobs(doc));
      if (c) {
        const n = findNumber(c, ["totalResultCount", "recordCount", "totalCount", "itemCount", "count"]);
        if (n) return n;
      }
      // DOM fallback: the "(87)" in the results heading. Search pages say
      // "Results for ... (81)"; browse pages just say "<Category> in <Brand> (87)"
      // — accept any heading with a trailing count.
      const h = [...(doc.querySelectorAll ? doc.querySelectorAll("h1, h2, [data-testid='results-heading']") : [])]
        .map(e => e.textContent || "").find(t => /\(\d[\d,]*\)/.test(t));
      const m = h && h.match(/\((\d[\d,]*)\)/);
      return m ? parseInt(m[1].replace(/,/g, "")) : 0;
    }

    // A real composition contains a percentage or a known fiber word — this lets
    // us ignore "Material: Imported" / "Care: Machine washable" style noise.
    const FIBER = /\d\s*%|\b(cotton|polyester|spandex|elastane|rayon|viscose|modal|nylon|acrylic|wool|linen|lyocell|tencel|cashmere|silk|bamboo|polyamide|jersey|fleece)\b/i;
    const COMP_LABEL = /(?:fabric material|material|fabric content|fabric composition|composition|shell|body|fabric)/i;
    const NEXT_LABEL = /\s*(?:care|country of origin|country|size|fit|neckline|closure|features?|style|pattern|occasion)\b.*$/i;

    function cleanComp(s) { return String(s).replace(/\s+/g, " ").replace(NEXT_LABEL, "").trim(); }

    // Deep scan any JSON for a composition, in either shape:
    //   { name:"Material", value:"55% Cotton/45% Polyester" }   (spec pair)
    //   "Material: 55% Cotton/45% Polyester"                     (highlight bullet)
    function findComposition(obj, depth) {
      depth = depth || 0;
      if (obj == null || depth > 14) return "";
      if (typeof obj === "string") {
        const m = obj.match(new RegExp("^\\s*" + COMP_LABEL.source + "\\s*[:\\-]\\s*(.+)$", "i"));
        return (m && FIBER.test(m[1])) ? cleanComp(m[1]) : "";
      }
      if (Array.isArray(obj)) {
        for (const v of obj) { const r = findComposition(v, depth + 1); if (r) return r; }
        return "";
      }
      if (typeof obj === "object") {
        const nm = obj.name || obj.displayName || obj.key;
        const val = obj.value != null ? obj.value : obj.values;
        if (nm && val != null && new RegExp("^\\s*" + COMP_LABEL.source + "\\s*$", "i").test(String(nm))) {
          const sval = Array.isArray(val) ? val.join(", ") : String(val);
          if (FIBER.test(sval)) return cleanComp(sval);
        }
        for (const k in obj) { const r = findComposition(obj[k], depth + 1); if (r) return r; }
      }
      return "";
    }

    // Design feature labels to pull from the product page "Key item features".
    // These are literal on-page values, so they satisfy the provenance rule.
    const DESIGN_LABELS = ["Silhouette", "Fit", "Neckline", "Collar", "Sleeve Type",
      "Sleeve Length", "Sleeve Style", "Sleeves", "Sleeve", "Closure", "Length",
      "Hem", "Waist", "Rise", "Pockets", "Features", "Feature", "Style", "Design Details"];
    const SPEC_SKIP = /^(material|fabric|care|country|size|brand|gender|age|model|price|color|assembled|manufacturer|warranty|count|weight)/i;

    // Gather a label -> value map from a product page, from both shapes:
    //   { name:"Fit", value:"Relaxed" }   and   "Fit: Relaxed"  (highlight bullet)
    function collectSpecs(obj, out, depth) {
      depth = depth || 0;
      if (obj == null || depth > 16) return out;
      if (typeof obj === "string") {
        const m = obj.match(/^\s*([A-Za-z][A-Za-z /&-]{1,26}):\s*(.+\S)\s*$/);
        if (m) { const k = m[1].trim(), v = m[2].trim(); if (v.length <= 240 && !out[k]) out[k] = v; }
        return out;
      }
      if (Array.isArray(obj)) { for (const v of obj) collectSpecs(v, out, depth + 1); return out; }
      if (typeof obj === "object") {
        const nm = obj.name || obj.displayName || obj.key;
        const val = obj.value != null ? obj.value : obj.values;
        if (typeof nm === "string" && nm.length <= 28 && val != null) {
          const sval = Array.isArray(val) ? val.join(", ") : String(val);
          if (sval && sval.length <= 240 && !out[nm.trim()]) out[nm.trim()] = sval.trim();
        }
        for (const k in obj) collectSpecs(obj[k], out, depth + 1);
      }
      return out;
    }

    // All colour options from a product page's variant swatches.
    function extractColorways(blobs) {
      const colors = [];
      const seen = new Set();
      const add = c => { const s = String(c || "").trim(); if (s && !seen.has(s.toLowerCase())) { seen.add(s.toLowerCase()); colors.push(s); } };
      const walk = (o, d) => {
        if (!o || d > 16 || typeof o !== "object") return;
        if (Array.isArray(o)) { o.forEach(v => walk(v, d + 1)); return; }
        const nm = (o.name || o.type || o.id || o.variantType || "") + "";
        if (/colou?r/i.test(nm) && Array.isArray(o.variantList)) {
          o.variantList.forEach(v => add(v && (v.name || v.value || v.swatchName)));
        }
        for (const k in o) walk(o[k], d + 1);
      };
      blobs.forEach(b => walk(b, 0));
      return colors;
    }

    function pickDesign(specs) {
      const parts = [];
      for (const label of DESIGN_LABELS) {
        if (specs[label] && !SPEC_SKIP.test(label)) parts.push(`${label}: ${specs[label]}`);
      }
      return parts.join("; ").slice(0, 300);
    }
    function pickComposition(specs, blobs) {
      for (const key of ["Fabric Material", "Material", "Fabric Content", "Fabric Composition", "Composition", "Shell", "Fabric"]) {
        if (specs[key] && FIBER.test(specs[key])) return cleanComp(specs[key]);
      }
      for (const b of blobs) { const v = findComposition(b); if (v) return v; }
      return "";
    }

    // Fetch a product page and extract everything we can that's literally on it.
    // Returns { composition, colorways, design, reason }.
    async function fetchDetail(url) {
      const empty = r => ({ composition: "", colorways: "", design: "", reason: r });
      let html;
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 12000);
        try {
          const res = await fetch(url, { credentials: "include", signal: ctrl.signal });
          html = await res.text();
        } finally { clearTimeout(timer); }
      } catch (e) {
        return empty((e && e.name === "AbortError") ? "timeout" : "error");
      }
      if (/Robot or human|px-captcha|blocked/i.test(html) && !/__NEXT_DATA__/.test(html)) return empty("blocked");
      try {
        const doc = new DOMParser().parseFromString(html, "text/html");
        const blobs = jsonBlobs(doc);
        const specs = {};
        blobs.forEach(b => collectSpecs(b, specs));
        const composition = pickComposition(specs, blobs);
        const design = pickDesign(specs);
        const colorways = extractColorways(blobs).join("; ");
        return { composition, colorways, design, reason: composition ? "" : "not_found" };
      } catch (e) { return empty("error"); }
    }

    function context(doc) {
      doc = doc || document;
      return {
        brand: brandOf(doc, null),
        category: categoryOf(doc, brandOf(doc, null)),
        totalPages: totalPages(doc),
        page: parseInt(new URLSearchParams((doc.location || location).search).get("page") || "1"),
      };
    }

    // Clean 9-column workbook with embedded thumbnails (ExcelJS). Async because
    // it fetches image bytes. ctx carries { ExcelJS, fetchImage, onProgress }.
    async function buildWorkbook(items, ctx) {
      const WPBExcel = (typeof self !== "undefined" && self.WPBExcel) ||
        (typeof global !== "undefined" && global.WPBExcel) ||
        (typeof require !== "undefined" && require("./excel.js"));
      return WPBExcel.buildKnitWorkbook(items, ctx);
    }

    return {
      id: "walmart",
      label: "Walmart",
      match: url => /^https?:\/\/(www\.)?walmart\.com\/(browse|search|shop|cp|c\/)/i.test(url || ""),
      context, scrapeList, totalPages, resultCount, nextPageUrl, fetchDetail, buildWorkbook, isResultsPage,
      templateUrl: null,   // ExcelJS builds a fresh styled workbook; no template needed
      // internal, exposed for tests
      _priceOf: priceOf, _imageOf: imageOf, _resultsFromStacks: resultsFromStacks,
      _findComposition: findComposition, _collectSpecs: collectSpecs,
      _extractColorways: extractColorways, _pickDesign: pickDesign,
    };
  })();

  // ---------------------------------------------------------------------------
  // Registry
  // ---------------------------------------------------------------------------
  const ADAPTERS = [walmart];

  const SITES = {
    shared,
    adapters: ADAPTERS,
    active(url) { return ADAPTERS.find(a => a.match(url)) || null; },
    get(id) { return ADAPTERS.find(a => a.id === id) || null; },
  };

  if (typeof module !== "undefined" && module.exports) module.exports = SITES;
  root.SITES = SITES;
})(typeof self !== "undefined" ? self : this);
