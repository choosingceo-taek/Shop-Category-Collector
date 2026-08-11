/* Generic collection engine — site-agnostic.
   It picks the active adapter (SITES.active) for the current URL and drives it:

     phase 'list'  -> adapter.scrapeList each page, auto-advance adapter.nextPageUrl
     phase 'spec'  -> adapter.fetchComposition for each product (optional)
     phase 'build' -> adapter.buildWorkbook(...) -> download .xlsx

   All Walmart-specific knowledge lives in sites.js. To support another store,
   add an adapter there — this file does not change.

   Robustness built in here:
     - global dedupe of products by id/url across pages
     - pagination stops when: no next URL, OR a page adds 0 new items, OR the
       safety cap (MAX_PAGES) is hit — so a changed page layout can't loop forever
     - crash-safe resume across the full-page navigations pagination causes
*/

const JOB = "wpb_job";
const QUEUE = "wpb_queue";          // batch run over a saved list of category URLs
/* Products taken from one URL. Infinite-scroll grids (Zara, COS, Massimo Dutti)
   put a whole category on a single page, so "current page only" alone still
   unrolls into hundreds of rows — enough to bury the curated list and to make
   the detail phase crawl. 60 is roughly what a shop shows before the first
   "load more", which is the slice a designer actually looks at. */
const DEFAULT_MAX_ITEMS = 60;
const MAX_PAGES = 200;              // hard safety cap
const EMPTY_PAGE_LIMIT = 2;         // stop after this many consecutive no-new-item pages

const sleep = ms => new Promise(r => setTimeout(r, ms));

// True only while THIS content script's extension context is still valid.
// After the extension is reloaded/updated, an old content script left running
// on the page has an invalidated context; chrome.* calls then throw
// "Extension context invalidated". We detect that and stop quietly instead of
// spamming uncaught errors — the user just needs to reload the page.
function alive() { try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; } }

const g = () => new Promise(r => {
  if (!alive()) return r(null);
  try { chrome.storage.local.get(JOB, o => r(chrome.runtime.lastError ? null : (o[JOB] || null))); }
  catch (e) { r(null); }
});
const s = j => new Promise(r => {
  if (!alive()) return r();
  try { chrome.storage.local.set({ [JOB]: j }, () => r()); } catch (e) { r(); }
});
const clear = () => new Promise(r => {
  if (!alive()) return r();
  try { chrome.storage.local.remove(JOB, () => r()); } catch (e) { r(); }
});

function adapter() { return (self.SITES && SITES.active(location.href, document)) || null; }
function itemKey(r) { return (r.id || r.product_url || r.name || "").toLowerCase(); }

// This tab's id (from the service worker). A job is bound to the tab that
// started it so other tabs never touch it. undefined = not asked yet, null =
// couldn't determine (treated as "no binding", legacy behaviour).
let _tabId;
function myTabId() {
  return new Promise(res => {
    if (_tabId !== undefined) return res(_tabId);
    if (!alive()) return res(null);
    try {
      chrome.runtime.sendMessage({ type: "whoami" }, resp => {
        _tabId = (!chrome.runtime.lastError && resp && resp.tabId != null) ? resp.tabId : null;
        res(_tabId);
      });
    } catch (e) { _tabId = null; res(null); }
  });
}

