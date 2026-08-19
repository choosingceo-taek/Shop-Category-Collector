/* Catalog storage — the accumulating product database behind the
   collect → catalog → project → report flow.

   IndexedDB, not chrome.storage.local: a designer builds this up over a season
   and it runs to thousands of products, well past storage.local's ~10MB cap
   (which also re-serialises the whole blob on every write). IndexedDB lives in
   the extension origin, so the service worker and every extension page
   (side panel, catalog tab) share ONE database — a scan writes and the catalog
   tab sees it, with no file passing and no server.

   Stores
     products  key = stable product identity (see productKey)
               indexes: brand, category, source, addedAt
     scans     one row per scan run (provenance for the rows it produced)
     projects  {id, name, createdAt, keys: [productKey]} — the report's input unit
     snapshots one row per WEEK: how many products were newly seen and how often
               each keyword/fibre/colour/brand/category appeared (see
               report/trend.js weeklySnapshots). Products are live data — a
               re-scan rewrites them and a cleanup deletes them — so the weekly
               numbers are frozen separately. A few KB a week keeps a multi-year
               trend readable from ~100 rows instead of ~100,000 products.

   Everything here is plain data access. Aggregation lives in report/report.js,
   so both stay independently testable. */
(function (root) {
  "use strict";
  const DB = "shopcat", VER = 4;
  let _db = null;

  /* Opening has to survive an older connection still being alive.

     The database version goes up when a release adds a store. If a page opens
     the new version while another context — typically the service worker,
     which is still running the code from before the reload — holds the old
     one, IndexedDB BLOCKS the upgrade and open() simply never settles. The LAB
     then sits on "Loading…" forever with nothing in the console, which is
     exactly what "I can't get into the LAB" looks like.

     Two guards. Every connection agrees to step aside when a newer version
     arrives (onversionchange → close), so the upgrade proceeds by itself. And
     if something still holds on, the wait ends with an error that names the
     remedy instead of hanging. */
  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((res, rej) => {
      const req = indexedDB.open(DB, VER);
      req.onblocked = () => rej(new Error(
        "The catalog is held open by an older version of the extension. " +
        "Reload Market Lens on chrome://extensions (↻) and open the LAB again."));
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains("products")) {
          const p = db.createObjectStore("products", { keyPath: "key" });
          p.createIndex("brand", "brand", { unique: false });
          p.createIndex("category", "category", { unique: false });
          p.createIndex("source", "source", { unique: false });
          p.createIndex("addedAt", "addedAt", { unique: false });
        }
        if (!db.objectStoreNames.contains("scans")) db.createObjectStore("scans", { keyPath: "id" });
        if (!db.objectStoreNames.contains("projects")) db.createObjectStore("projects", { keyPath: "id" });
        if (!db.objectStoreNames.contains("snapshots")) {
          const s = db.createObjectStore("snapshots", { keyPath: "id" });   // "2026-W32"
          s.createIndex("start", "start", { unique: false });
        }
        /* The rows a list run has collected so far.

           They used to live in the run record in chrome.storage.local, which
           holds 10 MB — measured: the team's 456-entry list at 60 products
           each is 13.7 MB, and the write fails outright ("kQuotaBytes quota
           exceeded"), losing the whole run's spreadsheet. It was also rewritten
           in full after every URL, so a long list serialised gigabytes on its
           way through. Here it is appended in chunks and read once at the end. */
        if (!db.objectStoreNames.contains("runrows")) {
          const r = db.createObjectStore("runrows", { keyPath: "id", autoIncrement: true });
          r.createIndex("runId", "runId", { unique: false });
        }
        /* Search interest, imported by hand from Google Trends.

           There is no public Trends API, the internal endpoints refuse a
           machine that asks for thirty words a week, and — the part that
           decides it — a rank cannot be collected retroactively: switching it
           on tomorrow tells you nothing about last month. A CSV export is
           accurate, allowed, and dated, so that is the road. One row per term
           per week; a term with no row simply has no line, and never a zero.  */
        if (!db.objectStoreNames.contains("trends")) {
          const t = db.createObjectStore("trends", { keyPath: "key" });   // "satin dress|2026-W32"
          t.createIndex("term", "term", { unique: false });
        }
      };
      req.onsuccess = () => {
        _db = req.result;
        // let the next version in rather than blocking it
        _db.onversionchange = () => { try { _db.close(); } catch (e) {} _db = null; };
        res(_db);
      };
      req.onerror = () => rej(req.error);
    });
  }
  const req2p = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

  // Stable identity for a product across re-scans. The product URL is the real
  // identity; strip the query so a colour/variant parameter doesn't fork one
  // product into many rows. Falls back to brand+name when there's no URL.
  function productKey(it) {
    const u = it && it.product_url;
    if (u) {
      try {
        const x = new URL(u);
        // keep params that ARE the product id — Inditex's pelement, the Gap
        // family's pid (product.do?pid=…) — and drop tracking noise. Without
        // pid every Gap product shares one path and the whole scan collapses
        // into a single catalog row.
        const keep = ["pelement", "pid"]
          .map(k => { const v = x.searchParams.get(k); return v ? k + "=" + v : ""; })
          .filter(Boolean).join("&");
        return (x.origin + x.pathname).replace(/\/$/, "").toLowerCase() + (keep ? "?" + keep : "");
      } catch (e) { return String(u).toLowerCase(); }
    }
    return ((it && it.brand) || "") .toLowerCase() + "|" + ((it && it.name) || "").toLowerCase();
  }

  /* Collapse the same product appearing twice.

     Re-scanning a category weekly does NOT duplicate anything — the product URL
     is the key, so week two updates week one's row and keeps its addedAt. What
     does slip through is one garment reachable at two URLs: a locale prefix, a
     colour-specific slug, or the same style listed in two categories the shop
     routes differently.

     So this is a second, conservative pass on brand + name. Both must be
     non-empty and match exactly after normalising case and spacing — a name
     alone is not enough (two shops both sell a "LINEN SHIRT"). The survivor
     keeps the EARLIEST addedAt, because first-seen is what the weekly trend
     buckets on and the later sighting is not a new arrival. Field values are
     filled in from the loser only where the survivor is blank, so merging never
     loses a composition or an image.

     Returns { rows, merged } — merged is reported in the UI rather than being
     silently applied, since a number that quietly shrinks is exactly what makes
     a team stop trusting the tool. */
  function dedupe(items) {
    const norm = s => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
    const out = [], byName = new Map();
    let merged = 0;
    (items || []).forEach(it => {
      if (!it) return;
      const b = norm(it.brand), n = norm(it.name);
      const k = (b && n) ? b + "|" + n : "";
      if (!k) { out.push(it); return; }
      const prev = byName.get(k);
      if (prev == null) { byName.set(k, out.length); out.push(it); return; }
      merged++;
      const keep = out[prev];
      Object.keys(it).forEach(f => {
        const v = it[f];
        if (v === "" || v == null) return;
        if (keep[f] === "" || keep[f] == null) keep[f] = v;      // fill gaps only
      });
      keep.addedAt = Math.min(keep.addedAt || Infinity, it.addedAt || Infinity);
      keep.listIds = [...new Set([].concat(keep.listIds || [], it.listIds || []))];
      keep.dupCount = (keep.dupCount || 1) + 1;
    });
    return { rows: out, merged };
  }

  /* A thumbnail value that is not actually a photo.

     Lazy-loading grids hand out 1x1 transparent GIFs (as data: URIs) and
     spacer files while the real photo waits for a scroll event. Rows scanned
     before the srcset fix stored those placeholders VERBATIM — and because the
     field then reads as "already filled", neither a re-scan nor the PDP image
     fallback would replace it. The card renders a black box instead of saying
     NO IMAGE, which is worse than empty: it looks broken instead of honest.

     So placeholders are treated as empty everywhere: cleaned before a row is
     stored, and cleaned again when rows are read (which repairs the rows the
     old scans already poisoned, without a migration). */
  // filename CONTAINING a token, not exactly equal to it — Zara's placeholder
  // is "transparent-background.png", a real https URL that an exact-name match
  // let straight through into every stored row. Sync with sites.js PLACEHOLDER.
  const IMG_PLACEHOLDER = /^data:|\/[^/?#]*(?:blank|placeholder|spacer|transparent|1x1|pixel|noimage|no-image|dummy)[^/?#]*\.(?:gif|png|svg|jpe?g|webp)(?:[?#]|$)/i;
  /* Only an http(s) address survives, because everything downstream — the LAB
     card, the report, the thumbnail embedded in the Excel — loads it from an
     extension page, where a relative address resolves against the extension
     rather than the shop and simply fails.

     But "not absolute" is not the same as "not a picture". Shopify themes
     write their images protocol-relative (//edikted.co.uk/cdn/shop/files/x.jpg)
     — a perfectly good address that this rule threw away, which is why a whole
     Edikted scan produced 64 rows with names, prices and publish dates and NO
     IMAGE on every one of them. A missing scheme is repaired, not punished;
     anything still not http(s) after that is genuinely unusable. */
  /* Cleaned on write AND on read, so rows an older scan poisoned are repaired
     the next time the LAB opens — no migration, no re-scan.

     The path check is the one that matters. srcset used to be split on
     commas, and image addresses contain them (Adobe Scene7's
     ?op_usm=0.5,2,10,0, Cloudinary's c_fill,w_600,h_800), so a candidate
     shattered and a fragment like "0&fmt=webp" was stored as a product photo.
     Resolved against the shop it even became a plausible https:// address, so
     the row counted as HAVING a picture and the scan graded the page healthy
     — which is why four shops showed IMAGE BLOCKED for three releases while
     every check said they were fine. An address has a path; a fragment does
     not. A row with nothing usable is honestly empty, and an empty one is
     what the photo-coverage check is watching for. */
  function cleanImage(u) {
    let s = String(u || "").trim();
    if (s.slice(0, 2) === "//") s = "https:" + s;
    if (!s || IMG_PLACEHOLDER.test(s) || !/^https?:/i.test(s)) return "";
    try {
      const p = new URL(s).pathname;
      if (!p || p === "/") return "";
    } catch (e) { return ""; }
    return s;
  }

  /* A brand value that is not actually a brand.

     Brand is the grouping key in Excel, in the LAB and in every report, so a
     wrong one does not just look untidy — it splits one shop into dozens of
     one-product "brands" and the trend numbers underneath become meaningless.
     Three things have been stored in that field that are not brands:

       a style code   Shopify's `vendor` is free text and Edikted fills it
                      with S23548_NAVY-AND-WHITE, unique per product
       a hostname     shop.lululemon.com, gap.com — an early fallback
       a platform     "Shopify store", "Generic site (basic info only)"

     Each is recognisable by shape rather than by a list of known bad values,
     so shops nobody has looked at are covered too. The replacement is the
     shop's own domain — a fact, and the same name the list entry carries.

     Cleaned on write AND on read, the way placeholder images are: the rows
     that older scans already poisoned are repaired the next time the LAB
     opens, with no migration to run and no re-scan to sit through. */
  const STYLE_CODE = /^(?=.*\d)[A-Za-z0-9]+[_-][A-Za-z0-9_-]*$/;   // S23548_NAVY-AND-WHITE
  const HOSTNAME = /^(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}$/i; // shop.lululemon.com
  function hostBrand(url) {
    const api = self.ScanLists;
    let host = "";
    try { host = new URL(String(url || "")).hostname; } catch (e) { host = ""; }
    if (!host) return "";
    return api && api.brandFromHost ? api.brandFromHost(host) : host.replace(/^www\./, "");
  }
  function cleanBrand(brand, url) {
    const b = String(brand == null ? "" : brand).trim();
    if (!b) return "";
    const api = self.ScanLists;
    const isPlatform = api && api.PLATFORM_LABEL ? api.PLATFORM_LABEL.test(b)
      : /^(shopify store|generic site.*)$/i.test(b);
    if (isPlatform) return hostBrand(url) || "";
    if (HOSTNAME.test(b)) {
      return (api && api.brandFromHost ? api.brandFromHost(b.replace(/^https?:\/\//, "")) : b) || b;
    }
    // A style code has no spaces, carries a digit and a separator. Real brand
    // names with digits ("Rag & Bone", "3.1 Phillip Lim", "Ninety Percent")
    // all contain a space, so they never match.
    if (!/\s/.test(b) && STYLE_CODE.test(b)) return hostBrand(url) || "";
    return b;
  }

  /* The category column has the same problem, and it is the other key the
     Excel and the LAB group by.

     Shops hang an id on the end of a category address — lululemon's
     /n14f1wz6o10, nike's -3n82yz5e1x6z9om13 — and it reached the column
     through the list entry's label. A key in there splits one page into as
     many groups as it has ids, exactly as a style code did to brands.

     Repaired on write and on read, so rows collected before this stop being
     their own group the next time the LAB opens — no migration, no re-scan.
     What is left when the id goes is kept; when nothing is left, the column is
     empty, which is honest and which the designer's own label overrides. */
  function cleanCategory(cat) {
    const c = String(cat == null ? "" : cat).trim();
    if (!c) return "";
    const api = self.ScanLists;
    if (!api || !api.stripCodes) return c;
    return api.stripCodes(c) || "";
  }

  // Merge an incoming row over the stored one. A re-scan should refresh prices
  // and fill gaps WITHOUT wiping a field the new scan happened to miss —
  // otherwise a partial run degrades good data already in the catalog.
  function merge(oldRec, incoming, meta) {
    const out = Object.assign({}, oldRec || {}, {});
    // a stored placeholder counts as a gap, so a real photo can land in it
    if (out.image_url) out.image_url = cleanImage(out.image_url);
    // a style-code "brand" counts as a gap too, so a real one can land in it
    if (out.brand) out.brand = cleanBrand(out.brand, out.product_url || out.url);
    if (out.category) out.category = cleanCategory(out.category);
    Object.keys(incoming).forEach(k => {
      let v = incoming[k];
      if (k === "image_url") v = cleanImage(v);
      if (k === "brand") v = cleanBrand(v, incoming.product_url || incoming.url || out.product_url);
      if (k === "category") v = cleanCategory(v);
      if (v === "" || v == null) return;             // never overwrite with blank
      out[k] = v;
    });
    out.key = productKey(incoming);
    out.source = (meta && meta.source) || out.source || "";
    out.site = (meta && meta.site) || out.site || "";
    out.scanId = (meta && meta.scanId) || out.scanId || "";
    // Which saved list(s) produced this row. A product can legitimately belong
    // to several (two lists may watch the same category), so this is a union
    // rather than a last-writer-wins field — that is what lets "export this
    // list's results" mean exactly the products that list collected.
    /* A row can also ARRIVE with list membership of its own — that is what an
       imported catalog carries — so the union takes both sides. Losing the
       stored side would quietly un-file a product from the list that collected
       it, and "show me this list's results" would come back short. */
    const ids = new Set([].concat(oldRec && oldRec.listIds || [], incoming && incoming.listIds || []));
    if (meta && meta.listId) { ids.add(meta.listId); out.listName = meta.listName || out.listName || ""; }
    if (ids.size) out.listIds = [...ids];
    /* …and which listing page(s) it was seen on. A union for the same reason:
       two saved addresses can show the same garment (a shop's New In and its
       Tops), and taking one of them out of a list must not remove a product
       the other one still collects. */
    const pages = new Set([].concat(oldRec && oldRec.pages || [], incoming && incoming.pages || []));
    if (meta && meta.pageSig) pages.add(meta.pageSig);
    if (pages.size) out.pages = [...pages];
    out.addedAt = (oldRec && oldRec.addedAt) || Date.now();
    out.updatedAt = Date.now();
    out.seenCount = ((oldRec && oldRec.seenCount) || 0) + 1;
    return out;
  }

  // Upsert a scan's rows. Returns {added, updated}.
  async function putScan(scan) {
    const meta = (scan && scan.meta) || {};
    const items = (scan && scan.items) || [];
    const scanId = meta.scanId || ("s" + Date.now());
    const db = await open();
    let added = 0, updated = 0;
    await new Promise((res, rej) => {
      const t = db.transaction(["products", "scans"], "readwrite");
      const P = t.objectStore("products");
      t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
      items.forEach(it => {
        const key = productKey(it);
        if (!key) return;
        const g = P.get(key);
        g.onsuccess = () => {
          const prev = g.result;
          if (prev) updated++; else added++;
          P.put(merge(prev, it, Object.assign({ scanId }, meta)));
        };
      });
      t.objectStore("scans").put({
        id: scanId, site: meta.site || "", source: meta.source || "",
        brand: meta.brand || "", category: meta.category || "", url: meta.url || "",
        scannedAt: meta.scannedAt || new Date().toISOString(), count: items.length,
      });
    });
    return { added, updated, scanId };
  }

  const all = store => open().then(db =>
    req2p(db.transaction(store, "readonly").objectStore(store).getAll()));

  /* Every reader of the catalog — LAB, the new-in feed, the brand rail, the
     report, "export this list" — comes through here, so repairing on read is
     what makes the fix retroactive: rows collected before the vendor rule
     existed stop showing up as their own one-product brands. */
  const allProducts = () => all("products").then(rows => {
    (rows || []).forEach(r => {
      if (!r) return;
      const fixed = cleanBrand(r.brand, r.product_url || r.url);
      if (fixed !== r.brand) r.brand = fixed;
      const cat = cleanCategory(r.category);
      if (cat !== r.category) r.category = cat;
    });
    return rows;
  });
  /* A handful of products by key, rather than the whole table.

     This is what a re-scan asks before it opens sixty product pages: which of
     these have we already read? Point lookups, so a catalog of thirty thousand
     costs the same as one of thirty — reading everything to answer a question
     about sixty rows would give back the time the skip is meant to save. */
  async function getMany(keys) {
    const list = (keys || []).filter(Boolean);
    if (!list.length) return {};
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction("products", "readonly");
      const P = t.objectStore("products");
      const out = {};
      list.forEach(k => {
        const r = P.get(k);
        r.onsuccess = () => { if (r.result) out[k] = r.result; };
      });
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  }

  const allScans = () => all("scans");
  const allProjects = () => all("projects");
  const allSnapshots = () => all("snapshots").then(r => r.sort((a, b) => a.start - b.start));

  /* ---- search interest ----------------------------------------------------
     Rows imported from a Google Trends CSV: one term, one week, one number,
     plus the file it came from so a re-import replaces rather than doubles. */
  const allTrends = () => all("trends").then(r => r.sort((a, b) => (a.week < b.week ? -1 : 1)));
  async function putTrends(rows) {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction("trends", "readwrite"), st = t.objectStore("trends");
      (rows || []).forEach(r => {
        if (!r || !r.term || !r.week) return;
        st.put({ key: `${String(r.term).toLowerCase()}|${r.week}`,
          term: String(r.term), week: String(r.week),
          value: Number(r.value) || 0, at: Date.now() });
      });
      t.oncomplete = () => res((rows || []).length);
      t.onerror = () => rej(t.error);
    });
  }
  async function clearTrends() {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction("trends", "readwrite");
      t.objectStore("trends").clear();
      t.oncomplete = res; t.onerror = () => rej(t.error);
    });
  }

  /* Write this week's (and any earlier week's) frozen numbers.

     Overwrite by id on purpose: a week is rebuilt from the products still in
     the catalog every time the LAB opens, so the current week keeps growing as
     more scans land, and an older week is simply re-confirmed. Once the products
     are gone the last written row is what remains — which is the point.

     Never lets a rebuild shrink a week: if the products behind week W were
     deleted, the stored row for W is kept as-is rather than replaced by a
     smaller one computed from what is left. */
  async function putSnapshots(rows) {
    if (!rows || !rows.length) return { written: 0, kept: 0 };
    const db = await open();
    let written = 0, kept = 0;
    await new Promise((res, rej) => {
      const t = db.transaction("snapshots", "readwrite");
      const S = t.objectStore("snapshots");
      t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
      rows.forEach(r => {
        const g = S.get(r.id);
        g.onsuccess = () => {
          const prev = g.result;
          if (prev && prev.products > r.products) { kept++; return; }
          written++;
          S.put(Object.assign({}, r, { firstBuiltAt: (prev && prev.firstBuiltAt) || r.builtAt }));
        };
      });
    });
    return { written, kept };
  }

  async function stats() {
    const items = await allProducts();
    const brands = new Set(), cats = new Set(), sources = new Set();
    items.forEach(i => { if (i.brand) brands.add(i.brand); if (i.category) cats.add(i.category); if (i.source) sources.add(i.source); });
    return { products: items.length, brands: brands.size, categories: cats.size, sources: sources.size };
  }

  // ---- projects ------------------------------------------------------------
  async function saveProject(p) {
    const db = await open();
    const rec = Object.assign({ id: p.id || ("p" + Date.now()), createdAt: Date.now(), keys: [] }, p);
    rec.updatedAt = Date.now();
    await req2p(db.transaction("projects", "readwrite").objectStore("projects").put(rec));
    return rec;
  }
  async function deleteProject(id) {
    const db = await open();
    return req2p(db.transaction("projects", "readwrite").objectStore("projects").delete(id));
  }
  // Products of a project, in catalog order — the report's input set.
  async function projectItems(id) {
    const db = await open();
    const proj = await req2p(db.transaction("projects", "readonly").objectStore("projects").get(id));
    if (!proj) return [];
    const P = db.transaction("products", "readonly").objectStore("products");
    const rows = await Promise.all((proj.keys || []).map(k => req2p(P.get(k))));
    return rows.filter(Boolean);
  }

  async function removeProducts(keys) {
    const db = await open();
    const t = db.transaction("products", "readwrite");
    const P = t.objectStore("products");
    keys.forEach(k => P.delete(k));
    return new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
  }
  /* Take an address out of a list, and take out what it collected.

     Until now removing a row from a list removed only the plan: the products
     that address had already scraped stayed in the catalog, so the LAB kept
     counting a page the list says is gone, and there was no way to undo a
     scan except to empty the whole catalog. A list is one research question
     (v1.71) — an address that is no longer part of it is no longer part of
     the answer.

     Two ways a row can belong to the address, and they are not the same kind
     of fact:

       · `pages` — the row records the listing page(s) it was seen on. This is
         exact, and it is a UNION: a garment that another saved address still
         collects keeps that address in the list and survives here.
       · brand + category, for rows scanned before `pages` existed. That pair
         is what the list row itself shows (ADANOLA / activewear) and what the
         spreadsheet and the LAB group by, so it is the same claim the screen
         makes — but it is a NAME, not a record of where the row came from, so
         it only applies when no surviving address anywhere claims that pair.
         Deleting a product another page still collects would be worse than
         leaving one behind: the first is silent data loss, the second is a
         stale row a re-scan corrects.

     `keepSigs` / `keepPairs` are what the rest of the lists still hold, sent
     by the caller because only the panel knows the lists. */
  function pairKey(brand, category) {
    return String(brand || "").trim().toLowerCase() + " :: " +
      String(category || "").trim().toLowerCase();
  }
  async function forgetPage(spec) {
    const sig = String((spec && spec.sig) || "");
    const listId = String((spec && spec.listId) || "");
    const keepSigs = new Set([].concat((spec && spec.keepSigs) || []).filter(Boolean));
    const keepPairs = new Set([].concat((spec && spec.keepPairs) || []).filter(Boolean));
    const pair = pairKey(spec && spec.brand, spec && spec.category);
    const named = pair !== pairKey("", "") && !keepPairs.has(pair);
    const items = await all("products");
    const doomed = [];
    (items || []).forEach(p => {
      if (!p || !p.key) return;
      const pages = [].concat(p.pages || []).filter(Boolean);
      if (pages.length) {
        if (!pages.includes(sig)) return;
        // seen on another page this list (or another list) still holds
        if (pages.some(s => s !== sig && keepSigs.has(s))) return;
        doomed.push(p.key);
        return;
      }
      // collected before rows recorded their page — go by what the list row says
      if (!named) return;
      if (listId && !([].concat(p.listIds || []).includes(listId))) return;
      if (pairKey(cleanBrand(p.brand, p.product_url || p.url), cleanCategory(p.category)) !== pair) return;
      doomed.push(p.key);
    });
    /* Counting and removing are the same question asked twice, so they are one
       function: the number the panel puts in front of the person before they
       press Remove has to be the number that is actually removed. */
    if (doomed.length && !(spec && spec.dry)) await removeProducts(doomed);
    return { removed: doomed.length, kept: (items || []).length - doomed.length };
  }

  /* ---- keeping the catalog from growing without end -----------------------

     Measured on this database: about 283 bytes per product once IndexedDB has
     warmed up, against a quota of ~150 GB — so DISK is never the constraint.
     What does degrade is the work done on every LAB open: allProducts() reads
     and repairs the whole table, and the trend maths runs over it. A designer
     scanning eight lists weekly adds roughly 25,000 products a year.

     The weekly snapshot is what makes pruning safe: each week's numbers are
     frozen in a few KB, so a year of history survives even after its products
     are gone. Old products are the working set, not the record.

     Nothing is deleted on a schedule. This is the tool a person points at a
     window they no longer need, and it says exactly what it removed. */
  async function pruneOlderThan(cutoffMs) {
    if (!isFinite(cutoffMs)) return { removed: 0, kept: 0 };
    const db = await open();
    const items = await all("products");
    const doomed = items.filter(p => (p.addedAt || 0) < cutoffMs).map(p => p.key);
    if (doomed.length) await removeProducts(doomed);
    return { removed: doomed.length, kept: items.length - doomed.length };
  }

  /* What the catalog weighs right now — products, the frozen weeks, and what
     the browser says the whole extension database is using. */
  async function usage() {
    const [products, snapshots, scans] = await Promise.all([
      all("products"), all("snapshots"), all("scans"),
    ]);
    let bytes = 0, quota = 0;
    try {
      const est = await navigator.storage.estimate();
      bytes = est.usage || 0; quota = est.quota || 0;
    } catch (e) {}
    const times = products.map(p => p.addedAt || 0).filter(Boolean);
    return {
      products: products.length, snapshots: snapshots.length, scans: scans.length,
      bytes, quota,
      oldest: times.length ? Math.min(...times) : 0,
      newest: times.length ? Math.max(...times) : 0,
    };
  }

  /* ---- moving a catalog between browsers ----------------------------------

     Every designer runs this in their own Chrome, and IndexedDB is per browser
     — so there are as many catalogs as there are people, none of them aware of
     the others. Two consequences the team feels: a person's history dies with
     their machine, and a trend built from four people's scans cannot be seen by
     any of them.

     Merging is well defined here, which is what makes a plain file enough. A
     product's identity is its URL, so the same garment scanned by two people is
     one row; the survivor keeps the EARLIEST addedAt, because first-seen is what
     the weekly trend buckets on; list membership is a union. Frozen weeks merge
     by the same never-shrink rule a rebuild uses. So one browser can take
     everyone's file and hold the team's LAB, and nobody's numbers are invented
     in the process. */
  async function exportAll() {
    const [products, snapshots, projects] = await Promise.all([
      all("products"), all("snapshots"), all("projects"),
    ]);
    return { format: "market-lens-catalog", version: 1, at: Date.now(),
      products, snapshots, projects };
  }

  async function importAll(data) {
    const out = { products: 0, added: 0, updated: 0, snapshots: 0, projects: 0 };
    if (!data || data.format !== "market-lens-catalog") throw new Error("not a Market Lens backup");
    const items = [].concat(data.products || []);
    if (items.length) {
      const db = await open();
      await new Promise((res, rej) => {
        const t = db.transaction("products", "readwrite");
        const P = t.objectStore("products");
        t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
        items.forEach(it => {
          const key = productKey(it);
          if (!key) return;
          const g = P.get(key);
          g.onsuccess = () => {
            const prev = g.result;
            if (prev) out.updated++; else out.added++;
            /* merge() stamps addedAt with "now" for a row it has not seen, which
               is right for a scan and wrong for an import: this row was first
               seen on someone else's machine, on the day their scan saw it. The
               incoming date wins when it is earlier, so a merged trend keeps
               pointing at when the garment actually appeared. */
            const rec = merge(prev, it, { scanId: it.scanId || "", source: it.source || "" });
            const first = Math.min(prev && prev.addedAt || Infinity, it.addedAt || Infinity);
            if (isFinite(first)) rec.addedAt = first;
            rec.seenCount = Math.max((prev && prev.seenCount) || 0, it.seenCount || 0) || 1;
            P.put(rec);
          };
        });
      });
      out.products = items.length;
    }
    if ((data.snapshots || []).length) {
      const r = await putSnapshots(data.snapshots);
      out.snapshots = r.written;
    }
    for (const p of data.projects || []) {
      try { await saveProject(p); out.projects++; } catch (e) {}
    }
    return out;
  }

  async function clearAll() {
    const db = await open();
    const names = ["products", "scans", "projects", "snapshots", "runrows"];
    const t = db.transaction(names, "readwrite");
    names.forEach(n => t.objectStore(n).clear());
    return new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
  }

  /* ---- rows of a run in progress -----------------------------------------
     Written by the worker on behalf of the content script (the page origin has
     no access to the extension's database), read once when the list finishes,
     and cleared as soon as the spreadsheet is out. */
  async function appendRunRows(runId, items) {
    if (!runId || !items || !items.length) return 0;
    const db = await open();
    await new Promise((res, rej) => {
      const t = db.transaction("runrows", "readwrite");
      t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
      t.objectStore("runrows").add({ runId, at: Date.now(), items });
    });
    return items.length;
  }

  async function getRunRows(runId) {
    if (!runId) return [];
    const db = await open();
    const chunks = await req2p(db.transaction("runrows", "readonly")
      .objectStore("runrows").index("runId").getAll(IDBKeyRange.only(runId)));
    return [].concat.apply([], (chunks || []).sort((a, b) => a.id - b.id).map(c => c.items || []));
  }

  async function clearRunRows(runId) {
    const db = await open();
    const t = db.transaction("runrows", "readwrite");
    const S = t.objectStore("runrows");
    if (runId) {
      const keys = await req2p(S.index("runId").getAllKeys(IDBKeyRange.only(runId)));
      (keys || []).forEach(k => S.delete(k));
    } else S.clear();
    return new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
  }

  const API = { open, putScan, allProducts, getMany, allScans, allProjects, allSnapshots,
    allTrends, putTrends, clearTrends,
    appendRunRows, getRunRows, clearRunRows,
    putSnapshots, stats, saveProject, deleteProject, projectItems, removeProducts,
    pruneOlderThan, forgetPage, usage, exportAll, importAll,
    clearAll, productKey, merge, dedupe, cleanImage, cleanBrand, cleanCategory };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  root.CatalogStore = API;
})(typeof self !== "undefined" ? self : this);
