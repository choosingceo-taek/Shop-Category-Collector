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

   Everything here is plain data access. Aggregation lives in report/report.js,
   so both stay independently testable. */
(function (root) {
  "use strict";
  const DB = "shopcat", VER = 1;
  let _db = null;

  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((res, rej) => {
      const req = indexedDB.open(DB, VER);
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
      };
      req.onsuccess = () => { _db = req.result; res(_db); };
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
        // keep Inditex's pelement (it IS the product id), drop tracking noise
        const pe = x.searchParams.get("pelement");
        return (x.origin + x.pathname).replace(/\/$/, "").toLowerCase() + (pe ? "?pelement=" + pe : "");
      } catch (e) { return String(u).toLowerCase(); }
    }
    return ((it && it.brand) || "") .toLowerCase() + "|" + ((it && it.name) || "").toLowerCase();
  }

  // Merge an incoming row over the stored one. A re-scan should refresh prices
  // and fill gaps WITHOUT wiping a field the new scan happened to miss —
  // otherwise a partial run degrades good data already in the catalog.
  function merge(oldRec, incoming, meta) {
    const out = Object.assign({}, oldRec || {}, {});
    Object.keys(incoming).forEach(k => {
      const v = incoming[k];
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
    if (meta && meta.listId) {
      const ids = new Set([].concat(out.listIds || []));
      ids.add(meta.listId);
      out.listIds = [...ids];
      out.listName = meta.listName || out.listName || "";
    }
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

  const allProducts = () => all("products");
  const allScans = () => all("scans");
  const allProjects = () => all("projects");

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
  async function clearAll() {
    const db = await open();
    const t = db.transaction(["products", "scans", "projects"], "readwrite");
    ["products", "scans", "projects"].forEach(n => t.objectStore(n).clear());
    return new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
  }

  const API = { open, putScan, allProducts, allScans, allProjects, stats,
    saveProject, deleteProject, projectItems, removeProducts, clearAll,
    productKey, merge };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  root.CatalogStore = API;
})(typeof self !== "undefined" ? self : this);