// Identity of a collection = its search context, ignoring the page number and
// noisy tracking params. A job only auto-resumes on pages with the SAME
// signature, so an abandoned job from a different category can never resurface
// its old items on a new page.
function collectionSig(url) {
  try {
    const u = new URL(url);
    const p = u.searchParams;
    /* Every query parameter is part of the collection's identity unless it is
       a page cursor or a tracking tag. Naming the meaningful ones one site at
       a time does not scale and gets it wrong quietly: Abercrombie splits
       Tees, Tanks and Dresses with categoryId + facet on ONE path, so a
       short list of known keys made three categories look like one and the
       second and third were skipped as "already scanning that". Dropping the
       cursor keys is what keeps a paginated page recognisable as the same
       collection. */
    const SKIP = /^(page|pageid|pagenum|pageno|nao|start|offset|begin|mlink|utm_[a-z]+|gclid|fbclid|msclkid|srsltid|icid)$/i;
    const parts = [];
    p.forEach((v, k) => { if (!SKIP.test(k)) parts.push(k.toLowerCase() + "=" + String(v).trim().toLowerCase()); });
    parts.sort();
    const query = parts.join("&");
    // Gap-family SPAs put the real category filters in the FRAGMENT
    // (#pageId=0&style=…&neckline=…) — hoodies and zip-ups share the exact
    // same path and query. Fold key=value fragments into the signature (minus
    // the page number and tracking) so they count as different collections;
    // a plain #anchor has no "=" and changes nothing.
    const h = (u.hash || "").replace(/^#/, "");
    let frag = "";
    if (h.includes("=")) {
      const fp = new URLSearchParams(h);
      [...fp.keys()].forEach(k => { if (SKIP.test(k)) fp.delete(k); });
      fp.sort();
      frag = fp.toString().toLowerCase();
    }
    return u.pathname + "|" + query + "|" + frag;
  } catch (e) { return url; }
}

// Ask the service worker to fetch image bytes (it has cross-origin host access;
// a content-script fetch would be blocked by CORS). Resolves null on any failure
// so a missing image never breaks the export.
function fetchImageViaBg(url) {
  return new Promise(res => {
    if (!url || !alive()) return res(null);
    try {
      chrome.runtime.sendMessage({ type: "fetchImage", url }, resp => {
        if (chrome.runtime.lastError) return res(null);
        res(resp && resp.ok ? resp : null);
      });
    } catch (e) { res(null); }
  });
}

/* Write a progress line for the panel and the FAB to read.

   Only ever writes over a job that is still running. report() is a
   read-modify-write of the whole job record, so a late message — a background
   fetch that resolves after the run closed — used to write the OLD object back
   and set active:true again. The panel then showed "Saved to catalog…" with a
   live progress bar forever, on a scan that had already finished. */
async function report(msg) {
  const j = await g();
  if (!j || !j.active) return;
  // while running a saved list, prefix which URL of how many we're on
  const q = await getQueue();
  j.status = (q && q.active) ? `[${q.idx + 1}/${q.list.length}] ${msg}` : msg;
  await s(j);
}

// ---- batch queue: run a saved list of category URLs end to end --------------
// The user keeps a list of "brand + category URL" they revisit every week. The
// queue walks it: each URL gets a normal full scan (the job engine below is
// unchanged), and when that finishes we move to the next. It lives in storage
// like the job, so the navigations between URLs can't lose it.
const getQueue = () => new Promise(r => {
  if (!alive()) return r(null);
  try { chrome.storage.local.get(QUEUE, o => r(chrome.runtime.lastError ? null : (o[QUEUE] || null))); }
  catch (e) { r(null); }
});
const setQueue = q => new Promise(r => {
  if (!alive()) return r();
  try { chrome.storage.local.set({ [QUEUE]: q }, () => r()); } catch (e) { r(); }
});

// Same collection? Compare without the page param so a scan that paginated away
// still counts as "on the queue's current URL".
function sameCollection(a, b) {
  try { return collectionSig(a) === collectionSig(b); } catch (e) { return a === b; }
}

/* Push a finished scan's rows into the catalog (IndexedDB, service-worker side)
   and return the same rows as a plain scan record.

   Every scan does this, whether it downloads its own spreadsheet or is one leg
   of a list run — the catalog is what makes the data reusable later without
   re-visiting the shop, and what LAB reads. Passing the queue stamps the rows
   with the list that produced them, so "export this list" can mean exactly the
   products that list collected. */
async function catalogSave(j, a, kept, total, queue) {
  const keptItems = [].concat.apply([], Object.values(kept || {}));
  const fromList = queue || await getQueue();
  const inList = fromList && fromList.active;
  const scan = {
    meta: {
      schema: "shop-scan/1",
      source: a.id, site: a.label,
      brand: (j.items[0] && j.items[0].brand) || "",
      category: (j.items[0] && j.items[0].category) || "",
      url: j.startUrl || location.href,
      scannedAt: new Date().toISOString(),
      count: total,
      listId: inList ? fromList.listId : "",
      listName: inList ? fromList.name : "",
    },
    items: keptItems.map(it => ({
      brand: it.brand || "", name: it.name || "", category: it.category || "",
      price: it.price || "", price_was: it.price_was || "",
      colorways: it.colorways || "", color_count: it.color_count || "",
      size_range: it.size_range || "", fabric_composition: it.fabric_composition || "",
      design: it.design || "", product_url: it.product_url || "", image_url: it.image_url || "",
      // when the shop itself published the product, where the shop tells us
      launched_at: it.launched_at || "",
    })),
  };
  /* Awaited, not fire-and-forget: the reply used to land after the run had
     closed and its report() call brought the finished job back to life. */
  const saved = await new Promise(res => {
    try {
      chrome.runtime.sendMessage({ type: "catalogPut", scan }, r => {
        void chrome.runtime.lastError; res(r && r.ok ? r : null);
      });
    } catch (e) { res(null); }
  });
  if (saved && !inList) await report(`Saved to catalog — ${saved.added} new, ${saved.updated} updated`);
  return scan;
}

/* ---- automatic site diagnosis -------------------------------------------

   Opening a shop up used to be a console job: run devcheck(), then paste
   diagnose-generic.js into the failing page and copy the output. Both steps
   are now automatic. Every scan already exercises the real engine, so the
   scan ITSELF records a per-site verdict (found / gaps / broken), and when a
   site comes up broken it photographs the page structure right there — the
   same facts the diagnose script gathered by hand. A Scan all that hits
   failures downloads one `sitecheck_….txt` next to the Excel; sending that
   file is the entire manual step that remains.

   Read-only by design: the diagnosis never changes what a scan collects,
   never blocks the run (every piece is wrapped), and adds nothing when all
   sites pass — designers only ever see the file when something needs fixing. */

const HEALTH = "wpb_sitehealth";     // { [collectionSig]: record }, latest per collection
const HEALTH_MAX = 300;              // oldest records fall off

const kvGet = key => new Promise(r => {
  if (!alive()) return r(null);
  try { chrome.storage.local.get(key, o => r(chrome.runtime.lastError ? null : (o[key] || null))); }
  catch (e) { r(null); }
});
const kvSet = (key, v) => new Promise(r => {
  if (!alive()) return r();
  try { chrome.storage.local.set({ [key]: v }, () => r()); } catch (e) { r(); }
});

// What the developer needs to know about a page the engine could not read:
// platform, structured data, where the repetition is, and one real tile.
// Everything is truncated — this is a photograph, not a mirror.
function selfDiagnose() {
  const out = { url: String(location.href).slice(0, 200), title: String(document.title || "").slice(0, 80) };
  const clip = (s, n) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);
  try {
    const html = document.documentElement.innerHTML;
    out.platform = [
      (/cdn\.shopify\.com|\/cdn\/shop\//.test(html)) && "Shopify",
      (/demandware\.static|dwstatic/i.test(html)) && "SFCC",
      (/Magento|\/mage\//i.test(html)) && "Magento",
      (/__NEXT_DATA__/.test(html)) && "Next.js",
      (/__NUXT__/.test(html)) && "Nuxt",
    ].filter(Boolean);
  } catch (e) {}
  try {
    // JSON-LD: which node types exist, and does an ItemList carry the products?
    const types = {}; let listLen = 0, sample = null;
    document.querySelectorAll('script[type="application/ld+json"]').forEach(sc => {
      let d; try { d = JSON.parse(sc.textContent); } catch (e) { return; }
      ([].concat(Array.isArray(d) ? d : (d["@graph"] || [d]))).forEach(n => {
        if (!n || typeof n !== "object") return;
        const t = [].concat(n["@type"] || []).join(",") || "?";
        types[t] = (types[t] || 0) + 1;
        if (/ItemList/i.test(t) && Array.isArray(n.itemListElement)) {
          listLen += n.itemListElement.length;
          if (!sample) {
            const it = (n.itemListElement[0] && (n.itemListElement[0].item || n.itemListElement[0])) || {};
            sample = { name: clip(it.name, 60), url: clip(it.url || it["@id"], 90) };
          }
        }
      });
    });
    out.ld = { types, itemList: listLen, sample };
  } catch (e) {}
  try {
    // Where do the links point? Digits collapse so /p/12345 and /p/67890 count
    // as one shape — the top shapes are the product-URL pattern candidates.
    const shapes = {};
    document.querySelectorAll("a[href]").forEach(aEl => {
      let p; try { p = new URL(aEl.href, location.href).pathname; } catch (e) { return; }
      const shape = p.replace(/\d+/g, "N").split("/").slice(0, 4).join("/");
      if (shape.length > 1) shapes[shape] = (shapes[shape] || 0) + 1;
    });
    out.linkShapes = Object.entries(shapes).sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([k, n]) => `${k} ×${n}`);
  } catch (e) {}
  try {
    // Repeated-structure candidates: a parent with several same-tag children
    // that each hold a link and an image is almost certainly the grid.
    const grids = [];
    document.querySelectorAll("body *").forEach(el => {
      const kids = el.children;
      if (!kids || kids.length < 4 || grids.length >= 3) return;
      const tag = kids[0].tagName;
      let alike = 0, tiles = 0;
      for (const k of kids) {
        if (k.tagName !== tag) continue;
        alike++;
        if (k.querySelector("a[href]") && k.querySelector("img, [style*=background-image]")) tiles++;
      }
      if (alike >= 4 && tiles >= 3) {
        grids.push({
          parent: el.tagName.toLowerCase() + clip(el.className && ("." + String(el.className).split(/\s+/).slice(0, 2).join(".")), 60),
          children: alike, tilesWithLinkAndImg: tiles,
        });
        if (!out.tile) {
          // one real tile, attribute values shortened so a base64 src can't bloat it
          out.tile = clip(kids[0].outerHTML.replace(/="([^"]{80})[^"]*"/g, '="$1…"'), 1400);
        }
      }
    });
    out.grids = grids;
  } catch (e) {}
  try {
    // which image attributes this theme uses (the lazy-loading fingerprint)
    const attrs = {};
    document.querySelectorAll("img").forEach(img => {
      for (const at of img.attributes) {
        if (/^(src|srcset|data-[\w-]*(src|image|lazy|bg)[\w-]*)$/i.test(at.name) && at.value)
          attrs[at.name] = (attrs[at.name] || 0) + 1;
      }
    });
    out.imgAttrs = attrs;
  } catch (e) {}
  try {
    const PRICE_RE = /(?:[$₩€£¥]\s?\d[\d,]*(?:\.\d{1,2})?|\d[\d,]*(?:\.\d{1,2})?\s?(?:원|USD|EUR|GBP))/;
    let leaves = 0, sample = "";
    document.querySelectorAll("span,div,p,b,strong,em,ins,del").forEach(el => {
      if (el.children.length > 1 || leaves >= 500) return;
      const t = clip(el.textContent, 40);
      if (t && t.length <= 40 && PRICE_RE.test(t)) { leaves++; if (!sample) sample = t; }
    });
    out.priceLeaves = { count: leaves, sample };
  } catch (e) {}
  // hard cap: a record is a note, not a page dump
  try { if (JSON.stringify(out).length > 4000 && out.tile) out.tile = out.tile.slice(0, 400) + "…"; } catch (e) {}
  return out;
}

