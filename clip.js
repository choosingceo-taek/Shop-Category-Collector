/* Generic single-product extractor — injected on demand into ANY page.
   Unlike the adapters in sites.js (which drive whole-category scans on
   allow-listed retailers), this reads ONE product from whatever page the user
   is on, so clipping works on unsupported shops, lookbooks and inspo sites too.

   Same charter ordering: structured data (JSON-LD -> OpenGraph/meta) first, DOM
   heuristics only as a last resort, and never a site-specific CSS selector. It
   returns "" for anything it cannot read rather than guessing — the panel shows
   those as blank so the user can fill them in.

   Loaded as a content script via chrome.scripting.executeScript; the last
   expression is the injected function's return value. */
(function () {
  "use strict";
  const clean = s => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  const abs = u => { try { return new URL(u, location.href).toString(); } catch (e) { return ""; } };

  // ---- structured data ------------------------------------------------------
  function jsonLd() {
    const out = [];
    document.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
      let d; try { d = JSON.parse(s.textContent); } catch (e) { return; }
      [].concat(d && d["@graph"] ? d["@graph"] : d).forEach(n => n && out.push(n));
    });
    return out;
  }
  function ldProduct() {
    for (const n of jsonLd()) {
      const types = [].concat(n["@type"] || []).join(",");
      if (/(^|,)Product(,|$)/i.test(types)) return n;
    }
    return null;
  }
  const meta = (...names) => {
    for (const n of names) {
      const e = document.querySelector(`meta[property="${n}"], meta[name="${n}"]`);
      const v = e && e.getAttribute("content");
      if (v && clean(v)) return clean(v);
    }
    return "";
  };

  // ---- price ----------------------------------------------------------------
  function offerPrice(offers) {
    const o = [].concat(offers || [])[0];
    if (!o) return { price: "", currency: "" };
    const p = o.price || o.lowPrice || (o.priceSpecification && o.priceSpecification.price) || "";
    const c = o.priceCurrency || (o.priceSpecification && o.priceSpecification.priceCurrency) || "";
    return { price: clean(p), currency: clean(c) };
  }
  const SYM = { USD: "$", EUR: "€", GBP: "£", KRW: "₩", JPY: "¥", AUD: "A$", CAD: "C$" };
  const withSymbol = (amount, cur) => {
    if (!amount) return "";
    if (/^[^\d]/.test(amount)) return amount;                 // already symbolised
    const s = SYM[String(cur).toUpperCase()] || (cur ? cur + " " : "");
    return s + amount;
  };
  // visible price as a fallback: the first money-looking string in the main area
  function domPrice() {
    const t = clean(document.body ? document.body.innerText.slice(0, 6000) : "");
    const m = t.match(/(?:[$€£₩¥]|USD|EUR|KRW)\s?\d[\d.,]*/);
    return m ? clean(m[0]) : "";
  }

  // ---- image ----------------------------------------------------------------
  function biggestImage() {
    let best = null, bestArea = 0;
    document.querySelectorAll("img").forEach(img => {
      const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
      const area = (w || 0) * (h || 0);
      // ignore sprites/icons/logos and tracking pixels
      if (w < 200 || h < 200 || area <= bestArea) return;
      const src = img.currentSrc || img.getAttribute("src") || img.getAttribute("data-src") || "";
      if (!src || /^data:/.test(src) && src.length < 200) return;
      best = src; bestArea = area;
    });
    return best ? abs(best) : "";
  }

  // ---- fabric / composition (fiber-validated, same rule as the adapters) -----
  const FIBERS = "cotton|polyester|spandex|elastane|rayon|viscose|modal|nylon|acrylic|wool|linen|lyocell|tencel|cashmere|silk|bamboo|polyamide|cupro|mohair|alpaca|hemp";
  function compositionFrom(text) {
    const t = String(text || "").replace(/\s+/g, " ");
    const SEG = "\\d{1,3}\\s?%\\s?(?:(?!off|sale|discount|extra)[A-Za-z]+[ \\t]+)?(?:" + FIBERS + ")\\b";
    const RE = new RegExp(SEG + "(?:[ ,/&+]+" + SEG + ")*", "i");
    const m = t.match(RE);
    return m ? clean(m[0]) : "";
  }
  function fabric(ld) {
    if (ld && ld.material) {
      const s = clean([].concat(ld.material).map(m => (m && m.name) || m).join(", "));
      if (s) return s;
    }
    // labelled spec rows, then the page text — both fiber-validated
    const li = [...document.querySelectorAll("li, dd, td, p")].map(e => e.textContent || "").join("\n");
    return compositionFrom(li) || compositionFrom(document.body ? document.body.innerText : "");
  }

  // ---- colours / sizes from JSON-LD variants --------------------------------
  function variantValues(ld, key) {
    const out = [], seen = new Set();
    const add = v => {
      const s = clean(v);
      if (s && s.length <= 40 && !seen.has(s.toLowerCase())) { seen.add(s.toLowerCase()); out.push(s); }
    };
    if (ld) {
      [].concat(ld[key] || []).forEach(add);
      [].concat(ld.hasVariant || []).forEach(v => v && add(v[key]));
    }
    return out;
  }

  // ---- assemble -------------------------------------------------------------
  const ld = ldProduct();
  const { price, currency } = offerPrice(ld && ld.offers);
  const ogPrice = meta("product:price:amount", "og:price:amount");
  const ogCur = meta("product:price:currency", "og:price:currency");

  const name = clean((ld && ld.name) || meta("og:title", "twitter:title") ||
    (document.querySelector("h1") && document.querySelector("h1").textContent) || document.title);
  const brand = clean((ld && ld.brand && (ld.brand.name || ld.brand)) ||
    meta("og:site_name", "product:brand") || "");
  const image = abs((ld && [].concat(ld.image || [])[0] && ([].concat(ld.image)[0].url || [].concat(ld.image)[0])) ||
    meta("og:image", "twitter:image") || "") || biggestImage();
  const colors = variantValues(ld, "color");
  const sizes = variantValues(ld, "size");

  return {
    type: "product",
    name: name.slice(0, 200),
    brand,
    price: withSymbol(price, currency) || withSymbol(ogPrice, ogCur) || domPrice(),
    image_url: image,
    product_url: (ld && clean(ld.url)) || location.href.split("#")[0],
    fabric_composition: fabric(ld),
    colorways: colors.join("; "),
    size_range: sizes.join("; "),
    category: clean((ld && ld.category) || ""),
    design: clean(meta("og:description", "description")).slice(0, 400),
    source: location.hostname.replace(/^www\./, ""),
  };
})();
