/* Styled Excel builder (ExcelJS) — produces the clean 9-column workbook with
   embedded thumbnail images and readable formatting.

   Columns (exactly, in order):
     Thumbnail · Product URL · Brand · Category · Product Name ·
     Retail Price · Colorways · Fabric Composition · Key Design Details

   Thumbnails: the real image is embedded into the cell. If the image bytes
   can't be fetched (or are webp, which xlsx can't embed), the cell falls back
   to an =IMAGE("url") formula (renders in Excel 365 / Google Sheets), and
   always carries the image URL as a hyperlink so the link is never lost.

   Runs in the content script (global ExcelJS + WPB) and under Node (require).
*/
(function (root) {
  "use strict";

  const HEADERS = ["Thumbnail", "Product URL", "Brand", "Category", "Product Name",
    "Retail Price", "Colorways", "Fabric Composition", "Key Design Details"];
  // column widths in Excel "characters"
  const WIDTHS = [16, 46, 16, 22, 40, 12, 22, 30, 34];
  const IMG_PX = 96;          // embedded image box
  const ROW_H = 78;           // data row height (points) to fit the image

  function cleanComposition(rec) {
    const c = rec.fabric_composition;
    return (c && String(c).trim()) ? String(c).trim() : "Needs Review";
  }
  function colorways(rec) {
    const c = rec.colorways;
    return (c && String(c).trim()) ? String(c).trim() : "Needs Review";
  }
  function designDetails(rec, WPB) {
    try { return WPB.derive(rec.name)[2] || ""; } catch (e) { return ""; }
  }
  function price(rec) {
    const p = rec.price;
    if (p == null || p === "") return "Needs Review";
    const s = String(p).trim();
    return /^\d/.test(s) ? "$" + s : s;
  }

  // Keep only in-scope knit items, using the shared pipeline rules.
  function filterKept(items, WPB) {
    const kept = [], dropped = [], seen = new Set();
    for (const rec of items) {
      const [sheet, why] = WPB.route(rec);
      if (!sheet) { dropped.push([rec.name, why]); continue; }
      if (WPB.knitScope(rec.name, rec.category, rec.fabric_composition) === "EXCLUDE") {
        dropped.push([rec.name, "non-knit"]); continue;
      }
      const k = (rec.id || rec.product_url || rec.name || "").toLowerCase();
      if (k && seen.has(k)) continue; if (k) seen.add(k);
      kept.push(rec);
    }
    return { kept, dropped };
  }

  // items: normalized records. ctx: { ExcelJS?, WPB?, fetchImage?(url)->{ok,base64,ext}|null, scope? }
  async function buildKnitWorkbook(items, ctx) {
    ctx = ctx || {};
    const ExcelJS = ctx.ExcelJS || root.ExcelJS || (typeof require !== "undefined" && require("exceljs"));
    const WPB = ctx.WPB || root.WPB || (typeof require !== "undefined" && require("./pipeline.js"));
    const fetchImage = typeof ctx.fetchImage === "function" ? ctx.fetchImage : null;

    // ctx.scope === false -> keep everything (no knit/brand filtering)
    const { kept, dropped } = ctx.scope === false
      ? { kept: items.slice(), dropped: [] }
      : filterKept(items, WPB);

    const wb = new ExcelJS.Workbook();
    wb.creator = "Fabric-Scanner";
    const ws = wb.addWorksheet("Products", { views: [{ state: "frozen", ySplit: 1 }] });
    ws.columns = HEADERS.map((h, i) => ({ header: h, width: WIDTHS[i] }));

    // header styling
    const head = ws.getRow(1);
    head.height = 22;
    head.eachCell(c => {
      c.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
      c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0071DC" } };
      c.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
      c.border = { bottom: { style: "thin", color: { argb: "FFBBBBBB" } } };
    });
    ws.autoFilter = { from: { row: 1, column: 2 }, to: { row: 1, column: HEADERS.length } };

    const onProgress = typeof ctx.onProgress === "function" ? ctx.onProgress : null;
    for (let i = 0; i < kept.length; i++) {
      const rec = kept[i];
      if (onProgress && i % 3 === 0) { try { await onProgress(i, kept.length); } catch (e) {} }
      const rowNo = i + 2;                 // 1 = header
      const row = ws.getRow(rowNo);
      row.values = [
        "",                                // Thumbnail (image/formula set below)
        rec.product_url || "Needs Review",
        rec.brand || "",
        rec.category || "",
        rec.name || "",
        price(rec),
        colorways(rec),
        cleanComposition(rec),
        designDetails(rec, WPB),
      ];
      row.height = ROW_H;
      row.alignment = { vertical: "middle", wrapText: true };
      row.eachCell(c => { c.border = { bottom: { style: "hair", color: { argb: "FFDDDDDD" } } }; });

      // Product URL as a clickable hyperlink
      if (rec.product_url) {
        const uc = row.getCell(2);
        uc.value = { text: rec.product_url, hyperlink: rec.product_url };
        uc.font = { color: { argb: "FF0563C1" }, underline: true };
      }
      // Price centered
      row.getCell(6).alignment = { vertical: "middle", horizontal: "center" };

      // Thumbnail
      const thumb = row.getCell(1);
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
        } catch (e) { /* fall through to formula */ }
      }
      if (!embedded && rec.image_url) {
        // Excel 365 / Google Sheets render this; older Excel shows the link.
        thumb.value = { formula: '_xlfn.IMAGE("' + rec.image_url.replace(/"/g, "") + '")', result: "" };
        thumb.note = rec.image_url;
      } else if (!rec.image_url) {
        thumb.value = "Needs Review";
      }
    }

    const buf = await wb.xlsx.writeBuffer();
    return { bytes: new Uint8Array(buf), kept: { Products: kept }, dropped };
  }

  const api = { HEADERS, buildKnitWorkbook, filterKept };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.WPBExcel = api;
})(typeof self !== "undefined" ? self : this);