function healthMark(rec) {
  if (!rec.count) return "❌";
  if (rec.named < rec.count || rec.imaged < rec.count || rec.priced < rec.count) return "⚠️";
  // Fabric is judged only as ALL-or-nothing, and only when details were
  // collected: single products legitimately state no blend, but a whole site
  // at zero means the extraction is broken — the user's core column.
  if (rec.withSpec && rec.count && rec.fabric === 0) return "⚠️";
  return "✅";
}
function healthNote(rec) {
  if (!rec.count) return "0 products";
  const miss = [];
  if (rec.named < rec.count) miss.push(`name×${rec.count - rec.named}`);
  if (rec.imaged < rec.count) miss.push(`image×${rec.count - rec.imaged}`);
  if (rec.priced < rec.count) miss.push(`price×${rec.count - rec.priced}`);
  if (rec.withSpec && rec.count && rec.fabric === 0) miss.push("fabric×all");
  return miss.length ? `${rec.count} found · missing ${miss.join(" ")}` : `${rec.count} found · complete`;
}

/* When a whole site's fabric column came back empty, photograph ONE product
   page the same way diagnose-pdp.js did by hand: does the served PDP contain
   %-fibre wording at all, what does its JSON-LD carry, and (Shopify) does the
   .js endpoint's description mention it. That answer decides the fix — parse
   better vs. the data genuinely not being served — without anyone opening a
   console. Fetch-based and bounded; failure returns nothing. */
async function diagnoseDetail(item) {
  const out = { url: String(item.product_url || "").slice(0, 160) };
  const clip = (s, n) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);
  const grab = async (u, asText) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    try {
      const res = await fetch(u, { credentials: "include", signal: ctrl.signal });
      return { status: res.status, body: res.ok ? await res.text() : "" };
    } catch (e) { return { status: 0, body: "" }; } finally { clearTimeout(timer); }
  };
  try {
    const pdp = await grab(item.product_url);
    out.pdpStatus = pdp.status;
    if (pdp.body) {
      const doc = new DOMParser().parseFromString(pdp.body, "text/html");
      const types = {};
      let material = "";
      doc.querySelectorAll('script[type="application/ld+json"]').forEach(sc => {
        let d; try { d = JSON.parse(sc.textContent); } catch (e) { return; }
        [].concat(Array.isArray(d) ? d : (d["@graph"] || [d])).forEach(n => {
          if (!n || typeof n !== "object") return;
          types[[].concat(n["@type"] || []).join(",") || "?"] = 1;
          if (!material && n.material) material = clip(n.material, 80);
        });
      });
      out.ld = { types: Object.keys(types), material };
      // every place the served page says "<number>%" near words — the raw
      // sightings the composition parser would have to read
      const text = (doc.body && doc.body.textContent || "").replace(/\s+/g, " ");
      out.pctRuns = (text.match(/[^%\d]{0,30}\d{1,3}\s?%[^\d]{0,40}/g) || [])
        .map(s => clip(s, 70)).filter(s => /[A-Za-z가-힣]/.test(s)).slice(0, 4);
    }
    if (/\/products\//i.test(item.product_url)) {          // Shopify-shaped
      try {
        const u = new URL(item.product_url); u.search = ""; u.hash = "";
        const js = await grab(u.origin + u.pathname.replace(/\/$/, "") + ".js");
        out.js = { status: js.status };
        if (js.body) {
          try {
            const p = JSON.parse(js.body);
            const desc = String(p.description || "");
            out.js.descLen = desc.length;
            out.js.descPct = (desc.match(/\d{1,3}\s?%/g) || []).length;
          } catch (e) {}
        }
      } catch (e) {}
    }
  } catch (e) {}
  return out;
}

// Called by the build phase, when this URL's items are final. Never throws
// into the scan; a failed diagnosis loses a diagnosis, not a spreadsheet.
async function recordHealth(j, a, ent) {
  try {
    const filled = f => j.items.filter(it => String(it[f] || "").trim()).length;
    const rec = {
      url: j.startUrl || location.href, sig: j.sig || collectionSig(location.href),
      adapter: a.id, brand: (ent && ent.brand) || "", label: (ent && ent.label) || "",
      count: j.items.length, named: filled("name"), imaged: filled("image_url"), priced: filled("price"),
      fabric: filled("fabric_composition"), withSpec: !!j.withSpec,
      ts: Date.now(),
    };
    rec.mark = healthMark(rec);
    // Photograph the page only when something is wrong AND we are still looking
    // at the scanned collection (single-page scans stay on it; a paginated run
    // may have walked off it, and diagnosing the wrong page would mislead).
    if (rec.mark !== "✅" && collectionSig(location.href) === rec.sig) rec.diag = selfDiagnose();
    // A site whose fabric came back empty for EVERY product gets one product
    // page photographed too — that is where the blend would live, and it is
    // the page the developer used to inspect by hand (Edikted, Alo).
    if (rec.withSpec && rec.count && rec.fabric === 0 && j.items[0] && j.items[0].product_url) {
      rec.diagDetail = await diagnoseDetail(j.items[0]);
    }
    const all = (await kvGet(HEALTH)) || {};
    all[rec.sig] = rec;
    const keys = Object.keys(all);
    if (keys.length > HEALTH_MAX) {
      keys.sort((x, y) => (all[x].ts || 0) - (all[y].ts || 0))
        .slice(0, keys.length - HEALTH_MAX).forEach(k => delete all[k]);
    }
    await kvSet(HEALTH, all);
  } catch (e) { /* diagnosis must never cost a scan */ }
}

