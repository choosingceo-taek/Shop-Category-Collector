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

  const API = { parseList, mergeEntries, normUrl, load, save, KEY };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  root.ScanLists = API;
})(typeof self !== "undefined" ? self : this);
