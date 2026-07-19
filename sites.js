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

  // Fabric composition from free text (product descriptions etc). Accepts
  // "Material: 95% Polyester, 5% Spandex" label style AND a bare percentage
  // run "95% Polyester 5% Spandex"; validated by a fiber/percentage check so
  // "Material: Imported" style noise never passes.
  const FIBER_RE = /\d\s*%|\b(cotton|polyester|spandex|elastane|rayon|viscose|modal|nylon|acrylic|wool|linen|lyocell|tencel|cashmere|silk|bamboo|polyamide|jersey|fleece)\b/i;
  function compositionFromText(text) {
    // closing tags become newlines so list-item boundaries survive stripping —
    // otherwise "Material: 95% ...</li><li>Ruched sides" runs together.
    const t = String(text || "")
      .replace(/<\/(?:li|p|div|tr|h\d)>|<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]+/g, " ");
    // label style — separator optional so "COMPOSITION 95% COTTON" (no colon) works
    const trimTail = s => String(s)
      .replace(/\s*[—–|·].*$/, "")                                        // "… — Machine wash cold"
      .replace(/\s*\b(machine wash|hand wash|care|country of origin)\b.*$/i, "")
      .trim();
    const lab = t.match(/(?:fabric material|material|fabric content|fabric composition|composition|fabric)\s*[:\-]?\s*([^.;\n]{3,140})/i);
    if (lab && FIBER_RE.test(lab[1])) return trimTail(lab[1]);
    // bare percentage runs — scan ALL of them and take the first that NAMES a
    // fiber, so promo text like "20% off" earlier on the page can't shadow the
    // real "95% Cotton 5% Elastane" later on
    const FIBER_WORD = /\b(cotton|polyester|spandex|elastane|rayon|viscose|modal|nylon|acrylic|wool|linen|lyocell|tencel|cashmere|silk|bamboo|polyamide)\b/i;
    const runs = t.match(/\d{1,3}\s?%\s?[A-Za-z]+(?:[ ,/&+]+\d{1,3}\s?%\s?[A-Za-z]+)*/g) || [];
    const hit = runs.find(r => FIBER_WORD.test(r));
    return hit ? hit.trim() : "";
  }

  // Expose shared helpers so adapters (and tests) can reuse them.
  const shared = { jsonBlobs, sliceBalanced, looksProduct, collectProductArrays,
    findKeyedValue, findNumber, uniqBy, compositionFromText, FIBER_RE };

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
    // The breadcrumb leaf is the real category name ("Clothing / Fashion Brands /
    // Time and Tru / Time and Tru Tops & Tees" -> "Time and Tru Tops & Tees").
    function breadcrumbLeaf(doc) {
      let trail = [];
      (doc.querySelectorAll ? doc.querySelectorAll('script[type="application/ld+json"]') : []).forEach(s => {
        if (trail.length) return;
        let d; try { d = JSON.parse(s.textContent); } catch (e) { return; }
        [].concat(d && d["@graph"] ? d["@graph"] : d).forEach(n => {
          if (n && /BreadcrumbList/i.test([].concat(n["@type"] || []).join(","))) {
            trail = [].concat(n.itemListElement || [])
              .map(e => (e && (e.name || (e.item && e.item.name))) || "").filter(Boolean);
          }
        });
      });
      if (!trail.length && doc.querySelector) {
        const nav = doc.querySelector('nav[aria-label*="readcrumb" i], [class*="readcrumb" i]');
        if (nav) trail = [...nav.querySelectorAll("a,li,span")]
          .map(a => (a.textContent || "").replace(/\s+/g, " ").trim()).filter(Boolean);
      }
      trail = trail.filter(t => t && !/^home$/i.test(t));
      return trail.length ? trail[trail.length - 1] : "";
    }
    // Category: prefer the breadcrumb leaf (the true category — the H1 on a
    // filtered brand shelf is often just "115 results"). Fall back to the H1
    // with the brand stripped, but never return a bare result-count.
    function categoryOf(doc, brand) {
      const leaf = breadcrumbLeaf(doc);
      if (leaf) return leaf;
      const h1 = (doc.querySelector && doc.querySelector("h1")) || {};
      let t = (h1.textContent || "").replace(/\(\d[\d,]*\).*/, "").trim();
      t = t.split("|")[0].trim();                                    // drop "... | Walmart" title tail
      t = t.replace(/\s+in\s+[A-Za-z][^,]*$/i, "").trim();          // drop "... in <brand/dept>"
      if (/^\d[\d,]*\s*(?:results?|items?|products?)$/i.test(t)) return "";   // "115 results" is not a category
      const b = String(brand || "").trim();
      if (b && t.toLowerCase().startsWith(b.toLowerCase() + " ")) { // drop leading brand
        t = t.slice(b.length).trim();
      }
      return t;
    }
    // Best-effort colorways from the list JSON (variant swatches). Full color
    // lists usually live on the product page; this catches what the shelf ships.
    // Normalize a colour name: collapse spaces and drop trailing punctuation so
    // "Dark Navy." / "Dark Navy.." don't survive as separate colours.
    const cleanColor = s => String(s || "").replace(/\s+/g, " ").replace(/[.…,;]+\s*$/, "").trim();
    function dedupeColors(names) {
      const seen = new Set(), out = [];
      names.forEach(s => { const c = cleanColor(s); const k = c.toLowerCase(); if (c && !seen.has(k)) { seen.add(k); out.push(c); } });
      return out;
    }
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
      return dedupeColors(names).join("; ");
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

    // Base design categories to pull from "Key item features". Matched as a WORD
    // ANYWHERE in the label, so Walmart's AI-generated descriptive labels map to
    // the base category: "Relaxed Fit" -> Fit, "Trendy Features" -> Features,
    // "Functional Closure" -> Closure, "Practical Pockets" -> Pockets, etc.
    // Order matters: multi-word / more specific categories first.
    const DESIGN_CATS = ["Design Details", "Sleeve Length", "Sleeve Type", "Sleeve Style",
      "Silhouette", "Neckline", "Collar", "Sleeves", "Sleeve", "Closure", "Waistband",
      "Waist", "Rise", "Hemline", "Hem", "Pockets", "Pocket", "Features", "Feature",
      "Fit", "Hood", "Length"];
    const SPEC_SKIP = /^(?:material|fabric|care|country|size|brand|gender|age|model|price|color|assembled|manufacturer|warranty|count|weight|pack|dimension)/i;
    function designCat(label) {
      for (const cat of DESIGN_CATS) {
        if (new RegExp("\\b" + cat.replace(/\s+/g, "\\s+") + "\\b", "i").test(label)) {
          if (/^feature/i.test(cat)) return "Features";
          if (/^pocket/i.test(cat)) return "Pockets";
          if (/^sleeve/i.test(cat)) return "Sleeves";
          return cat;
        }
      }
      return "";
    }

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
      const add = c => { const s = cleanColor(c); if (s && !seen.has(s.toLowerCase())) { seen.add(s.toLowerCase()); colors.push(s); } };
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
      const parts = [], used = new Set();
      for (const label in specs) {
        if (SPEC_SKIP.test(label)) continue;          // material / care / size / colour / …
        const cat = designCat(label);
        if (!cat || used.has(cat.toLowerCase())) continue;
        let v = String(specs[label]).replace(/\s+/g, " ").trim();
        if (v.length > 90) v = v.slice(0, 90).replace(/[\s,;]+\S*$/, "") + "…";   // trim long AI blurbs
        used.add(cat.toLowerCase());
        parts.push(`${cat}: ${v}`);
      }
      return parts.join("; ").slice(0, 400);
    }
    function pickComposition(specs, blobs) {
      // any spec whose LABEL names a composition field (Material / Fabric /
      // Composition / Shell / Body — incl. "Material Composition") and whose value
      // actually lists fibers.
      for (const label in specs) {
        if (COMP_LABEL.test(label) && FIBER.test(specs[label])) return cleanComp(specs[label]);
      }
      for (const b of blobs) { const v = findComposition(b); if (v) return v; }
      return "";
    }
    // "Key item features" bullets (Material / Fit / Neckline / Closure / Pockets /
    // Features …) are server-rendered as <li>Label: Value</li>. Some products
    // expose these ONLY in the DOM, not the embedded JSON — so read them too,
    // which recovers both the composition (Material) and the design attributes.
    function collectSpecsFromDom(doc, out) {
      if (!doc || !doc.querySelectorAll) return out;
      doc.querySelectorAll("li").forEach(el => {
        const t = (el.textContent || "").replace(/\s+/g, " ").trim();
        if (!t || t.length > 200) return;
        const m = t.match(/^([A-Za-z][A-Za-z /&-]{1,26}):\s*(.+\S)$/);
        if (m && !out[m[1].trim()]) out[m[1].trim()] = m[2].trim();
      });
      return out;
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
        collectSpecsFromDom(doc, specs);   // recover Material/Fit/Neckline/… from the visible bullets
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
      multiBrand: true,   // a retailer of many brands — show Retailer + Brand separately
      // Any walmart.com page routes to the full Walmart engine (detail collection).
      // The content script only injects on listing paths (manifest), so this can't
      // fire on product/cart pages; being permissive means a listing on a path the
      // old narrow regex missed (e.g. brand shelves) no longer falls to "generic".
      match: url => /^https?:\/\/(www\.)?walmart\.com\//i.test(url || ""),
      context, scrapeList, totalPages, resultCount, nextPageUrl, fetchDetail, buildWorkbook, isResultsPage,
      templateUrl: null,   // ExcelJS builds a fresh styled workbook; no template needed
      // internal, exposed for tests
      _priceOf: priceOf, _imageOf: imageOf, _resultsFromStacks: resultsFromStacks,
      _findComposition: findComposition, _collectSpecs: collectSpecs,
      _extractColorways: extractColorways, _pickDesign: pickDesign,
      _categoryOf: categoryOf, _context: context,
      _collectSpecsFromDom: collectSpecsFromDom, _pickComposition: pickComposition,
      _colorwaysOf: colorwaysOf, _designCat: designCat,
    };
  })();

  // ---------------------------------------------------------------------------
  // Generic adapter — DOM-heuristic fallback for sites with no dedicated
  // adapter. Trades accuracy for zero per-site setup: it finds repeated
  // "product tile" elements (has a price + an image + a link, and at least a
  // few near-identical siblings so a one-off promo price can't be mistaken for
  // a listing) and reads only what's literally on the shelf — name, price,
  // image, URL. It never guesses brand/category/colorway/composition/design;
  // those stay "정보 확인" (excel.js's existing not-found rule), because those
  // fields need per-site page structure knowledge a generic scan can't have.
  //
  // Scope is controlled by manifest.json, not by this adapter: match() is a
  // catch-all (true) so it only ever runs on domains manifest.json already
  // allow-listed (content scripts don't load on unlisted domains). Adding a
  // new site with basic-field support = one manifest.json pattern, no code.
  // ---------------------------------------------------------------------------
  const generic = (function () {
    const PRICE_RE = /(?:[$₩€£¥]\s?\d[\d,]*(?:\.\d{1,2})?|\d[\d,]*(?:\.\d{1,2})?\s?(?:원|USD|EUR|GBP))/;
    const MAX_TILES = 400;

    const textOf = el => ((el && el.textContent) || "").replace(/\s+/g, " ").trim();
    const abs = (href, base) => { try { return new URL(href, base).toString(); } catch (e) { return href || ""; } };

    function firstPrice(text) { const m = text.match(PRICE_RE); return m ? m[0] : ""; }

    // Nearest ancestor (including self) of `el` that contains BOTH an <img>
    // and an <a href>, searched within a shallow depth so we land on the tile,
    // not the whole page body.
    function tileAncestor(el, maxDepth) {
      let node = el, depth = 0;
      while (node && depth <= maxDepth) {
        const hasImg = !!(node.querySelector && node.querySelector("img"));
        const hasLink = (node.tagName === "A" && node.getAttribute("href")) ||
          !!(node.querySelector && node.querySelector("a[href]"));
        if (hasImg && hasLink) return node;
        node = node.parentElement;
        depth++;
      }
      return null;
    }

    // A crude structural signature used to check that a tile isn't a one-off:
    // real listings repeat the same tag+class shape multiple times.
    function signature(el) {
      const cls = el.className && typeof el.className === "string"
        ? el.className.trim().split(/\s+/).slice(0, 3).sort().join(".") : "";
      return el.tagName + "|" + cls + "|" + (el.parentElement ? el.parentElement.tagName : "");
    }

    // Recommendation / cross-sell modules ("Complete the look", "You may also
    // like", "Looks we love", SFCC Einstein carousels, "Recently viewed", …)
    // repeat the same tile shape as the real grid and would inflate the export.
    // Exclude any tile whose ancestor container is semantically a recommendation
    // — by class/id/aria/data attribute or a heading right above it. Kept to
    // specific reco phrases so a real category (e.g. "Trending") isn't dropped.
    const RECO_RE = /recommend|related[\s_-]?product|you[\s_-]?may[\s_-]?(?:also[\s_-]?)?like|complete[\s_-]?the[\s_-]?look|looks?[\s_-]?we[\s_-]?love|recently[\s_-]?viewed|also[\s_-]?(?:bought|viewed|like)|einstein|cross[\s_-]?sell|up[\s_-]?sell|shop[\s_-]?the[\s_-]?look|you[\s_-]?might[\s_-]?(?:also[\s_-]?)?like|customers[\s_-]?also/i;
    function inRecommendation(tile) {
      let node = tile;
      for (let d = 0; node && d < 12; d++) {
        const attr = (typeof node.className === "string" ? node.className : "") + " " + (node.id || "") + " " +
          (node.getAttribute ? ((node.getAttribute("aria-label") || "") + " " + (node.getAttribute("data-component") || "") +
            " " + (node.getAttribute("data-section") || "") + " " + (node.getAttribute("data-analytics") || "")) : "");
        if (RECO_RE.test(attr)) return true;
        let prev = node.previousElementSibling, hops = 0;
        while (prev && hops++ < 3) {
          if (/^H[1-6]$/.test(prev.tagName || "") && RECO_RE.test(prev.textContent || "")) return true;
          prev = prev.previousElementSibling;
        }
        node = node.parentElement;
      }
      return false;
    }

    function bestImage(el) {
      const img = el.querySelector && el.querySelector("img");
      if (!img) return "";
      const src = img.getAttribute("src") || img.getAttribute("data-src") || "";
      if (src && !/^data:/i.test(src)) return src;
      const srcset = img.getAttribute("data-srcset") || img.getAttribute("srcset") || "";
      const m = srcset.match(/(\S+)\s*(?:\d|,|$)/);
      return m ? m[1] : (src || "");
    }

    function bestUrl(el, base) {
      const a = el.tagName === "A" ? el : (el.querySelector && el.querySelector("a[href]"));
      return a ? abs(a.getAttribute("href"), base) : "";
    }

    // Name: prefer a heading/title-class element (the explicit product-name
    // convention most listing markup uses), then image alt text (sites that
    // skip a name element but write a specific alt), then the link's
    // title/aria-label, then the longest remaining text run that isn't the
    // price. Heading beats alt because alt is often a generic repeated label
    // ("Product photo") while a title/name-class element is usually the one
    // place the specific product name actually lives.
    function bestName(el, priceText) {
      const heading = el.querySelector && el.querySelector(
        'h1,h2,h3,h4,h5,h6,[class*="title" i],[class*="name" i],[class*="heading" i]');
      const ht = heading && textOf(heading);
      if (ht && ht.length >= 3 && ht.length <= 200 && ht !== priceText) return ht;

      const img = el.querySelector && el.querySelector("img");
      const alt = img && (img.getAttribute("alt") || "").trim();
      if (alt && alt.length >= 3 && alt.length <= 150 && !/^(image|photo|thumbnail|product|products|img|picture)$/i.test(alt)) return alt;

      const a = el.tagName === "A" ? el : (el.querySelector && el.querySelector("a[href]"));
      const label = a && ((a.getAttribute("title") || a.getAttribute("aria-label") || "").trim());
      if (label && label.length >= 3) return label;

      // fallback: longest text node in the tile, excluding the price text
      let best = "";
      (el.querySelectorAll ? el.querySelectorAll("*") : []).forEach(n => {
        if (n.children && n.children.length) return;   // only leaf-ish nodes
        const t = textOf(n);
        if (t && t !== priceText && !PRICE_RE.test(t) && t.length > best.length && t.length <= 200) best = t;
      });
      return best;
    }

    // Products from schema.org JSON-LD (ItemList / Product). Many storefronts
    // (Salesforce Commerce, Magento, custom) server-render this, giving reliable
    // name + url (+ often image/price) with no markup guessing. Currency symbol
    // is derived from priceCurrency when the price is a bare number.
    const CUR = { USD: "$", CAD: "$", AUD: "$", NZD: "$", GBP: "£", EUR: "€", JPY: "¥", KRW: "₩" };
    function priceFromOffers(offers) {
      const o = Array.isArray(offers) ? offers[0] : (offers || {});
      const spec = o.priceSpecification || {};
      const p = o.price != null ? o.price : (o.lowPrice != null ? o.lowPrice : spec.price);
      if (p == null || p === "") return "";
      const s = String(p);
      if (/^[^\d]/.test(s)) return s;                 // already has a symbol
      const cur = o.priceCurrency || spec.priceCurrency || "";
      return (CUR[cur] || (cur ? cur + " " : "")) + s;
    }
    function firstImg(img) { return Array.isArray(img) ? (img[0] && (img[0].url || img[0]) || "") : (img && (img.url || img) || ""); }
    function jsonLdProducts(doc, base) {
      const out = [];
      (doc.querySelectorAll ? doc.querySelectorAll('script[type="application/ld+json"]') : []).forEach(s => {
        let data; try { data = JSON.parse(s.textContent); } catch (e) { return; }
        const nodes = Array.isArray(data) ? data : (data["@graph"] ? data["@graph"] : [data]);
        nodes.forEach(node => {
          if (!node || typeof node !== "object") return;
          const type = [].concat(node["@type"] || []).join(",");
          if (/ItemList/i.test(type) && Array.isArray(node.itemListElement)) {
            node.itemListElement.forEach(li => {
              const it = (li && li.item) || li || {};
              const url = it.url || it["@id"] || (typeof li.url === "string" ? li.url : "");
              const name = it.name || "";
              if (!url && !name) return;
              out.push({ url: abs(url, base), name: String(name),
                image: firstImg(it.image), price: priceFromOffers(it.offers) });
            });
          } else if (/(^|,)Product(,|$)/i.test(type) && node.name) {
            const url = node.url || node["@id"] || base;
            out.push({ url: abs(url, base), name: String(node.name),
              image: firstImg(node.image), price: priceFromOffers(node.offers) });
          }
        });
      });
      return out;
    }

    function scrapeList(doc, url) {
      doc = doc || document;
      if (!doc.querySelectorAll) return [];
      const base = url || (doc.location && doc.location.href) || "";

      // 1) price-bearing leaf-ish elements (own text matches, few/no element children)
      const priceLeaves = [];
      doc.querySelectorAll("*").forEach(el => {
        if (priceLeaves.length >= MAX_TILES * 4) return;   // hard cap, pathological pages
        if (el.children && el.children.length > 2) return;
        const t = textOf(el);
        if (t.length <= 40 && PRICE_RE.test(t)) priceLeaves.push(el);
      });

      // 2) climb to the tile (has image + link), dedupe by node
      const tiles = new Map();   // node -> priceText
      for (const leaf of priceLeaves) {
        const tile = tileAncestor(leaf, 6);
        if (tile && !tiles.has(tile)) tiles.set(tile, firstPrice(textOf(leaf)));
      }

      // 3) require repetition — reject signatures with < 3 members (promo one-offs)
      const bySig = new Map();
      tiles.forEach((price, tile) => {
        const sig = signature(tile);
        (bySig.get(sig) || bySig.set(sig, []).get(sig)).push(tile);
      });
      const validTiles = new Set();
      bySig.forEach(list => { if (list.length >= 3) list.forEach(t => validTiles.add(t)); });

      // 4) extract, dedupe by URL
      const seen = new Set();
      const out = [];
      for (const [tile, price] of tiles) {
        if (!validTiles.has(tile) || out.length >= MAX_TILES) continue;
        if (inRecommendation(tile)) continue;   // drop recommendation/cross-sell carousels
        const product_url = bestUrl(tile, base);
        if (!product_url || seen.has(product_url)) continue;
        seen.add(product_url);
        // keep the tile even if the name is weak/empty (generic alt) — JSON-LD
        // below may supply the real name for this URL; unnamed rows are dropped
        // at the end.
        out.push({
          brand: "", category: "", department: "",
          name: bestName(tile, price) || "", price, product_url,
          image_url: bestImage(tile),
          id: product_url,
        });
      }

      // 5) merge JSON-LD products: fill fields on matched URLs, add any the DOM
      //    scan missed. Keyed by pathname so absolute/relative forms unify.
      const pathKey = u => { try { return new URL(u, base).pathname.replace(/\/$/, ""); } catch (e) { return u; } };
      const byPath = new Map(out.map(r => [pathKey(r.product_url), r]));
      jsonLdProducts(doc, base).forEach(p => {
        if (!p.url || !/\/[a-z0-9]/i.test(p.url)) return;
        const key = pathKey(p.url);
        const existing = byPath.get(key);
        if (existing) {
          if (!existing.name && p.name) existing.name = p.name;
          if (!existing.price && p.price) existing.price = p.price;
          if (!existing.image_url && p.image) existing.image_url = p.image;
        } else if (p.name && out.length < MAX_TILES) {
          const rec = { brand: "", category: "", department: "",
            name: p.name, price: p.price || "", product_url: p.url,
            image_url: p.image || "", id: p.url };
          byPath.set(key, rec); out.push(rec);
        }
      });
      // drop any tile that never got a name (weak DOM match with no JSON-LD hit)
      return out.filter(r => r.name);
    }

    // Best-effort page-count / result-count text scan; both are display hints
    // only — the engine treats an unknown (null/0) as "probe the next page and
    // stop when nothing new comes back", so a wrong guess here can't drop pages.
    function totalPages(doc) {
      doc = doc || document;
      const nums = [...(doc.querySelectorAll
        ? doc.querySelectorAll('nav[aria-label*="pagination" i] a, nav[aria-label*="pagination" i] button, ' +
            '[class*="pagination" i] a, [class*="pagination" i] button, a[rel="next"]')
        : [])].map(a => parseInt((a.textContent || "").trim())).filter(n => !isNaN(n) && n < 10000);
      return nums.length ? Math.max(...nums) : null;
    }
    function resultCount(doc) {
      doc = doc || document;
      const body = (doc.body && doc.body.textContent) || "";
      const m = body.match(/\b(\d[\d,]{1,6})\s*(?:results?|items?|products?)\b/i);
      return m ? parseInt(m[1].replace(/,/g, "")) : 0;
    }
    function nextPageUrl(url, page) {
      try {
        const u = new URL(url);
        u.searchParams.set("page", String(page + 1));
        return u.toString();
      } catch (e) { return null; }
    }
    function isResultsPage(doc) {
      doc = doc || document;
      const body = (doc.body && doc.body.textContent) || "";
      return !/couldn.t be found|page not found|404 error|sorry.{0,20}that/i.test(body);
    }

    async function buildWorkbook(items, ctx) {
      const WPBExcel = (typeof self !== "undefined" && self.WPBExcel) ||
        (typeof global !== "undefined" && global.WPBExcel) ||
        (typeof require !== "undefined" && require("./excel.js"));
      return WPBExcel.buildKnitWorkbook(items, ctx);
    }

    function context(doc) {
      doc = doc || document;
      const h1 = (doc.querySelector && doc.querySelector("h1")) || {};
      return {
        brand: "", category: (h1.textContent || "").trim().slice(0, 80),
        totalPages: totalPages(doc),
        page: parseInt(new URLSearchParams((doc.location || location).search).get("page") || "1"),
      };
    }

    return {
      id: "generic",
      label: "일반 사이트 (기본 정보만)",
      match: () => true,   // catch-all; manifest.json's host allowlist is the real gate
      context, scrapeList, totalPages, resultCount, nextPageUrl, buildWorkbook, isResultsPage,
      templateUrl: null,
      // fetchDetail intentionally omitted — content.js skips detail collection
      // gracefully when an adapter doesn't implement it.
      _tileAncestor: tileAncestor, _signature: signature, _bestName: bestName,
      _jsonLdProducts: jsonLdProducts, _inRecommendation: inRecommendation,
    };
  })();

  // ---------------------------------------------------------------------------
  // Shopify adapter — covers every Shopify storefront (Edikted and thousands of
  // other fashion shops) in one adapter. Detected by page content (Shopify CDN
  // markers), not by domain, so any allow-listed Shopify site upgrades from
  // generic to this automatically.
  //
  // List phase reads the RENDERED page (so storefront filters the user applied
  // are respected), then detail phase uses Shopify's public per-product JSON
  // endpoint ({product_url}.js) for colorways (Color option values), fabric
  // composition (from the description, fiber-validated), brand (vendor) and
  // the original price (compare_at_price).
  // ---------------------------------------------------------------------------
  const shopify = (function () {
    const stripVariant = u => { try { const x = new URL(u); x.search = ""; x.hash = ""; return x.toString(); } catch (e) { return u; } };

    function match(url, doc) {
      if (!doc || !doc.querySelector) return false;
      return !!doc.querySelector(
        'link[href*="cdn.shopify.com"], script[src*="cdn.shopify.com"], ' +
        'link[href*="/cdn/shop/"], script[src*="/cdn/shop/"], ' +
        '#shopify-features, meta[name="shopify-checkout-api-token"]');
    }

    // Category from the collection handle in the URL: /collections/mini-dresses
    // -> "Mini Dresses". This is literal site structure, not a guess.
    function categoryFromUrl(url) {
      const m = String(url || "").match(/\/collections\/([^/?#]+)/i);
      if (!m) return "";
      return decodeURIComponent(m[1]).replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
    }

    function scrapeList(doc, url) {
      doc = doc || document;
      const category = categoryFromUrl(url);
      // 1) generic tile detection, kept only for real product links
      let items = generic.scrapeList(doc, url)
        .filter(r => /\/products\//i.test(r.product_url))
        .map(r => ({ ...r, category, product_url: stripVariant(r.product_url), id: stripVariant(r.product_url) }));
      // 2) fallback: walk product-link anchors directly (themes whose price
      //    element sits outside what the generic climb reaches)
      if (!items.length && doc.querySelectorAll) {
        const seen = new Set();
        doc.querySelectorAll('a[href*="/products/"]').forEach(a => {
          const href = stripVariant(new URL(a.getAttribute("href"), url || "https://x/").toString());
          if (seen.has(href)) return;
          // climb a little to find the card that holds image + price text
          let node = a, img = null, price = "";
          for (let d = 0; d < 4 && node; d++, node = node.parentElement) {
            if (!img) img = node.querySelector && node.querySelector("img");
            if (!price) { const m = ((node.textContent || "").match(/(?:[$₩€£¥]\s?\d[\d,]*(?:\.\d{1,2})?)/) || [])[0]; if (m) price = m; }
            if (img && price) break;
          }
          const name = (a.getAttribute("title") || (img && img.getAttribute("alt")) || (a.textContent || "")).replace(/\s+/g, " ").trim();
          if (!name || name.length < 3 || !price) return;
          seen.add(href);
          items.push({ brand: "", category, department: "", name: name.slice(0, 200), price,
            product_url: href, image_url: img ? (img.getAttribute("src") || img.getAttribute("data-src") || "") : "", id: href });
        });
      }
      return items;
    }

    // Shopify's public product JSON: {product_url}.js → title, vendor, options
    // (Color values = full colorway list), price/compare_at_price (cents),
    // description HTML (composition usually lives there as "Material: ...").
    function parseProductJson(p, listPrice) {
      const opt = (p.options || []).find(o => /colou?r/i.test((o && (o.name || o)) + ""));
      const colorways = opt ? (opt.values || []).join("; ") : "";
      const composition = compositionFromText(p.description || p.body_html || "");
      let price_was = "";
      if (p.compare_at_price && p.price && p.compare_at_price > p.price) {
        const sym = (String(listPrice || "").match(/^[^\d\s.,]+/) || ["$"])[0];
        price_was = sym + (p.compare_at_price / 100).toFixed(2);
      }
      return {
        composition, colorways, design: "",
        brand: p.vendor || "",
        category: p.type || "",
        price_was,
        reason: composition ? "" : "not_found",
      };
    }

    async function fetchDetail(url) {
      const empty = r => ({ composition: "", colorways: "", design: "", reason: r });
      let jsUrl;
      try {
        const u = new URL(url); u.search = ""; u.hash = "";
        if (!/\/products\//i.test(u.pathname)) return empty("not_found");
        jsUrl = u.origin + u.pathname.replace(/\/$/, "") + ".js";
      } catch (e) { return empty("error"); }
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 12000);
        let res;
        try { res = await fetch(jsUrl, { credentials: "include", signal: ctrl.signal }); }
        finally { clearTimeout(timer); }
        if (!res.ok) return empty(res.status === 404 ? "not_found" : "blocked");
        return parseProductJson(await res.json(), "");
      } catch (e) {
        return empty((e && e.name === "AbortError") ? "timeout" : "error");
      }
    }

    function context(doc) {
      doc = doc || document;
      const url = (doc.location && doc.location.href) || (typeof location !== "undefined" ? location.href : "");
      return {
        brand: "",
        category: categoryFromUrl(url),
        totalPages: generic.totalPages(doc),
        page: parseInt(new URLSearchParams((doc.location || location).search).get("page") || "1"),
      };
    }

    return {
      id: "shopify",
      label: "Shopify 스토어",
      match, context, scrapeList,
      totalPages: generic.totalPages,
      resultCount: generic.resultCount,
      nextPageUrl: generic.nextPageUrl,       // Shopify collections use ?page=N and keep filter params
      isResultsPage: generic.isResultsPage,
      fetchDetail, buildWorkbook: generic.buildWorkbook,
      templateUrl: null,
      _parseProductJson: parseProductJson, _categoryFromUrl: categoryFromUrl,
    };
  })();

  // ---------------------------------------------------------------------------
  // Cotton On adapter — cottonon.com runs Salesforce Commerce Cloud (SFCC /
  // Demandware): product URLs look like
  //   /AU/hold-me-cami/2060406-02.html?dwvar_..._color=...&cgid=womens-sleeveless-tops
  // The URL itself carries the product name (slug) and category (cgid), so the
  // list phase can fill both without guessing at markup. The detail phase reads
  // the PDP's JSON-LD (brand/name) and SFCC's standard variationAttributes
  // JSON (colour + size lists), plus a fiber-validated composition scan.
  // ---------------------------------------------------------------------------
  const cottonon = (function () {
    const titleCase = s => String(s || "").replace(/-/g, " ").trim().replace(/\b\w/g, c => c.toUpperCase());

    // "/AU/hold-me-cami/2060406-02.html" -> "Hold Me Cami"
    function nameFromUrl(url) {
      try {
        const segs = new URL(url).pathname.split("/").filter(Boolean);
        const htmlIdx = segs.findIndex(s => /\.html$/i.test(s));
        if (htmlIdx > 0) {
          const slug = segs[htmlIdx - 1];
          if (slug && slug.length > 2 && !/^[A-Z]{2}$/i.test(slug)) return titleCase(slug);
        }
        // fallback: slug-pid baked into the .html segment ("hold-me-cami-2060406.html")
        if (htmlIdx >= 0) {
          const base = segs[htmlIdx].replace(/\.html$/i, "").replace(/-?\d[\d-]*$/, "");
          if (base.length > 2) return titleCase(base);
        }
      } catch (e) {}
      return "";
    }
    function categoryFromUrl(url) {
      try {
        const u = new URL(url);
        const cgid = u.searchParams.get("cgid") || "";
        if (cgid) return titleCase(cgid);
        // Sub-brand / gym listing URLs carry no cgid — derive the category from
        // the last path segment (e.g. /AU/co/women/womens-activewear/womens-gym-tops/
        // -> "Womens Gym Tops"). Skip PDP urls, where that segment is the product
        // slug (product name), not a category.
        const segs = u.pathname.split("/").filter(Boolean);
        if (segs.some(s => /\.html$/i.test(s))) return "";      // PDP -> not a category
        const cat = segs.filter(s => !/^[a-z]{2}$/i.test(s) && s.toLowerCase() !== "co");
        const last = cat[cat.length - 1];
        return last && last.length > 2 ? titleCase(last) : "";
      } catch (e) { return ""; }
    }

    function scrapeList(doc, url) {
      const items = generic.scrapeList(doc, url);
      // one category for the whole page = what the user is browsing (breadcrumb/
      // H1), not each product's primary cgid (which is often a narrower facet).
      const pageCat = listingCategory(doc, url);
      for (const r of items) {
        const slugName = nameFromUrl(r.product_url);
        if (slugName) r.name = slugName;           // canonical, beats scraped tile text
        r.category = pageCat || categoryFromUrl(r.product_url) || categoryFromUrl(url);
        // colours from this tile's swatch links (live listing DOM only)
        const c = colorsForBase(doc, productBase(r.product_url));
        if (c.count > 1) { r.color_count = c.count; if (c.colorways) r.colorways = c.colorways; }
      }
      return items.filter(r => /\.html/i.test(r.product_url));   // keep real PDP links only
    }

    // SFCC embeds the product model with variationAttributes:
    //   [{ attributeId:"color", values:[{ displayValue:"Black" }, ...] },
    //    { attributeId:"size",  values:[{ displayValue:"XS" }, ...] }]
    function variationValues(obj, attrRe, acc, depth) {
      depth = depth || 0; acc = acc || [];
      if (!obj || depth > 14 || typeof obj !== "object") return acc;
      if (Array.isArray(obj)) { obj.forEach(v => variationValues(v, attrRe, acc, depth + 1)); return acc; }
      const attr = obj.attributeId || obj.id || obj.attribute || "";
      if (attrRe.test(String(attr)) && Array.isArray(obj.values)) {
        obj.values.forEach(v => {
          const d = v && (v.displayValue || v.value || v.name);
          if (d && !acc.includes(String(d))) acc.push(String(d));
        });
      }
      for (const k in obj) variationValues(obj[k], attrRe, acc, depth + 1);
      return acc;
    }

    // Colour label extractor. cottonon.com PDPs show the selected colour as a
    // visible "Colour: cherry dream" text label (confirmed live via
    // diagnose-color.js — one colour per PDP URL). Grab the name after the
    // label and trim once the next UI section begins (Size/Select/Add/etc.),
    // since page.textContent runs sections together with no separator.
    function colourFromText(text) {
      const m = String(text || "").match(/\bColou?r\s*:?\s*([A-Za-z][A-Za-z0-9 .&/'’-]{1,38})/i);
      if (!m) return "";
      let v = m[1]
        // cut at the first word that begins the next section on the page
        .replace(/\s+(?:Size|Select|Add|Please|Choose|Quantity|Qty|Online|In\s?store|Find|Delivery|Shipping|Details|Description|Composition|Material|Care|Reviews?|Share|Wishlist|Sold|Available|Low\s?stock)\b.*$/i, "")
        .replace(/\s+/g, " ").trim();
      // a real colour name is a few words at most; guard against runaway grabs
      if (!v || v.split(" ").length > 5) return "";
      return v;
    }

    // --- Colour variants ------------------------------------------------------
    // On a Cotton On PDP every colour is its OWN PDP that shares the product slug
    // (/AU/<slug>/<pid>.html), shown as a row of swatch thumbnails. Counting the
    // distinct sibling pids under this slug gives the true colour count; the
    // swatch's aria-label / title / img-alt gives the names when present. This is
    // far more reliable than the visible "Colour: <name>" label, which Cotton On
    // renders client-side (so it's absent from the fetched HTML).
    function slugFromUrl(url) {
      try {
        const segs = new URL(url).pathname.split("/").filter(Boolean);
        const i = segs.findIndex(s => /\.html$/i.test(s));
        if (i > 0) return segs[i - 1];
        return segs.slice(-2, -1)[0] || "";
      } catch (e) { return ""; }
    }
    // Turn a swatch label into a bare colour name, dropping any product-name
    // prefix ("Original Graphic Tee - Glass Cherries / White" -> "Glass ...").
    function cleanColourName(raw, productName) {
      let s = String(raw || "").replace(/\s+/g, " ").trim();
      if (!s) return "";
      const dash = s.split(/\s[-–—]\s/);
      if (dash.length > 1) s = dash[dash.length - 1].trim();
      const inm = s.match(/\bin\s+([A-Za-z][A-Za-z0-9 .&/'’-]{1,38})$/i);
      if (inm) s = inm[1].trim();
      if (productName && s.toLowerCase() === String(productName).toLowerCase()) return "";
      if (!/[A-Za-z]/.test(s) || s.length > 40 || /\d{4,}/.test(s)) return "";  // reject SKUs/junk
      return s;
    }
    function colorSwatches(doc, slug, productName) {
      const out = []; const seen = new Set();
      if (!doc.querySelectorAll || !slug) return out;
      doc.querySelectorAll(`a[href*="/${slug}/"]`).forEach(a => {
        const href = a.getAttribute("href") || "";
        const m = href.match(/\/(\d[\w-]*)\.html/i);   // sibling pid = one colour
        if (!m || seen.has(m[1])) return; seen.add(m[1]);
        const img = a.querySelector && a.querySelector("img");
        const rawName = a.getAttribute("aria-label") || a.getAttribute("title") ||
          (img && (img.getAttribute("alt") || img.getAttribute("title"))) || "";
        out.push({ pid: m[1], name: cleanColourName(rawName, productName) });
      });
      return out;
    }

    // Colour variants from the LIVE listing (unlike the PDP fetch, the listing
    // DOM is JS-rendered, so a tile's colour swatches are present). Every colour
    // of a product shares the same base pid (2061433-04 -> base 2061433), so the
    // swatch links for one product all carry "<base>-<colourcode>.html". Count
    // the distinct colour codes; names come from the swatch img-alt/aria/title.
    function productBase(url) {
      try {
        const m = new URL(url).pathname.match(/\/(\d{4,})-[A-Za-z0-9]+\.html/i);
        return m ? m[1] : "";
      } catch (e) { return ""; }
    }
    const colourCase = s => String(s || "").toLowerCase().replace(/\s+/g, " ").trim()
      .replace(/\b\w/g, c => c.toUpperCase());

    // Colour variants on the LIVE listing. Confirmed structure (diagnose-listing-
    // color.js on cottonon.com): each product's colour swatches share the base
    // pid in their href (e.g. ?dwvar_2061433-04_color=…) and carry the colour
    // NAME in the image alt as "Select Colour: WASHED BLACK"; the current colour
    // is in the main image alt "…Jacket, WASHED CACTUS GREEN". Names are the
    // reliable identity (the pid codes live in color= params, not the .html path).
    function colorsForBase(doc, base) {
      if (!doc.querySelectorAll || !base) return { count: 0, colorways: "" };
      const names = new Map();   // lowercased -> display name
      const codes = new Set();   // fallback identity when no name is present
      const sel = ['a[href*="' + base + '"]', 'img[src*="' + base + '"]', 'img[data-src*="' + base + '"]',
        '[data-pid*="' + base + '"]', '[data-variant*="' + base + '"]', '[data-product-id*="' + base + '"]'].join(",");
      doc.querySelectorAll(sel).forEach(el => {
        const img = (el.tagName === "IMG") ? el : (el.querySelector && el.querySelector("img"));
        const label = el.getAttribute("aria-label") || el.getAttribute("title") ||
          (img && (img.getAttribute("alt") || img.getAttribute("title"))) || "";
        if (/^\s*size\b/i.test(label)) return;                 // size buttons also carry the pid
        const m = label.match(/select\s+colou?r\s*:\s*(.+)$/i) ||   // swatch: "Select Colour: X"
          label.match(/,\s*([A-Za-z][A-Za-z0-9 /&'’-]{1,38})\s*$/); // main image: "…Jacket, X"
        if (m) {
          let n = m[1].replace(/\s+/g, " ").trim();
          // strip gallery-image noise so all views of one colour collapse to it:
          // "Black - Example Image 1" / "Black - Front" / "Black View 2" -> "Black"
          n = n.replace(/\s*[-–—]?\s*(?:example\s+)?(?:image|img|photo|view|front|back|side|angle|model|look|zoom)\b.*$/i, "").trim();
          if (n && !/^(?:example|image|img|photo|view)\b/i.test(n)) names.set(n.toLowerCase(), colourCase(n));
        }
        // fallback colour identity from the variant code (color= param / pid)
        const attrs = (el.getAttribute("href") || "") + " " + (el.getAttribute("src") || "") + " " +
          (el.getAttribute("data-src") || "") + " " + (el.getAttribute("data-pid") || "");
        const cm = attrs.match(new RegExp("color=" + base + "-([A-Za-z0-9]{1,8})", "i")) ||
          attrs.match(new RegExp("/" + base + "-([A-Za-z0-9]{1,8})\\.html", "i"));
        if (cm) codes.add(cm[1].toLowerCase());
      });
      if (names.size) return { count: names.size, colorways: [...names.values()].join("; ") };
      return { count: codes.size, colorways: "" };            // names unknown, count only
    }

    // Key design details: the PDP's "Features" list. Cotton On renders this
    // inconsistently — sometimes as a <ul><li> list, sometimes as plain lines
    // with NO bullets (e.g. the Knox jacket) — so don't require <li>. Collect
    // the lines that follow the "Features" heading until the next section
    // (Composition / Ingredients / Dimensions / Care / Product Code / …).
    function featuresFromDoc(doc) {
      if (!doc.querySelectorAll) return [];
      const STOP = /^(compositions?|ingredients?|dimensions?|care|product\s*code|complete\s+the\s+look|reviews?|size\b|colou?r\b)/i;
      let anchor = null;
      const cand = doc.querySelectorAll("h1,h2,h3,h4,h5,h6,strong,b,p,div,span,dt");
      for (let i = 0; i < cand.length; i++) {
        if (/^\s*features\s*:?\s*$/i.test(cand[i].textContent || "")) { anchor = cand[i]; break; }
      }
      if (!anchor) return [];
      const out = [];
      const take = el => {
        if (!el) return;
        const ul = (el.matches && el.matches("ul,ol")) ? el : (el.querySelector && el.querySelector("ul,ol"));
        if (ul) { ul.querySelectorAll("li").forEach(li => out.push(li.textContent || "")); return; }
        // plain (bullet-less) lines: <br>-separated inside one element, or the
        // element itself is one line.
        const html = el.innerHTML || "";
        if (/<br/i.test(html)) html.split(/<br\s*\/?>/i).forEach(part => {
          const t = part.replace(/<[^>]+>/g, " "); out.push(t);
        });
        else out.push(el.textContent || "");
      };
      // walk the siblings after the "Features" heading until the next section
      let sib = anchor.nextElementSibling, steps = 0;
      while (sib && steps++ < 14) {
        const t = (sib.textContent || "").replace(/\s+/g, " ").trim();
        if (STOP.test(t)) break;
        if (t) take(sib);
        sib = sib.nextElementSibling;
      }
      // some layouts put the label + items inside one container, as siblings of
      // the label rather than after it — sweep the parent's children too.
      if (!out.length && anchor.parentElement) {
        let after = false;
        [...anchor.parentElement.children].forEach(ch => {
          if (ch === anchor) { after = true; return; }
          if (!after) return;
          const t = (ch.textContent || "").replace(/\s+/g, " ").trim();
          if (STOP.test(t)) { after = false; return; }
          if (t) take(ch);
        });
      }
      return out.map(s => String(s).replace(/\s+/g, " ").trim())
        .filter(s => s && s.length <= 200 && !/^features:?$/i.test(s));
    }

    // The breadcrumb trail (Home dropped) — JSON-LD BreadcrumbList first, then a
    // DOM breadcrumb nav. This reflects the ON-SITE navigation names, which is
    // what the user sees and expects — unlike URL slugs, which don't match the
    // display name (a "Sweats & Hoodies" page can live at .../sweats-fleece-womens/).
    function breadcrumbTrail(doc) {
      let trail = [];
      (doc.querySelectorAll ? doc.querySelectorAll('script[type="application/ld+json"]') : []).forEach(s => {
        if (trail.length) return;
        let d; try { d = JSON.parse(s.textContent); } catch (e) { return; }
        [].concat(d && d["@graph"] ? d["@graph"] : d).forEach(n => {
          if (n && /BreadcrumbList/i.test([].concat(n["@type"] || []).join(","))) {
            trail = [].concat(n.itemListElement || [])
              .map(e => (e && (e.name || (e.item && e.item.name))) || "").filter(Boolean);
          }
        });
      });
      if (!trail.length && doc.querySelector) {
        const nav = doc.querySelector('nav[aria-label*="readcrumb" i], [class*="readcrumb" i]');
        if (nav) trail = [...nav.querySelectorAll("a,li,span")]
          .map(a => (a.textContent || "").replace(/\s+/g, " ").trim()).filter(Boolean);
      }
      const out = [];
      trail.forEach(t => {
        if (!t || /^home$/i.test(t)) return;
        if (!out.some(x => x.toLowerCase() === t.toLowerCase())) out.push(t);
      });
      return out;
    }
    // PDP category: the trail minus the product crumb.
    function breadcrumbCategory(doc, productName) {
      const trail = breadcrumbTrail(doc)
        .filter(t => !(productName && t.toLowerCase() === String(productName).toLowerCase()));
      return trail.slice(0, 3).join(" / ");
    }
    // Listing category: the on-site name of the category the user is browsing.
    // Prefer the breadcrumb leaf (current category), then the page H1, then the
    // URL — because URL slugs can be an internal facet ("sweats-fleece-womens")
    // that doesn't match the browse category ("Sweats & Hoodies").
    function listingCategory(doc, url) {
      const trail = breadcrumbTrail(doc);
      if (trail.length) return trail[trail.length - 1];
      const h1 = doc.querySelector && doc.querySelector("h1");
      if (h1) {
        const t = (h1.textContent || "").replace(/\s*\(\d[\d,]*\)\s*$/, "").replace(/\s+/g, " ").trim();
        if (t && t.length <= 60) return t;
      }
      return categoryFromUrl(url);
    }

    function parseDetailDoc(doc, rawHtml, url) {
      let brand = "", name = "";
      const colors = [], sizes = [];
      const addTo = (arr, v) => {
        const s = String(v == null ? "" : v).replace(/\s+/g, " ").trim();
        if (s && s.length <= 40 && !arr.some(x => x.toLowerCase() === s.toLowerCase())) arr.push(s);
      };
      // JSON-LD Product on the PDP — brand/name + schema.org color/size/hasVariant
      (doc.querySelectorAll ? doc.querySelectorAll('script[type="application/ld+json"]') : []).forEach(s => {
        let d; try { d = JSON.parse(s.textContent); } catch (e) { return; }
        [].concat(d && d["@graph"] ? d["@graph"] : d).forEach(n => {
          if (!n || !/(^|,)Product(,|$)/i.test([].concat(n["@type"] || []).join(","))) return;
          if (!name && n.name) name = String(n.name);
          if (!brand && n.brand) brand = String(n.brand.name || n.brand);
          [].concat(n.color || []).forEach(c => addTo(colors, c));
          [].concat(n.size || []).forEach(z => addTo(sizes, z));
          [].concat(n.hasVariant || []).forEach(v => { if (v) { addTo(colors, v.color); addTo(sizes, v.size); } });
        });
      });
      // embedded SFCC variationAttributes JSON (when present)
      const blobs = jsonBlobs(doc);
      blobs.forEach(b => {
        variationValues(b, /colou?r/i).forEach(c => addTo(colors, c));
        variationValues(b, /^size$/i).forEach(z => addTo(sizes, z));
      });
      // DOM fallback (confirmed live on cottonon.com): size buttons carry
      // aria-label="Size <value>, available" / ", sold out" / ", low stock" —
      // no embedded JSON needed.
      if (!sizes.length && doc.querySelectorAll) {
        doc.querySelectorAll('[class*="size" i] [aria-label], [aria-label*="size" i]').forEach(el => {
          const m = (el.getAttribute("aria-label") || "").match(/^size\s+([^,]+)/i);
          if (m) addTo(sizes, m[1]);
        });
      }
      // Colour variants: the row of swatch thumbnails, each a sibling PDP that
      // shares this product's slug. This is the authoritative colour SET + count.
      const canon = doc.querySelector && doc.querySelector('link[rel="canonical"]');
      const slug = slugFromUrl(url) || slugFromUrl((canon && canon.getAttribute("href")) || "");
      const swatches = colorSwatches(doc, slug, name || nameFromUrl(url || ""));
      let colorCount = swatches.length;
      swatches.forEach(sw => { if (sw.name) addTo(colors, sw.name); });
      // broader swatch scan by base pid: catches <img>/data-* swatches too, in
      // case the thumbnails are server-rendered even when the slug links aren't.
      const byBase = colorsForBase(doc, productBase(url || ""));
      if (byBase.count > colorCount) colorCount = byBase.count;
      if (byBase.colorways) byBase.colorways.split("; ").forEach(c => addTo(colors, c));
      // fallback for the CURRENT colour only: the visible "Colour: <name>" label,
      // read from its own element (server HTML glues sections with no whitespace).
      // No loose whole-page scan — that grabbed unrelated words like "HERE".
      if (!colors.length && doc.querySelectorAll) {
        let best = "";
        doc.querySelectorAll("*").forEach(el => {
          const t = el.textContent || "";
          if (t.length > 120 || !/\bColou?r\s*:/i.test(t)) return;   // label leaf, not a big container
          if (!best || t.length < best.length) best = t;
        });
        const c = colourFromText(best);
        if (c) addTo(colors, c);
      }
      if (!colorCount) colorCount = colors.length;   // named-but-no-swatch case
      // brand fallback: og:brand / site name / the store's own house brand.
      // cottonon.com is a single-house-brand site, so "Cotton On" is a factual
      // default (not a guess) when the page doesn't state it explicitly.
      if (!brand && doc.querySelector) {
        const og = doc.querySelector('meta[property="og:brand"], meta[name="brand"], meta[property="product:brand"]');
        brand = (og && og.getAttribute("content")) || "Cotton On";
      } else if (!brand) { brand = "Cotton On"; }
      const composition = compositionFromText((doc.body && doc.body.textContent) || rawHtml || "");
      const productName = name || nameFromUrl(url || "");
      const design = featuresFromDoc(doc).slice(0, 3).join("; ");   // first 3 Features bullets
      const category = breadcrumbCategory(doc, productName);
      return {
        composition, colorways: colors.join("; "), color_count: colorCount || "",
        design, category, brand, sizes: sizes.join("; "),
        reason: composition ? "" : "not_found",
      };
    }

    async function fetchDetail(url) {
      // Brand is factual for a single-house-brand site even when the fetch
      // fails, so return it on every path (colour/size still need the PDP).
      const empty = r => ({ composition: "", colorways: "", color_count: "", design: "", brand: "Cotton On", reason: r });
      let html;
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 12000);
        try {
          const res = await fetch(url, { credentials: "include", signal: ctrl.signal });
          if (!res.ok) return empty(res.status === 404 ? "not_found" : "blocked");
          html = await res.text();
        } finally { clearTimeout(timer); }
      } catch (e) {
        return empty((e && e.name === "AbortError") ? "timeout" : "error");
      }
      try {
        return parseDetailDoc(new DOMParser().parseFromString(html, "text/html"), html, url);
      } catch (e) { return empty("error"); }
    }

    // --- SFCC grid pagination (start/sz offsets, NOT ?page=N) ---------------
    // cottonon.com's category grid loads more products with ?start=<offset>&sz=<n>
    // ("load more" grows the grid 60 → 120 → 180…), so the page number is encoded
    // in `start`, not a `page` param. sz is the batch size (60 on Cotton On).
    const SFCC_SZ = 60;
    function gridSize(url) {
      try { return parseInt(new URL(url).searchParams.get("sz")) || SFCC_SZ; }
      catch (e) { return SFCC_SZ; }
    }
    function gridPage(url) {
      try {
        const p = new URL(url).searchParams;
        const start = parseInt(p.get("start")) || 0;
        return Math.floor(start / (parseInt(p.get("sz")) || SFCC_SZ)) + 1;
      } catch (e) { return 1; }
    }
    // reset to the first slice (start=0) so a scan started mid-grid still
    // collects from the beginning.
    function firstPageUrl(url) {
      try {
        const u = new URL(url);
        u.searchParams.delete("start");
        u.searchParams.delete("page");
        return u.toString();
      } catch (e) { return url; }
    }
    // next slice: page N (1-based) was scraped -> advance start to N*sz.
    function nextPageUrl(url, page) {
      try {
        const u = new URL(url);
        const sz = parseInt(u.searchParams.get("sz")) || SFCC_SZ;
        u.searchParams.set("start", String(page * sz));
        u.searchParams.set("sz", String(sz));
        u.searchParams.delete("page");
        return u.toString();
      } catch (e) { return null; }
    }

    function context(doc) {
      doc = doc || document;
      const url = (doc.location && doc.location.href) || (typeof location !== "undefined" ? location.href : "");
      return {
        brand: "",
        category: listingCategory(doc, url),   // on-site name (breadcrumb/H1), not URL slug
        totalPages: null,          // SFCC total unknown up front -> probe to the end
        page: gridPage(url),
      };
    }

    return {
      id: "cottonon",
      label: "Cotton On",
      match: url => /(^|\.)cottonon\.com\//i.test(String(url || "").replace(/^https?:\/\//i, "")),
      context, scrapeList,
      totalPages: () => null,           // SFCC grid: probe to the end via start/sz
      resultCount: generic.resultCount,
      nextPageUrl, firstPageUrl,        // SFCC start/sz offsets, not ?page=N
      isResultsPage: generic.isResultsPage,
      fetchDetail, buildWorkbook: generic.buildWorkbook,
      templateUrl: null,
      _nameFromUrl: nameFromUrl, _categoryFromUrl: categoryFromUrl,
      _variationValues: variationValues, _parseDetailDoc: parseDetailDoc,
      _colourFromText: colourFromText,
      _nextPageUrl: nextPageUrl, _firstPageUrl: firstPageUrl, _gridPage: gridPage,
      _colorSwatches: colorSwatches, _cleanColourName: cleanColourName,
      _featuresFromDoc: featuresFromDoc, _breadcrumbCategory: breadcrumbCategory,
      _listingCategory: listingCategory, _breadcrumbTrail: breadcrumbTrail,
      _productBase: productBase, _colorsForBase: colorsForBase,
    };
  })();

  // ---------------------------------------------------------------------------
  // Registry — order matters: more specific adapters must come before generic.
  // ---------------------------------------------------------------------------
  const ADAPTERS = [walmart, cottonon, shopify, generic];

  const SITES = {
    shared,
    adapters: ADAPTERS,
    // doc is optional — adapters that detect by page content (e.g. shopify's
    // cdn markers) use it; URL-pattern adapters (walmart) ignore it.
    active(url, doc) { return ADAPTERS.find(a => a.match(url, doc)) || null; },
    get(id) { return ADAPTERS.find(a => a.id === id) || null; },
  };

  if (typeof module !== "undefined" && module.exports) module.exports = SITES;
  root.SITES = SITES;
})(typeof self !== "undefined" ? self : this);
