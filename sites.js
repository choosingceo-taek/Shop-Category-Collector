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
     fetchComposition(url) : Promise<string>          (optional deep detail)
     buildWorkbook(XLSX, templateArrayBuffer, items, opts)
                          : { bytes, kept, dropped }  (how to export)
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

    function priceOf(it) {
      const p = it.priceInfo || it.primaryOffer || {};
      const cand = p.linePrice || p.currentPrice || p.offerPrice || p.linePriceDisplay ||
        (p.currentPrice && p.currentPrice.price) || it.price;
      if (cand == null) return "";
      if (typeof cand === "object") return cand.price || cand.priceString || "";
      return cand;
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
    function categoryOf(doc) {
      const h1 = (doc.querySelector && doc.querySelector("h1")) || {};
      return (h1.textContent || "").replace(/\(\d[\d,]*\).*/, "").trim();
    }

    // Walmart's MAIN search/browse results live in `itemStacks[].items`. Pulling
    // those only keeps us off the "recommended / sponsored / you-might-also-like"
    // carousels that otherwise inflate the count (e.g. 308 vs 81 real results).
    function resultsFromStacks(blobs) {
      const items = [];
      const walk = (o, d) => {
        if (!o || d > 12) return;
        if (Array.isArray(o)) { o.forEach(v => walk(v, d + 1)); return; }
        if (typeof o === "object") {
          for (const k in o) {
            if (k === "itemStacks" && Array.isArray(o[k])) {
              o[k].forEach(st => { if (st && Array.isArray(st.items)) items.push(...st.items.filter(looksProduct)); });
            }
            walk(o[k], d + 1);
          }
        }
      };
      blobs.forEach(b => walk(b, 0));
      return items;
    }

    function scrapeList(doc, url) {
      doc = doc || document;
      const blobs = jsonBlobs(doc);
      // Prefer the main results grid; only fall back to the broad merge-all sweep
      // (which can over-collect carousels) if the grid can't be located.
      let raw = resultsFromStacks(blobs);
      if (!raw.length) {
        const arrays = [];
        blobs.forEach(b => collectProductArrays(b, 0, arrays));
        raw = [].concat.apply([], arrays);
      }
      let items = uniqBy(raw,
        it => String(it.usItemId || it.productId || it.id || it.canonicalUrl || it.name));
      const category = categoryOf(doc);
      let out = items.map(it => ({
        brand: brandOf(doc, it),
        name: it.name || it.title || it.productName || "",
        price: priceOf(it),
        product_url: abs(it.canonicalUrl || it.productPageUrl || it.productUrl || it.url || it.seoUrl),
        image_url: imageOf(it),
        category,
        department: it.department || "",
        id: String(it.usItemId || it.productId || it.id || it.itemId || ""),
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

    function totalPages(doc) {
      doc = doc || document;
      const blobs = jsonBlobs(doc);
      for (const b of blobs) {
        const n = findNumber(b, ["maxPage", "numberOfPages", "totalPages", "pageCount"]);
        if (n) return n;
        // derive from result count + page size
        const total = findNumber(b, ["totalResultCount", "totalCount", "recordCount"]);
        const size = findNumber(b, ["pageSize", "resultsPerPage", "perPage"]);
        if (total && size) return Math.ceil(total / size);
      }
      const nums = [...(doc.querySelectorAll
        ? doc.querySelectorAll('nav[aria-label*="pagination" i] a, [data-testid*="pagination" i] a, ul.paginator a')
        : [])].map(a => parseInt(a.textContent)).filter(n => !isNaN(n));
      return nums.length ? Math.max(...nums) : null;
    }

    function nextPageUrl(url, page) {
      // Walmart uses ?page=N on both /browse and /search. Preserve all other params.
      const u = new URL(url);
      u.searchParams.set("page", String(page + 1));
      return u.toString();
    }

    async function fetchComposition(url) {
      try {
        // hard timeout so one stalled product page can't freeze the whole run
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 12000);
        let html;
        try {
          const res = await fetch(url, { credentials: "include", signal: ctrl.signal });
          html = await res.text();
        } finally { clearTimeout(timer); }
        // bot-wall guard: Walmart returns a captcha/blocked shell with no product JSON
        if (/Robot or human|px-captcha|blocked/i.test(html) && !/__NEXT_DATA__/.test(html)) return "";
        const doc = new DOMParser().parseFromString(html, "text/html");
        const blobs = jsonBlobs(doc);
        const keys = ["Fabric Material", "Material", "Fabric Content", "Composition",
          "Fabric", "Shell", "Body", "Fabric Composition"];
        for (const b of blobs) { const v = findKeyedValue(b, keys); if (v) return v; }
        // last resort: regex the raw html for a spec pair
        const m = html.match(/"(?:Fabric Material|Material|Fabric Content|Composition)"\s*,\s*"value"\s*:\s*"([^"]+)"/);
        return m ? m[1] : "";
      } catch (e) { return ""; }
    }

    function context(doc) {
      doc = doc || document;
      return {
        brand: brandOf(doc, null),
        category: categoryOf(doc),
        totalPages: totalPages(doc),
        page: parseInt(new URLSearchParams((doc.location || location).search).get("page") || "1"),
      };
    }

    function buildWorkbook(XLSX, templateArrayBuffer, items, opts) {
      // Walmart uses the knit-DB template + brand/scope routing in pipeline.js.
      const WPB = (typeof self !== "undefined" && self.WPB) ||
        (typeof global !== "undefined" && global.WPB) || root.WPB;
      return WPB.fillWorkbook(XLSX, templateArrayBuffer, items, opts);
    }

    return {
      id: "walmart",
      label: "Walmart",
      match: url => /^https?:\/\/(www\.)?walmart\.com\/(browse|search|shop|cp|c\/)/i.test(url || ""),
      context, scrapeList, totalPages, nextPageUrl, fetchComposition, buildWorkbook,
      templateUrl: "template.xlsx",
      // internal, exposed for tests
      _priceOf: priceOf, _imageOf: imageOf, _resultsFromStacks: resultsFromStacks,
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
