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
  /* Header matching is by CONTAINS, in priority order, and each column is
     claimed once. The team's brand sheet is why: its columns are
       Brand Level | Primary Category | Secondary Category | Brand | Main Page Link
     — "Main Page Link" never equalled "url", and "Brand Level" would have been
     read as the brand column before "Brand" got a chance. Tier is tried first
     precisely because its header usually contains the word Brand too. */
  const HDR = [
    ["tier",  /(tier|level|등급|티어|그룹)/i],
    ["url",   /(url|link|주소|링크|사이트|address)/i],
    ["brand", /(brand|브랜드|shop|store|매장|label)/i],
    ["label", /(category|카테고리|name|이름|분류|메모|note|type)/i],
  ];

  function parseGrid(grid) {
    const rows = (grid || []).map(r => (r || []).map(c => cellText(c)));
    if (!rows.length) return [];

    // find a header row in the first few lines
    let hdrIdx = -1, cols = null;
    for (let i = 0; i < Math.min(6, rows.length); i++) {
      const r = rows[i];
      const found = { tier: -1, url: -1, brand: -1, label: -1 };
      r.forEach((c, j) => {
        const v = String(c || "").trim();
        if (!v) return;
        // first unclaimed key whose pattern this header matches wins the column
        const hit = HDR.find(([k, re]) => found[k] < 0 && re.test(v));
        if (hit) found[hit[0]] = j;
      });
      if (found.url >= 0) { hdrIdx = i; cols = found; break; }
    }

    const out = [];
    const start = hdrIdx >= 0 ? hdrIdx + 1 : 0;
    let lastBrand = "";
    for (let i = start; i < rows.length; i++) {
      const r = rows[i];
      let url = "", brand = "", label = "", tier = "";
      if (cols) {
        url = firstUrl(r[cols.url]);
        brand = cols.brand >= 0 ? String(r[cols.brand] || "").trim() : "";
        label = cols.label >= 0 ? String(r[cols.label] || "").trim() : "";
        tier = cols.tier >= 0 ? tierOf(r[cols.tier]) : "";
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
      out.push(tier ? { brand, label, url, tier } : { brand, label, url });
    }
    return out;
  }

  /* "Tier 1 : Hero Reference Brands" -> "Tier 1".
     The sheet writes a tier and a nickname in one cell; only the tier is a
     stable key to group by, and the prose after the colon changes wording
     between revisions. Anything without a recognisable tier number is kept
     verbatim so an unexpected scheme still groups, just under its own name. */
  function tierOf(v) {
    const t = String(cellText(v) || "").trim();
    if (!t) return "";
    const m = t.match(/tier\s*([0-9]+)|(?:^|[^0-9])([0-9]+)\s*(?:차|등급)/i);
    if (m) return "Tier " + (m[1] || m[2]);
    return t.split(/[:：]/)[0].trim().slice(0, 24);
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

  /* ---- export: hand the list back in the shape it came from ---------------

     The point is a round trip. The designer takes the list out as a file, adds
     a brand's category in Excel or Notepad, brings it back, and the collector
     updates. So what comes out must be exactly what parseList / parseGrid read
     back in — the pairs below are covered by a round-trip test, because a
     format that only ALMOST parses is worse than none. */

  // parseList's own shape: a brand heading, then "- Category : URL" under it.
  function toText(entries) {
    const byBrand = new Map();
    (entries || []).forEach(e => {
      if (!e || !e.url) return;
      const b = String(e.brand || "").trim();
      if (!byBrand.has(b)) byBrand.set(b, []);
      byBrand.get(b).push(e);
    });
    const out = [];
    byBrand.forEach((rows, brand) => {
      if (out.length) out.push("");
      if (brand) out.push(brand);
      rows.forEach(e => {
        const label = String(e.label || "").trim();
        out.push(label ? `- ${label} : ${e.url}` : `- ${e.url}`);
      });
    });
    return out.join("\n") + "\n";
  }

  // parseGrid's header shape. Header words are the ones HDR already matches, so
  // a file exported here re-imports without the user renaming anything.
  const GRID_HEADER = ["Brand", "Category", "URL"];
  function toGrid(entries) {
    const rows = (entries || []).filter(e => e && e.url);
    // the Tier column only appears when something actually carries a tier, so a
    // plain list round-trips as three columns exactly as before
    const withTier = rows.some(e => e.tier);
    const head = withTier ? ["Tier"].concat(GRID_HEADER) : GRID_HEADER.slice();
    return [head].concat(rows.map(e => {
      const base = [String(e.brand || ""), String(e.label || ""), String(e.url)];
      return withTier ? [String(e.tier || "")].concat(base) : base;
    }));
  }

  /* Merge an imported list back in.

     Adding a category is the common case, but the file is also where someone
     fixes a brand name or renames a category — so a URL already in the list has
     its brand/label UPDATED rather than being skipped outright. The URL is the
     identity; everything else is editable text. Entries the file doesn't
     mention are left alone, so importing one brand's sheet never wipes the
     rest of the list. */
  function mergeEntries(existing, incoming) {
    const list = (existing || []).slice();
    const index = new Map();
    list.forEach((e, i) => { const k = normUrl(e.url); if (k) index.set(k, i); });
    let added = 0, updated = 0, skipped = 0;
    (incoming || []).forEach(e => {
      const k = normUrl(e && e.url);
      if (!k) { skipped++; return; }
      if (!index.has(k)) {
        index.set(k, list.length); list.push(e); added++; return;
      }
      const cur = list[index.get(k)];
      const nb = String(e.brand || "").trim(), nl = String(e.label || "").trim();
      const nt = String(e.tier || "").trim();
      const changed = (nb && nb !== cur.brand) || (nl && nl !== cur.label) || (nt && nt !== cur.tier);
      if (changed) {
        if (nb) cur.brand = nb;
        if (nl) cur.label = nl;
        if (nt) cur.tier = nt;
        updated++;
      } else skipped++;
    });
    return { list, added, updated, skipped };
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

  /* brand -> tier, from whatever the lists carry. Applied at DISPLAY time by
     brand name, so importing the tier sheet once labels products that were
     scanned long before — no re-scan, no migration. */
  function tierMap(lists) {
    const m = {};
    [].concat(lists || []).forEach(l => (l.entries || []).forEach(e => {
      const b = String((e && e.brand) || "").trim().toLowerCase();
      if (b && e.tier) m[b] = e.tier;
    }));
    return m;
  }

  /* ---- naming a grabbed page ---------------------------------------------

     Both places that file a page — the on-page grab button and the panel —
     must name it identically, or the same shop lands in two Excel groups.
     The rules live here so there is one of them. */

  // "shop.lululemon.com" -> "Lululemon". The brand is the grouping key in
  // Excel and the LAB, so a raw hostname must never reach a cell.
  const SUFFIX = new Set(["com", "net", "org", "co", "uk", "us", "au", "kr", "jp", "cn",
    "de", "fr", "es", "it", "nl", "se", "dk", "no", "fi", "pl", "ca", "nz", "in", "io", "eu"]);
  /* Labels that say WHERE you are, not WHAT is sold. A shop puts these in
     front of its own domain — shop.lululemon.com, us.boohoo.com,
     row.gymshark.com ("rest of world") — and none of them is a brand.

     The set is closed on purpose, and everything else in that position is
     taken to be a name. That is the case this exists for: a house brand
     lives on its parent company's domain (athleta.gap.com,
     bananarepublic.gap.com, oldnavy.gap.com), and reading the registrable
     domain filed all of them as GAP — four different shops merged into one
     row in the Excel and one bar in the LAB, which is the failure a wrong
     brand always causes here. A label of two characters or fewer is a
     country or a language, never a brand. */
  const ROUTING = new Set(["www", "www2", "www3", "shop", "shops", "shopping",
    "store", "stores", "mobile", "secure", "checkout", "cart", "account",
    "accounts", "my", "web", "online", "int", "intl", "international",
    "global", "row", "apac", "emea", "latam", "americas", "asia", "europe",
    "outlet", "sale", "static", "assets", "images", "img", "cdn", "media",
    "content", "api", "home", "main"]);
  function brandFromHost(host) {
    const parts = String(host || "").toLowerCase().replace(/^www\./, "").split(".");
    while (parts.length > 1 && SUFFIX.has(parts[parts.length - 1])) parts.pop();
    let i = 0;
    while (i < parts.length - 1 &&
      (parts[i].length <= 2 || /^\d+$/.test(parts[i]) || ROUTING.has(parts[i]))) i++;
    const name = parts[i] || parts[parts.length - 1] || String(host || "");
    return name.split(/[-_]/).filter(Boolean)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ") || String(host || "");
  }

  /* A category label fit for a list row: the page title minus the boilerplate
     tail every shop appends ("Women's T-shirts | ZARA United States" ->
     "Women's T-shirts"). Only segments that repeat the brand/domain or are
     pure storefront wording are dropped, so a real category that happens to
     contain a dash survives untouched. */
  /* A word a shop generated, not a word a person wrote.

     Shops hang an opaque id on the end of a category address — lululemon's
     /c/women-whats-new/n14f1wz6o10, nike's /w/new-womens-tops-t-shirts-
     3n82yz5e1x6z9om13 — and it arrives in the row as part of the name. It is
     not a category, it is a database key, and the Excel and the LAB group by
     that column.

     The test is deliberately narrow, because throwing away a real name is
     worse than keeping a code: at least six characters, at least two digits
     AND at least two letters. That is every id these shops mint and no word a
     designer types — "1990s" has one letter, "y2k" and "90s" are too short,
     "501" and "3/4" have no letters at all, and they all survive. */
  function isCodeWord(w) {
    const s = String(w || "");
    if (s.length < 6) return false;
    return (s.match(/\d/g) || []).length >= 2 && (s.match(/[a-z]/gi) || []).length >= 2;
  }
  const stripCodes = text => String(text || "")
    .split(/\s+/).filter(w => w && !isCodeWord(w)).join(" ").trim();

  function cleanLabel(raw, brand, host) {
    const norm = x => String(x || "").toLowerCase().replace(/[^a-z0-9가-힣]+/g, "");
    const bn = norm(brand);
    const stem = norm(String(host || "").replace(/^www\./, "").split(".")[0]);
    const segs = String(raw || "").replace(/\s+/g, " ").trim()
      .split(/\s*[|·]\s*|\s+[-—–]\s+/).filter(Boolean);
    while (segs.length > 1) {
      const last = segs[segs.length - 1], ln = norm(last);
      const boiler = /^(official (web ?)?(site|store)|online (shop|store)|shop online|united states|korea|대한민국)$/i.test(last.trim());
      if (boiler || (bn && ln.includes(bn)) || (stem && ln.includes(stem))) segs.pop();
      else break;
    }
    // and never a shop's own id, wherever in the name it turned up
    return stripCodes(segs.join(" · ")).slice(0, 60);
  }

  /* A category name taken from the address, for rows that never got one.

     Imports and older adds sometimes stored the URL itself as the label, and a
     row reading "cottonon.com/AU/co/women/wom…" tells the designer nothing
     about what she is watching. The shop's own slug does: it is the name the
     shop gave that page, not a guess. */
  function labelFromUrl(url) {
    let segs = [];
    try {
      const u = new URL(String(url || "").replace(/^(?!https?:)/i, "https://"));
      segs = u.pathname.split("/").filter(Boolean);
    } catch (e) { return ""; }
    const skip = /^(c|co|shop|browse|collections?|categor(y|ies)|women|womens|en|us|uk|au|kr|intl|[a-z]{2}([-_][a-z]{2})?)$/i;
    // last segment that is not a locale, a routing word or a bare id
    for (let i = segs.length - 1; i >= 0; i--) {
      const s = decodeURIComponent(segs[i]).replace(/\.(html?|aspx?|do)$/i, "");
      if (!s || skip.test(s) || /^\d+$/.test(s)) continue;
      // An opaque id is not a name: shops end their category URLs with codes
      // like /n1jux6 or /cat90030. No separator plus a digit means a code, so
      // keep walking up the path to the segment a human wrote.
      if (!/[-_+]/.test(s) && /\d/.test(s)) continue;
      /* The id is not always a segment of its own: nike writes the whole
         category and the key as one slug, /w/new-womens-tops-t-shirts-
         3n82yz5e1x6z9om13, so a name has to be cleaned as well as chosen. */
      const words = stripCodes(s.replace(/[-_+]+/g, " ").replace(/\b[a-z]?\d{3,}\b/gi, "")).trim();
      if (words.length < 2) continue;
      return words.replace(/\s+/g, " ").replace(/\b\w/g, c => c.toUpperCase()).slice(0, 60);
    }
    return "";
  }
  // Does this label read as an address rather than a category?
  const looksLikeUrl = s => /^(https?:\/\/|www\.)/i.test(String(s || "").trim()) ||
    /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/|$)/i.test(String(s || "").trim());

  // A platform name is not a brand. "Shopify store" as a brand splits one shop
  // across Excel groups, so the engine's label is used only when it names a
  // real shop; otherwise the domain does.
  const PLATFORM_LABEL = /^(shopify store|generic site.*)$/i;
  function brandFor(ctx, adapterLabel, host) {
    if (ctx && ctx.brand) return String(ctx.brand);
    const label = String((ctx && ctx.site) || adapterLabel || "");
    const isPlatform = (ctx && ctx.platform) || PLATFORM_LABEL.test(label);
    if (label && !isPlatform) return label;
    return brandFromHost(host);
  }

  /* ---- when a list scans itself ------------------------------------------

     A list is one research question, and the answer is only comparable if it
     is asked on a rhythm — the LAB compares week to week, so a week that
     nobody remembered to scan is a hole in the trend, not a quiet week. So a
     list can carry its own time:

       schedule = { on: true, time: "09:00", days: [1,2,3,4,5] }

     days are 0=Sunday…6=Saturday; an empty list means every day. The clock is
     the user's own local time — a designer says "every weekday at nine" about
     the morning they are actually in.

     Kept pure and here (not in the worker) so both the panel and the alarm
     agree on what "next" means, and so it can be tested without a browser. */
  const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

  function nextRun(schedule, from) {
    const s = schedule || {};
    if (!s.on) return 0;
    const m = HHMM.exec(String(s.time || ""));
    if (!m) return 0;
    const hh = +m[1], mm = +m[2];
    const days = [].concat(s.days || []).filter(d => d >= 0 && d <= 6);
    const base = from instanceof Date ? new Date(from.getTime()) : new Date(from || Date.now());
    for (let i = 0; i < 8; i++) {
      const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i, hh, mm, 0, 0);
      if (d.getTime() <= base.getTime()) continue;          // today's time already passed
      if (days.length && !days.includes(d.getDay())) continue;
      return d.getTime();
    }
    return 0;
  }

  // "Weekdays at 09:00" — what the panel shows so the setting is readable
  // without opening it.
  const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  function scheduleLabel(schedule) {
    const s = schedule || {};
    if (!s.on || !HHMM.test(String(s.time || ""))) return "";
    const days = [].concat(s.days || []).filter(d => d >= 0 && d <= 6).sort();
    const when = !days.length || days.length === 7 ? "Every day"
      : days.join() === "1,2,3,4,5" ? "Weekdays"
      : days.join() === "0,6" ? "Weekends"
      : days.map(d => DAY_NAMES[d]).join(" ");
    return `${when} at ${s.time}`;
  }

  const API = { parseList, parseGrid, parseCsv, mergeEntries, normUrl,
    toText, toGrid, GRID_HEADER, tierOf, tierMap, load, save, KEY,
    brandFromHost, cleanLabel, brandFor, PLATFORM_LABEL, labelFromUrl, looksLikeUrl,
    isCodeWord, stripCodes,
    nextRun, scheduleLabel, DAY_NAMES };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  root.ScanLists = API;
})(typeof self !== "undefined" ? self : this);
