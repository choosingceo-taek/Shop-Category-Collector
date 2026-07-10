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
const g = () => new Promise(r => chrome.storage.local.get(JOB, o => r(o[JOB] || null)));
const s = j => new Promise(r => chrome.storage.local.set({ [JOB]: j }, r));
const clear = () => new Promise(r => chrome.storage.local.remove(JOB, r));

function adapter() { return (self.SITES && SITES.active(location.href)) || null; }
function itemKey(r) { return (r.id || r.product_url || r.name || "").toLowerCase(); }

async function report(msg) { const j = await g(); if (j) { j.status = msg; await s(j); } }

async function step() {
  const j = await g();
  if (!j || !j.active) return;
  const a = adapter();
  if (!a) { await report("이 페이지를 지원하는 어댑터가 없습니다."); j.active = false; await s(j); return; }

  // -------- phase: list (scrape + auto-paginate) --------
  if (j.phase === "list") {
    const page = j.pagesDone + 1;
    const scraped = a.scrapeList(document, location.href) || [];
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
      await s(j); step();
    }
    return;
  }

  // -------- phase: spec (optional per-product detail) --------
  if (j.phase === "spec") {
    if (typeof a.fetchComposition !== "function") { j.phase = "build"; await s(j); step(); return; }
    for (let i = 0; i < j.items.length; i++) {
      if (j.items[i].fabric_composition != null && j.items[i].fabric_composition !== "") continue;
      if (j.items[i]._specDone) continue;
      j.items[i].fabric_composition = await a.fetchComposition(j.items[i].product_url);
      j.items[i]._specDone = true;
      if (i % 3 === 0) { await report(`원단 조성 수집… ${i + 1}/${j.items.length}`); await s(j); }
      await sleep(500 + Math.random() * 600);
    }
    j.phase = "build"; await s(j); step(); return;
  }

  // -------- phase: build (export) --------
  if (j.phase === "build") {
    await report("엑셀 생성 중…");
    try {
      let templateAB = null;
      if (a.templateUrl) templateAB = await (await fetch(chrome.runtime.getURL(a.templateUrl))).arrayBuffer();
      const { bytes, kept, dropped } = a.buildWorkbook(XLSX, templateAB, j.items, { dedupe: true });
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
