/* Scan lists — the saved "brand + category URL" lists the weekly routine runs on.

   The user already keeps this by hand in a text file (brand on one line, then
   "- Category : URL" rows). That file IS the workflow, so the parser below
   accepts exactly that shape — paste it in and the list is built. A list can
   then be run end to end: the queue in content.js walks each URL, scanning it
   fully, so the user clicks once instead of once per URL.

   Lists live in chrome.storage.local (they are small — tens of URLs), unlike the
   product catalog which needs IndexedDB. Pure functions are exported for tests. */
(function (root) {
  "use strict";
  const KEY = "wpb_lists";

  /* Parse the text format the user already writes:

       Aritzia
       - ALL NEW : https://www.aritzia.com/intl/en/new
       - Tops & Bodysuits : https://www.aritzia.com/intl/en/clothing/tops

       Zara
       - New : https://www.zara.com/us/en/woman-new-in-l1180.html

     A line with a URL becomes an entry; the most recent non-URL, non-bullet line
     is its brand. Bare URLs (no label) are accepted too — the label then comes
     from the URL's last path segment, so nothing is silently dropped. */
  function parseList(text) {
    const out = [];
    let brand = "";
    String(text || "").split(/\r?\n/).forEach(raw => {
      const line = raw.trim();
      if (!line) return;
      const urlMatch = line.match(/https?:\/\/\S+/);
      if (!urlMatch) {
        // a heading line — treat as the brand for the rows that follow
        const h = line.replace(/^[-*•]\s*/, "").replace(/[:：]\s*$/, "").trim();
        if (h && !/^https?:/i.test(h)) brand = h;
        return;
      }
      const url = urlMatch[0].replace(/[),.]+$/, "");
      // label = whatever precedes the URL, minus bullets and the separator
      let label = line.slice(0, urlMatch.index)
        .replace(/^[-*•]\s*/, "").replace(/[:：]\s*$/, "").trim();
      if (!label) {
        try {
          const segs = new URL(url).pathname.split("/").filter(Boolean);
          label = (segs.pop() || "").replace(/\.html?$/i, "").replace(/[-_]+/g, " ").trim();
        } catch (e) { label = ""; }
      }
      out.push({ brand, label, url });
    });
    return out;
  }

  /* Tabular import — a spreadsheet or CSV of brand / category / URL.

     Designers keep these lists in Excel as often as in a text file, so the
     import reads a grid (array of rows) rather than assuming one shape:

       - if a header row names the columns (brand/브랜드, category/카테고리/
         label/이름, url/링크/주소), those columns are used
       - otherwise every cell is scanned for a URL, and the other cells on that
         row become brand and label by position

     Anything without a URL is skipped rather than guessed at. */
  const HDR = {
    url: /^(url|link|주소|링크|사이트)$/i,
    brand: /^(brand|브랜드|shop|store|매장)$/i,
    label: /^(category|카테고리|label|name|이름|분류|메모|note)$/i,
  };
  function parseGrid(grid) {
    const rows = (grid || []).map(r => (r || []).map(c => cellText(c)));
    if (!rows.length) return [];

    // find a header row in the first few lines
    let hdrIdx = -1, cols = null;
    for (let i = 0; i < Math.min(5, rows.length); i++) {
      const r = rows[i];
      const found = { url: -1, brand: -1, label: -1 };
      r.forEach((c, j) => {
        const v = String(c || "").trim();
        Object.keys(HDR).forEach(k => { if (found[k] < 0 && HDR[k].test(v)) found[k] = j; });
      });
      if (found.url >= 0) { hdrIdx = i; cols = found; break; }
    }

    const out = [];
    const start = hdrIdx >= 0 ? hdrIdx + 1 : 0;
    let lastBrand = "";
    for (let i = start; i < rows.length; i++) {
      const r = rows[i];
      let url = "", brand = "", label = "";
      if (cols) {
        url = firstUrl(r[cols.url]);
        brand = cols.brand >= 0 ? String(r[cols.brand] || "").trim() : "";
        label = cols.label >= 0 ? String(r[cols.label] || "").trim() : "";
        if (!url) url = firstUrl(r.join(" "));      // URL drifted to another column
      } else {
        const j = r.findIndex(c => firstUrl(c));
        if (j < 0) {
          // a lone text cell above URL rows reads as a brand heading
          const only = r.filter(c => String(c || "").trim());
          if (only.length === 1) lastBrand = String(only[0]).trim();
          continue;
        }
        url = firstUrl(r[j]);
        const rest = r.filter((c, k) => k !== j && String(c || "").trim())
          .map(c => String(c).trim());
        if (rest.length >= 2) { brand = rest[0]; label = rest[1]; }
        // one text cell: under a brand heading it's the category, otherwise the
        // brand ("Aritzia" / "  ALL NEW  url" indents its rows this way)
        else if (rest.length === 1) { if (lastBrand) label = rest[0]; else brand = rest[0]; }
      }
      if (!url) continue;
      if (!brand) brand = lastBrand;
      if (!label) {
        try {
          const segs = new URL(url).pathname.split("/").filter(Boolean);
          label = (segs.pop() || "").replace(/\.html?$/i, "").replace(/[-_]+/g, " ").trim();
        } catch (e) { label = ""; }
      }
      out.push({ brand, label, url });
    }
    return out;
  }
  // an ExcelJS cell can be a string, a hyperlink object, or a rich-text run
  function cellText(c) {
    if (c == null) return "";
    if (typeof c === "string" || typeof c === "number") return String(c);
    if (c.hyperlink) return String(c.hyperlink);
    if (c.text) return String(c.text);
    if (c.result != null) return String(c.result);
    if (Array.isArray(c.richText)) return c.richText.map(t => t.text).join("");
    return String(c);
  }
  function firstUrl(v) {
    const m = String(cellText(v) || "").match(/https?:\/\/\S+/);
    return m ? m[0].replace(/[),.]+$/, "") : "";
  }

  // CSV / TSV -> grid. Handles quoted fields containing commas.
  function parseCsv(text) {
    const src = String(text || "");
    const delim = (src.split("\n")[0] || "").includes("\t") ? "\t" : ",";
    const rows = [];
    let row = [], field = "", q = false;
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (q) {
        if (ch === '"') { if (src[i + 1] === '"') { field += '"'; i++; } else q = false; }
        else field += ch;
      } else if (ch === '"') q = true;
      else if (ch === delim) { row.push(field); field = ""; }
      else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (ch !== "\r") field += ch;
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  // Merge new entries into a list, skipping URLs it already has.
  function mergeEntries(existing, incoming) {
    const seen = new Set((existing || []).map(e => normUrl(e.url)));
    const add = [];
    (incoming || []).forEach(e => {
      const k = normUrl(e.url);
      if (!k || seen.has(k)) return;
      seen.add(k); add.push(e);
    });
    return { list: (existing || []).concat(add), added: add.length, skipped: (incoming || []).length - add.length };
  }
  function normUrl(u) {
    try { const x = new URL(u); return (x.origin + x.pathname).replace(/\/$/, "").toLowerCase(); }
    catch (e) { return String(u || "").trim().toLowerCase(); }
  }

  // ---- storage -------------------------------------------------------------
  const load = () => new Promise(r => {
    try { chrome.storage.local.get(KEY, o => r((o && o[KEY]) || [])); } catch (e) { r([]); }
  });
  const save = lists => new Promise(r => {
    try { chrome.storage.local.set({ [KEY]: lists }, () => r()); } catch (e) { r(); }
  });

  const API = { parseList, parseGrid, parseCsv, mergeEntries, normUrl, load, save, KEY };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  root.ScanLists = API;
})(typeof self !== "undefined" ? self : this);
