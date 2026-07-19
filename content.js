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
    const q = (p.get("q") || "").trim().toLowerCase();
    const facet = (p.get("facet") || "").trim().toLowerCase();
    const cat = (p.get("cat_id") || p.get("catId") || p.get("cat_ids") || "").trim();
    return u.pathname + "|" + q + "|" + facet + "|" + cat;
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

async function report(msg) { const j = await g(); if (j) { j.status = msg; await s(j); } }

// Top-level wrapper: no matter what throws, the job never silently freezes —
// the error is written to the status box and the tab can be re-run.
async function step() {
  const j = await g();
  if (!j || !j.active || j.paused) return;
  try {
    await runStep(j);
  } catch (e) {
    const cur = await g();
    if (cur) { cur.status = "오류: " + (e && e.message || e) + " (다시 실행하면 재시도)"; await s(cur); }
  }
}

async function runStep(j) {
  const a = adapter();
  if (!a) { await report("No adapter supports this page."); j.active = false; await s(j); return; }

  // -------- phase: list (scrape + auto-paginate) --------
  if (j.phase === "list") {
    // The page number comes from the URL, not a counter, so pausing/resuming or
    // reloading can never skip a page or scrape one twice.
    const page = (a.context && (a.context(document).page || 1)) || 1;
    if (page <= j.pagesDone) {
      // this page is already collected (resume/reload) -> jump to the next one
      const more = (j.totalPages && j.pagesDone < j.totalPages) ||
                   (j.resultCount && j.items.length < j.resultCount) ||
                   (!j.totalPages && !j.resultCount);
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
        await report(`Loading all items… ${n} rendered`);
      }
      window.scrollTo(0, 0);
    }
    let scraped = [];
    try { scraped = a.scrapeList(document, location.href) || []; }
    catch (e) { scraped = []; await report(`Page ${page} parse error (skipped): ${e && e.message || e}`); }
    j.seen = j.seen || {};
    let added = 0;
    for (const r of scraped) {
      const k = itemKey(r);
      if (!k || j.seen[k]) continue;
      j.seen[k] = 1; j.items.push(r); added++;
    }
    j.pagesDone = page;
    j.totalPages = j.totalPages || a.totalPages(document) || 0;
    j.resultCount = j.resultCount || (a.resultCount ? a.resultCount(document) : 0) || 0;
    j.emptyStreak = added === 0 ? (j.emptyStreak || 0) + 1 : 0;
    await s(j);
    const target = j.resultCount ? "/" + j.resultCount : "";
    await report(`Collecting… ${page}${j.totalPages ? "/" + j.totalPages + "p" : "p"} · ${j.items.length}${target} items (+${added} this page)`);

    const next = a.nextPageUrl(location.href, page);
    // Keep paginating while the site's reported total says items are missing —
    // but with a small tolerance: the reported count often includes 1-2
    // sponsored/unavailable items that never render (e.g. "12" for an 11-item
    // shelf), and chasing those would walk us onto a non-existent page.
    const COUNT_TOLERANCE = 2;
    const haveMore = j.resultCount && (j.resultCount - j.items.length) > COUNT_TOLERANCE;
    const knownDone = j.totalPages && page >= j.totalPages && !haveMore;
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
    for (let i = j.specIdx || 0; i < total; i++) {
      if (!alive()) return;   // extension reloaded mid-run -> stop quietly
      const live = await g();
      if (!live || !live.active || live.paused) { await s(j); return; }   // pause -> keep progress
      j.specIdx = i;
      const it = j.items[i];
      if (!it._specDone) {
        try {
          const d = await a.fetchDetail(it.product_url);
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
            if (d.name && !it.name) it.name = d.name;
            if (d.image_url && !it.image_url) it.image_url = d.image_url;
            if (d.product_url && !/-l\d/i.test(it.product_url || "")) it.product_url = d.product_url;
            it._compReason = d.reason || "";
          } else { it.fabric_composition = d || ""; }
        } catch (e) { it.fabric_composition = ""; it._compReason = "error"; }   // never stall the run
      }
      it._specDone = true;
      await report(`Collecting details… ${i + 1}/${total}`);   // update every item so progress is visible
      if (i % 5 === 0) await s(j);                          // persist periodically for resume
      await sleep(400 + Math.random() * 400);
    }
    j.specIdx = total; j.phase = "build"; await s(j); step(); return;
  }

  // -------- phase: build (export) --------
  if (j.phase === "build") {
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
      await report(`Done: ${total} rows${dropSummary ? " · excluded (" + dropSummary + ")" : ""} · ${j.items.length} collected`);
    } catch (e) {
      await report("Excel build failed: " + (e && e.message || e));
    }
    const done = await g(); if (done) { done.active = false; await s(done); }
  }
}

// ---- job controls, shared by the popup (via messages) and the on-page FAB ----
async function startJob(opts) {
  opts = opts || {};
  // bind the job to THIS tab so browsing in other tabs can't stop or divert it
  const tabId = await myTabId();
  // always a FRESH job tagged with this page's collection signature
  await s({ active: true, paused: false, phase: "list", items: [], seen: {}, pagesDone: 0,
      totalPages: 0, emptyStreak: 0, withSpec: opts.withSpec !== false, tabId,
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
    send(a ? Object.assign({ site: a.label, adapterId: a.id, hasDetail: typeof a.fetchDetail === "function", multiBrand: !!a.multiBrand }, a.context(document)) : { site: null });
    return true;
  }
  if (m.type === "status") { g().then(j => send(j || {})); return true; }
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
  return !!job.sig && job.sig === sig;                                          // same collection only
}
(async () => {
  const j = await g();
  if (!j || !j.active) return;
  if (ownsAndMatches(j, await myTabId(), collectionSig(location.href))) step();
})();
