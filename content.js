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
  if (!j || !j.active) return;
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
    const page = j.pagesDone + 1;
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
    j.emptyStreak = added === 0 ? (j.emptyStreak || 0) + 1 : 0;
    await s(j);
    await report(`수집 중… ${page}${j.totalPages ? "/" + j.totalPages : ""}p · ${j.items.length}개 (이번 페이지 +${added})`);

    const next = a.nextPageUrl(location.href, page);
    const knownDone = j.totalPages && page >= j.totalPages;
    const stalled = j.emptyStreak >= EMPTY_PAGE_LIMIT;
    const capped = page >= MAX_PAGES;

    if (next && !knownDone && !stalled && !capped) {
      await sleep(1200 + Math.random() * 900);   // human pace / anti-bot friendly
      location.href = next;                        // navigation -> resume() re-enters step()
    } else {
      if (capped) await report(`안전 상한(${MAX_PAGES}p) 도달 — 수집 중단하고 엑셀 생성.`);
      j.phase = j.withSpec ? "spec" : "build";
      j.specIdx = 0;
      await s(j);
      // announce the phase change immediately so the UI doesn't look frozen at "N/Np"
      await report(j.withSpec ? `목록 ${j.items.length}개 완료 — 원단 조성 수집 시작…` : "목록 완료 — 엑셀 생성 준비…");
      step();
    }
    return;
  }

  // -------- phase: spec (optional per-product detail) --------
  if (j.phase === "spec") {
    if (typeof a.fetchComposition !== "function") { j.phase = "build"; await s(j); step(); return; }
    const total = j.items.length;
    for (let i = j.specIdx || 0; i < total; i++) {
      if (!alive()) return;   // extension reloaded mid-run -> stop quietly
      j.specIdx = i;
      const it = j.items[i];
      if (!it._specDone && !(it.fabric_composition)) {
        try {
          const d = await a.fetchComposition(it.product_url);
          if (d && typeof d === "object") { it.fabric_composition = d.value || ""; it._compReason = d.reason || ""; }
          else { it.fabric_composition = d || ""; }   // string-returning adapters
        } catch (e) { it.fabric_composition = ""; it._compReason = "error"; }   // never stall the run
      }
      it._specDone = true;
      await report(`원단 조성 수집… ${i + 1}/${total}`);   // update every item so progress is visible
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
        ExcelJS: self.ExcelJS, WPB: self.WPB, XLSX: self.XLSX,
        fetchImage: fetchImageViaBg,
        onProgress: (i, total) => report(`엑셀 생성 중… 썸네일 ${i}/${total}`),
      };
      const { bytes, kept, dropped } = await a.buildWorkbook(j.items, ctx);
      const blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const url = URL.createObjectURL(blob);
      const el = document.createElement("a");
      const tag = (j.items[0] && j.items[0].brand || a.label || "collect").replace(/\W+/g, "");
      el.href = url; el.download = `${a.id}_${tag}_filled.xlsx`;
      document.body.appendChild(el); el.click(); el.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      const total = Object.values(kept).reduce((n, v) => n + (v.length || 0), 0);
      await report(`완료: ${total}개 기입, ${(dropped || []).length}개 제외(스코프 밖) · 총 수집 ${j.items.length}개`);
    } catch (e) {
      await report("엑셀 생성 실패: " + (e && e.message || e));
    }
    const done = await g(); if (done) { done.active = false; await s(done); }
  }
}

chrome.runtime.onMessage.addListener((m, _s, send) => {
  if (m.type === "start") {
    s({ active: true, phase: "list", items: [], seen: {}, pagesDone: 0, totalPages: 0,
        emptyStreak: 0, withSpec: m.withSpec, status: "시작…" })
      .then(() => { step(); send({ ok: true }); });
    return true;
  }
  if (m.type === "cancel") { clear().then(() => send({ ok: true })); return true; }
  if (m.type === "context") {
    const a = adapter();
    send(a ? Object.assign({ site: a.label }, a.context(document)) : { site: null });
    return true;
  }
  if (m.type === "status") { g().then(j => send(j || {})); return true; }
  return true;
});

// resume across the page navigations that pagination triggers
g().then(j => { if (j && j.active) step(); });
