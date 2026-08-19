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
/* Every write stamps the time. All progress already flows through here —
   report(), each phase change, each persisted batch — so `at` is the run's
   heartbeat, and something outside the page can tell "still working" from
   "stopped" without knowing anything about phases. */
const s = j => new Promise(r => {
  if (!alive()) return r();
  if (j && typeof j === "object") j.at = Date.now();
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
  if (q && typeof q === "object") q.at = Date.now();   // heartbeat, as above
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
      product_type: it.product_type || "",
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
   same facts the diagnose script gathered by hand. The whole report is kept
   in storage and printed by devsitecheck(); a scan writes ONE file and it is
   the spreadsheet, because a stray .txt in the Downloads folder is the
   developer's business showing up in the designer's.

   Read-only by design: the diagnosis never changes what a scan collects,
   never blocks the run (every piece is wrapped), and adds nothing when all
   sites pass — designers only ever see the file when something needs fixing. */

const HEALTH = "wpb_sitehealth";     // { [collectionSig]: record }, latest per collection
const HEALTH_MAX = 300;              // oldest records fall off
const SITECHECK = "wpb_sitecheck";   // the latest run's report, kept instead of downloaded
const PROFILE = "wpb_siteprofile";   // { [host]: what we learned by reading the page }
const PROFILE_MAX = 200;

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
        // a picture is a picture however the shop paints it — <img>, a CSS
        // background, or a lazy loader's attribute waiting to become one
        const g0 = self.SITES && SITES.get && SITES.get("generic");
        const picSel = "img, picture, source, " +
          ((g0 && g0._BG_SEL) || '[style*=background-image]');
        if (k.querySelector("a[href]") && k.querySelector(picSel)) tiles++;
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
    /* The reader's own pattern, not a copy of it. A second copy went stale the
       moment the first one learned that half of Europe writes the symbol after
       the number — and a diagnosis that asks a different question than the
       reader reports "no prices here" about a page covered in them. */
    const g = self.SITES && SITES.get && SITES.get("generic");
    const PRICE_RE = (g && g._PRICE_RE) ||
      /(?:[$₩€£¥]\s?\d[\d,]*(?:\.\d{1,2})?|\d[\d,]*(?:\.\d{1,2})?\s?(?:원|USD|EUR|GBP))/;
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

/* ---- reading the page instead of trusting our rule about it ---------------

   The funnel above only REPORTS that a shop's adapter emptied a scan. Saying
   it is not enough: a designer whose Aritzia list came back with no Excel has
   to wait for a developer to change one regular expression, and in the
   meantime the tool is broken for them.

   So when the adapter this shop is routed to comes back with nothing, the
   scan reads the page structurally — the same reader that already handles the
   66 shops with no adapter at all — and, if what comes back looks like a real
   product grid, collects THAT. The site's own markup outranks our stale
   assumption about its addresses.

   This is not intelligence and does not pretend to be. There is no model in
   the extension (charter) and none is needed: "the repeating thing that has
   links, pictures and prices in it" is a structural fact, and structure is
   what a developer reads in F12 anyway. What it cannot do is invent data the
   page never served — a composition that isn't in the HTML, a catalogue
   behind a private API, a shop that answers a bot with a block page. Those
   still surface as failures with the page photograph attached. */

const RESCUE_MIN = 4;                // fewer tiles than this is not a grid

// Guardrail: only accept a structural read that looks like merchandise.
// A page of editorial banners can produce "links with images"; requiring
// names on most of them plus prices or pictures keeps navigation chrome out.
function plausibleGrid(rows) {
  if (!Array.isArray(rows) || rows.length < RESCUE_MIN) return false;
  const share = f => rows.filter(r => String(r[f] || "").trim()).length / rows.length;
  return share("name") >= 0.6 && (share("price") >= 0.5 || share("image_url") >= 0.5);
}

function genericRead(doc, url) {
  try {
    const g = self.SITES && SITES.get && SITES.get("generic");
    return g ? (g.scrapeList(doc || document, url || location.href) || []) : [];
  } catch (e) { return []; }
}

// What the rejected addresses have in common, written the way a developer
// would write the fix: /p/<slug>/N . Digits collapse to N, long slugs to
// <slug>, so twelve product URLs come out as one pattern.
function pathShape(urls) {
  const shapes = {};
  [].concat(urls || []).forEach(u => {
    let p = "";
    try { p = new URL(u, location.href).pathname; } catch (e) { return; }
    const seg = p.split("/").filter(Boolean).map(s =>
      /^\d+$/.test(s) ? "N" : (/\d/.test(s) && /[-_]/.test(s)) || s.length > 12 ? "<slug>" : s);
    const key = "/" + seg.join("/");
    shapes[key] = (shapes[key] || 0) + 1;
  });
  const best = Object.keys(shapes).sort((a, b) => shapes[b] - shapes[a])[0] || "";
  return best;
}

/* Remember it per shop, so the next scan does not rediscover the same thing
   and so the record can say WHICH adapters have gone stale. The profile never
   silences the report — a shop being read structurally is exactly what the
   developer needs to see. */
async function learnProfile(host, info) {
  try {
    const all = (await kvGet(PROFILE)) || {};
    const prev = all[host] || {};
    all[host] = Object.assign({}, prev, info, {
      host, learnedAt: Date.now(), hits: (prev.hits || 0) + 1,
      firstAt: prev.firstAt || Date.now(),
    });
    const keys = Object.keys(all);
    if (keys.length > PROFILE_MAX) {
      keys.sort((x, y) => (all[x].learnedAt || 0) - (all[y].learnedAt || 0))
        .slice(0, keys.length - PROFILE_MAX).forEach(k => delete all[k]);
    }
    await kvSet(PROFILE, all);
  } catch (e) {}
}

const hostOf = u => { try { return new URL(u || location.href).hostname.replace(/^www\./, ""); } catch (e) { return ""; } };

/* The repair has to reach the product page too, or it only half works.

   A shop whose adapter no longer recognises its list addresses does not
   recognise its product addresses either — Shopify's detail reader wants
   "/products/" in the path and returns nothing for a shop that moved to
   "/p/". The rows would come back with names and pictures and an empty
   fabric column, which is the column this tool exists for. So on a repaired
   page the site-neutral reader (JSON-LD, then visible text) goes first and
   the adapter stays as the backup. */
/* `have` is what the listing already gave us for this row. An adapter that
   would otherwise open the product page just to find a picture can skip that
   when the tile already supplied one — sixty saved page loads on a shop whose
   grid renders its photos. */
async function readDetail(a, url, repaired, have) {
  if (!repaired || a.id === "generic") return a.fetchDetail(url, have);
  const g = self.SITES && SITES.get && SITES.get("generic");
  let open = null;
  if (g && typeof g.fetchDetail === "function") {
    try { open = await g.fetchDetail(url); } catch (e) {}
    if (open && open.composition) return open;
  }
  let own = null;
  try { own = await a.fetchDetail(url, have); } catch (e) {}
  return (own && own.composition) ? own : (open || own);
}

/* One storefront is one brand. A shop that hands back several different
   makers is either a genuine multi-brand retailer — which says so — or a shop
   whose brand field we are misreading, and every figure grouped by brand
   downstream is then wrong.

   It is only worth telling anyone when it SURVIVED. Set Active writes its drop
   into the vendor field ("JUL 2026 - GONE BANANAS"), and since v1.94 the name
   on the list entry is written over it for any shop that is not a multi-brand
   retailer — so the rows are already filed under one brand and there is
   nothing to do. Flagging it anyway put a warning on a shop that was fine,
   and a band that cries wolf is a band nobody reads. The warning belongs to
   the case where no list name was there to save it. */
function brandsDisagree(rec) {
  return !rec.multiBrand && (rec.saidBrands || []).length > 1 &&
    !String(rec.brand || "").trim();
}
/* Fabric was judged all-or-nothing, so a site that answered for three of
   sixty passed as healthy. Individual products legitimately state no blend;
   a site where almost none do is an extraction that has stopped working.
   Same for photos — the one that mattered on Vuori. */
const THIN_FABRIC = 0.25, THIN_PHOTO = 0.5;
function healthMark(rec) {
  if (!rec.count) return "❌";
  if (brandsDisagree(rec)) return "⚠️";
  if (rec.named < rec.count || rec.imaged < rec.count || rec.priced < rec.count) return "⚠️";
  if (rec.imaged / rec.count < THIN_PHOTO) return "⚠️";
  if (rec.withSpec && rec.count && rec.fabric / rec.count < THIN_FABRIC) return "⚠️";
  /* A rescued page is never called ready. The designer's spreadsheet is
     complete — that is the point of the rescue — but the shop is being read
     around its own adapter, and calling that ✅ would hide the stale rule
     forever, since a clean run downloads no site check file at all. */
  if (rec.repair) return "⚠️";
  /* Half a grid that calls itself finished is worse than a grid that fails —
     the spreadsheet looks whole. */
  if (rec.more || rec.shortOf || rec.stoppedWith) return "⚠️";
  return "✅";
}
/* An empty fabric column has three quite different causes and they are fixed
   by three different people. The probe already opened one product page and
   wrote down what was on it; this turns that into the sentence.

     · the page refused us or was too busy   → scan it again later
     · the page states a composition         → OURS: we were looking in the
                                               wrong place, and here is the
                                               line we should have read
     · the page states none anywhere         → nobody's: there was nothing
                                               there to read

   The middle one is the whole point. "no fabric on any of the 30" could mean
   any of the three, so it sent the last three rounds of photo bugs looking in
   the wrong place; quoting the shop's own sentence back ends that. */
/* A product page that has not been built yet.

   Fetching gives the document the server sent; a page whose content is drawn
   by scripts afterwards arrives as a shell, and reading "no composition" off
   it is reading our own request, not the shop. Two facts settle it, and both
   are already in the probe: hardly any text, and no structured product data.
   Recorded by diagnoseDetail as textLen. */
function looksLikeShell(d) {
  d = d || {};
  if (d.textLen == null) return false;                 // probed before this existed
  const types = (d.ld && d.ld.types) || [];
  const hasProduct = types.some(t => /product/i.test(String(t)));
  return d.textLen < 400 && !hasProduct;
}

function fabricBecause(d) {
  d = d || {};
  const st = d.pdpStatus || (d.js && d.js.status) || 0;
  if (st === 429 || st === 503) {
    return ` — the shop's product pages answered ${st} (too busy), so scan it again later`;
  }
  if (st === 403 || st === 401) return ` — the shop's product pages refused us (${st})`;
  if (st && st >= 400) return ` — the shop's product pages answered ${st}`;
  if (!st) return "";                       // the probe never ran; say no more than we know
  /* Percentages on a shop page are not all compositions — "20% off" is the
     commonest number on a product page. The composition parser drops those
     lines and so does this, or the sentence would blame us for a sale badge. */
  const runs = (d.pctRuns || []).filter(s => !/\b(off|sale|save|discount|extra|up to)\b/i.test(s));
  const said = runs[0] || (d.ld && d.ld.material) || "";
  if (said) {
    return ` — but its product page does state one ("${String(said).trim().slice(0, 48)}"), ` +
      `so this is ours to fix, not something to retry`;
  }
  if (d.js && d.js.descPct) {
    return ` — but the shop's own product data states one, so this is ours to fix`;
  }
  /* "The page does not state one" is only true of the page a PERSON sees. What
     we fetched may be a shell that scripts fill in afterwards — Alo's product
     pages arrive with almost no text in them — and blaming the shop for that
     sends the next round looking at the wrong thing. The shell is
     recognisable: a product page that says almost nothing and carries no
     structured product data is not a product page yet. */
  if (looksLikeShell(d)) {
    return ` — its product page arrives nearly empty and is filled in by scripts ` +
      `afterwards, so fetching it cannot see the blend. This is ours: the page has ` +
      `to be read in a tab, not fetched`;
  }
  return ` — its product page does not state one anywhere either, so there was nothing to read`;
}

/* The same verdict, said to the person who has to act on it.

   healthNote() is the developer's line — "image×60, fabric×all". It is what
   the site report has always carried, and it lives behind a console command,
   which is why every one of these problems reached the designer as a screen
   full of grey boxes instead of a sentence. This is the sentence. It names
   the shop, what is wrong with what came back, and whether the spreadsheet
   can still be trusted. */
function healthWhy(rec) {
  const who = rec.brand || rec.label || "This site";
  if (!rec.count) {
    /* "Nothing was collected" used to offer three guesses and never the one
       that was ours. When the page photograph shows repeated product blocks
       and no price we could read, the shop is fine and the reader is not —
       and that is the sentence a developer can act on immediately, instead of
       the designer being told to try scrolling. */
    const d = rec.diag || {};
    const by = rec.adapter ? ` (read by the ${rec.adapter} reader)` : "";
    const tiles = (d.grids || []).reduce((n, g) => Math.max(n, g.tilesWithLinkAndImg || 0), 0);
    if (tiles >= 3 && d.priceLeaves && !d.priceLeaves.count) {
      return `${who}: the page showed ${tiles} product blocks, but no price on it ` +
        `could be read — so none of them was collected. This is ours to fix, ` +
        `not something to retry${by}.`;
    }
    /* The adapter kept nothing out of a page that plainly had products on it:
       our own filter emptied the scan, not the shop. The funnel is the fact
       that separates "we cannot read this shop" from "our rule for this shop
       has gone stale", and it was sitting in the record unsaid. */
    if (rec.funnel && rec.funnel.tilesOnPage) {
      return `${who}: the page offered ${rec.funnel.tilesOnPage} products and the ` +
        `${rec.funnel.adapter} reader kept none of them — our filter emptied this ` +
        `scan, not the shop. It was expecting a different address shape` +
        ((rec.funnel.rejectedUrls || [])[0]
          ? ` (it saw "${String(rec.funnel.rejectedUrls[0]).slice(0, 60)}")` : "") + `.`;
    }
    /* Nothing came back AND the photograph saw no repeating product block —
       so the page we were served genuinely had no grid on it. Saying that is
       what makes the three suggestions worth trying rather than a shrug. */
    const sawNothing = d.grids && !tiles
      ? ` The page we were served had no product grid on it at all, so this is ` +
        `about what the shop sent rather than how it was read.` : "";
    return `${who}: nothing was collected. The page may need scrolling, ` +
      `may have asked for a region or consent choice, or may block automated ` +
      `visits${by}.${sawNothing}`;
  }
  const parts = [];
  if (brandsDisagree(rec)) {
    parts.push(`the shop gave ${rec.saidBrands.length} different brand names ` +
      `(${rec.saidBrands.slice(0, 3).join(", ")}…) — one shop should be one brand, ` +
      `so it is filed under the name in your list`);
  }
  /* Any missing photo is said, not just a page that is mostly missing them.
     The mark is raised by `imaged < count` but the sentence only spoke below
     half, so a shop with 50 of 60 was flagged with nothing to read — which is
     precisely the "needs a look" the designer was shown for VUORI, and
     exactly the failure v1.95 was written to stop. */
  if (rec.imaged === 0) parts.push(`no photos at all (${rec.count} products)`);
  else if (rec.imaged < rec.count) {
    parts.push(`photos on only ${rec.imaged} of ${rec.count}`);
  }
  if (rec.more) {
    parts.push(`the grid was still loading more when the scan stopped — ` +
      `${rec.count} were taken, and this page has more`);
  }
  if (rec.stoppedWith) {
    /* The shop stated no total, so there is no "N of M" to report — what there
       is, is what the page still had on it when we stopped. That is the whole
       difference between "that was all of them" and "we stopped early", and
       without it this scan grades itself clean either way. */
    parts.push(`${rec.stoppedWith.got} came through and the page still had ` +
      `${rec.stoppedWith.leftover} on it — it never said how many it holds, ` +
      `so this may be part of the listing`);
  }
  if (rec.shortOf) {
    parts.push(`the page says it is showing ${rec.shortOf.said} items and ` +
      `${rec.shortOf.got} came through — the grid did not hand over the rest`);
  }
  if (rec.withSpec && rec.fabric === 0) {
    /* Why the column is empty decides who fixes it: a shop that throttled us
       is a scan to run again, a page that simply does not state the blend is
       nobody's fault, and anything else is ours. The detail probe already
       fetched one product page and kept its status — and, until now, kept
       what it found there to itself. "no fabric on any of the 30" with no
       cause is the ALO YOGA line, and it starts the next round with a guess. */
    parts.push(`no fabric on any of the ${rec.count}${fabricBecause(rec.diagDetail)}`);
  }
  else if (rec.withSpec && rec.fabric / rec.count < THIN_FABRIC) {
    parts.push(`fabric on only ${rec.fabric} of ${rec.count}`);
  }
  if (rec.named < rec.count) parts.push(`${rec.count - rec.named} without a name`);
  if (rec.priced < rec.count) parts.push(`${rec.count - rec.priced} without a price`);
  if (rec.repair) {
    parts.push("the page had to be read around its usual rule — the rows are " +
      "right, but this shop's reader is out of date");
  }
  /* A mark with nothing behind it is the bug, not the shop.

     Every branch above is reachable only from a branch of healthMark, but the
     two lists drifted apart once already and the cost lands on the designer as
     "needs a look" — five words that send them back to guessing. So the last
     word is a backstop: if the page was graded and no sentence was produced,
     say the counts rather than say nothing. `health-test` holds the two in
     step from now on. */
  if (!parts.length) {
    if (healthMark(rec) === "✅") return "";
    parts.push(`${rec.count} products came through — ${rec.named} named, ` +
      `${rec.imaged} with a photo, ${rec.priced} priced` +
      (rec.withSpec ? `, ${rec.fabric} with fabric` : ""));
  }
  /* Which reader produced this decides where a fix goes: a dedicated adapter
     with a stale rule and a generic read of an unknown shop are different
     jobs, and the line never said which one it was. */
  const by = rec.adapter ? ` (read by the ${rec.adapter} reader)` : "";
  return `${who}: ${parts.join(" · ")}${by}.`;
}

function healthNote(rec) {
  if (!rec.count) return "0 products";
  const miss = [];
  if (brandsDisagree(rec)) miss.push(`brand×${(rec.saidBrands || []).length} names`);
  if (rec.named < rec.count) miss.push(`name×${rec.count - rec.named}`);
  if (rec.imaged < rec.count) miss.push(`image×${rec.count - rec.imaged}`);
  if (rec.priced < rec.count) miss.push(`price×${rec.count - rec.priced}`);
  if (rec.withSpec && rec.count && rec.fabric / rec.count < THIN_FABRIC) {
    miss.push(rec.fabric ? `fabric×${rec.count - rec.fabric}` : "fabric×all");
  }
  const base = miss.length ? `${rec.count} found · missing ${miss.join(" ")}` : `${rec.count} found · complete`;
  return rec.repair ? `${base} · recovered by reading the page (${rec.repair.adapter} adapter kept none)` : base;
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
      /* How much of a page actually arrived. A product page that scripts build
         afterwards comes back nearly empty, and without this the report says
         the shop states no composition when what it means is that we fetched
         a shell. */
      out.textLen = text.trim().length;
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
    /* What the SHOP said the brand was, before the list entry's name is
       applied over it. Set Active writes its drop there ("JUL 2026 - GONE
       BANANAS"), and a single storefront that names itself several different
       ways is a shop we are reading wrong — the kind of thing that used to be
       invisible because every row still had a name, a photo, a price and a
       blend, so the check said the page was fine. */
    const saidBrands = [...new Set(j.items
      .map(it => String(it.brand || "").trim()).filter(Boolean))].slice(0, 8);
    const rec = {
      url: j.startUrl || location.href, sig: j.sig || collectionSig(location.href),
      adapter: a.id, brand: (ent && ent.brand) || "", label: (ent && ent.label) || "",
      count: j.items.length, named: filled("name"), imaged: filled("image_url"), priced: filled("price"),
      fabric: filled("fabric_composition"), withSpec: !!j.withSpec,
      saidBrands, multiBrand: !!a.multiBrand,
      ts: Date.now(),
    };
    // the page was read around its adapter — the spreadsheet is whole, the rule is not
    if (j.repair) rec.repair = j.repair;
    // the grid was still growing when the scan ran out of scroll rounds
    if (j.moreWaiting) rec.more = true;
    // the page said it was showing more than we could get out of it
    if (j.shortOf) rec.shortOf = j.shortOf;
    if (j.stoppedWith) rec.stoppedWith = j.stoppedWith;
    if (j.topped) rec.topped = j.topped;
    rec.mark = healthMark(rec);
    // Photograph the page only when something is wrong AND we are still looking
    // at the scanned collection (single-page scans stay on it; a paginated run
    // may have walked off it, and diagnosing the wrong page would mislead).
    // A repaired page needs no photograph: the pattern line already says what
    // to change, and a 4KB dump next to it only buries the answer.
    if (rec.mark !== "✅" && !rec.repair && collectionSig(location.href) === rec.sig) rec.diag = selfDiagnose();
    /* Where in the pipeline the products were lost.

       "0 products" has two very different causes, and the page photograph
       cannot tell them apart: either the page offered no tiles (a shop we
       cannot read), or it offered plenty and this shop's adapter rejected
       them all (a rule of ours that has gone stale). Aritzia was the second —
       the grid was read, every tile found, and the product-URL filter dropped
       all of them — and nothing in the report said so, which is what made it
       a mystery instead of a one-line fix.

       Only computed when the adapter came back empty, and only for a
       dedicated adapter, so it costs one extra DOM pass exactly when that
       pass is the answer. */
    if (!rec.count && a.id !== "generic" && collectionSig(location.href) === rec.sig) {
      try {
        const g = self.SITES && SITES.get && SITES.get("generic");
        const raw = g ? (g.scrapeList(document, location.href) || []) : [];
        if (raw.length) {
          rec.funnel = {
            tilesOnPage: raw.length, keptByAdapter: 0, adapter: a.id,
            note: `the page offered ${raw.length} tiles and the ${a.id} adapter kept none — ` +
              `its own filters, not the shop, are what emptied this scan`,
            // the shapes it rejected: this is what a changed URL pattern looks like
            rejectedUrls: raw.slice(0, 3).map(r => String(r.product_url || "").slice(0, 140)),
          };
        }
      } catch (e) {}
    }
    // A site whose fabric came back empty for EVERY product gets one product
    // page photographed too — that is where the blend would live, and it is
    // the page the developer used to inspect by hand (Edikted, Alo).
    if (rec.withSpec && rec.count && rec.fabric === 0 && j.items[0] && j.items[0].product_url) {
      rec.diagDetail = await diagnoseDetail(j.items[0]);
    }
    /* Written last, because the sentence is allowed to use the photograph:
       "the page showed 24 product blocks and no price we could read" is a
       different instruction from "try scrolling", and only the diagnosis
       knows which one is true. */
    rec.why = healthWhy(rec);
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

/* One report per list run, ONLY when something failed: the verdict for every
   URL plus the stored page photograph of each failure — the exact output the
   developer used to assemble by hand with devcheck + diagnose scripts. It is
   kept in storage rather than downloaded (devsitecheck() prints it), so a
   scan still leaves exactly one file behind and that file is the Excel. */
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
      /* Put the funnel FIRST when we have it: it names the culprit in a
         sentence, and the page dump below is only needed when it doesn't. */
      if (r.repair) lines.push(`   ⚑ recovered by reading the page: the ${r.repair.adapter} adapter kept ` +
        `none of the ${r.repair.tiles} tiles, so the page's own markup was used instead.` +
        `\n     the products here look like ${r.repair.pattern} — that is what the ${r.repair.adapter} ` +
        `adapter's URL rule should accept. The spreadsheet for this site is complete.`);
      if (r.funnel) lines.push("   ⚑ " + r.funnel.note +
        "\n     rejected e.g. " + (r.funnel.rejectedUrls || []).join("  |  "));
      if (r.diag) lines.push("   diag: " + JSON.stringify(r.diag));
      if (r.diagDetail) lines.push("   pdp: " + JSON.stringify(r.diagDetail));
      lines.push("");
    }
    /* A scan produces ONE file, and it is the spreadsheet (user's rule).

       The site check used to download itself as a .txt next to the Excel. It
       is the developer's channel, not the designer's: what it bought was a
       stray text file in the Downloads folder of someone who only asked for a
       spreadsheet, and on the run that collected nothing it was the ONLY thing
       that appeared. So the report is kept, not written out — it stays in
       storage where devsitecheck() prints it — and the run's last line still
       says plainly that something needs attention. */
    const text = lines.join("\n");
    await kvSet(SITECHECK, {
      name: q.name || "list", at: Date.now(), text,
      bad: bad.length, total: recs.length,
    });
    /* The LAST line the panel shows has to be the whole story: what was
       collected, where it already is, and what is worth a look. The file is
       no longer part of it — a run fills the catalog, and the spreadsheet is
       taken with ⬇ when it is wanted. */
    const collected = (q && q.rowCount) || 0;
    const need = `${bad.length} of ${recs.length} site${recs.length === 1 ? "" : "s"} need attention`;
    await report(collected
      ? `${collected} products in PRODUCTS and the LAB · ${need} · press ⬇ for the Excel`
      : `No products collected — ${bad.length} of ${recs.length} site${recs.length === 1 ? "" : "s"} came back empty or broken.`);
  } catch (e) { /* the report is a bonus — never fail the run over it */ }
}

