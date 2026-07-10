/* Walmart PB Knit pipeline — shared logic (browser content script + Node tests).
   Mirrors the Python config/pipeline. Edit scope rules here. */
(function (root) {
  const CATEGORY_RULES = {
    "T-shirts": ["t-shirt", "tshirt", "tee", "henley", "graphic tee"],
    "Sweatshirts & Hoodies": ["hoodie", "sweatshirt", "pullover", "quarter zip"],
    "Tank Tops": ["tank", "cami", "camisole", "muscle tee", "sleeveless"],
    "Leggings": ["legging", "active tight", "yoga pant"],
    "Sweatpants": ["sweatpant", "jogger", "fleece pant", "track pant", "lounge pant", "knit pant"],
  };
  const NON_TARGET = ["dress", "skirt", "skort", "polo", "shorts", "jean", "jegging",
    "jacket", "coat", "romper", "pajama", "uniform", "sock", "underwear"];
  const KNIT_FABRIC = ["single jersey", "jersey", "interlock", "rib", "ponte", "french terry",
    "terry", "fleece", "thermal", "waffle", "double knit", "slub", "pique", "pointelle", "knit"];
  const KNIT_GARMENT = ["tee", "t-shirt", "tshirt", "tank", "cami", "henley", "pullover",
    "hoodie", "sweatshirt", "jogger", "legging"];
  const EXCLUDE_KNIT = ["sweater", "cardigan", "woven", "poplin", "denim", "jean", "chambray",
    "twill", "flannel", "corduroy", "blouse", "camp shirt", "linen", "eyelet blouse",
    "peasant", "jacket", "coat", "blazer"];
  const MATERIAL_KEYS = ["Fabric Material", "Material", "Fabric Content", "Composition", "Fabric"];

  // brand (lowercased) -> sheet routing
  const BRANDS = {
    "time and tru": { kind: "women", sheet: "timeandtru" },
    "terra & sky": { kind: "women", sheet: "terra and sky" },
    "terra and sky": { kind: "women", sheet: "terra and sky" },
    "no boundaries": { kind: "women", sheet: "no boundaries" },
    "free assembly": { kind: "women", sheet: "Free Assembly" },
    "wonder nation": { kind: "kids", sheets: { girls: "Wonder Nation Girls", boys: "Wonder Nation Boys" } },
    "weekend academy": { kind: "kids", sheets: { girls: "Weekend Academy Girls", boys: "Weekend Academy Boys" } },
  };

  const COLS = ["Thumbnail", "Image URL", "Product URL", "Brand", "Category", "Product Name",
    "Retail Price", "Fabric Composition", "Fabric Weight (if available)", "Fabric Construction",
    "Surface / Texture", "Handfeel", "Finish / Treatment", "Performance Features",
    "Sustainability Claims", "Colorways", "Key Design Details", "Material Analysis",
    "Commercial Opportunity", "Source"];

  const has = (t, arr) => { t = (t || "").toLowerCase(); return arr.find(k => t.includes(k)) || null; };

  function categorize(name, category) {
    const blob = `${name} ${category}`.toLowerCase();
    for (const cat in CATEGORY_RULES) if (CATEGORY_RULES[cat].some(k => blob.includes(k))) return cat;
    return null;
  }
  function department(name, category, deptField) {
    const blob = `${deptField || ""} ${name} ${category}`.toLowerCase();
    if (/baby|toddler|newborn/.test(blob)) return "baby";
    if (/girls|girl /.test(blob)) return "girls";
    if (/boys|boy /.test(blob)) return "boys";
    if (blob.includes("men") && !blob.includes("women")) return "men";
    if (/women|womens|ladies/.test(blob)) return "women";
    return "unknown";
  }
  function route(rec) {
    const cfg = BRANDS[(rec.brand || "").trim().toLowerCase()];
    if (!cfg) return [null, `unknown brand '${rec.brand}'`];
    const cat = categorize(rec.name, rec.category);
    if (!cat) return [null, "category not in target-5"];
    const dep = department(rec.name, rec.category, rec.department);
    if (cfg.kind === "women") {
      if (["men", "boys", "girls", "baby"].includes(dep)) return [null, `dept=${dep} excluded`];
      return [cfg.sheet, `${cat}/women`];
    }
    if (["girls", "boys"].includes(dep)) return [cfg.sheets[dep], `${cat}/${dep}`];
    return [null, `dept=${dep} (no girls/boys)`];
  }
  function knitScope(name, category, pubFabric) {
    const blob = `${name} ${category}`;
    if (has(pubFabric, KNIT_FABRIC) && !has(pubFabric, EXCLUDE_KNIT)) return "Verified";
    if (has(pubFabric, EXCLUDE_KNIT)) return "EXCLUDE";
    if (has(blob, EXCLUDE_KNIT) && !has(blob, KNIT_GARMENT)) return "EXCLUDE";
    if (has(blob, KNIT_GARMENT)) return "Visual Observation";
    return "Needs Review";
  }
  function derive(name) {
    const n = name.toLowerCase(); let con = "Cotton single jersey knit", surf = "Smooth jersey face";
    if (n.includes("slub")) [con, surf] = ["Slub single jersey knit", "Slub / uneven-yarn texture"];
    else if (n.includes("rib")) [con, surf] = ["Rib knit", "Ribbed vertical texture"];
    else if (n.includes("thermal") || n.includes("waffle")) [con, surf] = ["Thermal / waffle knit", "Waffle grid texture"];
    else if (n.includes("french terry")) [con, surf] = ["French terry knit", "Looped-back terry face"];
    else if (n.includes("fleece")) [con, surf] = ["Fleece knit", "Brushed fleece face"];
    else if (n.includes("pointelle")) [con, surf] = ["Pointelle knit", "Open decorative knit"];
    else if (n.includes("pima")) [con, surf] = ["Pima cotton jersey", "Fine smooth jersey face"];
    const neck = n.includes("crew") ? "Crew neck" : /v.?neck/.test(n) ? "V-neck" : n.includes("scoop") ? "Scoop neck" : "Round/other";
    const sleeve = n.includes("long sleeve") ? "Long sleeve" : n.includes("elbow") ? "Elbow sleeve"
      : /tank|cami|sleeveless/.test(n) ? "Sleeveless" : "Short sleeve";
    const det = [["tunic", "tunic length"], ["slim", "slim fit"], ["boxy", "boxy fit"], ["boyfriend", "boyfriend fit"],
      ["twist", "twist front"], ["envelope", "envelope back"], ["ruched", "side ruched"], ["hood", "hood"]]
      .filter(([k]) => n.includes(k)).map(([, v]) => v);
    return [con, surf, [neck, sleeve, ...det].join("; ")];
  }
  const tag = (v, t) => (v == null || v === "") ? "Needs Review" : `${v}  [${t}]`;

  function buildRow(rec) {
    const [con, surf, design] = derive(rec.name);
    const comp = rec.fabric_composition || "";
    const ncol = rec.colorways ? (rec.colorways.split(";").length) : 0;
    let tier = "core", p = parseFloat(String(rec.price).replace(/[^0-9.]/g, ""));
    if (!isNaN(p)) tier = p <= 8 ? "opening-price core" : p <= 13 ? "elevated basic" : "premium detail";
    const mat = (comp ? `${comp} — Verified composition. ` : `${con} (composition Needs Review). `) +
      (con.includes("Rib") ? "Rib gives lateral stretch/close fit." :
        con.includes("Slub") ? "Slub yarn adds surface texture, soft dry hand." :
        con.includes("Thermal") ? "Waffle structure = lightweight insulation." :
        con.includes("Pointelle") ? "Open decorative knit, breathable." : "Core jersey, breathable easy hand.");
    const comm = `${rec.price || "?"} ${tier} ${(rec.category || "item").toLowerCase()}` + (ncol >= 4 ? `; ${ncol}-color depth.` : ".");
    const d = {
      "Thumbnail": "See Image URL", "Image URL": rec.image_url || "Needs Review",
      "Product URL": rec.product_url || "Needs Review", "Brand": rec.brand, "Category": rec.category,
      "Product Name": rec.name, "Retail Price": rec.price || "Needs Review",
      "Fabric Composition": comp ? tag(comp, "Verified") : "Needs Review",
      "Fabric Weight (if available)": "Needs Review",
      "Fabric Construction": tag(con, comp ? "Verified" : "Visual Observation"),
      "Surface / Texture": tag(surf, "Visual Observation"),
      "Handfeel": tag("Soft hand (base-derived)", "Visual Observation"),
      "Finish / Treatment": rec.care ? tag(rec.care, "Verified") : "Needs Review",
      "Performance Features": "Needs Review", "Sustainability Claims": "Needs Review",
      "Colorways": rec.colorways ? tag(rec.colorways, "Verified") : "Needs Review",
      "Key Design Details": tag(design + (rec.fit ? `; ${rec.fit}` : ""), "Visual Observation"),
      "Material Analysis": mat, "Commercial Opportunity": comm, "Source": rec.product_url || "Needs Review",
    };
    return COLS.map(c => d[c]);
  }

  // records[] -> filled workbook bytes, using an XLSX template ArrayBuffer. Needs SheetJS (XLSX global).
  function fillWorkbook(XLSX, templateArrayBuffer, records, opts = {}) {
    const wb = XLSX.read(templateArrayBuffer, { type: "array" });
    const buckets = {}, dropped = [];
    const seen = new Set();
    for (const rec of records) {
      const [sheet, why] = route(rec);
      if (!sheet) { dropped.push([rec.name, why]); continue; }
      if (knitScope(rec.name, rec.category, rec.fabric_composition) === "EXCLUDE") {
        if (!opts.keepWoven) { dropped.push([rec.name, "non-knit"]); continue; }
      }
      if (opts.dedupe) { const k = sheet + "|" + rec.name.toLowerCase(); if (seen.has(k)) continue; seen.add(k); }
      (buckets[sheet] = buckets[sheet] || []).push(rec);
    }
    for (const sheet in buckets) {
      const ws = wb.Sheets[sheet]; if (!ws) continue;
      const rows = buckets[sheet].map(buildRow);
      XLSX.utils.sheet_add_aoa(ws, rows, { origin: "A2" });
      // extend the sheet !ref so new rows are included
      const range = XLSX.utils.decode_range(ws["!ref"]);
      range.e.r = Math.max(range.e.r, rows.length + 1); range.e.c = Math.max(range.e.c, 19);
      ws["!ref"] = XLSX.utils.encode_range(range);
    }
    const out = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    return { bytes: out, kept: buckets, dropped };
  }

  const api = { CATEGORY_RULES, MATERIAL_KEYS, BRANDS, COLS, categorize, department, route, knitScope, derive, buildRow, fillWorkbook };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.WPB = api;
})(typeof self !== "undefined" ? self : this);
