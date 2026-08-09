/* Styled Excel builder (ExcelJS) — the seven fields the design team reads, with
   embedded thumbnails and a strict provenance rule:

     - only words that are literally on the site go in as normal text
     - inferred / predicted values are NOT written; the cell shows "재확인 필요" (red)
     - information we could not find shows "정보 확인" (red italic)
     - when a problem caused the miss, the cause is appended: "정보 확인 (원인)"

   Columns (exactly, in order):
     브랜드 · 카테고리 · 상품명 · 썸네일 · URL · 원단 · 혼용률

   Runs in the content script (global ExcelJS) and under Node (require).
*/
(function (root) {
  "use strict";

  // The seven fields the design team actually reads. 원단 (fibre names) and
  // 혼용률 (the exact blend) are separate columns on purpose: sorting or
  // filtering by "cotton" is a different question from "how much cotton".
  const HEADERS = ["브랜드", "카테고리", "상품명", "썸네일", "URL", "원단", "혼용률"];
  const WIDTHS = [16, 20, 38, 16, 46, 22, 28];
  const COL = { brand: 1, category: 2, name: 3, thumb: 4, url: 5, fabric: 6, blend: 7 };
  const IMG_PX = 96;
  const ROW_H = 78;

  const HEADER_FILL = "FF0F3B5F";   // requested unified header colour (#0F3B5F)
  const REVERIFY = "재확인 필요";    // inferred/predicted -> must be re-checked (red)
  const CHECK = "정보 확인";         // not found (grey)

  const FONT_REAL = { color: { argb: "FF1A1A1A" } };
  const FONT_REVERIFY = { color: { argb: "FFCC0000" }, bold: true };  // inferred -> red bold
  const FONT_CHECK = { color: { argb: "FFCC0000" }, italic: true };   // unconfirmed/not found -> red italic
  const FONT_SALE = { color: { argb: "FFCC0000" } };                  // discounted price pair -> plain red

  // Only design descriptors that literally appear in the product name are "real".
  const DESIGN_TOKENS = [
    "crew neck", "crewneck", "v-neck", "vneck", "v neck", "scoop neck", "mock neck",
    "boat neck", "cowl neck", "henley", "turtleneck",
    "long sleeve", "short sleeve", "sleeveless", "elbow sleeve", "3/4 sleeve",
    "quarter sleeve", "cap sleeve", "puff sleeve", "dolman", "raglan",
    "tunic", "cropped", "crop", "boxy", "slim fit", "relaxed", "oversized", "fitted",
    "longline", "bodysuit", "peplum",
    "ruched", "twist front", "tie front", "knot front", "button front", "pocket",
    "hooded", "hood", "quarter zip", "half zip", "full zip", "drawstring", "smocked",
    "ruffle", "lace", "pleated", "shirred", "adjustable strap", "chenille",
    "slub", "ribbed", "rib knit", "thermal", "waffle", "french terry", "terry",
    "fleece", "pointelle", "pima", "jersey", "cable knit",
  ];

  function reasonKo(reason) {
    return ({
      blocked: "상세 페이지 차단됨",
      timeout: "시간 초과",
      not_found: "페이지에 정보 없음",
      not_collected: "원단 조성 미수집(옵션 꺼짐)",
      error: "수집 오류",
    })[reason] || "";
  }

  const cap = w => w.replace(/\b\w/g, c => c.toUpperCase());

  function literalDesign(name) {
    const n = (name || "").toLowerCase();
    let hits = DESIGN_TOKENS.filter(t => n.includes(t));
    // drop any token that is a substring of another matched token (crop vs cropped)
    hits = hits.filter(t => !hits.some(o => o !== t && o.includes(t)));
    const uniq = [...new Set(hits)];
    return uniq.length ? uniq.map(cap).join("\n") : "";   // one descriptor per line
  }

  // Each field -> { text, kind } where kind ∈ 'real' | 'reverify' | 'check'
  const real = t => ({ text: t, kind: "real" });
  const check = cause => ({ text: cause ? `${CHECK} (${cause})` : CHECK, kind: "check" });
  const reverify = () => ({ text: REVERIFY, kind: "reverify" });

  function fieldBrand(rec)    { return rec.brand ? real(String(rec.brand)) : check(); }
  function fieldCategory(rec) { return rec.category ? real(String(rec.category)) : check(); }

  // Split the size range out of a product name:
  //   "Capri Leggings, XS-XXXL"                 -> "Capri Leggings"                    | "XS-XXXL"
  //   "Denim Jegging, Sizes XS-XXXL"            -> "Denim Jegging"                     | "XS-XXXL"
  //   "Knit Leggings, 27\" Inseam, XS-XXXL"     -> "Knit Leggings, 27\" Inseam"        | "XS-XXXL"
  //   "Boxy Zip Up Hoodie, Women's XXS-XXL"     -> "Boxy Zip Up Hoodie"                | "XXS-XXL"
  //   "Cami, Women's and Women's Plus XXS-3X"   -> "Cami"                              | "XXS-3X"
  // A size token is XXS/XS/S/M/L/XL/XXL/XXXL or 2X/3X/4X; a range is TOKEN-TOKEN.
  const SIZE_TOK = "(?:[0-9]{1,2}X|[0-9X]{0,3}[SML])";
  const SIZE_RANGE_RE = new RegExp("\\b(" + SIZE_TOK + "\\s*[-–]\\s*" + SIZE_TOK + ")\\b", "gi");
  const GENDER_TAIL_RE = /[\s,]*(?:(?:women'?s?|men'?s?|juniors?'?|girls?'?|boys?'?|kids?'?|unisex|and|plus|&)[\s,]*)+$/i;
  function splitSize(name) {
    const n = String(name || "").trim();
    if (!n) return { name: n, size: "" };
    // explicit "... Sizes X-Y" at the end
    let m = n.match(/,?\s*\bSizes?\s+([^,]+?)\s*$/i);
    if (m) return { name: n.slice(0, m.index).replace(/,\s*$/, "").trim(), size: m[1].trim() };
    // a size range anywhere (usually at the end), possibly behind a gender/plus
    // phrase ("Women's XXS-XXL", "Women's and Women's Plus XXS-3X")
    const all = [...n.matchAll(SIZE_RANGE_RE)];
    if (all.length) {
      const hit = all[all.length - 1];
      const size = hit[1].replace(/\s+/g, "");
      const base = (n.slice(0, hit.index) + n.slice(hit.index + hit[0].length))
        .replace(GENDER_TAIL_RE, "").replace(/[\s,]+$/, "").trim();
      return { name: base || n, size };
    }
    return { name: n, size: "" };
  }
  function fieldName(rec) {
    const { name } = splitSize(rec.name);
    return name ? real(name) : check();
  }
  function fieldSize(rec) {
    // detail-collected size list (e.g. SFCC variationAttributes) beats the
    // name-derived range; both are literal site values
    if (rec.size_range && String(rec.size_range).trim()) return real(String(rec.size_range).trim());
    const { size } = splitSize(rec.name);
    return size ? real(size) : check();
  }

  // Retail (original) + Current price pair. When they differ (markdown/sale),
  // BOTH cells go red so discounted items stand out.
  const priceNum = s => parseFloat(String(s).replace(/[^0-9.]/g, ""));
  const priceStr = p => { const s = String(p).trim(); return /^\d/.test(s) ? "$" + s : s; };
  function fieldPrices(rec) {
    const cur = (rec.price != null && rec.price !== "") ? priceStr(rec.price) : null;
    const was = (rec.price_was != null && rec.price_was !== "") ? priceStr(rec.price_was) : null;
    const orig = was || cur;                       // no was-price -> not discounted
    const differ = !!(was && cur && priceNum(was) !== priceNum(cur));
    const kind = differ ? "sale" : "real";
    return {
      orig: orig ? { text: orig, kind } : check(),
      cur: cur ? { text: cur, kind } : check(),
    };
  }
  // A size token (XS, 2X, 14, "24 Plus", "XS-4X" …) is never a colour. Adapters
  // read colours from variant lists that sometimes also hold sizes; filtering
  // here means a leak can never be shown or counted as a colour, on ANY site.
  // Real colour names ("Ruby Light Check", "Cream 100") never match this.
  const SIZE_TOKEN = /^(?:one\s*size|o\/?s|x{0,3}s|m|x{0,4}l|\d{1,2}|\d{1,2}\s?x|\d{1,3}\s*plus|[\dxsml]{1,4}\s*-\s*[\dxsml]{1,4})$/i;
  // Split a colorways string ("Black; Navy; White") into its list, dropping any
  // leaked size tokens. Tolerant of ';' , '/' and ',' separators.
  function colorList(rec) {
    const s = (rec.colorways && String(rec.colorways).trim()) || "";
    if (!s) return [];
    return s.split(/\s*[;/]\s*|\s*,\s*/).map(x => x.trim())
      .filter(x => x && !SIZE_TOKEN.test(x));
  }
  function fieldColorways(rec) {
    const list = colorList(rec);
    // one colour per line so a multi-colour product reads cleanly (centred via
    // the col-9 alignment below) instead of a run-on "; "-joined blob.
    return list.length ? real(list.join("\n")) : check();
  }
  function fieldColorCount(rec, familyCount) {
    // The count must never disagree with the Colorways cell, so take the MAX of:
    // the listed colour names, an explicit adapter count (e.g. a Cotton On swatch
    // count when names aren't known), and the product-family count (Cotton On
    // lists each colour as its own row sharing the product slug).
    const n = Math.max(
      colorList(rec).length,
      parseInt(rec.color_count) || 0,
      familyCount > 1 ? familyCount : 0);
    return n ? real(String(n)) : check();   // unknown colorways -> unknown count (red)
  }
  // group key: same site + same product slug. For a "<slug>/<pid>.html" URL the
  // slug is the segment before the .html file; otherwise it's the LAST path
  // segment (e.g. Massimo Dutti "/us/<slug>-l<ref>", COS "/…/<slug>"). Colour
  // variants of one product share this; unrelated products don't. (Using the
  // last segment — not the second-to-last — matters for two-segment paths like
  // "/us/<slug>", where second-to-last is the locale and would wrongly unite the
  // whole page into one family, inflating every colour count.)
  function familyKey(rec) {
    try {
      const u = new URL(rec.product_url || "");
      const segs = u.pathname.split("/").filter(Boolean);
      const i = segs.findIndex(s => /\.html$/i.test(s));
      const slug = i > 0 ? segs[i - 1] : segs[segs.length - 1];
      return slug ? (u.host + "/" + slug.toLowerCase()) : "";
    } catch (e) { return ""; }
  }
  // 혼용률 — the blend exactly as the site stated it ("69% Cotton, 31% Cupro").
  function fieldComposition(rec) {
    if (rec.fabric_composition && String(rec.fabric_composition).trim())
      return real(String(rec.fabric_composition).trim());
    return check(reasonKo(rec._compReason));
  }
  // 원단 — just the fibres named in that blend, percentages stripped, in the
  // order the site listed them ("69% Cotton, 31% Cupro" -> "Cotton, Cupro").
  // Derived from the same recorded text, so it never introduces a fibre the
  // site didn't state.
  function fibreNames(comp) {
    const t = String(comp || "");
    if (!t.trim()) return [];
    const out = [], seen = new Set();
    // each "<pct>% <fibre words>" run; also bare fibre names with no percentage
    const re = /(?:\d{1,3}\s*%\s*)?([A-Za-z][A-Za-z\s-]{1,28}?)(?=\s*(?:[,;/&+]|\d{1,3}\s*%|$))/g;
    let m;
    while ((m = re.exec(t))) {
      const name = m[1].replace(/\s+/g, " ").trim()
        .replace(/\b\w/g, c => c.toUpperCase());
      const k = name.toLowerCase();
      if (name.length < 2 || seen.has(k)) continue;
      seen.add(k); out.push(name);
    }
    return out;
  }
  function fieldFabric(rec) {
    const names = fibreNames(rec.fabric_composition);
    return names.length ? real(names.join(", ")) : check(reasonKo(rec._compReason));
  }
  function fieldDesign(rec) {
    // 1) real design features pulled from the product page ("Fit: Relaxed; ...")
    if (rec.design && String(rec.design).trim()) return real(String(rec.design).trim());
    // 2) descriptors literally present in the product name
    const lit = literalDesign(rec.name);
    if (lit) return real(lit);
    // 3) nothing literal -> don't guess
    return reverify();
  }
  function fontFor(kind) {
    return kind === "reverify" ? FONT_REVERIFY
      : kind === "check" ? FONT_CHECK
      : kind === "sale" ? FONT_SALE
      : FONT_REAL;
  }

  const norm = s => String(s || "").toLowerCase().trim();
  // Word-boundary term match: the term must start at a boundary (start of string
  // or a non-alphanumeric char) but need not end at one, so "legging" matches
  // "leggings" yet "men's" does NOT match inside "women's" (wo·men's). Without
  // this, excluding "Men's" would wrongly drop every "Women's" product.
  function hasTerm(hay, term) {
    if (!term) return false;
    const esc = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    try { return new RegExp("(?:^|[^a-z0-9])" + esc, "i").test(hay); }
    catch (e) { return hay.includes(term); }
  }

  // The brand a shopper searched for is the MAJORITY brand; third-party
  // marketplace sellers (ZHYou, BUIGTTKLOP, …) show up as different, sparse
  // brand values. "제3자 셀러 제외" keeps only the dominant brand.
  function dominantBrand(items) {
    const count = new Map();
    for (const r of items) { const b = norm(r.brand); if (b) count.set(b, (count.get(b) || 0) + 1); }
    let best = "", n = 0;
    count.forEach((c, b) => { if (c > n) { n = c; best = b; } });
    return best;
  }

  // Apply de-dupe first, then the optional user filters. Returns kept + a
  // reason-tagged dropped list so the UI can report what each filter removed.
  // filters: { brands:[..], dominantBrandOnly:bool, nameInclude:[..], nameExclude:[..] }
  function filterKept(items, filters) {
    filters = filters || {};
    const wantBrands = (filters.brands || []).map(norm).filter(Boolean);
    const include = (filters.nameInclude || []).map(norm).filter(Boolean);
    const exclude = (filters.nameExclude || []).map(norm).filter(Boolean);
    const domOnly = !!filters.dominantBrandOnly;

    const kept = [], dropped = [], seen = new Set();
    // de-dupe up front so dominant-brand vote isn't skewed by duplicates
    const uniq = [];
    for (const rec of items) {
      const k = (rec.id || rec.product_url || rec.name || "").toLowerCase();
      if (k && seen.has(k)) { dropped.push([rec.name, "duplicate"]); continue; }
      if (k) seen.add(k);
      uniq.push(rec);
    }
    const dom = domOnly ? dominantBrand(uniq) : "";

    for (const rec of uniq) {
      const brand = norm(rec.brand), name = norm(rec.name);
      if (domOnly && dom && brand !== dom) { dropped.push([rec.name, "brand"]); continue; }
      if (wantBrands.length && !wantBrands.some(b => brand.includes(b))) { dropped.push([rec.name, "brand"]); continue; }
      if (include.length && !include.some(w => hasTerm(name, w))) { dropped.push([rec.name, "name-include"]); continue; }
      if (exclude.length && exclude.some(w => hasTerm(name, w))) { dropped.push([rec.name, "name-exclude"]); continue; }
      kept.push(rec);
    }
    return { kept, dropped };
  }

  // items: normalized records. ctx: { ExcelJS?, fetchImage?, onProgress?, filters? }
  async function buildKnitWorkbook(items, ctx) {
    ctx = ctx || {};
    const ExcelJS = ctx.ExcelJS || root.ExcelJS || (typeof require !== "undefined" && require("exceljs"));
    const fetchImage = typeof ctx.fetchImage === "function" ? ctx.fetchImage : null;
    const onProgress = typeof ctx.onProgress === "function" ? ctx.onProgress : null;

    const { kept: unsorted, dropped } = filterKept(items, ctx.filters);

    /* One file, grouped by BRAND only. A list run collects several brands, and
       a spreadsheet that interleaves them is unreadable — the designer wants
       Cotton On's rows together, then Zara's.

       Brand alone, not brand-then-category: splitting again by category slices
       the sheet into too many small blocks to read, and each scan already
       covers one category, so a brand's categories land together anyway.
       Array#sort is stable, so inside a brand the shop's own order survives —
       that order is the merchandiser's ranking and re-sorting by name would
       throw the information away. Rows with no brand sink to the bottom —
       spelled out rather than done with a high sentinel character, because a
       U+FFFF sentinel makes the file invalid UTF-8 and Chrome then refuses to
       load the whole extension. */
    const brandOf = r => String(r.brand || "").toLowerCase();
    const kept = unsorted.slice().sort((a, b) => {
      const x = brandOf(a), y = brandOf(b);
      if (!x || !y) return (!x && !y) ? 0 : (x ? -1 : 1);
      return x.localeCompare(y);
    });

    // colour-variant families: how many kept rows share each product slug
    const family = new Map();

    const wb = new ExcelJS.Workbook();
    wb.creator = "Fabric-Scanner";
    const ws = wb.addWorksheet("Products", { views: [{ state: "frozen", ySplit: 1 }] });
    ws.columns = HEADERS.map((h, i) => ({ header: h, width: WIDTHS[i] }));

    const head = ws.getRow(1);
    head.height = 22;
    head.eachCell(c => {
      c.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
      c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
      c.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
      c.border = { bottom: { style: "thin", color: { argb: "FFBBBBBB" } } };
    });
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: HEADERS.length } };

    for (let i = 0; i < kept.length; i++) {
      const rec = kept[i];
      if (onProgress && i % 3 === 0) { try { await onProgress(i, kept.length); } catch (e) {} }
      const rowNo = i + 2;
      const row = ws.getRow(rowNo);

      // text columns; thumbnail (4) and URL (5) are handled separately below
      const fields = {
        [COL.brand]: fieldBrand(rec),
        [COL.category]: fieldCategory(rec),
        [COL.name]: fieldName(rec),
        [COL.fabric]: fieldFabric(rec),
        [COL.blend]: fieldComposition(rec),
      };
      row.height = ROW_H;
      row.alignment = { vertical: "middle", wrapText: true };

      Object.keys(fields).forEach(c => {
        const f = fields[c];
        const cell = row.getCell(+c);
        cell.value = f.text;
        cell.font = fontFor(f.kind);
        cell.border = { bottom: { style: "hair", color: { argb: "FFDDDDDD" } } };
      });
      row.getCell(COL.fabric).alignment = { vertical: "middle", horizontal: "center", wrapText: true };
      row.getCell(COL.blend).alignment = { vertical: "middle", horizontal: "center", wrapText: true };

      // Product URL
      const uc = row.getCell(COL.url);
      if (rec.product_url) {
        uc.value = { text: rec.product_url, hyperlink: rec.product_url };
        uc.font = { color: { argb: "FF0563C1" }, underline: true };
      } else {
        const f = check(); uc.value = f.text; uc.font = fontFor(f.kind);
      }
      uc.border = { bottom: { style: "hair", color: { argb: "FFDDDDDD" } } };

      // Thumbnail
      const thumb = row.getCell(COL.thumb);
      thumb.border = { bottom: { style: "hair", color: { argb: "FFDDDDDD" } } };
      let embedded = false;
      if (fetchImage && rec.image_url) {
        try {
          const img = await fetchImage(rec.image_url);
          if (img && img.ok && img.base64 && /^(png|jpeg|gif)$/.test(img.ext)) {
            const id = wb.addImage({ base64: img.base64, extension: img.ext });
            ws.addImage(id, {
              tl: { col: (COL.thumb - 1) + 0.15, row: (rowNo - 1) + 0.12 },
              ext: { width: IMG_PX, height: IMG_PX },
              editAs: "oneCell",
            });
            embedded = true;
          }
        } catch (e) { /* fall through */ }
      }
      if (!embedded) {
        if (rec.image_url) {
          // real site image, shown via formula in Excel 365 / Google Sheets
          thumb.value = { formula: '_xlfn.IMAGE("' + rec.image_url.replace(/"/g, "") + '")', result: "" };
          thumb.note = rec.image_url;
        } else {
          const f = check(); thumb.value = f.text; thumb.font = fontFor(f.kind);
        }
      }
    }

    const buf = await wb.xlsx.writeBuffer();
    return { bytes: new Uint8Array(buf), kept: { Products: kept }, dropped };
  }

  const api = { HEADERS, buildKnitWorkbook, filterKept, literalDesign, reasonKo, _familyKey: familyKey, _colorList: colorList };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.WPBExcel = api;
})(typeof self !== "undefined" ? self : this);