/* Save the whole list run as ONE workbook.

   A list is "26SS tops" — four brands' top categories that belong in one
   spreadsheet, not four downloads the user then has to merge by hand. So a
   queued scan writes its rows into the queue instead of downloading, and the
   file is built once here, at the end, with every brand in it (excel.js groups
   the rows by brand). Also runs when the user stops early, so stopping still
   yields the work already done. */
/* The run's rows live in the extension's database (store.js runrows), reached
   through the worker because a content script runs in the page's origin. */
function runRows(op, runId, items) {
  return new Promise(res => {
    try {
      chrome.runtime.sendMessage({ type: "runRows", op, runId, items }, r => {
        void chrome.runtime.lastError; res(r || null);
      });
    } catch (e) { res(null); }
  });
}

async function queueExport(q) {
  const got = await runRows("get", q && q.runId);
  const rows = (got && got.rows) || [];
  /* A run that collected nothing has to SAY so.

     There is no spreadsheet to write, so this used to return in silence, and
     a run that ended with nothing at all looked the same as one that worked.
     The site check that follows names the sites; this line says why the file
     the designer was waiting for never arrived. */
  if (!rows.length) {
    const n = ((q && q.list) || []).length;
    await report(`No products collected from ${n} site${n === 1 ? "" : "s"} — nothing to put in an Excel.`);
    return;
  }
  /* Say what is there and where to take it. Building it here would mean
     fetching every photo in the run for a file nobody asked for. */
  const sites = ((q && q.list) || []).length;
  await report(`${rows.length} products from ${sites} site${sites === 1 ? "" : "s"} — ` +
    `in PRODUCTS and the LAB now. Press ⬇ for the Excel.`);
  return;
}

