/* Styled Excel builder (ExcelJS) — clean 9-column workbook with embedded
   thumbnails and a strict provenance rule:

     - only words that are literally on the site go in as normal text
     - inferred / predicted values are NOT written; the cell shows "재확인 필요" (red)
     - information we could not find shows "정보 확인" (grey)
     - when a problem caused the miss, the cause is appended: "정보 확인 (원인)"

   Columns (exactly, in order):
     Thumbnail · Product URL · Brand · Category · Product Name ·
     Retail Price · Colorways · Fabric Composition · Key Design Details

   Runs in the content script (global ExcelJS + WPB) and under Node (require).
*/
(function (root) {
  "use strict";

  const HEADERS = ["Thumbnail", "Product URL", "Brand", "Category", "Product Name",
    "Retail Price", "Colorways", "Fabric Composition", "Key Design Details"];
  const WIDTHS = [16, 46, 16, 22, 40, 12, 22, 30, 34];
  const IMG_PX = 96;
  const ROW_H = 78;

  const HEADER_FILL = "FF0F3B5F";   // requested unified header colour (#0F3B5F)
  const REVERIFY = "재확인 필요";    // inferred/predicted -> must be re-checked (red)
  const CHECK = "정보 확인";         // not found (grey)

  const FONT_REAL = { color: { argb: "FF1A1A1A" } };
  const FONT_REVERIFY = { color: { argb: "FFCC0000" }, bold: true };  // inferred -> red bold
  const FONT_CHECK = { color: { argb: "FFCC0000" }, italic: true };   // unconfirmed/not found -> red italic

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
    return uniq.length ? uniq.map(cap).join("; ") : "";
  }

  // Each field -> { text, kind } where kind ∈ 'real' | 'reverify' | 'check'
  const real = t => ({ text: t, kind: "real" });
  const check = cause => ({ text: cause ? `${CHECK} (${cause})` : CHECK, kind: "check" });
  const reverify = () => ({ text: REVERIFY, kind: "reverify" });

  function fieldBrand(rec)    { return rec.brand ? real(String(rec.brand)) : check(); }
  function fieldCategory(rec) { return rec.category ? real(String(rec.category)) : check(); }
  function fieldName(rec)     { return rec.name ? real(String(rec.name)) : check(); }
  function fieldPrice(rec) {
    if (rec.price == null || rec.price === "") return check();
    const s = String(rec.price).trim();
    return real(/^\d/.test(s) ? "$" + s : s);
  }
  function fieldColorways(rec) {
    return (rec.colorways && String(rec.colorways).trim()) ? real(String(rec.colorways).trim()) : check();
  }
  function fieldComposition(rec) {
    if (rec.fabric_composition && String(rec.fabric_composition).trim())
      return real(String(rec.fabric_composition).trim());
    return check(reasonKo(rec._compReason));
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
    return kind === "reverify" ? FONT_REVERIFY : kind === "check" ? FONT_CHECK : FONT_REAL;
  }

  // Keep every product on the page; only drop exact duplicates. Related/
  // recommended/sponsored carousels are already excluded upstream (the collector
  // reads the main results grid only), so nothing else needs filtering here.
  function filterKept(items) {
    const kept = [], dropped = [], seen = new Set();
    for (const rec of items) {
      const k = (rec.id || rec.product_url || rec.name || "").toLowerCase();
      if (k && seen.has(k)) { dropped.push([rec.name, "duplicate"]); continue; }
      if (k) seen.add(k);
      kept.push(rec);
    }
    return { kept, dropped };
  }

  // items: normalized records. ctx: { ExcelJS?, WPB?, fetchImage?(url)->{ok,base64,ext}|null, onProgress?, scope? }
  async function buildKnitWorkbook(items, ctx) {
    ctx = ctx || {};
    const ExcelJS = ctx.ExcelJS || root.ExcelJS || (typeof require !== "undefined" && require("exceljs"));
    const fetchImage = typeof ctx.fetchImage === "function" ? ctx.fetchImage : null;
    const onProgress = typeof ctx.onProgress === "function" ? ctx.onProgress : null;

    const { kept, dropped } = filterKept(items);

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
    ws.autoFilter = { from: { row: 1, column: 2 }, to: { row: 1, column: HEADERS.length } };

    for (let i = 0; i < kept.length; i++) {
      const rec = kept[i];
      if (onProgress && i % 3 === 0) { try { await onProgress(i, kept.length); } catch (e) {} }
      const rowNo = i + 2;
      const row = ws.getRow(rowNo);

      // columns 2..9 (thumbnail handled after)
      const fields = [
        null,                    // 1 Thumbnail
        null,                    // 2 Product URL (hyperlink, handled below)
        fieldBrand(rec),         // 3
        fieldCategory(rec),      // 4
        fieldName(rec),          // 5
        fieldPrice(rec),         // 6
        fieldColorways(rec),     // 7
        fieldComposition(rec),   // 8
        fieldDesign(rec),        // 9
      ];
      row.height = ROW_H;
      row.alignment = { vertical: "middle", wrapText: true };

      for (let c = 3; c <= 9; c++) {
        const f = fields[c - 1];
        const cell = row.getCell(c);
        cell.value = f.text;
        cell.font = fontFor(f.kind);
        cell.border = { bottom: { style: "hair", color: { argb: "FFDDDDDD" } } };
      }
      row.getCell(6).alignment = { vertical: "middle", horizontal: "center", wrapText: true };

      // Product URL (col 2)
      const uc = row.getCell(2);
      if (rec.product_url) {
        uc.value = { text: rec.product_url, hyperlink: rec.product_url };
        uc.font = { color: { argb: "FF0563C1" }, underline: true };
      } else {
        const f = check(); uc.value = f.text; uc.font = fontFor(f.kind);
      }
      uc.border = { bottom: { style: "hair", color: { argb: "FFDDDDDD" } } };

      // Thumbnail (col 1)
      const thumb = row.getCell(1);
      thumb.border = { bottom: { style: "hair", color: { argb: "FFDDDDDD" } } };
      let embedded = false;
      if (fetchImage && rec.image_url) {
        try {
          const img = await fetchImage(rec.image_url);
          if (img && img.ok && img.base64 && /^(png|jpeg|gif)$/.test(img.ext)) {
            const id = wb.addImage({ base64: img.base64, extension: img.ext });
            ws.addImage(id, {
              tl: { col: 0.15, row: (rowNo - 1) + 0.12 },
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

  const api = { HEADERS, buildKnitWorkbook, filterKept, literalDesign, reasonKo };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.WPBExcel = api;
})(typeof self !== "undefined" ? self : this);
