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

function adapter() { return (self.SITES && SITES.active(location.href)) || null; }
function itemKey(r) { return (r.id || r.product_url || r.name || "").toLowerCase(); }

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
  if (!a) { await report("이 페이지를 지원하는 어댑터가 없습니다."); j.active = false; await s(j); return; }

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
      await report(`페이지 ${page}는 결과 페이지가 아님 — ${j.items.length}개로 수집 종료`);
      j.phase = j.withSpec ? "spec" : "build";
      j.specIdx = 0;
      await s(j); step();
      return;
    }
    let scraped = [];
    try { scraped = a.scrapeList(document, location.href) || []; }
    catch (e) { scraped = []; await report(`페이지 ${page} 파싱 오류(건너뜀): ${e && e.message || e}`); }
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
    await report(`수집 중… ${page}${j.totalPages ? "/" + j.totalPages + "p" : "p"} · ${j.items.length}${target}개 (이번 페이지 +${added})`);

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
      if (capped) await report(`안전 상한(${MAX_PAGES}p) 도달 — 수집 중단하고 엑셀 생성.`);
      j.phase = j.withSpec ? "spec" : "build";
      j.specIdx = 0;
      await s(j);
      // announce the phase change immediately so the UI doesn't look frozen at "N/Np"
      await report(j.withSpec ? `목록 ${j.items.length}개 완료 — 상품 상세 수집 시작…` : "목록 완료 — 엑셀 생성 준비…");
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
            if (d.colorways) it.colorways = d.colorways;   // fuller than the list swatches
            if (d.design) it.design = d.design;            // real "Key item features"
            it._compReason = d.reason || "";
          } else { it.fabric_composition = d || ""; }
        } catch (e) { it.fabric_composition = ""; it._compReason = "error"; }   // never stall the run
      }
      it._specDone = true;
      await report(`상품 상세 수집… ${i + 1}/${total}`);   // update every item so progress is visible
      if (i % 5 === 0) await s(j);                          // persist periodically for resume
      await sleep(400 + Math.random() * 400);
    }
    j.specIdx = total; j.phase = "build"; await s(j); step(); return;
  }

  // -------- phase: build (export) --------
  if (j.phase === "build") {
    await report("엑셀 생성 중… (썸네일 이미지 포함, 잠시 걸립니다)");
    // if composition was never collected, mark the cause so the cell can explain it
    if (!j.withSpec) j.items.forEach(it => { if (!it.fabric_composition && !it._compReason) it._compReason = "not_collected"; });
    try {
      const ctx = {
        ExcelJS: self.ExcelJS,
        fetchImage: fetchImageViaBg,
        onProgress: (i, total) => report(`엑셀 생성 중… 썸네일 ${i}/${total}`),
      };
      const { bytes, kept, dropped } = await a.buildWorkbook(j.items, ctx);
      const total = Object.values(kept).reduce((n, v) => n + (v.length || 0), 0);
      const blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const url = URL.createObjectURL(blob);
      const el = document.createElement("a");
      // unique, descriptive filename so a new run never collides with an old file
      // (which made it look like "the previous result" when the old file was opened)
      const brandTag = (j.items[0] && j.items[0].brand || a.label || "collect").replace(/\W+/g, "");
      let catTag = "";
      try {
        const q = new URL(location.href).searchParams.get("q") || "";
        catTag = (j.items[0] && j.items[0].category || q).replace(/[^A-Za-z0-9]+/g, "").slice(0, 24);
      } catch (e) {}
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T-]/g, "").slice(8); // HHMMSS
      el.href = url;
      el.download = `${a.id}_${brandTag}${catTag ? "_" + catTag : ""}_${total}items_${stamp}.xlsx`;
      document.body.appendChild(el); el.click(); el.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      await report(`완료: ${total}개 기입${(dropped || []).length ? ", 중복 " + dropped.length + "개 제외" : ""} · 총 수집 ${j.items.length}개`);
    } catch (e) {
      await report("엑셀 생성 실패: " + (e && e.message || e));
    }
    const done = await g(); if (done) { done.active = false; await s(done); }
  }
}

chrome.runtime.onMessage.addListener((m, _s, send) => {
  if (m.type === "start") {
    // always a FRESH job tagged with this page's collection signature
    s({ active: true, paused: false, phase: "list", items: [], seen: {}, pagesDone: 0,
        totalPages: 0, emptyStreak: 0, withSpec: m.withSpec,
        sig: collectionSig(location.href), status: "시작…" })
      .then(() => {
        // collection always begins at page 1, wherever the user started from
        const u = new URL(location.href);
        if ((parseInt(u.searchParams.get("page")) || 1) > 1) {
          u.searchParams.delete("page");
          send({ ok: true });
          location.href = u.toString();   // auto-resumes there (same signature)
        } else { step(); send({ ok: true }); }
      });
    return true;
  }
  if (m.type === "pause") {
    g().then(j => { if (j && j.active) { j.paused = true; j.status = "일시정지됨 (재개 가능)"; return s(j); } })
      .then(() => send({ ok: true }));
    return true;
  }
  if (m.type === "resume") {
    g().then(j => {
      if (j && j.active && j.paused) { j.paused = false; j.status = "재개…"; return s(j).then(() => step()); }
    }).then(() => send({ ok: true }));
    return true;
  }
  // reset = discard the job entirely so a wrong run can never resurface
  if (m.type === "reset" || m.type === "cancel") { clear().then(() => send({ ok: true })); return true; }
  if (m.type === "context") {
    const a = adapter();
    send(a ? Object.assign({ site: a.label }, a.context(document)) : { site: null });
    return true;
  }
  if (m.type === "status") { g().then(j => send(j || {})); return true; }
  return true;
});

// resume across the page navigations that pagination triggers — but ONLY for the
// same collection, and never while paused. A leftover active job from a different
// search (or a legacy job with no signature) is abandoned and cleared, so it can
// never emit stale items into a new category's output.
g().then(j => {
  if (!j || !j.active) return;
  if (!j.sig || collectionSig(location.href) !== j.sig) { clear(); return; }
  if (j.paused) return;   // user paused — wait for the resume button
  step();
});