/* The file, when it is actually wanted. Called from the panel, which loads
   ExcelJS itself, so it does not depend on the scanned tab still being open. */
async function queueExportNow(q) {
  const got = await runRows("get", q && q.runId);
  const rows = (got && got.rows) || [];
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
    /* The rows are NOT cleared here. They are one run's worth, they are cleared
       when the next run starts, and keeping them means the spreadsheet can be
       rebuilt from what was collected without walking every shop again. */
  } catch (e) {
    await report("List Excel failed: " + (e && e.message || e) + " (use ⬇ Excel in the panel to retry)");
  }
}

/* A shop answered a different address than the one we asked for. Kept so the
   site report can say so — a category that arrives by redirect is worth
   knowing about even when the scan itself went fine, because the address in
   the list may be the one that has gone stale. */
async function noteRedirect(asked, landed) {
  try {
    const q = await getQueue();
    if (!q || !q.active) return;
    q.redirects = (q.redirects || []).slice(-40);
    q.redirects.push({ asked, landed, at: Date.now() });
    await setQueue(q);
  } catch (e) {}
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
    /* The spreadsheet is NOT written here any more.

       A run's job is to fill the catalog — PRODUCTS and the LAB have every
       shop's products as soon as that shop finishes. The file is a separate
       act: it costs a download of every thumbnail in the run, and a designer
       who scanned to look at the LAB never asked for one. So the rows are
       kept and the panel offers to take the file when it is wanted.

       The rows survive until the next run starts, so the file can still be
       made later without re-scanning. */
    await queueExport(q);          // job is still active here, so progress shows
    await queueHealthExport(q);    // failures (if any) are kept for devsitecheck()
    await closeJob();
    return false;
  }
  /* Skip a URL whose collection this run already scanned.

     A list picks up near-duplicates over time — the same category added twice
     from different entry points, or two addresses that resolve to one page
     (Zara's ?v1=… among them). Walking both costs a full scan and puts the
     same products through the run twice. The signature is what the engine
     already uses to decide "is this the same collection", so it is the honest
     test here too. */
  q.doneSigs = [].concat(q.doneSigs || []);
  const sigNow = collectionSig(location.href);
  if (sigNow && !q.doneSigs.includes(sigNow)) q.doneSigs.push(sigNow);
  q.skipped = q.skipped || 0;
  while (q.idx < q.list.length) {
    const cand = q.list[q.idx];
    const sig = cand && cand.url ? collectionSig(cand.url) : "";
    if (!sig || !q.doneSigs.includes(sig)) break;
    q.skipped++; q.idx += 1;
  }
  if (q.idx >= q.list.length) {
    q.active = false; q.finishedAt = Date.now();
    await setQueue(q);
    await queueExport(q);
    await queueHealthExport(q);
    await closeJob();
    return false;
  }
  await setQueue(q);
  await closeJob();
  const next = q.list[q.idx];
  /* Long enough for the caller's reply to leave before the page is torn down.
     It was 1500ms, which is a second of nothing per URL — twenty seconds
     across the team's list — and the ack does not need that long. */
  setTimeout(() => { try {
    // A fragment-only step (Gap: next category differs only after the #) never
    // fires a page load on href assignment, so nothing would restart the scan
    // and the queue would stall here — force the reload.
    const here = location.href.split("#")[0];
    location.href = next.url;
    if (String(next.url).split("#")[0] === here) location.reload();
  } catch (e) {} }, 400);
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
    /* The control that hands out the next tray of products.
       Matched on its own words and nothing else — a closed list, because the
       one thing worse than not finding it is pressing something else on a
       shop's page. "Add to bag", "Sign up", "Apply filters" and every other
       button on a listing page say none of these.
       It has to be visible and it has to be small: a whole section that
       happens to contain the phrase is not the button. */
    // eslint-disable-next-line no-inner-declarations
    function findLoadMore() {
      const WORDS = /^(load|show|view|see)\s+(\d+\s+)?more(\s+(products?|items?|styles?|results?))?$|^more(\s+(products?|items?))?$|^더\s?보기$|^더\s?많은\s?상품$/i;
      const cands = document.querySelectorAll(
        'button, a[role="button"], [role="button"], input[type="button"], input[type="submit"]');
      for (const el of cands) {
        if (el.disabled || el.getAttribute("aria-disabled") === "true") continue;
        const t = (el.innerText || el.value || el.getAttribute("aria-label") || "")
          .replace(/\s+/g, " ").trim();
        if (!t || t.length > 40 || !WORDS.test(t)) continue;
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;                  // not on the page
        if (getComputedStyle(el).visibility === "hidden") continue;
        return el;
      }
      return null;
    }
    // load time just the first viewport-full exists (e.g. 14 of 24/97). Scroll
    // to the bottom repeatedly until the tile count AND page height stop
    // growing, THEN scrape — no selectors involved, the site renders itself.
    if (a.lazyScroll) {
      // adapter may set a number = max scroll rounds (infinite-scroll sites like
      // Zara hold whole categories on one page and need more than Target's 20)
      const rounds = typeof a.lazyScroll === "number" ? a.lazyScroll : 20;
      const MORE_PRESSES = 8;
      let lastN = -1, lastH = -1, stable = 0;
      /* A grid that is already fully rendered still has to prove it is, so it
         pays the stability rounds every time — three of them, and at 700ms
         that was two seconds per URL doing nothing. The rule is unchanged
         (count and height both steady twice); only the wait between looks is
         shorter, which costs a lazy grid nothing because it is bounded by the
         same stability test rather than by the clock. */
      let grew = false, capped = false, sweeps = 0;
      /* What the shop says it is showing. Most listing pages print it ("48
         items"), and it is the only honest way to know that a lazy grid
         stopped early — nothing else on the page distinguishes "that is all of
         them" from "the trigger went past us". */
      let said = 0;
      try { said = (a.resultCount && a.resultCount(document)) || 0; } catch (e) {}
      /* Nothing has rendered YET is not the same as nothing is there.
         adidas and nike paint their grids from JavaScript after the document
         is ready, and the stability test could not tell the difference: zero
         equals zero equals zero, so two looks — under a second and a half —
         and the scan reported an empty page with no grid on it. The band then
         said the shop had sent nothing, which was our clock talking.
         A grid that really is absent pays this wait once, at the end of a
         scan that was going to fail anyway. */
      const ZERO_GRACE = 9000;
      const startedAt = Date.now();
      /* Some grids hand out the rest on a press rather than on a scroll, and
         nothing here had ever pressed anything. */
      /* A press that WORKED is not spending the budget.

         Eight presses was a fixed allowance, so a grid that opens ten at a
         time stopped at eighty however much it had left, and one that opens
         five stopped at forty. The allowance is there to stop us hammering a
         button that does nothing — so it is only spent when a press changes
         nothing. Growth is progress and gets refunded, and the run is still
         ended by the 60 cap, by the round budget, and by a hard ceiling. */
      let pressed = 0, presses = 0, lastPressN = -1;
      const MORE_PRESSES_HARD = 40;
      /* Rounds are a budget for LOOKING, and a press that works is not
         looking. Each productive press hands back the rounds its cycle spent
         proving the grid had stalled — otherwise a grid that opens four at a
         time runs out of rounds at 46 of 58, which is the same half scan by a
         different route. Everything that ends the loop still ends it: the 60
         cap, the hard press ceiling, and this bonus's own ceiling. */
      let bonus = 0;
      const BONUS_MAX = 60;
      let i = 0;
      for (; i < rounds + bonus && stable < 2; i++) {
        /* Step down a screen at a time rather than jumping to the bottom.
           A grid loads more when its sentinel enters the viewport, and jumping
           straight to the end of the document skips past that sentinel
           whenever anything tall sits below the grid — a long footer is
           enough. Measured (harden-probe): a 48-tile grid gave up 16 and the
           scan called itself complete. Stepping walks the sentinel through the
           viewport; the last step still lands on the bottom, for the grids
           that listen there. */
        const y = window.scrollY, bottom = document.body.scrollHeight;
        const next = Math.min(y + Math.round(window.innerHeight * 0.9), bottom);
        window.scrollTo(0, next <= y ? bottom : next);
        await sleep(450);
        const live = await g();
        if (!live || !live.active || live.paused) return;   // honor pause/stop mid-scroll
        let n = 0; try { n = (a.scrapeList(document, location.href) || []).length; } catch (e) {}
        // An adapter that reads nothing here must not also stop the unrolling:
        // at zero the count would be "stable" immediately and a lazy grid would
        // never open, leaving the rescue below one viewport of tiles to work with.
        if (!n && a.id !== "generic") n = genericRead(document, location.href).length;
        const h = document.body.scrollHeight;
        // the press on the previous look: refund it if the grid answered
        if (lastPressN >= 0) {
          if (n > lastPressN) { pressed = Math.max(0, pressed - 1); bonus = Math.min(BONUS_MAX, bonus + 3); }
          lastPressN = -1;
        }
        if (n === lastN && h === lastH) stable++; else { stable = 0; if (lastN >= 0 && n > lastN) grew = true; }
        lastN = n; lastH = h;
        /* Still nothing, and there is time left: keep looking instead of
           calling the page empty. The round budget is not spent on waiting —
           an app that takes four seconds to paint would otherwise use up every
           round before its first tile exists. */
        if (!n && Date.now() - startedAt < ZERO_GRACE) {
          stable = 0; i--;
          await report(`Waiting for the grid… ${Math.round((Date.now() - startedAt) / 1000)}s`);
          continue;
        }
        /* Scrolling only downward can pass a trigger for good: a grid that
           hands out more when a marker enters the viewport gets one chance at
           it, and if anything tall sits below the grid — a long footer is
           enough — the marker ends up behind us for the rest of the scan.
           Measured: 16 tiles of 48, graded complete. So a grid that HAS grown
           and then stalls gets one more sweep from the top. A grid that never
           grew is fully rendered and pays nothing for this. */
        const short = said && n < said && (!j.maxItems || n < j.maxItems);
        /* Sweep again while the page still says it is holding more. Bounded
           by the round budget and by our own 60 cap, so a shop that claims
           thousands cannot turn this into an endless crawl. */
        /* Some grids do not listen to the scroll at all — they hand out the
           next tray when a button is pressed. Nothing here had ever pressed
           one, so those shops came back with whatever the first screen held:
           4 of the 66 the page said it was showing, 40 of 269. Scrolling can
           never fix that, however many sweeps it takes.

           Only while we are short of the shop's own count, and only a bounded
           number of times, so this cannot become a crawl. */
        /* …and press it even when the shop never said how many it has.

           Gating this on the count made the rescue depend on the page printing
           "66 items" somewhere, and plenty of themes print no such number at
           all — Set Active's and Athleta's among them. On those the grid went
           stable at the first screenful, there was nothing to be short OF, and
           a button sitting right there saying "View More" was never pressed.
           Four of sixty-six, eight of a whole New Arrivals page.

           Pressing without a count is safe on its own terms: the vocabulary is
           closed, so nothing else on the page gets clicked; the press count is
           bounded; the 60 cap still ends it; and if a press yields nothing the
           grid goes stable again and the loop finishes. What the count is for
           is the opposite duty — knowing when to STOP, which is why a shop
           that did state its number and has been fully read presses nothing. */
        const mayPress = said ? short : true;
        if (stable >= 2 && mayPress && pressed < MORE_PRESSES && presses < MORE_PRESSES_HARD) {
          const btn = findLoadMore();
          if (btn) {
            /* A press is progress, not a probe, so it does not spend a round.
               A grid that opens twelve at a time would otherwise run out of
               budget long before it ran out of products. */
            pressed++; presses++; lastPressN = n; stable = 0; grew = true; i--;
            btn.click();
            await report(`Loading all items… ${n} rendered, asked for more`);
            await sleep(1200);
            continue;
          }
        }
        if (stable >= 2 && (grew || short) && sweeps < 4) {
          sweeps++; stable = 0;
          window.scrollTo(0, 0);
          await sleep(250);
        }
        // Enough for one research pass — stop unrolling. On an infinite-scroll
        // grid there is no page 2 to stop at, so the cap IS "the first page":
        // without it a single Zara category unrolls into several hundred rows
        // and buries the list the user actually assembled.
        if (j.maxItems && n >= j.maxItems) {
          capped = true;
          await report(`Loaded ${n} (cap ${j.maxItems})`);
          break;
        }
        await report(`Loading all items… ${n} rendered`);
      }
      /* We ran out of rounds while the grid was still handing out tiles. That
         is a HALF scan, and half a scan that calls itself finished is the
         worst thing this tool can do: the spreadsheet looks whole. The cap is
         a deliberate stop (60 is one research pass); running out of rounds is
         not. */
      /* …unless the shop's own count says we have it all. Running out of
         rounds on the last look of a grid that handed over every one of the
         40 it advertised is not a half scan, and reporting it as one puts a
         mark on a shop that behaved perfectly — the same crying-wolf that
         made the drop-name warning worthless. */
      const gotItAll = said && lastN >= said;
      if (!capped && !gotItAll && stable < 2 && grew && i >= rounds + bonus) j.moreWaiting = true;
      /* Still fewer than the shop said it was showing, and not because of our
         own cap: the grid kept the rest. Said on the page, with both numbers,
         because a half grid that grades itself complete is the one failure
         that looks exactly like success. */
      if (said && lastN < said && (!j.maxItems || lastN < j.maxItems))
        j.shortOf = { said, got: lastN };
      /* And when the shop states no count at all, say what we could still see
         when we stopped. A "Load more" still sitting on the page, or a link to
         the next page, is the page telling us it was holding something back —
         and without this the run has no way to distinguish "that was all of
         them" from "we ran out of budget", so it grades itself clean either
         way. Named here so the next round is not another guess. */
      if (!capped && !said && (!j.maxItems || lastN < j.maxItems)) {
        let leftover = "";
        try { if (findLoadMore()) leftover = "a Load more button"; } catch (e) {}
        if (!leftover) {
          try {
            const nx = document.querySelector('link[rel="next"], a[rel="next"], .pagination a[href*="page="]');
            if (nx) leftover = "a link to the next page";
          } catch (e) {}
        }
        if (leftover) j.stoppedWith = { got: lastN, leftover };
      }
      window.scrollTo(0, 0);
    }
    let scraped = [];
    try { scraped = a.scrapeList(document, location.href) || []; }
    catch (e) { scraped = []; await report(`Page ${page} parse error (skipped): ${e && e.message || e}`); }
    /* The adapter routed to this shop found nothing. Before accepting that,
       read the page structurally — if it really is a grid of products, those
       are the products, whatever our rule about this shop's addresses says.
       (Aritzia: the grid was there all along and a "/product/" rule dropped
       every tile, which produced a run with no spreadsheet at all.) */
    if (!scraped.length && a.id !== "generic") {
      const raw = genericRead(document, location.href);
      if (plausibleGrid(raw)) {
        scraped = raw;
        const shape = pathShape(raw.map(r => r.product_url));
        j.repair = { adapter: a.id, tiles: raw.length, via: "generic", pattern: shape };
        await learnProfile(hostOf(location.href), {
          adapter: a.id, via: "generic", pattern: shape, tiles: raw.length,
          note: `${a.id} adapter reads nothing here; products look like ${shape}`,
        });
        await report(`The ${a.id} reader found nothing — recovered ${raw.length} products from the page itself`);
      }
    }
    /* The grid is not always the whole collection, and it does not always say
       so. Where the shop publishes its own list of what this address holds,
       ask it — the rendered tiles keep their order at the front and whatever
       never rendered follows. The adapter decides whether that is honest for
       this address; it refuses whenever a filter is on it. */
    if (a.completeList) {
      try {
        const before = scraped.length;
        const full = await a.completeList(scraped, location.href, j.maxItems || 0);
        if (Array.isArray(full) && full.length > before) {
          j.topped = { grid: before, all: full.length };
          scraped = full;
          await report(`The grid rendered ${before} — the shop lists ${full.length} in this collection`);
        }
      } catch (e) { /* the shop disabled it: the grid stands as scraped */ }
    }

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
    /* Measured on a three-shop run of 60 products each: the detail step was
       7.8 of the 10.7 seconds a shop took, and almost all of that was waiting
       for a response rather than doing anything. Four lanes left the tab idle.
       Eight is still fewer simultaneous requests than a browser opens for one
       page of a shop (six per host plus preconnects), and it roughly halves
       the phase that dominates the run. */
    const LANES = 8;
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
            // the shop's own garment type, kept even when the page's own name
            // wins the category column
            if (d.product_type && !it.product_type) it.product_type = d.product_type;
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
        try {
          applyDetail(it, await readDetail(a, it.product_url, j.repair,
            { image: !!String(it.image_url || "").trim() }));
        }
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
    /* A list run does NOT need a spreadsheet here.

       The list produces ONE file when the last URL finishes, so the workbook
       built at this point was thrown away — after fetching every thumbnail in
       the shop to embed in it. Fourteen shops meant fourteen wasted workbooks
       and every photo downloaded twice: once into a file nobody keeps, once
       into the real one at the end.

       What the code below actually uses from it is `kept` — the rows that
       survive the export filters — and the drop summary. Those come from
       filterKept alone, with no ExcelJS and no network at all. */
    const queue0 = await getQueue();
    const listRun = !!(queue0 && queue0.active && j.queued);
    await report(listRun ? "Saving to the catalog…" : "Building Excel… (embedding thumbnails)");
    // if composition was never collected, mark the cause so the cell can explain it
    if (!j.withSpec) j.items.forEach(it => { if (!it.fabric_composition && !it._compReason) it._compReason = "not_collected"; });
    try {
      const ctx = {
        ExcelJS: self.ExcelJS,
        fetchImage: fetchImageViaBg,
        filters: j.filters || {},
        onProgress: (i, total) => report(`Building Excel… images ${i}/${total}`),
      };
      const built = listRun
        ? (() => { const f = self.WPBExcel.filterKept(j.items, ctx.filters);
                   return { bytes: null, kept: { Products: f.kept }, dropped: f.dropped }; })()
        : await a.buildWorkbook(j.items, ctx);
      const { bytes, kept, dropped } = built;
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
      const queue = listRun ? queue0 : await getQueue();
      const inList = listRun || !!(queue && queue.active && j.queued);
      if (inList) {
        /* The list entry's own naming, which the user typed on the Grab card.

           Brand: on a MULTI-BRAND retailer (Walmart, Target) each row states
           its own maker, so the row wins and the entry only fills blanks. On
           a single shop it is the other way round — one storefront is one
           brand, and whatever the shop wrote per product is not it.

           Set Active is why. It sells its own label, but files each product
           under the drop it belongs to — "JUL 2026 - GONE BANANAS",
           "AUG 2026 - CORE" — in Shopify's free-text vendor field. Reading
           that as the brand split one shop into a season calendar: the LAB
           showed drops as brands, and every number underneath them was a
           number about nothing. The existing guard only caught vendors shaped
           like style codes; a drop name reads like an ordinary name, so shape
           cannot decide it. What decides it is that the shop has one brand.

           Category, though, is the user's to name and theirs WINS. A shop only
           knows the collection it served — Alo's faceted new-arrivals URL is
           "/collections/new-arrivals" whether the facet is Tanks or Hoodies —
           so deriving it from the address files four different research
           questions under one heading, and the Excel groups by exactly this.
           The address is the shop's answer; the label is the designer's, and
           they were the one looking at the page. */
        const ent = queue.list[queue.idx] || {};
        const keptRows = [].concat.apply([], Object.values(kept || {}));
        const manyBrands = !!(a && a.multiBrand);
        keptRows.forEach(r => {
          if (ent.brand && !manyBrands) r.brand = ent.brand;
          else if (!r.brand && ent.brand) r.brand = ent.brand;
          if (ent.label) r.category = ent.label;
          else if (!r.category) r.category = "";
        });
        /* The rows go to the extension's database, not into the run record.
           Measured: the team's 456-entry list at 60 products each is 13.7 MB of
           run record, and chrome.storage.local refuses anything over 10 MB —
           the write fails and the whole run's spreadsheet is lost. The record
           now carries only the count. */
        await runRows("append", queue.runId, keptRows);
        queue.rowCount = (queue.rowCount || 0) + keptRows.length;
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
      /* Optional: try the detail path on ONE product. The fabric column is the
         reason this tool exists, and it comes from the product page rather
         than the grid — so a list check that only reads the grid cannot
         predict it. One fetch, nothing stored, and only when asked for. */
      let detail = null;
      if (m.detail && rows[0] && typeof a.fetchDetail === "function") {
        try {
          const d = await a.fetchDetail(rows[0].product_url);
          detail = {
            url: String(rows[0].product_url || "").slice(0, 120),
            composition: String((d && d.composition) || "").slice(0, 80),
            colorways: String((d && d.colorways) || "").slice(0, 60),
            reason: (d && d.reason) || "",
          };
        } catch (e) { detail = { error: String((e && e.message) || e).slice(0, 80) }; }
      } else if (m.detail) {
        detail = { skipped: rows.length ? "adapter has no detail phase" : "no products to test" };
      }
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
        detail,
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
      const runId = "r" + Date.now() + "-" + Math.floor(Math.random() * 1e6);
      await runRows("clear", "");                       // no rows from an abandoned run
      await setQueue({ active: true, runId, rowCount: 0, tabId, listId: m.listId || "", name: m.name || "",
        // rows themselves live in IndexedDB (runrows) — the queue record holds
        // only the count, because 10 MB of chrome.storage.local cannot hold a
        // team-sized run and losing it loses the whole spreadsheet
        list: m.list, idx: 0,
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
      if (q && (q.rowCount || 0)) await queueExport(q);
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

  /* A run that has walked its whole list still has to be finished — the
     spreadsheet is written from a page, because that is where ExcelJS lives.
     The stall watchdog can push the index past the end without a page to do
     it, so if we land here already past the end, close the run properly
     rather than leaving it "active" with nothing driving it. */
  if (q.idx >= q.list.length) { queueAdvance(); return; }

  const cur = q.list[q.idx];
  if (!cur) return;
  if (!sameCollection(cur.url, location.href)) {
    /* The shop sent us somewhere else.

       This line used to be a bare `return`, and that is how a run stopped
       dead: the queue stayed active, the index never moved, no error was
       written, and the panel went on showing a scan in progress. Anything
       that changes the address on the way in does it — a locale or region
       redirect, a consent interstitial, a canonical rewrite.

       On the SAME shop it is still the shop's own answer for that address, so
       scan where we were sent and record the redirect; a category page reached
       by redirect is the page the designer asked for. A different host is not
       ours to interpret, so it is left to the watchdog to report and step over.
       Either way, nothing waits forever. */
    if (hostOf(location.href) && hostOf(location.href) === hostOf(cur.url) && adapter()) {
      noteRedirect(cur.url, location.href);
    } else {
      return;
    }
  }
  if (!adapter()) return;                       // unsupported page — leave it alone
  startJob({ withSpec: q.withSpec !== false, filters: q.filters || {}, queued: true,
    maxItems: q.maxItems });
})();