/* One text file per list run, ONLY when something failed: the verdict for
   every URL plus the stored page photograph of each failure — the exact
   output the developer used to assemble by hand with devcheck + diagnose
   scripts. The designer's part is just "send this file". */
async function queueHealthExport(q) {
  try {
    const list = (q && q.list) || [];
    if (!list.length) return;
    const all = (await kvGet(HEALTH)) || {};
    const recs = list.map(ent => {
      const r = all[collectionSig(ent.url || "")];
      return r ? Object.assign({}, r, { brand: r.brand || ent.brand || "", label: r.label || ent.label || "" })
               : { url: ent.url, brand: ent.brand || "", label: ent.label || "", mark: "❌", note_override: "never scanned (no engine reached this page)" };
    });
    const bad = recs.filter(r => r.mark !== "✅");
    if (!bad.length) return;                        // all good — no extra file
    const n = m => recs.filter(r => r.mark === m).length;
    const lines = [];
    lines.push(`Market Lens site check — ${q.name || "list"} — ${new Date().toISOString().slice(0, 10)}`);
    lines.push(`${recs.length} sites: ✅ ${n("✅")} ready · ⚠️ ${n("⚠️")} gaps · ❌ ${n("❌")} broken`);
    lines.push("");
    lines.push("Some sites did not come out clean. Nothing is wrong with your Excel —");
    lines.push("rows that were collected are all there. To get the rest working,");
    lines.push("send this whole file to the developer. It contains no personal data,");
    lines.push("only what the failing pages are built from.");
    lines.push("");
    for (const r of bad) {
      lines.push(`${r.mark} ${r.brand || "?"} · ${r.label || ""}`.trimEnd());
      lines.push(`   ${r.note_override || healthNote(r)}${r.adapter ? ` | engine=${r.adapter}` : ""}`);
      lines.push(`   ${r.url}`);
      if (r.diag) lines.push("   diag: " + JSON.stringify(r.diag));
      if (r.diagDetail) lines.push("   pdp: " + JSON.stringify(r.diagDetail));
      lines.push("");
    }
    const tag = String(q.name || "list").replace(/[^\w가-힣]+/g, "_").slice(0, 30);
    const stamp = new Date().toISOString().slice(0, 10);
    const filename = `sitecheck_${tag}_${stamp}.txt`;
    const text = lines.join("\n");
    const b64 = btoa(unescape(encodeURIComponent(text)));
    const saved = await new Promise(res => {
      try {
        chrome.runtime.sendMessage({ type: "downloadFile", filename, b64, mime: "text/plain" },
          r => res(!chrome.runtime.lastError && !!(r && r.ok)));
      } catch (e) { res(false); }
    });
    if (!saved) {
      const blob = new Blob([text], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const el = document.createElement("a");
      el.href = url; el.download = filename;
      document.body.appendChild(el); el.click(); el.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
    await report(`${bad.length} site(s) need attention — details saved as ${filename}`);
  } catch (e) { /* the report is a bonus — never fail the run over it */ }
}

/* Save the whole list run as ONE workbook.

   A list is "26SS tops" — four brands' top categories that belong in one
   spreadsheet, not four downloads the user then has to merge by hand. So a
   queued scan writes its rows into the queue instead of downloading, and the
   file is built once here, at the end, with every brand in it (excel.js groups
   the rows by brand). Also runs when the user stops early, so stopping still
   yields the work already done. */
async function queueExport(q) {
  const rows = (q && q.rows) || [];
  if (!rows.length) return;
  const a = adapter();
  if (!a) return;
  const tag = String(q.name || "list").replace(/[^\w가-힣]+/g, "_").slice(0, 30);
  const stamp = new Date().toISOString().slice(0, 10);
  try {
    await report(`Building the list Excel… ${rows.length} rows`);
    const { bytes, kept } = await a.buildWorkbook(rows, {
      ExcelJS: self.ExcelJS,
      fetchImage: fetchImageViaBg,
      filters: q.filters || {},
      onProgress: (i, total) => report(`List Excel… images ${i}/${total}`),
    });
    const total = Object.values(kept).reduce((n, v) => n + (v.length || 0), 0);
    const filename = `${tag}_${total}items_${stamp}.xlsx`;
    let b64 = "";
    for (let i = 0; i < bytes.length; i += 0x8000)
      b64 += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    b64 = btoa(b64);
    const saved = await new Promise(res => {
      try {
        chrome.runtime.sendMessage({ type: "downloadXlsx", filename, b64 },
          r => res(!chrome.runtime.lastError && !!(r && r.ok)));
      } catch (e) { res(false); }
    });
    if (!saved) {
      const blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const url = URL.createObjectURL(blob);
      const el = document.createElement("a");
      el.href = url; el.download = filename;
      document.body.appendChild(el); el.click(); el.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
    const brands = [...new Set(rows.map(r => r.brand).filter(Boolean))];
    await report(`List done — ${total} products from ${brands.length} brands saved as one Excel file`);
  } catch (e) {
    await report("List Excel failed: " + (e && e.message || e) + " (use ⬇ Excel in the panel to retry)");
  }
}

// Called when a scan finishes. Advances the queue, or ends it.
async function queueAdvance() {
  const q = await getQueue();
  if (!q || !q.active) return false;
  const me = await myTabId();
  if (q.tabId != null && me != null && q.tabId !== me) return false;   // not this tab's queue
  // Closing the job before we navigate matters: the build phase works from
  // already-collected items, so a still-active job would resume on the NEXT
  // URL and re-export the previous category's rows there.
  const closeJob = async () => { const d = await g(); if (d) { d.active = false; await s(d); } };
  q.idx += 1;
  if (q.idx >= q.list.length) {
    q.active = false; q.finishedAt = Date.now();
    await setQueue(q);
    await queueExport(q);          // job is still active here, so progress shows
    await queueHealthExport(q);    // failures (if any) leave as one sitecheck txt
    await closeJob();
    return false;
  }
  await setQueue(q);
  await closeJob();
  const next = q.list[q.idx];
  setTimeout(() => { try {
    // A fragment-only step (Gap: next category differs only after the #) never
    // fires a page load on href assignment, so nothing would restart the scan
    // and the queue would stall here — force the reload.
    const here = location.href.split("#")[0];
    location.href = next.url;
    if (String(next.url).split("#")[0] === here) location.reload();
  } catch (e) {} }, 1500);
  return true;
}

// Top-level wrapper: no matter what throws, the job never silently freezes —
// the error is written to the status box and the tab can be re-run.
async function step() {
  const j = await g();
  if (!j || !j.active || j.paused) return;
  try {
    await runStep(j);
  } catch (e) {
    const cur = await g();
    if (cur) { cur.status = "Error: " + (e && e.message || e) + " (run again to retry)"; await s(cur); }
  }
}

async function runStep(j) {
  const a = adapter();
  if (!a) { await report("No adapter supports this page."); j.active = false; await s(j); return; }

  // Page-by-page scanning is done once we leave the list phase. Detail collection
  // fetches each product by URL and the build reads already-collected items, so
  // neither needs the visible page — bring the tab back to where the user started
  // (pagination left it on a "no more pages" 404) so they watch "Collecting
  // details…" on their own page. Done once (j.returned); the reload re-enters
  // this same phase and continues from the saved progress, so nothing is lost.
  // (skipped during a queued run — the queue navigates to the next URL when this
  // scan finishes, so bouncing back to this one's start would just waste a load)
  if (j.phase !== "list" && j.startUrl && !j.returned && !j.queued && j.startUrl !== location.href) {
    j.returned = true; await s(j);
    location.href = j.startUrl;
    return;
  }

  // -------- phase: list (scrape + auto-paginate) --------
  if (j.phase === "list") {
    // The page number comes from the URL, not a counter, so pausing/resuming or
    // reloading can never skip a page or scrape one twice.
    const page = (a.context && (a.context(document).page || 1)) || 1;
    if (page <= j.pagesDone) {
      // this page is already collected (resume/reload) -> jump to the next one
      const more = j.singlePage === false && (
                   (j.totalPages && j.pagesDone < j.totalPages) ||
                   (j.resultCount && j.items.length < j.resultCount) ||
                   (!j.totalPages && !j.resultCount));
      const next = more ? a.nextPageUrl(location.href, j.pagesDone) : null;
      if (next && j.pagesDone < MAX_PAGES) { await sleep(600); location.href = next; }
      else { j.phase = j.withSpec ? "spec" : "build"; await s(j); step(); }
      return;
    }
    // Past page 1, a page without the results grid (e.g. Walmart's 404, which
    // still ships ~100 recommendation products in its JSON) means we've walked
    // past the last real page — finish with what we have instead of scraping it.
    if (page > 1 && typeof a.isResultsPage === "function" && !a.isResultsPage(document)) {
      // Normal end-of-category probe: we walked one page past the last real one.
      await report(`Reached the last page — ${j.items.length} collected, moving on`);
      j.phase = j.withSpec ? "spec" : "build";
      j.specIdx = 0;
      await s(j); step();
      return;
    }
    // Lazily-rendered grids (Target): tiles only render as you scroll, so at
    // load time just the first viewport-full exists (e.g. 14 of 24/97). Scroll
    // to the bottom repeatedly until the tile count AND page height stop
    // growing, THEN scrape — no selectors involved, the site renders itself.
    if (a.lazyScroll) {
      // adapter may set a number = max scroll rounds (infinite-scroll sites like
      // Zara hold whole categories on one page and need more than Target's 20)
      const rounds = typeof a.lazyScroll === "number" ? a.lazyScroll : 20;
      let lastN = -1, lastH = -1, stable = 0;
      for (let i = 0; i < rounds && stable < 2; i++) {
        window.scrollTo(0, document.body.scrollHeight);
        await sleep(700);
        const live = await g();
        if (!live || !live.active || live.paused) return;   // honor pause/stop mid-scroll
        let n = 0; try { n = (a.scrapeList(document, location.href) || []).length; } catch (e) {}
        const h = document.body.scrollHeight;
        if (n === lastN && h === lastH) stable++; else stable = 0;
        lastN = n; lastH = h;
        // Enough for one research pass — stop unrolling. On an infinite-scroll
        // grid there is no page 2 to stop at, so the cap IS "the first page":
        // without it a single Zara category unrolls into several hundred rows
        // and buries the list the user actually assembled.
        if (j.maxItems && n >= j.maxItems) {
          await report(`Loaded ${n} (cap ${j.maxItems})`);
          break;
        }
        await report(`Loading all items… ${n} rendered`);
      }
      window.scrollTo(0, 0);
    }
    let scraped = [];
    try { scraped = a.scrapeList(document, location.href) || []; }
    catch (e) { scraped = []; await report(`Page ${page} parse error (skipped): ${e && e.message || e}`); }
    j.seen = j.seen || {};
    let added = 0, hitCap = false;
    for (const r of scraped) {
      const k = itemKey(r);
      if (!k || j.seen[k]) continue;
      // Cap per URL. A list of eight categories at a few hundred rows each is
      // not a research pass, it is a dump — and the detail phase would fetch
      // every one of them. Keeping the FIRST n preserves the shop's own order,
      // which is the merchandiser's ranking.
      if (j.maxItems && j.items.length >= j.maxItems) { hitCap = true; break; }
      j.seen[k] = 1; j.items.push(r); added++;
    }
    j.pagesDone = page;
    j.totalPages = j.totalPages || a.totalPages(document) || 0;
    j.resultCount = j.resultCount || (a.resultCount ? a.resultCount(document) : 0) || 0;
    j.emptyStreak = added === 0 ? (j.emptyStreak || 0) + 1 : 0;
    await s(j);
    const target = j.resultCount ? "/" + j.resultCount : "";
    await report(j.singlePage === false
      ? `Collecting… ${page}${j.totalPages ? "/" + j.totalPages + "p" : "p"} · ${j.items.length}${target} items (+${added} this page)`
      : `Collected ${j.items.length}${target} from this page${hitCap ? ` (cap ${j.maxItems})` : ""}`);

    // Current page only (the default). Walking a whole category returns far more
    // products than a research pass can use, and the point is a curated list of
    // categories rather than an exhaustive dump — so we scrape the page the user
    // chose and stop. Infinite-scroll grids still scroll out fully: that IS the
    // one page. Set singlePage:false to restore full pagination.
    const next = j.singlePage === false ? a.nextPageUrl(location.href, page) : null;
    // Keep paginating while the site's reported total says items are missing —
    // but with a small tolerance: the reported count often includes 1-2
    // sponsored/unavailable items that never render (e.g. "12" for an 11-item
    // shelf), and chasing those would walk us onto a non-existent page.
    const COUNT_TOLERANCE = 2;
    const haveMore = j.resultCount && (j.resultCount - j.items.length) > COUNT_TOLERANCE;
    // The reported total is both a completeness target AND a ceiling: once we've
    // collected it (within tolerance), STOP — even when the page-count hint is
    // unknown. Walking further spills past the last filtered page onto whatever
    // the site serves for out-of-range pages; Walmart returns broader, unfiltered
    // products there, which is how off-filter items (bags, shoes) crept into a
    // T-Shirts/Tank-Tops result. When no count is reported we still walk to the
    // 404 as before.
    const reachedCount = !!j.resultCount && !haveMore;
    const knownDone = reachedCount || (j.totalPages && page >= j.totalPages && !haveMore);
    const stalled = j.emptyStreak >= EMPTY_PAGE_LIMIT;
    const capped = page >= MAX_PAGES;

    if (next && !knownDone && !stalled && !capped) {
      await sleep(1200 + Math.random() * 900);   // human pace / anti-bot friendly
      const cur = await g();                       // honor a pause clicked during the delay
      if (!cur || !cur.active || cur.paused) return;
      location.href = next;                        // navigation -> resume() re-enters step()
    } else {
      if (capped) await report(`Safety cap (${MAX_PAGES}p) reached — stopping and building Excel.`);
      j.phase = j.withSpec ? "spec" : "build";
      j.specIdx = 0;
      await s(j);
      // announce the phase change immediately so the UI doesn't look frozen at "N/Np"
      await report(j.withSpec ? `List done (${j.items.length}) — collecting details…` : "List done — preparing Excel…");
      step();
    }
    return;
  }

  // -------- phase: detail (optional per-product page: composition/colors/design) --------
  if (j.phase === "spec") {
    if (typeof a.fetchDetail !== "function") { j.phase = "build"; await s(j); step(); return; }
    const total = j.items.length;
    // Fetch details a few at a time instead of one-by-one with a pause between.
    // Sequential + sleep was minutes of wall time for a normal category, and far
    // worse when the scan runs in a background tab: Chrome throttles timers in
    // hidden tabs (down to about once a minute), so each sleep became the
    // bottleneck. A small concurrency removes both problems and stays polite —
    // it is fewer simultaneous requests than the page itself makes.
    const LANES = 4;
    const applyDetail = (it, d) => {
      if (d && typeof d === "object") {
            it.fabric_composition = d.composition || "";
            // keep whichever colour source is FULLER — Cotton On's listing swatches
            // beat its weak no-JS PDP, while Walmart's PDP beats its sparse shelf.
            const nColors = s => s ? String(s).split(/\s*[;,/]\s*/).map(x => x.trim()).filter(Boolean).length : 0;
            if (d.colorways && nColors(d.colorways) > nColors(it.colorways)) it.colorways = d.colorways;
            if (d.color_count && (parseInt(d.color_count) || 0) > (parseInt(it.color_count) || 0)) it.color_count = d.color_count;
            if (d.design) it.design = d.design;            // real "Key item features"
            // optional enrichment some adapters provide (e.g. shopify vendor/type,
            // SFCC size lists)
            if (d.brand && !it.brand) it.brand = d.brand;
            if (d.category && !it.category) it.category = d.category;
            // the shop's own publish date, where the shop states one (Shopify's
            // published_at). Never inferred — a missing date stays missing.
            if (d.launched_at && !it.launched_at) it.launched_at = d.launched_at;
            // A lazy-loading grid can hand back a tile with no photo at all
            // (Zara's images only resolve as you scroll past). The PDP's own
            // structured-data image fills that hole; it never overwrites a
            // photo the listing already gave us.
            if (d.image_url && !it.image_url) it.image_url = d.image_url;
            // a PDP markdown (both current + original present) is authoritative
            // for this product — the listing tile often shows only the regular
            // price, so reflect the on-page sale in Current Price.
            if (d.price_was && d.price) { it.price = d.price; it.price_was = d.price_was; }
            else if (d.price_was && !it.price_was) it.price_was = d.price_was;
            if (d.price && !it.price) it.price = d.price;   // API-only price (e.g. Inditex list has none)
            if (d.sizes && !it.size_range) it.size_range = d.sizes;
            // adapters that build the whole row from an API (Inditex) fill name/
            // image/link only at the detail step — take them when the list left
            // them empty, and replace a synthetic pelement-only link once the
            // real product URL is known (a real MD link carries a "-l<ref>" slug).
            // The shop's own product JSON title is the name the tile shows, so
            // an adapter that marks its name canonical (Shopify) replaces
            // whatever the DOM scrape guessed — that is what stopped a whole
            // Edikted sheet reading "Select Size".
            if (d.name && (!it.name || d.name_canonical)) it.name = d.name;
            if (d.image_url && !it.image_url) it.image_url = d.image_url;
            if (d.product_url && !/-l\d/i.test(it.product_url || "")) it.product_url = d.product_url;
        it._compReason = d.reason || "";
      } else { it.fabric_composition = d || ""; }
    };

    let done = j.specIdx || 0;
    for (let i = j.specIdx || 0; i < total; i += LANES) {
      if (!alive()) return;   // extension reloaded mid-run -> stop quietly
      const live = await g();
      if (!live || !live.active || live.paused) { await s(j); return; }   // pause -> keep progress
      const slice = j.items.slice(i, i + LANES);
      await Promise.all(slice.map(async it => {
        if (it._specDone) return;
        try { applyDetail(it, await a.fetchDetail(it.product_url)); }
        catch (e) { it.fabric_composition = ""; it._compReason = "error"; }   // never stall the run
        it._specDone = true;
      }));
      done = Math.min(total, i + LANES);
      j.specIdx = done;
      await report(`Collecting details… ${done}/${total}`);
      await s(j);                                   // persist each batch for resume
    }
    j.specIdx = total; j.phase = "build"; await s(j); step(); return;
  }

  // -------- phase: build (export) --------
  if (j.phase === "build") {
    // The scan doubles as the site check: verdict + (on failure) a page
    // photograph, recorded before anything below can throw.
    {
      const q0 = await getQueue();
      const ent0 = (q0 && q0.active && j.queued) ? (q0.list[q0.idx] || null) : null;
      await recordHealth(j, a, ent0);
    }
    await report("Building Excel… (embedding thumbnails)");
    // if composition was never collected, mark the cause so the cell can explain it
    if (!j.withSpec) j.items.forEach(it => { if (!it.fabric_composition && !it._compReason) it._compReason = "not_collected"; });
    try {
      const ctx = {
        ExcelJS: self.ExcelJS,
        fetchImage: fetchImageViaBg,
        filters: j.filters || {},
        onProgress: (i, total) => report(`Building Excel… images ${i}/${total}`),
      };
      const { bytes, kept, dropped } = await a.buildWorkbook(j.items, ctx);
      const total = Object.values(kept).reduce((n, v) => n + (v.length || 0), 0);
      // break the dropped list down by reason for a transparent summary
      const dropByReason = {};
      (dropped || []).forEach(d => { const r = d[1] || "other"; dropByReason[r] = (dropByReason[r] || 0) + 1; });
      const reasonKo = { duplicate: "duplicate", brand: "brand", "name-include": "name filter", "name-exclude": "name exclude" };
      const dropSummary = Object.keys(dropByReason).map(r => `${reasonKo[r] || r} ${dropByReason[r]}`).join(", ");
      // unique, descriptive filename so a new run never collides with an old file
      // (which made it look like "the previous result" when the old file was opened)
      const brandTag = (j.items[0] && j.items[0].brand || a.label || "collect").replace(/\W+/g, "");
      let catTag = "";
      try {
        const q = new URL(location.href).searchParams.get("q") || "";
        catTag = (j.items[0] && j.items[0].category || q).replace(/[^A-Za-z0-9]+/g, "").slice(0, 24);
      } catch (e) {}
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T-]/g, "").slice(8); // HHMMSS
      const filename = `${a.id}_${brandTag}${catTag ? "_" + catTag : ""}_${total}items_${stamp}.xlsx`;
      /* Part of a saved-list run? Hold the rows instead of downloading. Four
         URLs used to mean four spreadsheets (plus four JSONs) that the designer
         had to merge by hand; the list is one research question, so it gets one
         file, built in queueExport() when the last URL finishes. */
      const queue = await getQueue();
      const inList = !!(queue && queue.active && j.queued);
      if (inList) {
        // The engine reads brand/category off the page; when the page states
        // neither, the list entry that sent us here carries the user's own
        // naming — fill only the blanks from it, so Excel and LAB never have
        // to group rows under an empty brand.
        const ent = queue.list[queue.idx] || {};
        const keptRows = [].concat.apply([], Object.values(kept || {}));
        keptRows.forEach(r => {
          if (!r.brand && ent.brand) r.brand = ent.brand;
          if (!r.category && ent.label) r.category = ent.label;
        });
        queue.rows = (queue.rows || []).concat(keptRows);
        await setQueue(queue);
        await catalogSave(j, a, kept, total, queue);
        await report(`${total} collected — one Excel file when the list finishes`);
        // the job stays active until queueAdvance closes it, so the final
        // "Excel 만드는 중…" lines still reach the panel
        await queueAdvance();
        return;
      }
      // Save via the service worker (chrome.downloads) — the in-page <a download>
      // click is silently swallowed on some retailers (Target). Fall back to the
      // anchor only if the worker path fails.
      let b64 = "";
      for (let i = 0; i < bytes.length; i += 0x8000) {
        b64 += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      }
      b64 = btoa(b64);
      const saved = await new Promise(res => {
        try {
          chrome.runtime.sendMessage({ type: "downloadXlsx", filename, b64 }, r => {
            if (chrome.runtime.lastError) return res(false);
            res(!!(r && r.ok));
          });
        } catch (e) { res(false); }
      });
      if (!saved) {
        const blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
        const url = URL.createObjectURL(blob);
        const el = document.createElement("a");
        el.href = url; el.download = filename;
        document.body.appendChild(el); el.click(); el.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      }
      // Companion JSON — the same kept rows as clean data, for the Report app
      // (market-research dashboards). Same base name, ".json". No new permissions:
      // it's just a second download, exactly like the xlsx.
      try {
        const scan = await catalogSave(j, a, kept, total, null);
        const jsonName = filename.replace(/\.xlsx$/i, "") + ".json";
        const jb64 = btoa(unescape(encodeURIComponent(JSON.stringify(scan))));
        const jsonSaved = await new Promise(res => {
          try {
            chrome.runtime.sendMessage({ type: "downloadFile", filename: jsonName, b64: jb64, mime: "application/json" },
              r => res(!chrome.runtime.lastError && !!(r && r.ok)));
          } catch (e) { res(false); }
        });
        if (!jsonSaved) {
          const jblob = new Blob([JSON.stringify(scan)], { type: "application/json" });
          const jurl = URL.createObjectURL(jblob);
          const je = document.createElement("a");
          je.href = jurl; je.download = jsonName;
          document.body.appendChild(je); je.click(); je.remove();
          setTimeout(() => URL.revokeObjectURL(jurl), 5000);
        }
      } catch (e) { /* JSON is a bonus — never fail the run over it */ }
      await report(`Done: ${total} rows${dropSummary ? " · excluded (" + dropSummary + ")" : ""} · ${j.items.length} collected`);
    } catch (e) {
      await report("Excel build failed: " + (e && e.message || e));
    }
    const done = await g(); if (done) { done.active = false; await s(done); }
    // (the tab was already returned to startUrl when detail/build began)
    // Running a saved list? Move on to its next URL.
    await queueAdvance();
  }
}

// ---- job controls, shared by the popup (via messages) and the on-page FAB ----
async function startJob(opts) {
  opts = opts || {};
  // bind the job to THIS tab so browsing in other tabs can't stop or divert it
  const tabId = await myTabId();
  // always a FRESH job tagged with this page's collection signature. startUrl is
  // where the user launched the scan, so we can bring the tab back here when the
  // run finishes (pagination usually leaves it on a "no more pages" 404).
  await s({ active: true, paused: false, phase: "list", items: [], seen: {}, pagesDone: 0,
      totalPages: 0, emptyStreak: 0, withSpec: opts.withSpec !== false, tabId,
      startUrl: location.href, queued: !!opts.queued,
      singlePage: opts.singlePage !== false,   // current page only unless asked otherwise
      // how many products one URL may contribute (0 = no cap)
      maxItems: opts.maxItems == null ? DEFAULT_MAX_ITEMS : (parseInt(opts.maxItems, 10) || 0),
      filters: opts.filters || {}, sig: collectionSig(location.href), status: "Starting…" });
  // collection always begins at the first page, wherever the user started from.
  // Adapters whose pagination isn't ?page=N (e.g. SFCC's ?start=N&sz=M) provide
  // firstPageUrl() to reset to the start; otherwise we just drop ?page.
  const a = adapter();
  let first;
  if (a && typeof a.firstPageUrl === "function") {
    first = a.firstPageUrl(location.href);
  } else {
    const u = new URL(location.href);
    u.searchParams.delete("page");
    first = u.toString();
  }
  if (first && first !== location.href) {
    // let callers get their ack out before the navigation tears this page down
    setTimeout(() => { location.href = first; }, 30);          // auto-resumes there (same sig)
  } else { step(); }
}
async function pauseJob() {
  const j = await g();
  if (j && j.active) { j.paused = true; j.status = "Paused (resumable)"; await s(j); }
}
async function resumeJob() {
  const j = await g();
  if (j && j.active && j.paused) { j.paused = false; j.status = "Resuming…"; await s(j); step(); }
}
// reset = discard the job entirely so a wrong run can never resurface
async function resetJob() { await clear(); }

// same-world API for fab.js (loaded after this file)
self.WPB_ENGINE = { startJob, pauseJob, resumeJob, resetJob, getJob: g, adapter };

chrome.runtime.onMessage.addListener((m, _s, send) => {
  if (m.type === "start") {
    startJob({ withSpec: m.withSpec, filters: m.filters }).then(() => send({ ok: true }));
    return true;
  }
  if (m.type === "pause") { pauseJob().then(() => send({ ok: true })); return true; }
  if (m.type === "resume") { resumeJob().then(() => send({ ok: true })); return true; }
  if (m.type === "reset" || m.type === "cancel") { resetJob().then(() => send({ ok: true })); return true; }
  if (m.type === "context") {
    const a = adapter();
    send(a ? Object.assign({ site: a.label, adapterId: a.id, platform: !!a.platform, hasDetail: typeof a.fetchDetail === "function", multiBrand: !!a.multiBrand }, a.context(document)) : { site: null });
    return true;
  }
  /* Dry run on the page in front of the user.

     Getting a shop working used to mean: run a scan, open the spreadsheet,
     notice a column is wrong, open DevTools, paste a diagnostic script, copy
     the output. That is six steps and a console for someone who does not use
     one. This runs the REAL engine — the same scrapeList a scan calls — and
     answers the only questions that matter: does it find products here, and
     do they come out with a name, a picture and a price.

     Read-only: it collects nothing, saves nothing, and cannot disturb a run.
     It reads what is rendered right now, so on a lazy grid the count is the
     first screenful; a scan scrolls and gets more. The panel says so. */
  if (m.type === "probe") {
    (async () => {
      const a = adapter();
      if (!a) return send({ ok: false, reason: "no-engine" });
      let rows = [];
      try { rows = a.scrapeList(document, location.href) || []; }
      catch (e) { return send({ ok: false, reason: String((e && e.message) || e) }); }
      const filled = f => rows.filter(r => String(r[f] || "").trim()).length;
      const html = document.documentElement.innerHTML;
      const platform = [
        /cdn\.shopify\.com|\/cdn\/shop\//.test(html) && "Shopify",
        /demandware|dwstatic/i.test(html) && "Salesforce",
        /__NEXT_DATA__/.test(html) && "Next.js",
        /__NUXT__/.test(html) && "Nuxt",
      ].filter(Boolean);
      const ctx = (() => { try { return a.context(document) || {}; } catch (e) { return {}; } })();
      send({
        ok: true, url: location.href,
        adapterId: a.id, site: a.label,
        brand: ctx.brand || "", category: ctx.category || "",
        lazy: !!a.lazyScroll,
        count: rows.length,
        named: filled("name"), imaged: filled("image_url"), priced: filled("price"),
        platform, ld: document.querySelectorAll('script[type="application/ld+json"]').length,
        samples: rows.slice(0, 3).map(r => ({
          name: String(r.name || "").slice(0, 70),
          price: r.price || "",
          img: !!r.image_url,
          url: String(r.product_url || "").slice(0, 90),
        })),
      });
    })();
    return true;
  }
  if (m.type === "status") { g().then(j => send(j || {})); return true; }
  // start a saved-list run in THIS tab: park the queue, then go to its first URL
  if (m.type === "runList" && m.list && m.list.length) {
    (async () => {
      const tabId = await myTabId();
      await clear();                              // any half-finished job is replaced
      await setQueue({ active: true, tabId, listId: m.listId || "", name: m.name || "",
        list: m.list, idx: 0, rows: [],
        maxItems: m.maxItems == null ? DEFAULT_MAX_ITEMS : m.maxItems,
        withSpec: m.withSpec !== false, filters: m.filters || {}, startedAt: Date.now() });
      send({ ok: true, count: m.list.length });
      setTimeout(() => { try {
        // same fragment-only guard as queueAdvance: starting a run from the
        // page it already shows (or one that differs only after the #) must
        // still reload so maybeResumeQueue fires
        const here = location.href.split("#")[0];
        location.href = m.list[0].url;
        if (String(m.list[0].url).split("#")[0] === here) location.reload();
      } catch (e) {} }, 60);
    })();
    return true;
  }
  if (m.type === "queueStatus") { getQueue().then(q => send(q || {})); return true; }
  if (m.type === "queueStop") {
    (async () => {
      const q = await getQueue();
      if (q) { q.active = false; q.finishedAt = Date.now(); await setQueue(q); }
      send({ ok: true });
      // stopping early still hands over what was collected, in one file — then
      // the job is closed so the half-finished URL doesn't carry on scanning
      if (q && (q.rows || []).length) await queueExport(q);
      // Stopping early still hands over the failure report — but only for the
      // URLs that actually finished (idx points at the one that was cut short;
      // calling an interrupted scan "broken" would send the developer chasing
      // a site that works).
      if (q) await queueHealthExport(Object.assign({}, q, { list: (q.list || []).slice(0, q.idx) }));
      const d = await g(); if (d) { d.active = false; await s(d); }
    })();
    return true;
  }
  return true;
});

// Resume across the page navigations that pagination triggers — but ONLY in the
// tab that started the job, and ONLY for the same collection, and never while
// paused. Binding to the owning tab is what lets the user browse other brands
// in other tabs without stopping or diverting a running scan: a different tab
// leaves the job completely untouched (no step, no clear). Within the owning
// tab, a different collection means the user navigated away — we keep the job
// intact (they can return) and simply don't scrape the wrong page. The job is
// only ever discarded explicitly (✕ / reset) or replaced by a new startJob, so
// stale items can never leak into another category's output.
// Pure decision: may THIS tab drive the stored job on the page with `sig`?
function ownsAndMatches(job, myTab, sig) {
  if (!job || !job.active || job.paused) return false;
  if (job.tabId != null && myTab != null && job.tabId !== myTab) return false; // another tab — hands off
  // The list phase scrapes THIS page, so it must be the same collection. Later
  // phases (detail/build) work from already-collected data via fetch/export, so
  // a refresh resumes them in the owning tab no matter which page it landed on
  // (e.g. the end-of-pagination 404) — refreshing never loses progress.
  if (job.phase && job.phase !== "list") return true;
  return !!job.sig && job.sig === sig;                                          // same collection only
}
(async () => {
  const j = await g();
  const me = await myTabId();
  if (j && j.active) {
    if (ownsAndMatches(j, me, collectionSig(location.href))) step();
    return;
  }
  // No job running: if a saved-list run is in progress and we just landed on its
  // current URL, start that URL's scan automatically. This is what makes a list
  // walk itself — the user clicks once, not once per URL.
  const q = await getQueue();
  if (!q || !q.active || !q.list || !q.list.length) return;
  if (q.tabId != null && me != null && q.tabId !== me) return;
  const cur = q.list[q.idx];
  if (!cur || !sameCollection(cur.url, location.href)) return;
  if (!adapter()) return;                       // unsupported page — leave it alone
  startJob({ withSpec: q.withSpec !== false, filters: q.filters || {}, queued: true,
    maxItems: q.maxItems });
})();
