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

  /* The first <h1> on the page is usually the category. Sometimes it is an
     interstitial that got there first — Gap's stores put "Want to shop
     athleta.com?" above the grid to send a visitor to another storefront, and
     that sentence became the category on every row of the scan.

     The test is a shape, not a shop: a category is a noun phrase. It is never
     a question, and it never contains a web address. Anything that is one of
     those is not what this page sells, so the reader falls through to the
     address — which the shop also wrote, and which says "all-new-arrivals". */
  const notACategory = t => {
    const s = String(t || "").trim();
    return /\?\s*$/.test(s) || /\b[a-z0-9-]+\.(com|net|org|co\.[a-z]{2}|[a-z]{2})\b/i.test(s);
  };

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

  /* Every image address that reaches a row has to be absolute.

     Shops write the same picture three ways — a full URL, protocol-relative
     (//shop/cdn/…, what Shopify emits) and root-relative (/cdn/shop/files/…)
     — and the last two only mean something next to the page they came from.
     Stored raw they are later resolved against the extension itself, which is
     how an Edikted scan produced 64 rows with names, prices and no pictures
     at all. Every reader goes through here: listing tiles, JSON-LD, og:image,
     and the platform APIs.

     A missing scheme is repaired, a relative path is resolved, and anything
     still not http(s) after that (data: URIs, javascript:, junk) is dropped
     rather than stored as a broken address. */
  function absImage(u, base) {
    let s = String(u || "").trim();
    if (!s) return "";
    if (s.slice(0, 2) === "//") s = "https:" + s;
    if (!/^https?:/i.test(s)) {
      const from = base || (typeof location !== "undefined" ? location.href : "");
      if (!from) return "";
      try { s = new URL(s, from).toString(); } catch (e) { return ""; }
    }
    return /^https?:/i.test(s) ? s : "";
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
  let FIBER_RE = /\d\s*%|\b(cotton|polyester|spandex|elastane|rayon|viscose|modal|nylon|acrylic|wool|linen|lyocell|tencel|cashmere|silk|bamboo|polyamide|jersey|fleece)\b/i;

  // Every fibre we will name. Used to REBUILD the composition from the
  // "<pct>% <fibre>" pairs actually present, instead of returning a raw slice of
  // page text — a slice can drag markup or JSON along with it (Zara states the
  // composition inside JSON-LD, where a naive label match captured
  // '","name":"OUTER SHELL","value":"97% polyester').
  // Longer names first so "triacetate" isn't clipped to "acetate".
  const FIBER_LIST = "metallised fibre|metallic fibre|triacetate|polyamide|polyester|elastane|" +
    "cashmere|viscose|acrylic|acetate|lyocell|spandex|alpaca|angora|bamboo|cotton|feather|" +
    "leather|mohair|tencel|linen|modal|nylon|rayon|ramie|cupro|hemp|jute|silk|wool|down";
  /* Korean fibre names — Alo's /ko-kr/ storefront (and any Korean shop) states
     the blend as "폴리에스터 87% 스판덱스 13%". The single-syllable fibres
     (면·마·견·울) appear INSIDE ordinary words (화면, 겨울…), so they only
     count when not glued to another Hangul syllable on either side. */
  const KO_FIBER_LIST = "폴리에스테르|폴리에스터|폴리아마이드|폴리아미드|엘라스테인|" +
    "스판덱스|캐시미어|비스코스|아세테이트|라이오셀|리오셀|아크릴|레이온|나일론|텐셀|" +
    "린넨|리넨|모달|양모|알파카|앙고라|모헤어|(?<![가-힣])(?:울|면|마|견)";
  const FIBER_ANY = FIBER_LIST + "|" + KO_FIBER_LIST;
  // the validity check accepts Korean fibre names too, so "소재: 면 100%" passes
  FIBER_RE = new RegExp(FIBER_RE.source + "|" + KO_FIBER_LIST, "i");
  const titleFibre = s => String(s || "").toLowerCase().replace(/\s+/g, " ").trim()
    .replace(/\b\w/g, c => c.toUpperCase());

  // All "<pct>% [qualifier] <fibre>" pairs, in document order. One optional
  // qualifier word is allowed ("100% Organic cotton"); promo wording ("50% off")
  // is excluded because the pair must end on a real fibre name.
  function fiberPairs(text) {
    const src = String(text || "");
    // The tail guard is "not followed by a letter" rather than \b: sites run the
    // pairs together with no separator ("95% cotton5% elastane"), and \b fails
    // between a letter and a digit, which silently dropped the first fibres.
    const re = new RegExp(
      "(\\d{1,3})\\s?%\\s?(?:(?!off|sale|discount|extra|savings?)([A-Za-z]+)\\s+)?(" + FIBER_ANY + ")(?![A-Za-z가-힣])",
      "gi");
    // Reversed order — "폴리에스터 87%" / "Cotton 95%". The fibre must sit
    // DIRECTLY against its number, and a following off/sale/할인 disqualifies
    // it, so "selected cotton 50% off" never reads as a blend.
    const rev = new RegExp(
      "(" + FIBER_ANY + ")(?![A-Za-z가-힣])\\s?:?\\s?(\\d{1,3})\\s?%(?!\\s?(?:off|sale|discount|할인))",
      "gi");
    /* "폴리에스터 87% 스판덱스 13%" and "95% cotton 5% elastane" both contain
       the OTHER direction's shape in their middle ("87% 스판덱스" / "cotton
       5%"), so the two readings are parsed separately and the one that
       accounts for more pairs wins — the wrong direction only ever catches a
       fragment. Ties go to %-first, the shape western shops use. */
    const fwd = [];
    let m;
    while ((m = re.exec(src))) {
      const pct = parseInt(m[1], 10);
      if (!(pct > 0 && pct <= 100)) continue;
      const qual = m[2] && /^(organic|recycled|virgin|merino|pima|supima|bci)$/i.test(m[2]) ? m[2] + " " : "";
      fwd.push({ pct, fiber: titleFibre(qual + m[3]) });
    }
    const bwd = [];
    while ((m = rev.exec(src))) {
      const pct = parseInt(m[2], 10);
      if (!(pct > 0 && pct <= 100)) continue;
      bwd.push({ pct, fiber: titleFibre(m[1]) });
    }
    return bwd.length > fwd.length ? bwd : fwd;
  }

  /* Rebuild a clean composition string from those pairs.

     Garments state several parts (OUTER SHELL / LINING / LACE) and the
     percentages inside one part sum to 100, so a running total that reaches 100
     — or a fibre repeating — means the next part started. Parts join with "; ",
     which is the same shape the Inditex adapter already emits. */
  function normalizeComposition(text) {
    const pairs = fiberPairs(text);
    if (!pairs.length) return "";
    const parts = [];
    let cur = [], sum = 0;
    for (const p of pairs) {
      if (sum >= 100 || cur.some(x => x.fiber === p.fiber)) {
        if (cur.length) parts.push(cur);
        cur = []; sum = 0;
      }
      cur.push(p); sum += p.pct;
    }
    if (cur.length) parts.push(cur);
    // drop a duplicated part (the same blend restated elsewhere on the page)
    const seen = new Set();
    return parts.map(part => part.map(p => p.pct + "% " + p.fiber).join(", "))
      .filter(s => { const k = s.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
      .join("; ");
  }
  // A candidate that still carries markup or JSON punctuation is not a value the
  // site displayed — never pass it through as-is.
  const looksStructural = s => /["{}\[\]<>]|@type|propertyID|additionalProperty/i.test(String(s || ""));

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
    // Labelled region. Read a WIDER window than we return: the pairs get rebuilt
    // from it, so a blend split across the label ("95% cotton … 5% elastane")
    // survives, while markup that shared the window is discarded by the rebuild.
    const lab = t.match(/(?:fabric material|material|fabric content|fabric composition|composition|fabric|소재|혼용률|원단|조성)\s*[:\-]?\s*([^\n]{3,300})/i);
    if (lab) {
      const built = normalizeComposition(lab[1]);
      if (built) return built;
      // no percentages (e.g. "Material: Cotton blend") — only usable when the
      // captured text is plain, displayed wording rather than markup/JSON
      const plain = trimTail(lab[1].slice(0, 140));
      if (FIBER_RE.test(plain) && !looksStructural(plain)) return plain;
    }
    // bare percentage runs — scan ALL of them and take the first that NAMES a
    // fiber, so promo text like "20% off" earlier on the page can't shadow the
    // real "95% Cotton 5% Elastane" later on
    const FIBERS = "cotton|polyester|spandex|elastane|rayon|viscose|modal|nylon|acrylic|wool|linen|lyocell|tencel|cashmere|silk|bamboo|polyamide";
    const FIBER_WORD = new RegExp("\\b(" + FIBERS + ")\\b", "i");
    // fiber-anchored pass (preferred): each "<pct> [adjective] <fiber>" segment
    // NAMES a real fiber, allowing ONE qualifier adjective ("100% Organic
    // cotton", "80% Recycled polyester" — common on COS / Massimo Dutti) and
    // chaining more segments. Every segment anchors on a fiber, so trailing
    // noise ("40% Polyester blend") can't attach. Line-scoped and
    // discount-guarded so "50% off … Cotton" can't masquerade as fabric.
    const SEG = "\\d{1,3}\\s?%\\s?(?:(?!off|sale|discount|extra|savings?)[A-Za-z]+[ \\t]+)?(?:" + FIBERS + ")\\b";
    const QUAL = new RegExp(SEG + "(?:[ ,/&+]+" + SEG + ")*", "i");
    for (const line of t.split(/\n/)) {
      const m = line.match(QUAL);
      // rebuild from the whole line first: the pair scanner reads run-together
      // pairs ("95% cotton5% elastane") that the \b-bounded match clips
      if (m) return normalizeComposition(line) || normalizeComposition(m[0]) || m[0].trim();
    }
    // Multilingual / reversed-order pass — fiberPairs also reads "폴리에스터
    // 87%" and "Cotton 95%", so rebuild from every line whose pairs are real
    // and keep the parts ("겉감: … / 안감: …" arrive as separate lines).
    // Promo lines are skipped whole (a discount line never states a blend) and
    // the parts are capped, so a body-text fallback can't chain a whole page.
    {
      const parts = [];
      for (const line of t.split(/\n/)) {
        if (/\b(off|sale|discount)\b|할인|세일/i.test(line)) continue;
        const built = normalizeComposition(line);
        if (built && !parts.includes(built)) { parts.push(built); if (parts.length >= 3) break; }
      }
      if (parts.length) return parts.join("; ");
    }
    // last resort — any %-run that happens to contain a fiber word somewhere
    const runs = t.match(/\d{1,3}\s?%\s?[A-Za-z]+(?:[ ,/&+]+\d{1,3}\s?%\s?[A-Za-z]+)*/g) || [];
    const hit = runs.find(r => FIBER_WORD.test(r));
    return hit ? (normalizeComposition(hit) || hit.trim()) : "";
  }

  /* Read one product page — the platform-agnostic detail reader.

     Every shop states the same facts in the same two places: schema.org
     structured data (JSON-LD Product: material, colour, size, brand, image)
     and the visible text (the "<pct>% <fibre>" run, which the fibre validator
     rebuilds). Neither is a CSS selector, so this survives redesigns and works
     on a shop nobody has looked at yet — which is the point: a site the
     registry has never seen still yields fabric, colours and sizes on its
     first scan instead of a column of red.

     Sources are tried best-first and only fill what is still empty, so a
     stronger source is never overwritten by a weaker one. Everything is
     validated: composition passes the fibre parser, colours and sizes must be
     short label-shaped strings. Nothing is inferred. */
  function readProductPage(doc, rawHtml, fallbackBrand, pageUrl) {
    let brand = "", name = "", image = "", material = "", descr = "";
    const colors = [], sizes = [];
    const addTo = (arr, v) => {
      const s = String(v == null ? "" : v).replace(/\s+/g, " ").trim();
      if (s && s.length <= 40 && !arr.some(x => x.toLowerCase() === s.toLowerCase())) arr.push(s);
    };
    (doc.querySelectorAll ? doc.querySelectorAll('script[type="application/ld+json"]') : []).forEach(s => {
      let d; try { d = JSON.parse(s.textContent); } catch (e) { return; }
      [].concat(d && d["@graph"] ? d["@graph"] : d).forEach(n => {
        if (!n || !/(^|,)Product(,|$)/i.test([].concat(n["@type"] || []).join(","))) return;
        if (!name && n.name) name = String(n.name);
        if (!brand && n.brand) brand = String(n.brand.name || n.brand);
        // schema.org states the fabric outright in `material` when a shop
        // bothers to fill it — the most reliable source there is.
        if (!material && n.material) material = String(n.material.name || n.material);
        if (!descr && n.description) descr = String(n.description);
        // the PDP's own photo — a backstop for tiles whose lazy-loaded grid
        // image never resolved (structured data, not a guessed CDN path)
        if (!image) {
          const im = [].concat(n.image || [])[0];
          const u = im && (im.url || im.contentUrl || im);
          if (typeof u === "string") image = absImage(u, pageUrl);
        }
        [].concat(n.color || []).forEach(c => addTo(colors, c));
        [].concat(n.size || []).forEach(z => addTo(sizes, z));
        [].concat(n.hasVariant || []).forEach(v => { if (v) { addTo(colors, v.color); addTo(sizes, v.size); } });
      });
    });
    // composition: declared material first, then the description, then the
    // visible text — li boundaries before the whole body, so a spec list item
    // can't run into the care instructions next to it.
    const liText = doc.querySelectorAll
      ? [...doc.querySelectorAll("li")].map(li => li.textContent || "").join("\n") : "";
    const composition = compositionFromText(material)
      || compositionFromText(descr)
      || compositionFromText(liText)
      || compositionFromText((doc.body && doc.body.textContent) || rawHtml || "");
    // og:image — the one photo nearly every PDP declares. Semantic markup,
    // not a CSS selector, so it survives redesigns; only used when both the
    // listing tile and JSON-LD gave nothing.
    if (!image && doc.querySelector) {
      const og = doc.querySelector('meta[property="og:image"], meta[name="og:image"]');
      image = absImage(og && og.getAttribute("content"), pageUrl);
    }
    return {
      composition, colorways: colors.join("; "), color_count: colors.length || "",
      design: designText(descr, liText), brand: brand || fallbackBrand || "", name,
      sizes: sizes.join("; "), image_url: image,
      reason: composition ? "" : "not_found",
    };
  }

  /* The words a shop writes about the garment itself.

     The product NAME is a thin sample of a design: "Airbrush Tank" says
     nothing about the square neck, the ruching or the cropped hem, and those
     are what a designer tracks. The shop states them on the product page, in
     the description and the spec bullets — so the same reader that already
     goes there for the composition brings that copy back, and the keyword
     axes in the LAB read name AND copy instead of name alone.

     Stored as text, not as extracted keywords, on purpose: the vocabulary that
     decides what counts as a detail lives in the report layer and improves
     over time, and text lets an old scan benefit from a better reading without
     being re-scanned. Bounded hard — this is a sample of the copy, not a
     mirror of the page, and it is carried on every product row. */
  const DESIGN_TEXT_MAX = 400;
  function designText(descr, liText) {
    const parts = [];
    const push = t => {
      const clean = String(t || "").replace(/\s+/g, " ").trim();
      if (clean) parts.push(clean);
    };
    push(descr);
    /* Spec bullets, but not the care label: "machine wash cold" and "imported"
       are on every garment ever made and would drown the real vocabulary. */
    String(liText || "").split("\n").forEach(line => {
      const t = line.replace(/\s+/g, " ").trim();
      if (!t || t.length < 4 || t.length > 120) return;
      if (/\b(wash|bleach|tumble|dry clean|iron|imported|made in|style ?#|sku|model is|wears? (a )?size)\b/i.test(t)) return;
      push(t);
    });
    return parts.join(" · ").slice(0, DESIGN_TEXT_MAX);
  }

  /* Fetch a product page and read it. Bounded, credentialed (so a shop that
     shows prices only to a session still answers), and it never throws — a
     product that can't be read reports WHY, which is what the red cell says. */
  const nap = ms => new Promise(r => setTimeout(r, ms));

  async function fetchProductPage(url, fallbackBrand) {
    const empty = r => ({ composition: "", colorways: "", design: "",
      brand: fallbackBrand || "", reason: r });
    let html;
    /* "Too many requests" is the one refusal that answers differently if you
       simply wait. On a plain shop the composition costs one page fetch per
       product, sixty in a row, and a shop that starts throttling halfway
       through empties the fabric column for the rest of the scan — measured
       (harden-probe). One patient retry recovers those; a shop that means no
       still says no, and we do not push past it. */
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 12000);
        try {
          const res = await fetch(url, { credentials: "include", signal: ctrl.signal });
          if (!res.ok) {
            const busy = res.status === 429 || res.status === 503;
            if (busy && attempt === 0) { await nap(1500); continue; }
            return empty(res.status === 404 ? "not_found" : busy ? "busy" : "blocked");
          }
          html = await res.text();
          break;
        } finally { clearTimeout(timer); }
      } catch (e) {
        if (e && e.name === "AbortError") return empty("timeout");
        if (attempt === 0) { await nap(600); continue; }
        return empty("error");
      }
    }
    if (html == null) return empty("error");
    try {
      return readProductPage(new DOMParser().parseFromString(html, "text/html"), html, fallbackBrand, url);
    } catch (e) { return empty("error"); }
  }

  // Expose shared helpers so adapters (and tests) can reuse them.
  const shared = { jsonBlobs, sliceBalanced, looksProduct, collectProductArrays,
    findKeyedValue, findNumber, uniqBy, compositionFromText, FIBER_RE,
    normalizeComposition, fiberPairs, readProductPage, fetchProductPage };

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
    // The breadcrumb trail ("Clothing / Fashion Brands / Time and Tru /
    // Time and Tru Tops & Tees" -> ["Clothing","Fashion Brands","Time and Tru",
    // "Time and Tru Tops & Tees"]), Home dropped.
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
      return trail.filter(t => t && !/^home$/i.test(t));
    }
    function breadcrumbLeaf(doc) { const t = breadcrumbTrail(doc); return t.length ? t[t.length - 1] : ""; }

    // Walmart's own apparel brands live under a "Fashion Brands" breadcrumb, not
    // in the product's brand field. Read that crumb so Time and Tru / No
    // Boundaries / etc. land in Brand instead of being left blank.
    const WM_BRANDS = /\b(Time and Tru|Terra & Sky|No Boundaries|Wonder Nation|Weekend Academy|Free Assembly|Athletic Works|Sofia Jeans|Scoop|Joyspun|Avia|George|Reef|Onassis|Love & Sports|Madden NYC|EV1|Kendall \+ Kylie)\b/i;
    function brandOf(doc, it) {
      const named = (it && (it.brand || (it.brandName))) || "";
      if (named) return named;
      const trail = breadcrumbTrail(doc);
      const bi = trail.findIndex(t => /^(?:fashion\s+)?brands?$/i.test(t));   // crumb after "Fashion Brands"
      if (bi >= 0 && trail[bi + 1]) return trail[bi + 1].replace(/\s+(shop|store)$/i, "").trim();
      for (const t of trail) { const m = t.match(WM_BRANDS); if (m) return m[1]; }   // known brand anywhere in trail
      const h = ((doc.querySelector && doc.querySelector("h1")) || {}).textContent || "";
      const m = h.match(WM_BRANDS);
      if (m) return m[1];
      const facet = (new URLSearchParams((doc.location || location).search).get("facet") || "");
      return facet.replace(/.*brand:/i, "").split("||")[0] || "";
    }
    // Category: the breadcrumb leaf with any leading brand stripped
    // ("Time and Tru Shorts" -> "Shorts"). Falls back to the H1, never a bare
    // result-count. A brand-shop landing (leaf == brand) has no sub-category.
    function categoryOf(doc, brand) {
      const b = String(brand || "").trim();
      let leaf = breadcrumbLeaf(doc);
      if (leaf) {
        if (b && leaf.toLowerCase() === b.toLowerCase()) return "All";
        if (b && leaf.toLowerCase().startsWith(b.toLowerCase() + " ")) leaf = leaf.slice(b.length).trim();
        return leaf || "All";
      }
      const h1 = (doc.querySelector && doc.querySelector("h1")) || {};
      let t = (h1.textContent || "").replace(/\(\d[\d,]*\).*/, "").trim();
      t = t.split("|")[0].trim();                                    // drop "... | Walmart" title tail
      t = t.replace(/\s+in\s+[A-Za-z][^,]*$/i, "").trim();          // drop "... in <brand/dept>"
      if (/^\d[\d,]*\s*(?:results?|items?|products?)$/i.test(t)) return "";   // "115 results" is not a category
      if (b && t.toLowerCase().startsWith(b.toLowerCase() + " ")) t = t.slice(b.length).trim();
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
      // ONLY colour-identified sources. A bare variantList/variants also carries
      // the SIZE variants (a single-colour, many-size item would otherwise report
      // its 9 sizes as 9 "colours"), so we never pull those blindly — colours
      // come from the explicitly-coloured field and the named colour criterion.
      pull(it.colorVariants);
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
            image_url: absImage((tile.querySelector("img") || {}).src, location.href),
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

    // Size options from a product page's size variant list (same shape as
    // colours). Some products carry the size only here, not in the name.
    function extractSizes(blobs) {
      const sizes = [];
      const add = s => { const v = String(s || "").replace(/\s+/g, " ").trim();
        if (v && v.length <= 14 && !sizes.some(x => x.toLowerCase() === v.toLowerCase())) sizes.push(v); };
      const walk = (o, d) => {
        if (!o || d > 16 || typeof o !== "object") return;
        if (Array.isArray(o)) { o.forEach(v => walk(v, d + 1)); return; }
        const nm = (o.name || o.type || o.id || o.variantType || "") + "";
        if (/\bsize\b|clothing[_\s-]?size|shoe[_\s-]?size/i.test(nm) && !/one\s*size/i.test(nm)) {
          if (Array.isArray(o.variantList)) o.variantList.forEach(v => add(v && (v.name || v.value || v.swatchName)));
          if (Array.isArray(o.values)) o.values.forEach(v => add(v && (v.name || v.value || v)));
        }
        for (const k in o) walk(o[k], d + 1);
      };
      blobs.forEach(b => walk(b, 0));
      return sizes;
    }
    // Collapse a size list to a range when it's a recognizable run
    // (["S","M","L","XL","XXL"] -> "S-XXL"; ["2","4",…,"20"] -> "2-20"),
    // otherwise a "; "-joined list.
    const SIZE_RANK = "XXXS,XXS,XS,S,M,L,XL,XXL,XXXL,XXXXL,1X,2X,3X,4X,5X,6X".split(",");
    function sizeRange(list) {
      if (!list || !list.length) return "";
      const clean = [...new Set(list.map(s => String(s).trim().toUpperCase()))];
      const ranked = clean.map(s => SIZE_RANK.indexOf(s));
      if (clean.length >= 2 && ranked.every(i => i >= 0)) {
        return SIZE_RANK[Math.min(...ranked)] + "-" + SIZE_RANK[Math.max(...ranked)];
      }
      const nums = clean.map(s => (/^\d{1,3}$/.test(s) ? parseInt(s) : NaN));
      if (clean.length >= 2 && nums.every(n => !isNaN(n))) return Math.min(...nums) + "-" + Math.max(...nums);
      return list.join("; ");
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
      return parts.join("\n").slice(0, 400);   // one detail per line in the cell
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
        // Composition: prefer a fiber-% reading from the visible "Key item
        // features" bullets — some products give a BARE "60% Cotton/40% Polyester"
        // bullet with no "Material" label. compositionFromText matches labeled
        // AND bare fiber-% runs (and rejects promo "20% off"). Fall back to the
        // structured/labeled specs, then the whole page.
        const featText = doc.querySelectorAll
          ? [...doc.querySelectorAll("li")].map(li => li.textContent || "").join("\n") : "";
        let composition = compositionFromText(featText) || pickComposition(specs, blobs);
        if (!composition) composition = compositionFromText((doc.body && doc.body.textContent) || html);
        const design = pickDesign(specs);
        const colorways = extractColorways(blobs).join("; ");
        const sizes = sizeRange(extractSizes(blobs));   // size from the PDP when the name has none
        return { composition, colorways, design, sizes, reason: composition ? "" : "not_found" };
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
      _brandOf: brandOf, _extractSizes: extractSizes, _sizeRange: sizeRange, _breadcrumbTrail: breadcrumbTrail,
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
    /* Money, in the orders shops actually write it.

       This is load-bearing beyond the price column: the reader finds a tile by
       finding a price and climbing to it, so a storefront whose money we
       cannot read does not come back with an empty price column — it comes
       back as ZERO PRODUCTS. Measured (money-probe): five ordinary European
       forms did exactly that — `89,00 €`, `890 kr`, `89,00 zł`, `CHF 89.00`
       and the space-separated euro — because the pattern only knew a symbol
       BEFORE the number. Half of Europe writes it after.

       Three orders, therefore: symbol first ($89.00, €89,00, A$89.00), symbol
       or code last (89,00 €, 890 kr, 89.00 GBP, 89,000원), and code first
       (CHF 89.00, SEK 890). The letter codes are a closed list so that
       ordinary words next to a number cannot become prices. */
    const CUR_CODE = "USD|EUR|GBP|AUD|CAD|JPY|CNY|CHF|SEK|NOK|DKK|PLN|KRW|HKD|SGD|NZD";
    const PRICE_RE = new RegExp(
      "(?:(?:US|CA|AU|NZ|HK|SG|NT|A|C|R|S)?\\$|[₩€£¥₹])\\s?\\d[\\d.,]*" +
      /* A currency mark with digits AFTER it belongs to those digits, not to
         the ones in front — "Blouse Number 1 €89,00" is one price, not "1 €"
         and then another. Without that, a product name ending in a number ate
         the currency mark and the row was stored holding "1 €". */
      "|\\d[\\d.,]*\\s?(?:[₩€£¥₹$]|원|zł|kr(?:onor?)?\\b|" + CUR_CODE + ")(?!\\s?\\d)" +
      "|(?:" + CUR_CODE + "|Rp|RM)\\s?\\d[\\d.,]*");
    const MAX_TILES = 400;

    const textOf = el => ((el && el.textContent) || "").replace(/\s+/g, " ").trim();

    /* Text that is on the page but is not the product.

       Two real spreadsheets made this necessary. Abercrombie writes a screen
       reader instruction inside every tile — every row came out named
       "Activating this element will cause content on the page to be updated."
       Edikted's tile carries a size picker, and every row came out "Select
       Size". Both are interface text: it belongs to the control, not the
       garment, and no shop names a product this way.

       This is a stoplist of INTERFACE phrases, not a whitelist of product
       words, so an unfamiliar product name still passes untouched. Matching is
       whole-string (or near it) — a real name that merely contains "new" or
       "size" is not affected. */
    const UI_PHRASE = new RegExp("^(?:" + [
      "activating this element[\\s\\S]*", "press (?:enter|space)[\\s\\S]*",
      "select(?: a)? (?:size|colou?r|option|style)", "choose (?:a )?(?:size|colou?r|options?)",
      "quick (?:add|shop|view|buy)", "add to (?:bag|cart|wishlist|favou?rites)",
      "shop (?:now|the look)", "view (?:details|product|more)", "see (?:details|more)",
      "sold out", "out of stock", "coming soon", "back in stock", "notify me",
      "new(?: in| arrival[s]?)?", "sale", "best ?seller[s]?", "more colou?rs",
      "colou?rs? available", "available in \\d+ colou?rs?", "size guide",
      "opens? in a new (?:tab|window)", "skip to (?:main )?content",
      "loading[\\s\\S]*", "please wait[\\s\\S]*", "click to [\\s\\S]*", "tap to [\\s\\S]*",
    ].join("|") + ")[.!\\s]*$", "i");
    const isUiText = t => !t || UI_PHRASE.test(String(t).trim());

    /* Is this node hidden from sight? Screen-reader-only text is the usual
       source of interface strings inside a tile, and it is invisible to the
       user reading the page — so it must be invisible to the scraper too.
       getComputedStyle is unavailable on a detached document (the detail
       phase parses fetched HTML), hence the attribute/class fallbacks. */
    function isHiddenNode(el) {
      if (!el || !el.getAttribute) return false;
      if (el.getAttribute("aria-hidden") === "true" || el.hasAttribute("hidden")) return true;
      const cls = (el.getAttribute("class") || "") + " " + (el.getAttribute("id") || "");
      if (/\b(sr-only|screen-?reader|visually-?hidden|a11y-?hidden|hidden-?accessible)\b/i.test(cls)) return true;
      const st = (el.getAttribute("style") || "");
      if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(st)) return true;
      try {
        const w = el.ownerDocument && el.ownerDocument.defaultView;
        if (w && w.getComputedStyle) {
          const cs = w.getComputedStyle(el);
          if (cs.display === "none" || cs.visibility === "hidden") return true;
          // the classic sr-only recipe: clipped to a 1px box
          const box = parseFloat(cs.width) <= 1 && parseFloat(cs.height) <= 1;
          if (box && (cs.position === "absolute" || cs.position === "fixed") && cs.overflow === "hidden") return true;
        }
      } catch (e) {}
      return false;
    }
    // Inside a control (a size picker, an add-to-bag button)? Then the text
    // labels the control.
    function inControl(el, stop) {
      let n = el;
      for (let d = 0; n && n !== stop && d < 6; d++, n = n.parentElement) {
        const tag = (n.tagName || "").toUpperCase();
        if (tag === "BUTTON" || tag === "SELECT" || tag === "OPTION" || tag === "LABEL" ||
            tag === "FORM" || tag === "NOSCRIPT") return true;
        if (n.getAttribute && /^(button|listbox|option|tab|menuitem)$/i.test(n.getAttribute("role") || "")) return true;
      }
      return false;
    }
    // A usable name is visible, outside controls, and not interface text.
    function goodName(t, el, tile) {
      if (!t || t.length < 3 || t.length > 200) return false;
      if (isUiText(t)) return false;
      if (el && (isHiddenNode(el) || inControl(el, tile))) return false;
      return true;
    }
    /* The product slug in its own URL, as a last resort. Abercrombie's
       /shop/wd/a-and-f-forme-wide-leg-pant-62626819 is the product's real
       name written by the shop — a far better answer than a11y text, and
       still not invented by us. */
    /* Not every last segment is a name. Measured against generated shapes
       (matrix-probe): `/p/style-number-1/PROD1.html` gave "Prod1" and
       `/product.do?pid=901` gave "Product.Do" — a code and a routing word,
       both stored as product names, both then counted as words by the LAB.
       So the segments are read from the end backwards and the ones that are
       plainly not names are stepped over: routing words, file names, and
       opaque codes. A segment the shop wrote for people usually carries a
       separator, so that one wins when there is one; if nothing readable is
       left the answer is nothing, because an invented name is worse than an
       empty cell (the row is dropped, and the check reports it). */
    const ROUTE_SEG = /^(products?|p|pd|pdp|dp|item|items|sku|style|styles|shop|shopping|browse|collections?|category|categories|cat|c|detail|details|default|index|home|main|us|uk|eu|intl|global|[a-z]{2}([-_][a-z]{2})?)$/i;
    /* A code has no separator: it is one run of letters and digits. Keeping
       that requirement matters — Edikted's `s24161_black` IS the nearest thing
       to a name its grid offers until the shop's own JSON answers, and calling
       it a code left the row named after the collection instead. */
    const CODE_SEG = s =>
      /^\d+$/.test(s) ||                       // 62626819
      !/[aeiou]/i.test(s) ||                   // NWTKJ
      /^(?=.*\d)[a-z0-9]{1,10}$/i.test(s) ||   // PROD1, HR1234, N1JUX6
      /^[0-9a-f]{8,}$/i.test(s);               // a hash
    function nameFromSlug(url) {
      let segs = [];
      try {
        const p = new URL(url).pathname.replace(/\/$/, "");
        segs = p.split("/").filter(Boolean).map(s => {
          try { return decodeURIComponent(s); } catch (e) { return s; }
        });
      } catch (e) { return ""; }
      const clean = s => s.replace(/\.(html?|aspx?|php|jsp|do|action)$/i, "")
        .replace(/[-_](?:p)?\d{5,}$/i, "")          // trailing product id
        .trim();
      const usable = segs.map(clean)
        .filter(s => s && s.length >= 3 && !ROUTE_SEG.test(s) && !CODE_SEG(s));
      if (!usable.length) return "";
      // the shop's own words: a segment with a separator reads as a sentence
      const worded = usable.filter(s => /[-_]/.test(s));
      const seg = (worded.length ? worded[worded.length - 1] : usable[usable.length - 1])
        .replace(/[-_]+/g, " ").trim();
      if (!seg || seg.length < 3 || /^\d+$/.test(seg)) return "";
      return seg.replace(/\b\w/g, c => c.toUpperCase()).slice(0, 200);
    }
    const abs = (href, base) => { try { return new URL(href, base).toString(); } catch (e) { return href || ""; } };

    function firstPrice(text) { const m = text.match(PRICE_RE); return m ? m[0] : ""; }

    // Nearest ancestor (including self) of `el` that contains BOTH an <img>
    // and an <a href>, searched within a shallow depth so we land on the tile,
    // not the whole page body.
    /* Where a tile keeps its photograph, in every form a shop uses.

       Requiring an <img> is what made a whole shop read as ZERO products, not
       merely as products without photos: a grid that paints its pictures as
       CSS backgrounds (a div with `background-image`, or a lazy loader's
       `data-bg` waiting to become one) has no <img> anywhere near the price,
       so no tile was ever recognised and the export came back empty. A
       picture is a picture whichever way the shop paints it. */
    const BG_ATTRS = ["data-bg", "data-background", "data-background-image",
      "data-bgset", "data-bg-src", "data-lazy-bg"];
    const BG_SEL = '[style*="background-image" i],[style*="background:" i],' +
      BG_ATTRS.map(a => `[${a}]`).join(",");
    function hasPicture(node) {
      if (!node || !node.querySelector) return false;
      if (node.querySelector("img, picture, source")) return true;
      if (node.querySelector(BG_SEL)) return true;
      const st = node.getAttribute && node.getAttribute("style");
      return !!(st && /background(-image)?\s*:[^;]*url\(/i.test(st));
    }

    function tileAncestor(el, maxDepth) {
      let node = el, depth = 0;
      while (node && depth <= maxDepth) {
        const hasLink = (node.tagName === "A" && node.getAttribute("href")) ||
          !!(node.querySelector && node.querySelector("a[href]"));
        if (hasLink && hasPicture(node)) return node;
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

    /* The tile's real photo URL.

       Lazy-loading grids (Zara, COS, Massimo Dutti) do not put the photo in
       `src` until the tile scrolls into view — before that `src` is a 1x1
       transparent GIF, a blurred data: URI, or absent entirely, and the real
       URL sits in a data-* attribute or in a <picture><source srcset>. Reading
       `src` alone is why a whole Zara export came back with no thumbnails.

       So: collect every candidate the markup offers, drop the placeholders,
       and take the LARGEST srcset entry (the widest `w` descriptor) — a
       thumbnail in a spreadsheet is downscaled anyway, and the small candidate
       is often a blur-up preview. */
    /* Matches the FILENAME (last path segment) containing a placeholder token.
       Zara proved exact-name matching insufficient: its lazy grid uses a real
       https URL to "transparent-background.png", which sailed straight through
       a pattern that only knew "transparent.png" — and a whole export shipped
       with invisible thumbnails. Tokens inside directory names don't trigger
       ([^/?#]* cannot cross a slash), so /transparent/photo.jpg still passes.
       Keep in sync with IMG_PLACEHOLDER in store.js. */
    const PLACEHOLDER = /^data:|\/[^/?#]*(?:blank|placeholder|spacer|transparent|1x1|pixel|noimage|no-image|dummy)[^/?#]*\.(?:gif|png|svg|jpe?g|webp)(?:[?#]|$)/i;

    /* srcset cannot be split on commas, because image addresses contain them.

       This was measured against the shapes the team's shops actually serve:
       Adobe Scene7, which lululemon and Aritzia use, writes
       `?wid=800&op_usm=0.5,2,10,0&fmt=webp`, and Cloudinary puts
       `c_fill,w_600,h_800` in the PATH. Splitting on "," shattered one
       address into five, and the piece that happened to carry the width
       descriptor won — so the row was stored holding "0&fmt=webp". Asked for
       that, lululemon answered {"message":"Bad Request."}, which is what the
       designer saw when they opened one. Three fixes had been shipped for
       "IMAGE BLOCKED" on the assumption that the address was right and we
       were being refused; the address was wrong the whole time.

       What separates two candidates is a comma that follows a complete
       candidate — and a URL may never contain whitespace, so the tokens are
       unambiguous: read the address up to the first space, then its optional
       descriptor, then expect a comma. */
    function parseSrcset(srcset) {
      const s = String(srcset || "");
      const out = [];
      let i = 0;
      while (i < s.length) {
        while (i < s.length && /[\s,]/.test(s[i])) i++;          // between candidates
        if (i >= s.length) break;
        const start = i;
        while (i < s.length && !/\s/.test(s[i])) i++;            // the address
        let url = s.slice(start, i);
        // a trailing comma IS the separator, and then there is no descriptor
        let ended = false;
        while (url.slice(-1) === ",") { url = url.slice(0, -1); ended = true; }
        let desc = "";
        if (!ended) {
          while (i < s.length) {
            while (i < s.length && /[ \t]/.test(s[i])) i++;
            if (i >= s.length) break;
            if (s[i] === ",") { i++; break; }
            const d0 = i;
            while (i < s.length && !/[\s,]/.test(s[i])) i++;
            desc = s.slice(d0, i);
            if (s[i] === ",") { i++; break; }
          }
        }
        if (url) out.push({ url, desc });
      }
      return out;
    }

    function widestFromSrcset(srcset) {
      let best = "", bestW = -1;
      parseSrcset(srcset).forEach(({ url, desc }) => {
        if (!url || PLACEHOLDER.test(url) || /^data:/i.test(url)) return;
        /* Debris guard. If a shop ever serves a srcset this parser cannot
           read, a fragment like "0&fmt=webp" must not be stored as a photo.
           An address either has a path, or it is a bare filename beside the
           page — anything else is a piece of a query string. */
        if (!url.includes("/") && !/^[\w@.~-]+\.[a-z0-9]{2,5}$/i.test(url)) return;
        const w = /(\d+)w$/.test(desc) ? parseInt(desc, 10)
          : /(\d+(?:\.\d+)?)x$/.test(desc) ? parseFloat(desc) * 1000
          : 0;
        if (w > bestW) { bestW = w; best = url; }
      });
      return best;
    }

    /* A colour swatch is not the garment.

       Tiles that let you preview colourways put those chips inside the tile,
       often BEFORE the photograph, and the first <img> was taken on sight — so
       the row was stored holding a 40px chip. Like the broken address before
       it, that counts as "has a photo" everywhere downstream, so every check
       said the scan was healthy while the LAB showed sixty colour dots.

       The only structural evidence is the shop's own declared size: a picture
       the markup itself says is 100px square is not the product shot. Nothing
       is guessed from class names, and an image with no declared size is never
       skipped — it is far worse to drop a photograph than to keep a chip. */
    function tinyPicture(img) {
      const num = a => {
        const v = parseInt(String(img.getAttribute(a) || "").replace(/px$/i, ""), 10);
        return isFinite(v) ? v : 0;
      };
      const w = num("width"), h = num("height");
      return !!(w && h && w <= 100 && h <= 100);
    }

    /* …and the other structural evidence: the shop's own words.

       Varley's grid puts a row of colour swatches under each photograph, and
       labels each one "Color swatch for Mid Tan" — the accessibility text a
       swatch has to carry to be operable at all. Those swatches are not
       declared at 40px anywhere, so the size guard above cannot see them, and
       the reader came back with a flat block of colour as the garment and
       "Color swatch for Mid Tan" as its name. Measured on a fixture built from
       that page: thirty rows, thirty swatches.

       This is the shop stating what the picture IS, in the one place the
       markup gives it — the same kind of fact as a declared width, and not a
       class name or a selector. */
    const SWATCH_TEXT = /\bcolou?r\s*swatch\b|\bswatch\s+for\b|^\s*swatch\b/i;
    function isSwatch(el) {
      if (!el || !el.getAttribute) return false;
      const said = (el.getAttribute("alt") || "") + " " +
        (el.getAttribute("aria-label") || "") + " " + (el.getAttribute("title") || "");
      return SWATCH_TEXT.test(said);
    }

    /* url() out of a background declaration, image-set() included: a shop may
       list several densities there, and the densest is the one worth keeping. */
    function bgUrl(style) {
      const s = String(style || "");
      if (!/background(-image)?\s*:/i.test(s) || !/url\(/i.test(s)) return "";
      const re = /url\(\s*["']?([^"')]+?)["']?\s*\)(?:\s*(\d+(?:\.\d+)?)(x|w))?/gi;
      let m, best = "", bestW = -1;
      while ((m = re.exec(s))) {
        const w = m[2] ? parseFloat(m[2]) * (m[3] === "x" ? 1000 : 1) : 0;
        if (w > bestW) { bestW = w; best = m[1]; }
      }
      return best;
    }

    const IMG_ATTRS = ["src", "data-src", "data-lazy-src", "data-original", "data-image",
      "data-echo", "data-hi-res-src", "data-image-src", "data-src-large",
      "data-zoom", "data-zoom-src", "data-large", "data-default-src",
      "data-flickity-lazyload", "data-bgset"];

    function bestImage(el) {
      if (!el || !el.querySelector) return "";
      const cands = [];
      /* Every <img> in the tile, in the order the shop wrote them, skipping
         the ones it declares as chips — unless the tile has exactly one
         picture, in which case a small declared size is a dense grid's layout
         rather than a swatch, and dropping it would trade a real photograph
         for a blank card. */
      const all = [...(el.querySelectorAll("img") || [])].filter(i => !isSwatch(i));
      const imgs = all.length > 1 ? all.filter(i => !tinyPicture(i)) : all;
      imgs.forEach(img => {
        // widest first, then the plain attributes lazy loaders populate
        cands.push(widestFromSrcset(img.getAttribute("srcset")));
        cands.push(widestFromSrcset(img.getAttribute("data-srcset")));
        IMG_ATTRS.forEach(a => cands.push(img.getAttribute(a) || ""));
      });
      // <picture><source srcset> — the <img> inside may never get a usable src
      (el.querySelectorAll("picture source, source") || []).forEach(s => {
        cands.push(widestFromSrcset(s.getAttribute("srcset") || s.getAttribute("data-srcset")));
      });
      // a background image, inline or waiting in a lazy loader's attribute
      if (el.getAttribute) cands.push(bgUrl(el.getAttribute("style")));
      (el.querySelectorAll(BG_SEL) || []).forEach(n => {
        cands.push(bgUrl(n.getAttribute("style")));
        BG_ATTRS.forEach(a => {
          const v = n.getAttribute(a) || "";
          // data-bgset holds a srcset; the rest hold one address
          cands.push(/\s\d+[wx],|\s\d+[wx]$/.test(v) ? widestFromSrcset(v) : v);
        });
      });
      /* Last: the copy inside <noscript>. Older lazy loaders leave the real
         photograph only there, and the visible <img> is a blur placeholder —
         with scripting on, the browser keeps that markup as TEXT, so it has to
         be read as text. It is the shop's own address either way. */
      let hit = cands.find(c => c && !PLACEHOLDER.test(c));
      if (!hit) {
        for (const ns of (el.querySelectorAll("noscript") || [])) {
          const txt = ns.textContent || "";
          const ss = txt.match(/srcset\s*=\s*["']([^"']+)["']/i);
          const one = txt.match(/<img[^>]*\ssrc\s*=\s*["']([^"']+)["']/i);
          const pick = (ss && widestFromSrcset(ss[1])) || (one && one[1]) || "";
          if (pick && !PLACEHOLDER.test(pick)) { hit = pick; break; }
        }
      }
      return hit || "";
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
    function bestName(el, priceText, url) {
      // every heading/title candidate, not just the first — the first one is
      // often a hidden a11y label sitting above the real title
      const heads = (el.querySelectorAll ? el.querySelectorAll(
        'h1,h2,h3,h4,h5,h6,[class*="title" i],[class*="name" i],[class*="heading" i]') : []);
      for (const h of heads) {
        const ht = textOf(h);
        if (ht !== priceText && goodName(ht, h, el)) return ht;
      }

      /* The alt of the PHOTOGRAPH, never the alt of a colour chip.

         tinyPicture already keeps 40px swatches out of the image column
         (v2.5.0) and the name path never learned the same thing, so a tile
         that previews its colourways before the garment was filed under
         "Black" — with the right photograph beside it, which is what makes it
         invisible: the row looks complete. Same rule, same reason: a picture
         the markup itself declares as 100px square is not the garment, and an
         image with no declared size is never skipped. */
      const imgs = [...((el.querySelectorAll && el.querySelectorAll("img")) || [])]
        .filter(i => !isSwatch(i));
      const img = imgs.length > 1 ? (imgs.find(i => !tinyPicture(i)) || imgs[0]) : imgs[0];
      const alt = img && (img.getAttribute("alt") || "").trim();
      if (alt && alt.length >= 3 && alt.length <= 150 && !isUiText(alt) &&
          !SWATCH_TEXT.test(alt) &&
          !/^(image|photo|thumbnail|product|products|img|picture)$/i.test(alt)) return alt;

      /* A picture drawn as a CSS background still has the shop's own words on
         it — in aria-label, because that is the only way such an element can
         name itself to a screen reader. It is the same fact <img alt> carries,
         written where the markup forced it to go, and not reading it cost the
         WHOLE ROW: with the name empty and the price excluded there was
         nothing left to keep, so a grid of background-image tiles inside
         wrapping links came back as zero products — an empty spreadsheet for
         that shop, which is the worst result this tool can produce. */
      if (!alt) {
        const lit = [...((el.querySelectorAll && el.querySelectorAll("[aria-label]")) || [])]
          .find(n => bgUrl(n.getAttribute("style")) ||
            (n.getAttribute("role") || "").toLowerCase() === "img");
        const bl = lit && (lit.getAttribute("aria-label") || "").trim();
        if (bl && bl.length >= 3 && bl.length <= 150 && !isUiText(bl)) return bl;
      }

      const a = el.tagName === "A" ? el : (el.querySelector && el.querySelector("a[href]"));
      const label = a && ((a.getAttribute("title") || a.getAttribute("aria-label") || "").trim());
      if (label && label.length >= 3 && label.length <= 200 && !isUiText(label)) return label;

      // longest visible text run in the tile that isn't the price or interface
      let best = "";
      (el.querySelectorAll ? el.querySelectorAll("*") : []).forEach(n => {
        if (n.children && n.children.length) return;   // only leaf-ish nodes
        const t = textOf(n);
        if (t === priceText || PRICE_RE.test(t)) return;
        if (t.length > best.length && goodName(t, n, el)) best = t;
      });
      // nothing on the tile is usable -> the shop's own slug, never a guess
      return best || nameFromSlug(url || bestUrl(el, url) || "");
    }
    // Did bestName fall back to the URL slug? Then a real name from structured
    // data outranks it.
    function isSlugName(name, url) {
      return !!name && name === nameFromSlug(url || "");
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

      /* 2) climb to the tile (has a picture + a link), dedupe by node.

         When several elements in one tile carry the price, the SMALLEST one is
         the price — a wrapper matches too, and its text is the name and the
         price run together. Markup rarely puts whitespace between those two
         nodes, so "Style Number 1" beside "89,00 €" reads as one string and
         the row was stored holding "189,00 €": the trailing 1 of the name
         became part of the money. Shop names ending in a number are ordinary
         (501, Air Max 90, Tee 2.0), so this was quietly wrong wherever they
         appear. The shortest match cannot contain the name. */
      const leafSet = new Set(priceLeaves);
      const wrapper = new Set();
      priceLeaves.forEach(l => {
        for (const k of (l.querySelectorAll ? l.querySelectorAll("*") : []))
          if (leafSet.has(k)) { wrapper.add(l); break; }
      });
      const tiles = new Map();   // node -> price leaf
      for (const leaf of priceLeaves) {
        if (wrapper.has(leaf)) continue;         // something smaller says it better
        const tile = tileAncestor(leaf, 6);
        if (!tile) continue;
        const prev = tiles.get(tile);
        if (!prev || textOf(leaf).length < textOf(prev).length) tiles.set(tile, leaf);
      }

      // Sale pairs: listings render "was $69.99  now $30.00" side by side. Read
      // every price in the leaf's price ROW (its parent) — exactly two distinct
      // values means a markdown: lower = current, higher = original. A semantic
      // strike-through (<del>/<s>/<strike>) in the tile is used the same way.
      // Anything else keeps the old single-price behavior.
      const PRICE_ALL = new RegExp(PRICE_RE.source, "g");
      const priceNum = s => parseFloat(String(s).replace(/[^0-9.]/g, ""));
      function pricePairFrom(leaf, tile) {
        const rowText = textOf(leaf.parentElement || leaf);
        const toks = [...new Set((rowText.match(PRICE_ALL) || []).map(t => t.trim()))];
        if (toks.length === 2 && priceNum(toks[0]) !== priceNum(toks[1])) {
          const [a, b] = toks;
          return priceNum(a) < priceNum(b) ? { price: a, price_was: b } : { price: b, price_was: a };
        }
        const price = firstPrice(textOf(leaf));
        const del = tile && tile.querySelector && tile.querySelector("del, s, strike");
        if (del) {
          const was = firstPrice(textOf(del));
          if (was && price && priceNum(was) > priceNum(price)) return { price, price_was: was };
          // the found leaf may itself be the struck-out original — pick the
          // other price in the tile as current
          if (was && was === price) {
            const all = [...new Set((textOf(tile).match(PRICE_ALL) || []).map(t => t.trim()))]
              .filter(t => t !== was);
            if (all.length === 1 && priceNum(all[0]) < priceNum(was)) return { price: all[0], price_was: was };
          }
        }
        return { price, price_was: "" };
      }

      // 3) require repetition — reject signatures with < 3 members (promo one-offs)
      const bySig = new Map();
      tiles.forEach((leaf, tile) => {
        const sig = signature(tile);
        (bySig.get(sig) || bySig.set(sig, []).get(sig)).push(tile);
      });
      const validTiles = new Set();
      bySig.forEach(list => { if (list.length >= 3) list.forEach(t => validTiles.add(t)); });

      // 4) extract, dedupe by URL
      const seen = new Set();
      const out = [];
      for (const [tile, leaf] of tiles) {
        if (!validTiles.has(tile) || out.length >= MAX_TILES) continue;
        if (inRecommendation(tile)) continue;   // drop recommendation/cross-sell carousels
        const product_url = bestUrl(tile, base);
        if (!product_url || seen.has(product_url)) continue;
        seen.add(product_url);
        const pp = pricePairFrom(leaf, tile);
        // keep the tile even if the name is weak/empty (generic alt) — JSON-LD
        // below may supply the real name for this URL; unnamed rows are dropped
        // at the end.
        out.push({
          brand: "", category: "", department: "",
          name: bestName(tile, pp.price, product_url) || "", price: pp.price, price_was: pp.price_was,
          product_url,
          // Absolute, always. Themes write pictures three ways — full URL,
          // protocol-relative (//shop/cdn/…, Shopify's default) and root-relative
          // (/cdn/shop/files/…) — and the last two only mean anything next to the
          // page they came from. Stored raw they resolve against the extension
          // later and every card reads NO IMAGE.
          image_url: (u => u ? abs(u, base) : "")(bestImage(tile)),
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
          if (p.name && (!existing.name || isSlugName(existing.name, existing.product_url)))
            existing.name = p.name;
          if (!existing.price && p.price) existing.price = p.price;
          if (!existing.image_url && p.image) existing.image_url = absImage(p.image, base);
        } else if (p.name && out.length < MAX_TILES) {
          const rec = { brand: "", category: "", department: "",
            name: p.name, price: p.price || "", product_url: p.url,
            image_url: absImage(p.image, base), id: p.url };
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
    /* How many the shop says it is showing.
       Read from the ELEMENT that says it, not from the page's flattened text:
       neighbouring elements run together there, so a heading next to the count
       reads as "New In48 items" and neither end of the number has a word
       boundary. Measured — the count came back 0 on exactly the page that
       needed it. The same failure as the price fusing with the name; the
       answer is the same, read the smallest thing that says it. */
    const COUNT_RE = /(?:^|[^\d])(\d[\d,]{0,6})\s*(?:results?|items?|products?|styles?)(?![a-z])/i;
    function resultCount(doc) {
      doc = doc || document;
      const els = doc.querySelectorAll
        ? doc.querySelectorAll("span,div,p,h1,h2,h3,strong,b,li,small") : [];
      for (const el of els) {
        if (el.children && el.children.length > 2) continue;
        const t = ((el.textContent || "").replace(/\s+/g, " ").trim());
        if (!t || t.length > 40) continue;
        const m = t.match(COUNT_RE);
        if (m) return parseInt(m[1].replace(/,/g, ""));
      }
      const m = ((doc.body && doc.body.textContent) || "").match(COUNT_RE);
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

    /* The detail phase for every shop nobody has written an adapter for.

       Half the team's list (66 of 132 domains) lands here, and until now this
       adapter had no fetchDetail at all — so those brands could never produce
       a fabric or a colourway, no matter how plainly their product pages
       stated it. The reader is entirely structural (JSON-LD + fibre-validated
       text), so this is not "support for 66 sites" written 66 times; it is the
       one thing every product page has in common.

       The list entry supplies the brand, so nothing here needs to guess it. */
    const fetchDetail = url => fetchProductPage(url, "");

    return {
      id: "generic",
      label: "Generic site (basic info only)",
      platform: true,      // a fallback engine, not a brand — never a grouping name
      match: () => true,   // catch-all; manifest.json's host allowlist is the real gate
      /* Scroll before scraping. Modern grids render tiles as they come into
         view, so reading the DOM at load time returns the first screenful and
         calls it the category — the single most common way an unadapted shop
         under-collects. The scroll loop stops as soon as the tile count and
         page height hold steady, so a site that renders everything up front
         pays about a second and nothing more. */
      lazyScroll: 18,
      context, scrapeList, totalPages, resultCount, nextPageUrl, buildWorkbook, isResultsPage,
      fetchDetail,
      templateUrl: null,
      _tileAncestor: tileAncestor, _signature: signature, _bestName: bestName,
      _bestImage: bestImage, _widestFromSrcset: widestFromSrcset, _parseSrcset: parseSrcset,
      /* The diagnosis has to ask the same question the reader asked, or it
         reports "no prices on this page" about a page full of them. */
      _PRICE_RE: PRICE_RE, _BG_SEL: BG_SEL,
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
    // The collection page the current scan is reading. Detail lookups need it to
    // find the bulk JSON endpoint; the product URL alone doesn't name the
    // collection it came from.
    let _listUrl = "";

    function match(url, doc) {
      if (!doc || !doc.querySelector) return false;
      return !!doc.querySelector(
        'link[href*="cdn.shopify.com"], script[src*="cdn.shopify.com"], ' +
        'link[href*="/cdn/shop/"], script[src*="/cdn/shop/"], ' +
        '#shopify-features, meta[name="shopify-checkout-api-token"]');
    }

    /* Category from the collection handle in the URL: /collections/mini-dresses
       -> "Mini Dresses". This is literal site structure, not a guess.

       Shopify also serves a collection narrowed by tag at
       /collections/<handle>/<tag> — Gymshark's womenswear is
       /collections/everyday/womens, and calling that page "Everyday" throws
       away the half the designer actually chose. The tag is site structure
       too, so it is kept. Not every second segment is a tag: /products/ under
       a collection is a product page, and Shopify's own routes (/page/N for
       pagination, and the tag negation form) are addresses, not categories. */
    const NOT_A_TAG = /^(products?|page|all)$/i;
    function categoryFromUrl(url) {
      const m = String(url || "").match(/\/collections\/([^/?#]+)(?:\/([^/?#]+))?/i);
      if (!m) return "";
      const title = s => decodeURIComponent(s).replace(/[-+]/g, " ").replace(/\b\w/g, c => c.toUpperCase());
      let out = title(m[1]);
      if (m[2] && !NOT_A_TAG.test(m[2]) && !/^\d+$/.test(m[2])) out += " " + title(m[2]);
      return out;
    }

    function scrapeList(doc, url) {
      doc = doc || document;
      if (url) _listUrl = url;
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
            product_url: href,
            image_url: img ? absImage(img.getAttribute("src") || img.getAttribute("data-src"), url) : "",
            id: href });
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
        composition, colorways, design: copyOf(p.description || p.body_html),
        brand: realVendor(p.vendor, p.handle),
        name: p.title || "", name_canonical: !!p.title,
        category: p.type || "",
        price_was,
        image_url: shopifyImage(p),
        reason: composition ? "" : "not_found",
      };
    }

    /* ---- bulk collection JSON ----------------------------------------------

       Every Shopify storefront publishes its catalogue as JSON at
         /collections/<handle>/products.json?limit=250&page=N
       with no key and no CORS trouble from the page's own origin. One request
       returns up to 250 products COMPLETE — vendor, product_type, tags, every
       option value (so the full colour list), every variant price and
       compare_at_price, and published_at (when the product actually went live).

       Why bother when we already read each PDP's .js? Because this is one
       request instead of N: a 200-product collection goes from 200 fetches to
       one, which is the difference between a scan that finishes and a scan the
       shop starts rate-limiting. The data is also richer and identical in shape
       for every Shopify shop, so there is nothing site-specific to maintain.

       It does NOT decide WHICH products get collected — the rendered page still
       does that, so the storefront filters and sort the user chose are respected
       and the charter's "scan what's on screen" rule is untouched. This is
       enrichment keyed by handle: anything the bulk pull doesn't cover falls
       back to the per-product endpoint below. */
    const BULK_PAGES = 4, BULK_LIMIT = 250;
    let _bulk = null;                       // { key, map: Map<handle, product> }

    const handleOf = u => {
      const m = String(u || "").match(/\/products\/([^/?#]+)/i);
      return m ? decodeURIComponent(m[1]).toLowerCase() : "";
    };

    async function loadBulk(listUrl) {
      let base;
      try {
        const x = new URL(listUrl);
        const m = x.pathname.match(/\/collections\/([^/?#]+)/i);
        if (!m) return null;
        base = x.origin + x.pathname.slice(0, x.pathname.indexOf(m[0]) + m[0].length);
      } catch (e) { return null; }
      if (_bulk && _bulk.key === base) return _bulk.map;

      const map = new Map();
      for (let page = 1; page <= BULK_PAGES; page++) {
        let list;
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 15000);
          let res;
          try {
            res = await fetch(`${base}/products.json?limit=${BULK_LIMIT}&page=${page}`,
              { credentials: "include", signal: ctrl.signal });
          } finally { clearTimeout(timer); }
          if (!res.ok) break;
          const j = await res.json();
          list = j && j.products;
        } catch (e) { break; }                       // shop disabled it — fall back
        if (!Array.isArray(list) || !list.length) break;
        list.forEach(p => { if (p && p.handle) map.set(String(p.handle).toLowerCase(), p); });
        if (list.length < BULK_LIMIT) break;
      }
      _bulk = { key: base, map };
      return map;
    }

    /* ---- when the grid keeps most of the collection ------------------------

       Set Active's /collections/new rendered four tiles and the scan graded
       itself complete. The rescue that exists for exactly this — press the
       shop's "load more", sweep the grid again — is gated on the page PRINTING
       how many it is showing ("66 items"), and plenty of themes print no such
       number anywhere. With nothing to be short OF, nothing was pressed,
       nothing was swept, and four of sixty-six looked like success. That is
       the one failure this tool must not have: a half scan that reports itself
       whole, because the spreadsheet then looks perfectly fine.

       A Shopify shop does not have to print it. The collection's own JSON
       lists exactly what the collection holds, needs no key, and we already
       fetch it for the composition. So when the address carries no filter —
       when there is nothing of the designer's choosing to preserve — the
       shop's list of the collection IS the collection. Whatever the grid never
       rendered is appended AFTER what it did, so the merchandiser's order
       still leads, which is what the ranking in that order is for.

       With a filter on the address the rendered page keeps deciding, because
       products.json knows nothing about the facets that were chosen. */
    /* A parameter we do not recognise is still a filter.

       Listing the ones that narrow a collection is the wrong way round: every
       theme invents its own. Varley writes ?o_cat=Tops&o_cat=Sweatshirts,
       Gymshark writes ?collections=t-shirts-tops, and neither looks like
       Shopify's own filter.*; both read as "no filter at all" against a list
       of known filters, and topping those up would put back precisely the
       products the designer excluded. So the list is the other one — the
       parameters that are known NOT to change which products are shown — and
       anything else means the rendered page decides. */
    const HARMLESS_PARAM =
      /^(page|sort_by|view|utm_[a-z]+|gclid|fbclid|srsltid|gad_source|ref|_pos|_sid|_ss|_fd|_psq)$/i;
    function collectionFiltered(u) {
      try {
        const x = new URL(u);
        if (x.hash && /[=&]/.test(x.hash)) return true;
        for (const k of x.searchParams.keys()) {
          if (!HARMLESS_PARAM.test(k)) return true;
        }
        /* /collections/<handle>/<tag> — the tag narrows the collection, and it
           is a name the shop wrote, so both halves are kept elsewhere; here it
           means the JSON for <handle> would be a wider set than the page. */
        const segs = x.pathname.split("/").filter(Boolean);
        const i = segs.indexOf("collections");
        if (i >= 0 && segs.length > i + 2 && segs[i + 2] !== "products") return true;
      } catch (e) { return true; }
      return false;
    }

    async function completeList(rows, listUrl, cap) {
      rows = rows || [];
      if (collectionFiltered(listUrl)) return rows;
      let origin = "";
      try { origin = new URL(listUrl).origin; } catch (e) { return rows; }
      const map = await loadBulk(listUrl);
      if (!map || !map.size) return rows;
      const have = new Set(rows.map(r => handleOf(r.product_url)).filter(Boolean));
      if (have.size >= map.size) return rows;
      /* products.json carries the amount but not the currency. The symbol the
         shop writes on this very page is the shop's own text, so it is taken
         from a tile that did render rather than guessed at; with no tile to
         read, the bare amount stands on its own. */
      let symbol = "";
      for (const r of rows) {
        const m = String(r.price || "").match(/^\s*([^\d\s.,]{1,3})/);
        if (m) { symbol = m[1]; break; }
      }
      const category = categoryFromUrl(listUrl);
      const limit = cap && cap > 0 ? cap : 60;
      const out = rows.slice();
      for (const p of map.values()) {
        if (out.length >= limit) break;
        const h = String((p && p.handle) || "").toLowerCase();
        if (!h || have.has(h)) continue;
        have.add(h);
        const v = (p.variants && p.variants[0]) || null;
        const amount = v && v.price != null ? String(v.price) : "";
        const url = `${origin}/products/${h}`;
        out.push({
          brand: "", category, department: "",
          name: p.title || "", price: amount ? symbol + amount : "",
          product_url: url, image_url: shopifyImage(p) || "", id: url,
        });
      }
      return out;
    }

    // products.json shape: prices are decimal strings, options carry every value.
    /* Shopify's "vendor" is a free-text field, and plenty of own-brand shops
       put the style code in it — Edikted filled a whole spreadsheet's brand
       column with S23887_LIGHT-GRAY-MELANGE, which is that product's own
       handle. A value that is the product's identifier is not a brand, so
       drop it and let the list entry's brand stand. */
    function realVendor(vendor, handle) {
      const v = String(vendor || "").trim();
      if (!v) return "";
      const norm = x => String(x || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
      if (handle && norm(v) === norm(handle)) return "";
      // a bare style code (letters+digits, no space) is a code, not a name
      if (!/\s/.test(v) && /\d/.test(v) && /[_-]/.test(v)) return "";
      return v;
    }

    /* Shopify states the product's own image in every JSON shape it serves:
       products.json gives `images:[{src}]`, the per-product .js gives
       `featured_image` (protocol-relative) and `images:[url]`. Any of them is
       a fact from the shop, which beats a lazy grid that never rendered. */
    function shopifyImage(p) {
      if (!p || typeof p !== "object") return "";
      const first = [].concat(p.images || [])[0];
      /* Some shops carry no product-level photo in products.json and hang the
         picture off the first variant instead — Vuori does, which is why a
         whole grid of theirs came back with the fabric filled in and NO IMAGE
         on every card. Still the shop's own JSON, so still a fact. */
      const vimg = ([].concat(p.variants || [])
        .map(v => v && (v.featured_image && (v.featured_image.src || v.featured_image)))
        .find(Boolean)) || "";
      const cand = (first && (first.src || first)) || p.featured_image || vimg || "";
      const s = String(cand || "").trim();
      if (!s) return "";
      return s.slice(0, 2) === "//" ? "https:" + s : s;
    }

    /* Shopify hands the shop's own copy back in its JSON, so the design words
       come for free — no product page fetch needed for the 47% of the team's
       list that runs on it. Same bound as the shared reader. */
    const copyOf = html => String(html || "")
      .replace(/<br\s*\/?>|<\/(p|li|div|h\d)>/gi, " · ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&[a-z]+;|&#\d+;/gi, " ")
      .replace(/\s*·\s*(?=·)/g, "")
      .replace(/\s+/g, " ").trim().slice(0, 400);

    function parseCollectionProduct(p) {
      const opt = (p.options || []).find(o => /colou?r/i.test(((o && (o.name || o)) || "") + ""));
      const colorways = opt ? (opt.values || []).join("; ") : "";
      const composition = compositionFromText(p.body_html || "");
      const num = v => { const n = parseFloat(String(v || "").replace(/,/g, "")); return isFinite(n) ? n : null; };
      let price_was = "";
      const v = (p.variants || [])[0];
      if (v) {
        const now = num(v.price), was = num(v.compare_at_price);
        if (was != null && now != null && was > now) price_was = was.toFixed(2);
      }
      return {
        composition, colorways, design: copyOf(p.body_html),
        brand: realVendor(p.vendor, p.handle),
        name: p.title || "", name_canonical: !!p.title,
        category: p.product_type || "",
        /* Kept separately as well. The category column carries the name the
           designer gave the page, which overwrites this — but the shop's own
           product type is the best answer there is to "what garment is this",
           and INSIGHTS splits by that. */
        product_type: p.product_type || "",
        price_was,
        // The shop's own photo for this product. Only used where the tile gave
        // none (applyDetail never overwrites a picture the listing supplied),
        // and it costs nothing — the bulk pull already carries it.
        image_url: shopifyImage(p),
        // when the shop actually published it — a real launch date, unlike our
        // own "first seen". Stored for later; trends still bucket by first-seen
        // so brands measured different ways never get compared as if equal.
        launched_at: p.published_at || "",
        reason: composition ? "" : "not_found",
      };
    }

    /* The PDP itself, as the composition's last resort.

       Plenty of themes (Edikted's "FABRIC & CARE" accordion among them) render
       the blend on the product page WITHOUT putting it in the description that
       products.json / the .js endpoint return — which left every row red even
       though the words are right there for a shopper. Structured data first
       (JSON-LD material/description), then the page text, both through the
       fiber-validated parser, so nothing that isn't a real blend passes. */
    /* The product page itself, when the shop's own JSON did not say.

       It reads it with the SAME reader every other engine uses
       (shared.readProductPage), and that is the point of the change that put
       it here: this function had grown its own copy, and the copy had drifted.
       It ended on `doc.body.textContent`, where every tag is already gone — so
       a spec list came back as one unbroken string and the item after the
       composition was glued to it:

         <li>100% Nylon</li><li>Machine wash cold</li>
           → "100% NylonMachine wash cold"

       "NylonMachine" is not the word nylon, so the fibre was never named and
       the cell came back empty. Measured on a fixture built from Gymshark's
       Everyday Seamless page: 100% Nylon and 100% Cotton read as nothing, and
       92% Nylon, 8% Elastane lost the elastane. The shared reader puts the
       list items on their own lines first, which is exactly the boundary that
       was missing. Same failure as "New In48 items" in v2.8.0, and the same
       answer: read it from the smallest thing that states it. */
    async function compFromPdp(url) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 12000);
        let res;
        try { res = await fetch(url, { credentials: "include", signal: ctrl.signal }); }
        finally { clearTimeout(timer); }
        if (!res.ok) return { composition: "", image: "" };
        const html = await res.text();
        const doc = new DOMParser().parseFromString(html, "text/html");
        try {
          const read = readProductPage(doc, html, "", url);
          if (read && (read.composition || read.image_url)) {
            return { composition: read.composition || "", image: read.image_url || "" };
          }
        } catch (e) { /* fall through to the pass below */ }
        let comp = "";
        doc.querySelectorAll('script[type="application/ld+json"]').forEach(sc => {
          if (comp) return;
          let d; try { d = JSON.parse(sc.textContent); } catch (e) { return; }
          for (const n of [].concat(Array.isArray(d) ? d : (d["@graph"] || [d]))) {
            if (!n || typeof n !== "object") continue;
            comp = compositionFromText(String(n.material || "")) ||
                   compositionFromText(String(n.description || ""));
            if (comp) return;
          }
        });
        /* The page is already parsed, so the photo costs nothing more. The
           bulk pull is enrichment rather than a verdict — that was settled for
           the composition, and a missing PICTURE is the same situation: the
           product page shows one, and a card that says NO IMAGE on a garment
           the shop photographed is simply wrong. */
        let image = "";
        try {
          const og = doc.querySelector('meta[property="og:image"], meta[name="og:image"]');
          image = absImage((og && og.getAttribute("content")) || "", url);
        } catch (e) {}
        if (!image) {
          doc.querySelectorAll('script[type="application/ld+json"]').forEach(sc => {
            if (image) return;
            let d; try { d = JSON.parse(sc.textContent); } catch (e) { return; }
            for (const n of [].concat(Array.isArray(d) ? d : (d["@graph"] || [d]))) {
              if (!n || typeof n !== "object" || !n.image) continue;
              const c = [].concat(n.image)[0];
              image = absImage(typeof c === "string" ? c : (c && c.url) || "", url);
              if (image) return;
            }
          });
        }
        return { composition: comp || compositionFromText((doc.body && doc.body.textContent) || ""), image };
      } catch (e) { return { composition: "", image: "" }; }
    }

    async function fetchDetail(url, have) {
      const empty = r => ({ composition: "", colorways: "", design: "", reason: r });
      /* One bulk pull covers the whole collection — but it is enrichment, not
         a verdict. When its body_html states no blend, the chain keeps going
         (.js only when bulk never saw the handle, then the PDP itself);
         stopping at the bulk answer is what left Edikted's and Alo's fabric
         columns red while the PDPs displayed the composition all along. */
      let out = null;
      if (_listUrl) {
        const map = await loadBulk(_listUrl);
        const hit = map && map.get(handleOf(url));
        if (hit) out = parseCollectionProduct(hit);
      }
      if (!out) {
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
          if (!res.ok) out = empty(res.status === 404 ? "not_found" : "blocked");
          else out = parseProductJson(await res.json(), "");
        } catch (e) {
          out = empty((e && e.name === "AbortError") ? "timeout" : "error");
        }
      }
      /* Go to the product page when either fact is still missing. Vuori is
         why the picture joined the composition here: its bulk JSON answered
         the blend, so the chain stopped, and the grid — lazy, so the tiles had
         given nothing — produced sixty cards reading NO IMAGE for products the
         shop photographs. One page fetch answers both, and only rows that are
         actually short of something pay for it. */
      /* The listing may already have supplied the picture. Then the page is
         only worth opening if the blend is still missing — otherwise every
         row on a shop whose grid renders its photos paid for a page load
         that could not tell us anything new. */
      const wantImage = !out.image_url && !(have && have.image);
      if (!out.composition || wantImage) {
        const pdp = await compFromPdp(url);
        if (pdp && pdp.composition && !out.composition) { out.composition = pdp.composition; out.reason = ""; }
        if (pdp && pdp.image && !out.image_url) out.image_url = pdp.image;
      }
      return out;
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
      label: "Shopify store",
      // The label names the PLATFORM, not a brand — the panel must never file
      // a list entry (or an Excel brand column) under "Shopify store".
      platform: true,
      /* Modern Shopify themes (Edikted's among them) render the grid as you
         scroll: at load only the first viewport of tiles exists in the DOM, so
         scraping straight away collected a handful of products or none at all.
         Every other infinite-grid adapter already scrolls first; shopify was
         the one that didn't. */
      lazyScroll: true,
      match, context, scrapeList, completeList,
      totalPages: generic.totalPages,
      resultCount: generic.resultCount,
      nextPageUrl: generic.nextPageUrl,       // Shopify collections use ?page=N and keep filter params
      isResultsPage: generic.isResultsPage,
      fetchDetail, buildWorkbook: generic.buildWorkbook,
      templateUrl: null,
      _parseProductJson: parseProductJson, _categoryFromUrl: categoryFromUrl,
      _parseCollectionProduct: parseCollectionProduct, _handleOf: handleOf,
      _collectionFiltered: collectionFiltered,
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
        if (t && t.length <= 60 && !notACategory(t)) return t;
      }
      return categoryFromUrl(url);
    }

    // PDP sale price: the Cotton On product page shows a markdown the LISTING
    // tile often hides — e.g. "$49.99  $35.00  (-30%)" (struck original, sale,
    // percent off). Layered read: JSON-LD offers first, then a strikethrough
    // element, then the "orig sale (-N%)" text pattern. Returns { price,
    // price_was } where price is the current (lower) amount; price_was is the
    // original only when a genuine markdown is found ("" otherwise).
    const CO_PRICE = /(?:[$₩€£¥]\s?\d[\d,]*(?:\.\d{1,2})?|\d[\d,]*(?:\.\d{1,2})?\s?(?:USD|AUD|NZD|GBP|EUR))/;
    const CO_PRICE_G = new RegExp(CO_PRICE.source, "g");
    const coNum = s => parseFloat(String(s == null ? "" : s).replace(/[^0-9.]/g, ""));
    function priceFromDoc(doc, rawHtml) {
      let price = "", price_was = "";
      // 1) JSON-LD offers — current price
      (doc && doc.querySelectorAll ? doc.querySelectorAll('script[type="application/ld+json"]') : []).forEach(s => {
        let d; try { d = JSON.parse(s.textContent); } catch (e) { return; }
        [].concat(d && d["@graph"] ? d["@graph"] : d).forEach(n => {
          if (!n || !/(^|,)Product(,|$)/i.test([].concat(n["@type"] || []).join(","))) return;
          [].concat(n.offers || []).forEach(o => {
            if (!o) return;
            const cur = o.price || (o.priceSpecification && o.priceSpecification.price);
            if (cur && !price) price = String(cur);
          });
        });
      });
      // 2) DOM strikethrough = original; a sale/now element = current
      if (doc && doc.querySelector) {
        const strike = doc.querySelector('del, s, strike, [class*="strike" i], [class*="was" i], [class*="original" i], [class*="regular" i]');
        const wasTxt = strike && (strike.textContent || "").match(CO_PRICE);
        if (wasTxt) {
          const saleEl = doc.querySelector('[class*="sale" i], [class*="now" i], [class*="reduced" i], [class*="special" i]');
          const saleTxt = saleEl && (saleEl.textContent || "").match(CO_PRICE);
          const w = wasTxt[0];
          const p = (saleTxt && saleTxt[0]) || price;
          if (p && coNum(w) > coNum(p)) { price = p; price_was = w; }
        }
      }
      // 3) text pattern "$49.99 $35.00 (-30%)": two prices immediately before a
      // percent-off — higher = original, lower = current. Robust to markup.
      if (!price_was) {
        const body = (doc && doc.body && doc.body.textContent) || rawHtml || "";
        const m = body.match(new RegExp(CO_PRICE.source + "\\s*" + CO_PRICE.source + "\\s*\\(?\\s*-?\\s*\\d{1,3}\\s*%", "i"));
        if (m) {
          const two = (m[0].match(CO_PRICE_G) || []);
          if (two.length >= 2 && coNum(two[0]) !== coNum(two[1])) {
            const hi = coNum(two[0]) > coNum(two[1]) ? two[0] : two[1];
            const lo = coNum(two[0]) > coNum(two[1]) ? two[1] : two[0];
            price = lo; price_was = hi;
          }
        }
      }
      return { price: price || "", price_was: price_was || "" };
    }

    function parseDetailDoc(doc, rawHtml, url) {
      let brand = "", name = "", image = "";
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
          // the PDP's own photo — a backstop for tiles whose lazy-loaded grid
          // image never resolved (structured data, not a guessed CDN path)
          if (!image) {
            const im = [].concat(n.image || [])[0];
            const u = im && (im.url || im.contentUrl || im);
            if (typeof u === "string") image = absImage(u, url);
          }
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
      /* List items on their own lines BEFORE the whole page, the same order
         the shared reader uses. Flattened body text glues a spec item to the
         one after it — "100% NylonMachine wash cold" — and the fibre stops
         being a word, so the cell comes back empty. */
      const liText = doc.querySelectorAll
        ? [...doc.querySelectorAll("li")].map(li => li.textContent || "").join("\n") : "";
      const composition = compositionFromText(liText)
        || compositionFromText((doc.body && doc.body.textContent) || rawHtml || "");
      const productName = name || nameFromUrl(url || "");
      const design = featuresFromDoc(doc).slice(0, 3).join("\n");   // first 3 Features bullets, one per line
      const category = breadcrumbCategory(doc, productName);
      const pp = priceFromDoc(doc, rawHtml);
      // og:image — the one photo nearly every PDP declares. Semantic markup,
      // not a CSS selector, so it survives redesigns; only used when both the
      // listing tile and JSON-LD gave nothing.
      if (!image && doc.querySelector) {
        const og = doc.querySelector('meta[property="og:image"], meta[name="og:image"]');
        image = absImage(og && og.getAttribute("content"), url);
      }
      return {
        composition, colorways: colors.join("; "), color_count: colorCount || "", image_url: image,
        design, category, brand, sizes: sizes.join("; "),
        price: pp.price, price_was: pp.price_was,
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
      _priceFromDoc: priceFromDoc,
      _colourFromText: colourFromText,
      _nextPageUrl: nextPageUrl, _firstPageUrl: firstPageUrl, _gridPage: gridPage,
      _colorSwatches: colorSwatches, _cleanColourName: cleanColourName,
      _featuresFromDoc: featuresFromDoc, _breadcrumbCategory: breadcrumbCategory,
      _listingCategory: listingCategory, _breadcrumbTrail: breadcrumbTrail,
      _productBase: productBase, _colorsForBase: colorsForBase,
    };
  })();

  // ---------------------------------------------------------------------------
  // Target adapter — custom-SPA multi-brand retailer (SPEC Phase 1), like
  // Walmart. Listings live at /c/<category-slug>/-/N-<id> and /s?searchTerm=…;
  // products at /p/<slug>/-/A-<tcin>. Pagination is an offset param
  // (?Nao=24 — 24 tiles per slice), probed to the end like Cotton On.
  // Extraction is layered per project rule (structured data first, DOM
  // heuristics via the generic engine, no guessed CSS selectors): the list
  // comes from generic.scrapeList filtered to real /p/ product links; detail
  // reads JSON-LD, embedded-JSON "Label: Value" strings, the visible bullet
  // list, then a fiber-% text scan.
  // ---------------------------------------------------------------------------
  const target = (function () {
    const compositionFromText = shared.compositionFromText;
    const titleCase = s => String(s || "").replace(/-+/g, " ").trim().replace(/\b\w/g, c => c.toUpperCase());
    const NAO_STEP = 24;                        // Target's listing slice size

    // /p/<slug>/-/A-89573361 -> tcin "89573361" (the stable product id)
    function tcinOf(url) {
      try { const m = new URL(url).pathname.match(/\/A-(\d{4,})/i); return m ? m[1] : ""; }
      catch (e) { return ""; }
    }
    // /p/women-s-slim-fit-tank-top-a-new-day/-/A-895… -> "Women S Slim Fit Tank Top A New Day"
    function nameFromUrl(url) {
      try {
        const segs = new URL(url).pathname.split("/").filter(Boolean);
        const i = segs.indexOf("p");
        if (i >= 0 && segs[i + 1] && segs[i + 1] !== "-") return titleCase(segs[i + 1]);
      } catch (e) {}
      return "";
    }

    // breadcrumb (JSON-LD BreadcrumbList / nav) — same on-site-name rule as the
    // other adapters: what the shopper sees beats URL slugs.
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
      return trail.filter(t => t && !/^(home|target)$/i.test(t));
    }
    function listingCategory(doc, url) {
      const trail = breadcrumbTrail(doc);
      if (trail.length) return trail[trail.length - 1];
      const h1 = doc.querySelector && doc.querySelector("h1");
      if (h1) {
        const t = (h1.textContent || "").replace(/\s*\(\d[\d,]*\)\s*$/, "").replace(/\s+/g, " ").trim();
        if (t && t.length <= 60 && !notACategory(t) &&
            !/^\d[\d,]*\s*(?:results?|items?)$/i.test(t)) return t;
      }
      try {
        const segs = new URL(url).pathname.split("/").filter(Boolean);
        const i = segs.indexOf("c");
        if (i >= 0 && segs[i + 1]) return titleCase(segs[i + 1]);
      } catch (e) {}
      return "";
    }

    function scrapeList(doc, url) {
      // generic tile scan (price leaf -> tile, reco carousels excluded, JSON-LD
      // merged), then keep only real /p/…/A-<tcin> product links, one per tcin —
      // Target tiles carry several links (image + title) to the same product.
      const raw = generic.scrapeList(doc, url).filter(r => /\/p\//i.test(r.product_url) && tcinOf(r.product_url));
      const pageCat = listingCategory(doc, url);
      const seen = new Set(); const out = [];
      for (const r of raw) {
        const id = tcinOf(r.product_url);
        if (seen.has(id)) continue; seen.add(id);
        r.id = id;
        if (!r.name || r.name.length < 4) { const n = nameFromUrl(r.product_url); if (n) r.name = n; }
        r.category = pageCat || r.category || "";
        out.push(r);
      }
      return out;
    }

    // --- offset pagination (?Nao=0/24/48…), reset + probe like SFCC ----------
    function gridPage(url) {
      try { return Math.floor((parseInt(new URL(url).searchParams.get("Nao")) || 0) / NAO_STEP) + 1; }
      catch (e) { return 1; }
    }
    function firstPageUrl(url) {
      try { const u = new URL(url); u.searchParams.delete("Nao"); u.searchParams.delete("page"); return u.toString(); }
      catch (e) { return url; }
    }
    function nextPageUrl(url, page) {
      try {
        const u = new URL(url);
        u.searchParams.set("Nao", String(page * NAO_STEP));
        u.searchParams.delete("page");
        return u.toString();
      } catch (e) { return null; }
    }

    // Embedded-JSON spec strings: Target's product data carries bullets like
    // "<B>Material:</B> 60% Cotton, 40% Polyester" — strip tags, keep the pair.
    function collectSpecStrings(obj, out, depth) {
      depth = depth || 0;
      if (obj == null || depth > 16) return out;
      if (typeof obj === "string") {
        const t = obj.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        const m = t.match(/^([A-Za-z][A-Za-z /&-]{1,26}):\s*(.+\S)$/);
        if (m && m[2].length <= 240 && !out[m[1].trim()]) out[m[1].trim()] = m[2].trim();
        return out;
      }
      if (Array.isArray(obj)) { for (const v of obj) collectSpecStrings(v, out, depth + 1); return out; }
      if (typeof obj === "object") { for (const k in obj) collectSpecStrings(obj[k], out, depth + 1); }
      return out;
    }

    function parseDetailDoc(doc, rawHtml, url) {
      let brand = "", name = "", image = "";
      const colors = [], sizes = [];
      const addTo = (arr, v) => {
        const s = String(v == null ? "" : v).replace(/\s+/g, " ").trim();
        if (s && s.length <= 40 && !arr.some(x => x.toLowerCase() === s.toLowerCase())) arr.push(s);
      };
      // JSON-LD Product — Target PDPs server-render brand (A New Day, Wild Fable…)
      (doc.querySelectorAll ? doc.querySelectorAll('script[type="application/ld+json"]') : []).forEach(s => {
        let d; try { d = JSON.parse(s.textContent); } catch (e) { return; }
        [].concat(d && d["@graph"] ? d["@graph"] : d).forEach(n => {
          if (!n || !/(^|,)Product(,|$)/i.test([].concat(n["@type"] || []).join(","))) return;
          if (!name && n.name) name = String(n.name);
          if (!brand && n.brand) brand = String(n.brand.name || n.brand);
          // the PDP's own photo — a backstop for tiles whose lazy-loaded grid
          // image never resolved (structured data, not a guessed CDN path)
          if (!image) {
            const im = [].concat(n.image || [])[0];
            const u = im && (im.url || im.contentUrl || im);
            if (typeof u === "string") image = absImage(u, url);
          }
          [].concat(n.color || []).forEach(c => addTo(colors, c));
          [].concat(n.size || []).forEach(z => addTo(sizes, z));
          [].concat(n.hasVariant || []).forEach(v => { if (v) { addTo(colors, v.color); addTo(sizes, v.size); } });
        });
      });
      // specs from embedded JSON strings + the visible bullet list (walmart's
      // DOM bullet reader is shape-agnostic <li>Label: Value</li>)
      const blobs = shared.jsonBlobs(doc);
      const specs = {};
      blobs.forEach(b => collectSpecStrings(b, specs));
      walmart._collectSpecsFromDom(doc, specs);
      if (!brand && specs.Brand) brand = specs.Brand;
      // composition: labeled spec that actually names fibers -> bare fiber-% text
      let composition = "";
      for (const label in specs) {
        if (/material|fabric|composition|shell|body/i.test(label) && shared.FIBER_RE.test(specs[label])) {
          composition = specs[label]; break;
        }
      }
      if (!composition) {
        // bullet lines first (li boundaries preserved), then raw HTML — whose
        // closing tags compositionFromText converts to line breaks itself.
        // body.textContent is NOT used: it glues "…Polyester" + "Machine…" together.
        const liText = doc.querySelectorAll
          ? [...doc.querySelectorAll("li")].map(li => li.textContent || "").join("\n") : "";
        composition = compositionFromText(liText) || compositionFromText(rawHtml || "");
      }
      // design: same base-category mapping as Walmart (Fit/Neckline/Closure/…)
      const parts = []; const used = new Set();
      for (const label in specs) {
        if (/^(?:material|fabric|care|country|size|brand|gender|age|model|price|color|assembled|manufacturer|warranty|count|weight|pack|dimension|tcin|upc|origin|street)/i.test(label)) continue;
        const cat = walmart._designCat(label);
        if (!cat || used.has(cat)) continue;
        used.add(cat);
        let v = String(specs[label]).replace(/\s+/g, " ").trim();
        if (v.length > 90) v = v.slice(0, 90).replace(/[\s,;]+\S*$/, "") + "…";
        parts.push(`${cat}: ${v}`);
      }
      // og:image — the one photo nearly every PDP declares. Semantic markup,
      // not a CSS selector, so it survives redesigns; only used when both the
      // listing tile and JSON-LD gave nothing.
      if (!image && doc.querySelector) {
        const og = doc.querySelector('meta[property="og:image"], meta[name="og:image"]');
        image = absImage(og && og.getAttribute("content"), url);
      }
      return {
        composition, colorways: colors.join("; "), design: parts.join("\n").slice(0, 400), image_url: image,
        brand, sizes: sizes.join("; "),
        reason: composition ? "" : "not_found",
      };
    }

    async function fetchDetail(url) {
      const empty = r => ({ composition: "", colorways: "", design: "", reason: r });
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

    function context(doc) {
      doc = doc || document;
      const url = (doc.location && doc.location.href) || (typeof location !== "undefined" ? location.href : "");
      return {
        brand: "",                          // per-product brands (A New Day, …) fill via detail
        category: listingCategory(doc, url),
        totalPages: null,                   // offset grid -> probe to the end
        page: gridPage(url),
      };
    }

    return {
      id: "target",
      label: "Target",
      multiBrand: true,   // a retailer of many brands — Retailer + Brand shown separately
      lazyScroll: true,   // tiles render on scroll — engine scrolls to the end before scraping
      match: url => /(^|\.)target\.com\//i.test(String(url || "").replace(/^https?:\/\//i, "")),
      context, scrapeList,
      totalPages: () => null,
      resultCount: generic.resultCount,
      nextPageUrl, firstPageUrl,
      isResultsPage: generic.isResultsPage,
      fetchDetail, buildWorkbook: generic.buildWorkbook,
      templateUrl: null,
      _tcinOf: tcinOf, _nameFromUrl: nameFromUrl, _listingCategory: listingCategory,
      _gridPage: gridPage, _nextPageUrl: nextPageUrl, _firstPageUrl: firstPageUrl,
      _parseDetailDoc: parseDetailDoc, _collectSpecStrings: collectSpecStrings,
    };
  })();

  // ---------------------------------------------------------------------------
  // Zara adapter — single-house-brand SPA (Inditex platform). Categories live at
  // /<locale>/<lang>/<slug>-l<id>.html (one continuous infinite-scroll grid, no
  // page param — the engine's lazy-scroll renders it out, then there is no next
  // page); products at /<slug>-p<code>.html. Extraction is layered per project
  // rule: generic tile scan + JSON-LD, slug-derived names, fiber-% text for
  // composition. "ZARA" is the factual house brand (same rule as Cotton On).
  // ---------------------------------------------------------------------------
  const zara = (function () {
    const compositionFromText = shared.compositionFromText;
    const titleCase = s => String(s || "").replace(/-+/g, " ").trim().replace(/\b\w/g, c => c.toUpperCase());

    // "/us/en/ribbed-tank-top-p04174304.html" -> "04174304"
    function codeOf(url) {
      try { const m = new URL(url).pathname.match(/-p(\d{5,})\.html/i); return m ? m[1] : ""; }
      catch (e) { return ""; }
    }
    // "/us/en/ribbed-tank-top-p04174304.html" -> "Ribbed Tank Top"
    function nameFromUrl(url) {
      try {
        const last = new URL(url).pathname.split("/").filter(Boolean).pop() || "";
        const m = last.match(/^(.+)-p\d{5,}\.html$/i);
        if (m) return titleCase(m[1]);
      } catch (e) {}
      return "";
    }
    // "/us/en/woman-tshirts-l1362.html" -> "Woman Tshirts"
    function categoryFromUrl(url) {
      try {
        const last = new URL(url).pathname.split("/").filter(Boolean).pop() || "";
        const m = last.match(/^(.+)-l\d+\.html$/i);
        if (m) return titleCase(m[1]);
      } catch (e) {}
      return "";
    }
    function listingCategory(doc, url) {
      // breadcrumb leaf -> H1 -> URL slug (same on-site-name-first rule)
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
      trail = trail.filter(t => t && !/^(home|zara)$/i.test(t));
      if (trail.length) return trail[trail.length - 1];
      const h1 = doc.querySelector && doc.querySelector("h1");
      if (h1) {
        const t = (h1.textContent || "").replace(/\s*\(\d[\d,]*\)\s*$/, "").replace(/\s+/g, " ").trim();
        if (t && t.length <= 60 && !notACategory(t) &&
            !/^\d[\d,]*\s*(?:results?|items?)$/i.test(t)) return t;
      }
      return categoryFromUrl(url);
    }

    function scrapeList(doc, url) {
      // generic tile scan (reco carousels excluded, JSON-LD merged), kept to
      // real product pages (-p<code>.html), one row per product code.
      const raw = generic.scrapeList(doc, url).filter(r => codeOf(r.product_url));
      const pageCat = listingCategory(doc, url);
      const seen = new Set(); const out = [];
      for (const r of raw) {
        const id = codeOf(r.product_url);
        if (seen.has(id)) continue; seen.add(id);
        r.id = id;
        const slugName = nameFromUrl(r.product_url);
        if (slugName && (!r.name || r.name.length < 4)) r.name = slugName;
        r.category = pageCat || r.category || "";
        r.brand = "ZARA";                     // single-house-brand site — factual
        out.push(r);
      }
      return out;
    }

    function parseDetailDoc(doc, rawHtml, url) {
      let brand = "", name = "", image = "";
      const colors = [], sizes = [];
      const addTo = (arr, v) => {
        const s = String(v == null ? "" : v).replace(/\s+/g, " ").trim();
        if (s && s.length <= 40 && !arr.some(x => x.toLowerCase() === s.toLowerCase())) arr.push(s);
      };
      (doc.querySelectorAll ? doc.querySelectorAll('script[type="application/ld+json"]') : []).forEach(s => {
        let d; try { d = JSON.parse(s.textContent); } catch (e) { return; }
        [].concat(d && d["@graph"] ? d["@graph"] : d).forEach(n => {
          if (!n || !/(^|,)Product(,|$)/i.test([].concat(n["@type"] || []).join(","))) return;
          if (!name && n.name) name = String(n.name);
          if (!brand && n.brand) brand = String(n.brand.name || n.brand);
          // the PDP's own photo — a backstop for tiles whose lazy-loaded grid
          // image never resolved (structured data, not a guessed CDN path)
          if (!image) {
            const im = [].concat(n.image || [])[0];
            const u = im && (im.url || im.contentUrl || im);
            if (typeof u === "string") image = absImage(u, url);
          }
          [].concat(n.color || []).forEach(c => addTo(colors, c));
          [].concat(n.size || []).forEach(z => addTo(sizes, z));
          [].concat(n.hasVariant || []).forEach(v => { if (v) { addTo(colors, v.color); addTo(sizes, v.size); } });
        });
      });
      // composition: fiber-% text — li boundaries first, then raw HTML (whose
      // closing tags compositionFromText turns into line breaks itself)
      const liText = doc.querySelectorAll
        ? [...doc.querySelectorAll("li")].map(li => li.textContent || "").join("\n") : "";
      const composition = compositionFromText(liText) || compositionFromText(rawHtml || "");
      // og:image — the one photo nearly every PDP declares. Semantic markup,
      // not a CSS selector, so it survives redesigns; only used when both the
      // listing tile and JSON-LD gave nothing.
      if (!image && doc.querySelector) {
        const og = doc.querySelector('meta[property="og:image"], meta[name="og:image"]');
        image = absImage(og && og.getAttribute("content"), url);
      }
      return {
        composition, colorways: colors.join("; "), design: "",
        brand: brand || "ZARA", sizes: sizes.join("; "), image_url: image,
        reason: composition ? "" : "not_found",
      };
    }

    async function fetchDetail(url) {
      const empty = r => ({ composition: "", colorways: "", design: "", brand: "ZARA", reason: r });
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

    function context(doc) {
      doc = doc || document;
      const url = (doc.location && doc.location.href) || (typeof location !== "undefined" ? location.href : "");
      return {
        brand: "",                            // single-brand: the panel shows the label
        category: listingCategory(doc, url),
        totalPages: null,
        page: 1,                              // one continuous infinite-scroll grid
      };
    }

    return {
      id: "zara",
      label: "Zara",
      lazyScroll: 60,     // whole category on one infinite-scroll page — scroll it out
      match: url => /(^|\.)zara\.com\//i.test(String(url || "").replace(/^https?:\/\//i, "")),
      context, scrapeList,
      totalPages: () => 1,                    // no page param — everything is on this page
      resultCount: generic.resultCount,
      nextPageUrl: () => null,                // nothing after the scrolled-out grid
      firstPageUrl: url => url,
      isResultsPage: generic.isResultsPage,
      fetchDetail, buildWorkbook: generic.buildWorkbook,
      templateUrl: null,
      _codeOf: codeOf, _nameFromUrl: nameFromUrl, _categoryFromUrl: categoryFromUrl,
      _listingCategory: listingCategory, _parseDetailDoc: parseDetailDoc,
    };
  })();

  // ---------------------------------------------------------------------------
  // Inditex catalog-API detail source (Massimo Dutti; the same `itxrest` API
  // family as Zara/Bershka/…). The grid HTML carries no fabric composition —
  // Inditex ships it only through the JSON API `productsArray`, where every
  // product object nests the real data under `bundleProductSummaries[].detail`
  // (top-level `detail.colors`/`composition` are empty for these "bundle"
  // products). This reads that structured JSON directly instead of scraping a
  // JS-rendered PDP, so composition/colors/sizes/sale-price come back reliably.
  // Field shape verified against a live productsArray response (diagnose-md-products.js):
  //   product.id / .name / .familyName / .bundleColors[{id,name}]
  //   bundleProductSummaries[0].detail.composition[0].composition[{name,percentage}]
  //   …detail.colors[0].sizes[{name, price, oldPrice}]   (price = minor units, ÷100)
  //   …detail.xmedia[0].xmediaItems[0].medias[0].url     (absolute CDN image)
  // Per the charter this hardcodes NO CSS selectors — it targets the platform
  // API, and the store/catalog ids are discovered from the page, not baked in.
  // ---------------------------------------------------------------------------
  const inditex = (function () {
    const prettify = s => String(s == null ? "" : s)
      .toLowerCase().replace(/\s+/g, " ").trim().replace(/\b\w/g, c => c.toUpperCase());

    // grid links are ".../<slug>-l<ref>?pelement=<productId>" — the productId
    // (pelement) is what productsArray keys on; the -l<ref> is only a reference.
    function pelementOf(url) {
      try { return new URL(url, "https://x/").searchParams.get("pelement") || ""; }
      catch (e) { return ""; }
    }

    // "https://www.massimodutti.com/us/women/t-shirts-n1444" -> ".../us" so a
    // productUrl slug can be turned back into an absolute PDP link.
    function hrefBaseOf(url) {
      try { const m = String(url).match(/^(https?:\/\/[^/]+\/[^/?#]+)/); return m ? m[1] : ""; }
      catch (e) { return ""; }
    }

    // Key Design Details = the descriptive part of the copy. The first sentence
    // states the fabric ("… crafted from 100% cotton"); design detail is what
    // follows — anchored on "Features" when present, else the material sentence
    // is dropped. (composition itself comes from the structured field, not here.)
    function designFromDescription(desc) {
      let t = String(desc == null ? "" : desc).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      if (!t) return "";
      const fi = t.search(/\bFeatures?\b/i);
      if (fi > 0) return t.slice(fi).trim();
      const sents = t.split(/(?<=[.!])\s+/);
      if (sents.length > 1 && /\b(crafted|made)\b|\bblend\b|\bfabric\b|\d+\s*%/i.test(sents[0])) {
        return sents.slice(1).join(" ").trim();
      }
      return t;
    }

    // absolute product image from the xmedia block (first media of first item).
    function imageOf(product) {
      const bps = (product && product.bundleProductSummaries) || [];
      for (const b of bps) {
        const xm = (b && b.detail && b.detail.xmedia) || [];
        for (const set of xm) for (const item of (set.xmediaItems || [])) {
          for (const m of (item.medias || [])) {
            const u = m && (m.url || (m.extraInfo && m.extraInfo.url) || m.deliveryUrl);
            if (u && /^https?:\/\//.test(u)) return u;
          }
        }
      }
      return "";
    }

    // Pure parser — a single productsArray product object -> row/detail fields.
    // Side-effect-free so the Node suite can exercise it without a browser.
    function parseProduct(product, opts) {
      opts = opts || {};
      const sym = opts.currency || "$";
      const bps = (product && product.bundleProductSummaries) || [];
      const bd0 = (bps[0] && bps[0].detail) || {};

      // composition: the first summary that carries one. Each fiber = "<pct>% <Fiber>";
      // a multi-zone garment (shell/lining) yields several distinct parts joined "; ".
      const parts = [];
      for (const b of bps) {
        const comp = b && b.detail && b.detail.composition;
        if (Array.isArray(comp) && comp.length) {
          for (const part of comp) {
            const fibers = (part.composition || [])
              .map(f => ((f && f.percentage != null && f.percentage !== "") ? f.percentage + "% " : "") + prettify(f && f.name))
              .map(x => x.trim()).filter(Boolean);
            if (fibers.length) parts.push(fibers.join(", "));
          }
          if (parts.length) break;
        }
      }
      const composition = [...new Set(parts)].join("; ");

      // colors: bundleColors is the authoritative per-product colour list.
      const colorNames = ((product && product.bundleColors) || [])
        .map(c => prettify(c && c.name)).filter(Boolean);

      // sizes + price: walk every summary/colour/size. Current = cheapest size;
      // a size's oldPrice > price proves a markdown (Inditex only sets oldPrice
      // when on sale). Prices are minor units -> ÷100.
      const sizeSet = [], seenSz = Object.create(null);
      let cur = Infinity, old = 0;
      for (const b of bps) for (const c of ((b && b.detail && b.detail.colors) || [])) {
        for (const z of ((c && c.sizes) || [])) {
          const nm = String((z && z.name) || "").trim();
          if (nm && !seenSz[nm.toLowerCase()]) { seenSz[nm.toLowerCase()] = 1; sizeSet.push(nm); }
          const pc = parseInt(z && z.price, 10); if (pc > 0) cur = Math.min(cur, pc);
          const po = parseInt(z && z.oldPrice, 10); if (po > 0) old = Math.max(old, po);
        }
      }
      const money = n => sym + (n / 100).toFixed(2);
      const onSale = old > 0 && cur !== Infinity && old > cur;

      const id = String((product && (product.id != null ? product.id : product.productUrlParam)) || "");
      const slug = product && product.productUrl;
      const product_url = (opts.hrefBase && slug) ? `${opts.hrefBase}/${slug}?pelement=${id}` : "";

      return {
        name: (product && product.name) || "",
        composition,
        colorways: colorNames.join("; "),
        color_count: colorNames.length || "",
        sizes: sizeSet.join("; "),
        design: designFromDescription(bd0.longDescription || bd0.description),
        price: cur !== Infinity ? money(cur) : "",     // current price (always, from API)
        price_was: onSale ? money(old) : "",           // struck-through price only when on sale
        brand: opts.brand || "",
        image_url: imageOf(product),
        product_url,
        reason: composition ? "" : "not_found",
      };
    }

    // -------- live-page capture (browser only) --------------------------------
    // The category grid is virtualized (off-screen tiles leave the DOM) and the
    // page fetches every product through the itxrest `productsArray` API at
    // load, so neither DOM scraping nor resource-timing (the SPA clears it) sees
    // the full set. md-capture.js hooks fetch/XHR in the PAGE world at
    // document_start and parks the running {store/catalog, productIds} on the
    // `data-md-capture` attribute; we read it here. A PerformanceObserver is
    // kept as a secondary source. See diagnose-md-full.js.
    const capture = { sc: null, ids: new Set() };
    function ingest(u) {
      u = String(u || "");
      const s = u.match(/catalog\/store\/(\d+)\/(\d+)\//);
      if (s && !capture.sc) capture.sc = { store: s[1], catalog: s[2] };
      const pm = u.match(/productsArray[^]*?productIds=([\d%2Cc,]+)/i);
      if (pm) {
        let ids = pm[1]; try { ids = decodeURIComponent(ids); } catch (e) {}
        ids.split(",").forEach(x => { x = x.trim(); if (/^\d+$/.test(x)) capture.ids.add(x); });
      }
    }
    // read whatever the page-world hook has captured so far (any id set/cleared
    // in resource timing is irrelevant — the attribute is cumulative).
    function ingestDom() {
      try {
        const raw = (typeof document !== "undefined") &&
          document.documentElement.getAttribute("data-md-capture");
        if (!raw) return;
        const d = JSON.parse(raw);
        if (d && d.sc && d.sc.store && d.sc.catalog && !capture.sc) capture.sc = d.sc;
        if (d && d.ids) d.ids.forEach(id => { if (/^\d+$/.test(String(id))) capture.ids.add(String(id)); });
      } catch (e) {}
    }
    let observing = false;
    function startCapture() {
      ingestDom();
      if (observing || typeof PerformanceObserver === "undefined") return;
      observing = true;
      try { (performance.getEntriesByType("resource") || []).forEach(e => ingest(e.name)); } catch (e) {}
      try { new PerformanceObserver(list => { for (const e of list.getEntries()) ingest(e.name); })
        .observe({ type: "resource", buffered: true }); } catch (e) {}
    }

    function currencyFromDoc(doc) {
      try {
        const t = ((doc && doc.body && doc.body.innerText) || "").slice(0, 30000);
        const m = t.match(/[$€£]/); if (m) return m[0];
      } catch (e) {}
      return "$";
    }

    // Build a store-bound brand helper (scrapeList + fetchDetail). brandId picks
    // the Inditex brand (Massimo Dutti = 3); fallbackSC is a list of known
    // store/catalog pairs tried (and self-validated) when live capture missed.
    function makeBrand(opts) {
      opts = opts || {};
      const brandId = opts.brandId, brand = opts.brand || "";
      const fallbackSC = opts.fallbackSC || [];
      const cache = { products: new Map(), sc: null, cur: null, loaded: false, loading: null };

      async function fetchArray(sc, ids) {
        const u = `/itxrest/3/catalog/store/${sc.store}/${sc.catalog}/productsArray?languageId=-1&appId=1&productIds=${ids.join(",")}`;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 15000);
        try {
          const r = await fetch(u, { credentials: "include", headers: { Accept: "application/json" }, signal: ctrl.signal });
          if (!r.ok) return null;
          const j = await r.json();
          return (j && j.products) || [];
        } catch (e) { return null; } finally { clearTimeout(timer); }
      }
      // pick a working store/catalog by validating a seed id against the API.
      async function resolveSC(seedId) {
        if (cache.sc) return cache.sc;
        const cands = [];
        if (capture.sc) cands.push(capture.sc);
        fallbackSC.forEach(sc => cands.push(sc));
        for (const sc of cands) {
          const prods = await fetchArray(sc, [seedId]);
          if (prods && prods.length) return (cache.sc = sc);
        }
        return null;
      }
      // fetch + parse every captured id once, in batches, into the cache.
      function ensureLoaded(doc, seedId, url) {
        if (cache.loaded) return Promise.resolve();
        if (cache.loading) return cache.loading;
        cache.loading = (async () => {
          cache.cur = currencyFromDoc(doc);
          const hrefBase = hrefBaseOf(url);
          const sc = await resolveSC(seedId);
          if (sc) {
            const ids = new Set(capture.ids); if (seedId) ids.add(String(seedId));
            const all = [...ids];
            for (let i = 0; i < all.length; i += 40) {
              const prods = await fetchArray(sc, all.slice(i, i + 40));
              (prods || []).forEach(p => cache.products.set(String(p.id), parseProduct(p, { currency: cache.cur, brand, hrefBase })));
            }
          }
          cache.loaded = true;
        })();
        return cache.loading;
      }

      async function fetchDetail(url) {
        const empty = r => ({ composition: "", colorways: "", design: "", brand, reason: r });
        const id = pelementOf(url);
        if (!id) return empty("not_found");
        const doc = (typeof document !== "undefined") ? document : null;
        await ensureLoaded(doc, id, url);
        const hit = cache.products.get(String(id));
        if (hit) return hit;
        // not in the batch (e.g. detail-only run) — fetch this one id directly.
        const sc = cache.sc || await resolveSC(id);
        if (!sc) return empty("error");
        const prods = await fetchArray(sc, [id]);
        const p = prods && prods.find(x => String(x.id) === String(id));
        if (!p) return empty("not_found");
        return parseProduct(p, { currency: cache.cur || currencyFromDoc(doc), brand, hrefBase: hrefBaseOf(url) });
      }

      // list = DOM pelement links (carry a real URL + image) UNIONED with the
      // productIds the observer captured while scrolling (the virtualized-away
      // ones). Captured-only rows get a pelement URL so the detail phase can
      // fetch them; their real URL/name/image are filled in there.
      function scrapeList(doc, url, category) {
        startCapture();
        try { (performance.getEntriesByType("resource") || []).forEach(e => ingest(e.name)); } catch (e) {}
        const base = hrefBaseOf(url);
        const rows = new Map();
        (doc.querySelectorAll ? doc.querySelectorAll('a[href*="pelement="]') : []).forEach(a => {
          const href = a.getAttribute("href") || "";
          const id = (href.match(/pelement=(\d+)/) || [])[1];
          if (!id || rows.has(id)) return;
          let abs = href; try { abs = new URL(href, url).toString(); } catch (e) {}
          const img = a.querySelector && a.querySelector("img");
          rows.set(id, {
            id, product_url: abs, name: "", price: "", price_was: "", category, brand,
            image_url: img ? absImage(img.getAttribute("src") || img.getAttribute("data-src"), url) : "",
          });
        });
        capture.ids.forEach(id => {
          if (rows.has(id)) return;
          rows.set(id, {
            id, product_url: base ? `${base}/?pelement=${id}` : "?pelement=" + id,
            name: "", price: "", price_was: "", category, brand, image_url: "",
          });
        });
        return [...rows.values()];
      }

      return { scrapeList, fetchDetail, _resolveSC: resolveSC, _cache: cache };
    }

    return { pelementOf, parseProduct, imageOf, designFromDescription, capture, startCapture, makeBrand };
  })();

  // ---------------------------------------------------------------------------
  // House-brand SPA factory — single-brand fashion sites (COS, Massimo Dutti)
  // whose category is one continuous grid (infinite scroll / "load more") and
  // whose product page carries structured data (JSON-LD) + a fiber-%
  // composition. This is the Zara model generalized. Per the project charter it
  // hardcodes NO site CSS selectors: the list + reco-exclusion come from the
  // generic engine, the category from the URL slug (with a JSON-LD breadcrumb
  // preferred), composition from JSON-LD / fiber-% text. A per-site diagnostic
  // (diagnose-generic.js) can later tune specifics if a field is missed.
  // ---------------------------------------------------------------------------
  function houseBrandAdapter(cfg) {
    const compositionFromText = shared.compositionFromText;
    const titleCase = s => String(s || "")
      .replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim()
      .replace(/\b\w/g, c => c.toUpperCase());

    // last path segment, minus any Inditex/CMS id suffix (-n123 / -l123 / -c123)
    // and .html — pure URL parsing, no DOM guessing.
    function categoryFromUrl(url) {
      try {
        const last = (new URL(url).pathname.split("/").filter(Boolean).pop() || "")
          .replace(/\.html?$/i, "")
          .replace(/-[nlc]\d+$/i, "");
        return titleCase(last);
      } catch (e) { return ""; }
    }

    function listingCategory(doc, url) {
      // JSON-LD breadcrumb leaf -> H1 -> URL slug (on-site name first)
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
      trail = trail.filter(t => t && !cfg.trailSkip.test(t));
      if (trail.length) return trail[trail.length - 1];
      const h1 = doc.querySelector && doc.querySelector("h1");
      if (h1) {
        const t = (h1.textContent || "").replace(/\s*\(\d[\d,]*\)\s*$/, "").replace(/\s+/g, " ").trim();
        if (t && t.length <= 60 && !notACategory(t) &&
            !/^\d[\d,]*\s*(?:results?|items?)$/i.test(t)) return t;
      }
      return categoryFromUrl(url);
    }

    // product identity: a verified code pattern when the site has one, else the
    // URL path (query stripped) so each product is one row and dupes collapse.
    function productKey(u) {
      if (cfg.codeOf) return cfg.codeOf(u) || null;
      try { const x = new URL(u); return x.origin + x.pathname; } catch (e) { return u || null; }
    }
    const isProduct = u => cfg.isProduct ? cfg.isProduct(u) : !!productKey(u);

    function scrapeList(doc, url) {
      /* The product-URL shape narrows the tiles; it must never erase them.

         A house-brand site is recognised by its address, and its product
         pages follow a pattern (Aritzia's /product/<slug>/<id>.html). Shops
         change those patterns — and when they do, a filter written as a hard
         requirement turns a working scan into zero products, silently: the
         grid was read, every tile was found, and then all of them were
         dropped for not matching a rule about last year's URLs.

         So the filter is a preference. If it keeps nothing while the generic
         scrape found tiles, the tiles win and the run reports what is on the
         page. A slightly noisy row is recoverable; an empty spreadsheet with
         no explanation is not. */
      const all = generic.scrapeList(doc, url);
      const kept = all.filter(r => isProduct(r.product_url));
      const raw = kept.length ? kept : all;
      const pageCat = listingCategory(doc, url);
      const seen = new Set(); const out = [];
      for (const r of raw) {
        const id = productKey(r.product_url);
        if (id && seen.has(id)) continue; if (id) seen.add(id);
        r.category = pageCat || r.category || "";
        r.brand = cfg.brand;                  // single-house-brand site — factual
        out.push(r);
      }
      return out;
    }

    // A house-brand PDP is read exactly like any other product page; the only
    // thing this site knows that the generic reader doesn't is its own brand.
    const parseDetailDoc = (doc, rawHtml, url) => readProductPage(doc, rawHtml, cfg.brand, url);
    const fetchDetail = url => fetchProductPage(url, cfg.brand);

    function context(doc) {
      doc = doc || document;
      const url = (doc.location && doc.location.href) || (typeof location !== "undefined" ? location.href : "");
      return { brand: "", category: listingCategory(doc, url), totalPages: null, page: 1 };
    }

    // A site whose PDP HTML lacks the composition (e.g. Inditex serves it only
    // via its catalog API) can supply an API-based detail fetcher; otherwise the
    // default fetches and parses the product page.
    const detailFn = cfg.fetchDetail || fetchDetail;

    return {
      id: cfg.id, label: cfg.label,
      lazyScroll: cfg.lazyScroll == null ? 60 : cfg.lazyScroll,  // one infinite-scroll grid
      match: cfg.match,
      context, scrapeList,
      totalPages: () => 1,                    // no page param — everything scrolls onto one page
      resultCount: generic.resultCount,
      nextPageUrl: () => null,
      firstPageUrl: url => url,
      isResultsPage: generic.isResultsPage,
      fetchDetail: detailFn, buildWorkbook: generic.buildWorkbook,
      templateUrl: null,
      _categoryFromUrl: categoryFromUrl, _listingCategory: listingCategory,
      _scrapeList: scrapeList, _parseDetailDoc: parseDetailDoc, _isProduct: isProduct,
      _productKey: productKey, _codeOf: cfg.codeOf || null,
    };
  }

  // Aritzia — aritzia.com/intl/en/clothing/<category>, /intl/en/new. Single
  // house brand (its in-house labels: Wilfred, Babaton, TNA… all sold as
  // Aritzia), one continuous grid. Starts on the same house-brand factory as
  // COS: generic tile scrape + JSON-LD breadcrumb category + fiber-% detail.
  // Product pages are ".../product/<slug>/<id>.html"; anything without that
  // shape is navigation, not a product, so it never becomes a row.
  const aritzia = houseBrandAdapter({
    id: "aritzia", label: "Aritzia", brand: "Aritzia",
    match: url => /(^|\.)aritzia\.com\//i.test(String(url || "").replace(/^https?:\/\//i, "")),
    trailSkip: /^(home|aritzia)$/i,
    // "/intl/en/product/sculpt-knit-tank/119480.html" -> "119480"
    codeOf: u => { try { return (new URL(u).pathname.match(/\/product\/[^/]+\/(\d{3,})/i) || [])[1] || ""; } catch (e) { return ""; } },
    isProduct: u => /\/product\//i.test(String(u || "")),
  });

  // COS (H&M group) — cos.com/<locale>/<gender>/<category>. One continuous grid.
  const cos = houseBrandAdapter({
    id: "cos", label: "COS", brand: "COS",
    match: url => /(^|\.)cos\.com\//i.test(String(url || "").replace(/^https?:\/\//i, "")),
    trailSkip: /^(home|cos)$/i,
  });

  // Massimo Dutti (Inditex, same platform family as Zara) —
  // massimodutti.com/<locale>/<gender>/<category>-n<id>. One continuous grid.
  // Massimo Dutti is fully API-driven (Inditex catalog API, brandId 3): the
  // grid is virtualized and the PDP is JS-rendered, so both the product LIST
  // and the per-product detail come from `productsArray`. We start from the
  // house-brand base (for context/category-from-breadcrumb) and swap in the
  // API list+detail. 34009527/30359506 is the US store/catalog, used only as a
  // self-validated fallback when live capture hasn't seen one yet.
  const massimodutti = (function () {
    const base = houseBrandAdapter({
      id: "massimodutti", label: "Massimo Dutti", brand: "Massimo Dutti",
      match: url => /(^|\.)massimodutti\.com\//i.test(String(url || "").replace(/^https?:\/\//i, "")),
      trailSkip: /^(home|massimo\s*dutti)$/i,
    });
    const brandApi = inditex.makeBrand({
      brandId: 3, brand: "Massimo Dutti",
      fallbackSC: [{ store: "34009527", catalog: "30359506" }],
    });
    const listingCategory = base._listingCategory;
    base.scrapeList = (doc, url) => brandApi.scrapeList(doc, url, listingCategory(doc, url));
    base.fetchDetail = brandApi.fetchDetail;
    base._brandApi = brandApi;
    return base;
  })();

  // Start capturing the page's itxrest calls as early as possible on a Massimo
  // Dutti page (before the user scrolls), so no product batch is missed.
  try {
    if (typeof location !== "undefined" && /(^|\.)massimodutti\.com$/i.test(location.hostname)) inditex.startCapture();
  } catch (e) {}

  // ---------------------------------------------------------------------------
  // Registry — order matters: more specific adapters must come before generic.
  // ---------------------------------------------------------------------------
  const ADAPTERS = [walmart, target, cottonon, zara, aritzia, cos, massimodutti, shopify, generic];

  const SITES = {
    shared,
    inditex,           // exposed for the Node suite (pure parseProduct/pelementOf)
    notACategory,      // ditto — the interstitial guard on the <h1> reader
    adapters: ADAPTERS,
    // doc is optional — adapters that detect by page content (e.g. shopify's
    // cdn markers) use it; URL-pattern adapters (walmart) ignore it.
    active(url, doc) { return ADAPTERS.find(a => a.match(url, doc)) || null; },
    get(id) { return ADAPTERS.find(a => a.id === id) || null; },
  };

  if (typeof module !== "undefined" && module.exports) module.exports = SITES;
  root.SITES = SITES;
})(typeof self !== "undefined" ? self : this);
