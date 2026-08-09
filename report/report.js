/* Report calculations — pure, side-effect-free market-research aggregations over
   one or more scan files exported by the Market Lens extension.
   No LLM, no network: every number here is plain computation (the charter's
   "정량 레포트는 순수 계산으로"). Exposed on window.ReportCalc for the page and
   via module.exports for the Node test suite. */
(function (root) {
  "use strict";

  // "$1,299.00" -> 1299 ; "€59.95" -> 59.95 ; "" / "정보 확인" -> null
  function parsePrice(v) {
    if (v == null) return null;
    const m = String(v).replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
    if (!m) return null;
    const n = parseFloat(m[0]);
    return isFinite(n) ? n : null;
  }

  // "69% Cotton, 31% Cupro; 100% Polyester" -> [{fiber:"Cotton",pct:69}, …]
  // Tolerant of "/", "," , ";" and "&" separators and missing percentages.
  function parseFibers(comp) {
    const t = String(comp || "").trim();
    if (!t) return [];
    const out = [];
    const seen = new Set();
    // each "<pct>% <Fiber words>" chunk; also bare "<Fiber>" with no pct
    const re = /(\d{1,3})\s*%\s*([A-Za-z][A-Za-z\s\-]*?)(?=(?:[,;/&]|\d{1,3}\s*%|$))/g;
    let m;
    while ((m = re.exec(t))) {
      const fiber = titleFiber(m[2]);
      const pct = parseInt(m[1], 10);
      if (fiber && !seen.has(fiber.toLowerCase())) { seen.add(fiber.toLowerCase()); out.push({ fiber, pct: isFinite(pct) ? pct : null }); }
    }
    return out;
  }
  function titleFiber(s) {
    return String(s || "").replace(/\s+/g, " ").trim()
      .replace(/\b\w/g, c => c.toUpperCase());
  }

  // "Black; White / Navy, Cream" -> ["Black","White","Navy","Cream"]
  function parseColors(v) {
    const s = String(v || "").trim();
    if (!s) return [];
    return s.split(/\s*[;/\n]\s*|\s*,\s*/).map(x => x.trim()).filter(Boolean);
  }

  // Key Design Details -> labelled attributes. Adapters emit either
  // "Neckline: Ribbed crewneck\nClosure: Button front" (Walmart's key item
  // features) or a prose sentence ("Features long raglan sleeves…", Inditex).
  // Labelled lines become {label, value} facets; prose is kept as free text so
  // the keyword pass can still mine it.
  const DESIGN_LABELS = /^(fit|neckline|closure|sleeves?|length|pockets?|features?|style|pattern|silhouette|waist|rise|collar|hem|lining|fastening|occasion|material)$/i;
  function parseDesign(design) {
    const t = String(design || "").trim();
    if (!t) return { facets: [], text: "" };
    const facets = [];
    const loose = [];
    t.split(/\n|(?:;\s)/).forEach(line => {
      const m = line.match(/^\s*([A-Za-z][A-Za-z \-]{1,20}?)\s*:\s*(.+)$/);
      if (m && DESIGN_LABELS.test(m[1].trim())) {
        const label = titleFiber(m[1]);
        // one line can list several values: "Two side pockets; one chest pocket"
        String(m[2]).split(/\s*;\s*|\s*,\s*(?=[A-Z])/).map(v => v.trim()).filter(Boolean)
          .forEach(v => facets.push({ label, value: titleFiber(v.replace(/\.$/, "")) }));
      } else if (line.trim()) loose.push(line.trim());
    });
    return { facets, text: loose.join(" ") };
  }

  // Trend keywords from a product name / prose design copy. Stopwords keep the
  // list to garment vocabulary (the words a designer actually tracks).
  const STOP = new Set(("a,an,the,and,or,with,for,of,in,on,to,from,by,at,this,that,it,its,is,are,be," +
    "women,womens,women's,men,mens,men's,plus,size,sizes,new,style,styles,piece,pieces," +
    "features,featuring,crafted,made,design,designed,fabric,top,item").split(","));
  function nameKeywords(text) {
    return String(text || "").toLowerCase()
      .replace(/[^a-z\s-]/g, " ").split(/\s+/)
      .map(w => w.replace(/^-+|-+$/g, ""))
      .filter(w => w.length >= 3 && !STOP.has(w));
  }

  // One item -> a normalized record the aggregations read.
  function normItem(it) {
    it = it || {};
    const price = parsePrice(it.price);
    const priceWas = parsePrice(it.price_was);
    const onSale = price != null && priceWas != null && priceWas > price;
    const colors = parseColors(it.colorways);
    const fibers = parseFibers(it.fabric_composition);
    const design = parseDesign(it.design);
    const name = (it.name || "").trim();
    return {
      brand: (it.brand || "").trim(),
      name,
      category: (it.category || "").trim(),
      price, priceWas, onSale,
      discountPct: onSale ? Math.round((1 - price / priceWas) * 100) : null,
      colors,
      colorCount: colors.length || (parseInt(it.color_count, 10) || 0),
      fibers,
      hasComposition: fibers.length > 0,
      designFacets: design.facets,
      hasDesign: design.facets.length > 0 || !!design.text,
      keywords: [...new Set(nameKeywords(name + " " + design.text))],
      product_url: it.product_url || "",
      image_url: it.image_url || "",
    };
  }

  function normScan(scan) {
    scan = scan || {};
    const items = (scan.items || []).map(normItem);
    const meta = Object.assign({}, scan.meta);
    return { meta, items };
  }

  // ---- frequency helpers -----------------------------------------------------
  function tally(pairs) {                    // [[key,weight]] -> sorted [{key,value}]
    const m = new Map();
    pairs.forEach(([k, w]) => { if (k) m.set(k, (m.get(k) || 0) + (w == null ? 1 : w)); });
    return [...m.entries()].map(([key, value]) => ({ key, value })).sort((a, b) => b.value - a.value);
  }
  function mean(xs) { const a = xs.filter(x => x != null); return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; }
  function median(xs) {
    const a = xs.filter(x => x != null).sort((x, y) => x - y);
    if (!a.length) return null;
    const i = Math.floor(a.length / 2);
    return a.length % 2 ? a[i] : (a[i - 1] + a[i]) / 2;
  }

  // Histogram of current prices into `bins` buckets over [min,max]. "Nice" step.
  function priceHistogram(items, bins) {
    bins = bins || 8;
    const prices = items.map(i => i.price).filter(p => p != null);
    if (!prices.length) return { buckets: [], min: null, max: null };
    const min = Math.min(...prices), max = Math.max(...prices);
    if (min === max) return { buckets: [{ lo: min, hi: min, count: prices.length }], min, max };
    const rawStep = (max - min) / bins;
    const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const step = Math.max(1, Math.ceil(rawStep / mag) * mag);
    const start = Math.floor(min / step) * step;
    const buckets = [];
    for (let lo = start; lo < max + step; lo += step) {
      buckets.push({ lo, hi: lo + step, count: 0 });
      if (buckets.length > 40) break;
    }
    prices.forEach(p => {
      let idx = Math.floor((p - start) / step);
      if (idx < 0) idx = 0; if (idx >= buckets.length) idx = buckets.length - 1;
      buckets[idx].count++;
    });
    return { buckets, min, max, step };
  }

  // ---- the aggregate a single-scan dashboard renders -------------------------
  function aggregate(scanOrItems) {
    // accepts a scan object {items:[raw]} or a bare array of raw items; always
    // normalizes (raw fields -> the shape the aggregations read).
    const rawItems = Array.isArray(scanOrItems) ? scanOrItems : ((scanOrItems && scanOrItems.items) || []);
    const items = rawItems.map(normItem);
    const n = items.length;
    const priced = items.map(i => i.price).filter(p => p != null);
    const saleItems = items.filter(i => i.onSale);
    const withComp = items.filter(i => i.hasComposition);

    const colorFreq = tally([].concat(...items.map(i => i.colors.map(c => [normColor(c), 1]))));
    // fibre "presence": share of products that contain each fibre
    const fiberPresence = tally([].concat(...items.map(i => uniqFibers(i.fibers).map(f => [f, 1]))))
      .map(r => ({ key: r.key, value: r.value, pct: n ? Math.round(r.value / n * 100) : 0 }));
    const brandShare = tally(items.map(i => [i.brand, 1])).filter(r => r.key);
    const categoryShare = tally(items.map(i => [i.category, 1])).filter(r => r.key);

    // design details: overall value frequency + grouped by attribute label, so a
    // designer can read "Neckline: crewneck 12 / v-neck 5" rather than a blob.
    const designValues = tally([].concat(...items.map(i =>
      i.designFacets.map(f => [f.label + ": " + f.value, 1]))));
    const byLabel = new Map();
    items.forEach(i => i.designFacets.forEach(f => {
      if (!byLabel.has(f.label)) byLabel.set(f.label, new Map());
      const m = byLabel.get(f.label);
      m.set(f.value, (m.get(f.value) || 0) + 1);
    }));
    const designFacets = [...byLabel.entries()].map(([label, m]) => ({
      label,
      values: [...m.entries()].map(([key, value]) => ({ key, value })).sort((a, b) => b.value - a.value),
      total: [...m.values()].reduce((s, x) => s + x, 0),
    })).sort((a, b) => b.total - a.total);
    // keyword trend from names + prose design copy (product-level presence)
    const keywords = tally([].concat(...items.map(i => i.keywords.map(k => [k, 1]))))
      .map(r => ({ key: r.key, value: r.value, pct: n ? Math.round(r.value / n * 100) : 0 }));
    const withDesign = items.filter(i => i.hasDesign);

    // headline detail: the top value from EACH attribute, so a summary line reads
    // "Neckline: Crewneck, Sleeves: Long, Fit: Regular" instead of three Fits.
    const designHighlights = designFacets.map(f => ({
      key: f.label + ": " + f.values[0].key, value: f.values[0].value, label: f.label,
    }));

    return {
      count: n,
      designValues, designFacets, designHighlights, keywords,
      designKnownPct: n ? Math.round(withDesign.length / n * 100) : 0,
      brandCount: brandShare.length,
      avgPrice: mean(priced),
      medianPrice: median(priced),
      minPrice: priced.length ? Math.min(...priced) : null,
      maxPrice: priced.length ? Math.max(...priced) : null,
      onSaleCount: saleItems.length,
      onSalePct: n ? Math.round(saleItems.length / n * 100) : 0,
      avgDiscountPct: mean(saleItems.map(i => i.discountPct)),
      compositionKnownPct: n ? Math.round(withComp.length / n * 100) : 0,
      distinctColors: colorFreq.length,
      distinctFibers: fiberPresence.length,
      colorFreq, fiberPresence, brandShare, categoryShare,
      priceHistogram: priceHistogram(items),
    };
  }
  function normColor(c) { return titleFiber(c); }
  function uniqFibers(fibers) {
    const s = new Set(); (fibers || []).forEach(f => f.fiber && s.add(f.fiber)); return [...s];
  }

  // ---- season / point-in-time comparison of two aggregates ------------------
  function compare(aggA, aggB) {
    const delta = (a, b) => (a == null || b == null) ? null : b - a;
    // align fibre presence by fibre name -> {fiber, a%, b%, delta}
    const keys = unionKeys(aggA.fiberPresence, aggB.fiberPresence);
    const fibers = keys.map(k => {
      const a = pctOf(aggA.fiberPresence, k), b = pctOf(aggB.fiberPresence, k);
      return { key: k, a, b, delta: b - a };
    }).sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
    const colorKeys = unionKeys(aggA.colorFreq, aggB.colorFreq);
    const colors = colorKeys.map(k => {
      const a = shareOf(aggA.colorFreq, k, aggA.count), b = shareOf(aggB.colorFreq, k, aggB.count);
      return { key: k, a, b, delta: b - a };
    }).sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
    // design values + name keywords, as share-of-products %p change
    const designKeys = unionKeys(aggA.designValues, aggB.designValues);
    const designs = designKeys.map(k => {
      const a = shareOf(aggA.designValues, k, aggA.count), b = shareOf(aggB.designValues, k, aggB.count);
      return { key: k, a, b, delta: b - a };
    }).sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
    const kwKeys = unionKeys(aggA.keywords, aggB.keywords);
    const keywords = kwKeys.map(k => {
      const a = pctOf(aggA.keywords, k), b = pctOf(aggB.keywords, k);
      return { key: k, a, b, delta: b - a };
    }).sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
    return {
      count: { a: aggA.count, b: aggB.count, delta: delta(aggA.count, aggB.count) },
      avgPrice: { a: aggA.avgPrice, b: aggB.avgPrice, delta: delta(aggA.avgPrice, aggB.avgPrice) },
      onSalePct: { a: aggA.onSalePct, b: aggB.onSalePct, delta: delta(aggA.onSalePct, aggB.onSalePct) },
      avgDiscountPct: { a: aggA.avgDiscountPct, b: aggB.avgDiscountPct, delta: delta(aggA.avgDiscountPct, aggB.avgDiscountPct) },
      fibers, colors, designs, keywords,
    };
  }
  function unionKeys(a, b) {
    const s = new Set(); (a || []).forEach(r => s.add(r.key)); (b || []).forEach(r => s.add(r.key)); return [...s];
  }
  function pctOf(arr, key) { const r = (arr || []).find(x => x.key === key); return r ? (r.pct != null ? r.pct : 0) : 0; }
  function shareOf(arr, key, total) { const r = (arr || []).find(x => x.key === key); return (r && total) ? Math.round(r.value / total * 100) : 0; }

  // ---- weekly bucketing (the "주차별" view) ---------------------------------
  // ISO-8601 week: Monday-start, week 1 holds the first Thursday. Returns
  // "2026-W32" so weeks sort lexicographically and survive year boundaries.
  function isoWeek(d) {
    const dt = (d instanceof Date) ? new Date(d.getTime()) : new Date(d);
    if (isNaN(dt.getTime())) return "";
    dt.setUTCHours(0, 0, 0, 0);
    // Thursday of this week decides the year
    dt.setUTCDate(dt.getUTCDate() + 4 - (dt.getUTCDay() || 7));
    const year = dt.getUTCFullYear();
    const jan1 = new Date(Date.UTC(year, 0, 1));
    const week = Math.ceil((((dt - jan1) / 86400000) + 1) / 7);
    return year + "-W" + String(week).padStart(2, "0");
  }
  // Group scans into weeks and aggregate each week's pooled items.
  // scans: [{meta:{scannedAt,…}, items:[raw]}] -> [{week, scans, agg}] ascending.
  function weekly(scans) {
    const byWeek = new Map();
    (scans || []).forEach(s => {
      const w = isoWeek((s && s.meta && s.meta.scannedAt) || (s && s.savedAt) || Date.now());
      if (!byWeek.has(w)) byWeek.set(w, []);
      byWeek.get(w).push(s);
    });
    return [...byWeek.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1).map(([week, ss]) => ({
      week,
      scans: ss.length,
      agg: aggregate({ items: [].concat(...ss.map(s => (s && s.items) || [])) }),
    }));
  }
  // Trend series over weeks for the headline metrics + a fibre/colour.
  function weeklyTrend(weeks, opts) {
    opts = opts || {};
    return (weeks || []).map(w => ({
      week: w.week,
      count: w.agg.count,
      avgPrice: w.agg.avgPrice,
      onSalePct: w.agg.onSalePct,
      fiberPct: opts.fiber ? pctOf(w.agg.fiberPresence, opts.fiber) : null,
      colorPct: opts.color ? shareOf(w.agg.colorFreq, opts.color, w.agg.count) : null,
    }));
  }
  // Top N image cards across scans — the inspo board.
  function inspoImages(scans, limit) {
    const out = [], seen = new Set();
    (scans || []).forEach(s => ((s && s.items) || []).forEach(it => {
      const u = it && it.image_url;
      if (!u || seen.has(u)) return;
      seen.add(u);
      out.push({ image_url: u, name: it.name || "", brand: it.brand || "",
        price: it.price || "", product_url: it.product_url || "",
        fabric: it.fabric_composition || "", colorways: it.colorways || "" });
    }));
    return limit ? out.slice(0, limit) : out;
  }

  const API = {
    parsePrice, parseFibers, parseColors, parseDesign, nameKeywords, normItem, normScan,
    aggregate, compare, priceHistogram, mean, median, tally,
    isoWeek, weekly, weeklyTrend, inspoImages,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  root.ReportCalc = API;
})(typeof self !== "undefined" ? self : this);
