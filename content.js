/* Content script: runs on every Walmart /browse & /search page.
   State machine driven by chrome.storage.local 'wpb_job'.
   Phase 'list'  -> scrape product list of each page, auto-advance ?page=N.
   Phase 'spec'  -> after last page, fetch each product page for fabric composition.
   Phase 'build' -> fill template.xlsx via WPB.fillWorkbook and download.

   !!! VERIFY on a live page (see VERIFY.md): the __NEXT_DATA__ product path and the
   spec key path. Selectors below have DOM fallbacks but confirm once in Chrome. */

const JOB = "wpb_job";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const g = () => new Promise(r => chrome.storage.local.get(JOB, o => r(o[JOB] || null)));
const s = j => new Promise(r => chrome.storage.local.set({ [JOB]: j }, r));
const clear = () => new Promise(r => chrome.storage.local.remove(JOB, r));

// ---- read the big embedded JSON Walmart ships in the page ----
function nextData() {
  const el = document.getElementById("__NEXT_DATA__");
  if (el) { try { return JSON.parse(el.textContent); } catch (e) {} }
  return null;
}
// deep-search for the first array of product-like objects
function findItems(obj, depth = 0) {
  if (!obj || depth > 8) return null;
  if (Array.isArray(obj) && obj.length && obj.some(x => x && (x.name || x.title) && (x.canonicalUrl || x.usItemId || x.productId)))
    return obj.filter(x => x && (x.name || x.title));
  if (typeof obj === "object") for (const k in obj) { const r = findItems(obj[k], depth + 1); if (r) return r; }
  return null;
}
function detectBrand() {
  const h = (document.querySelector("h1") || {}).textContent || "";
  const m = h.match(/(Time and Tru|Terra & Sky|No Boundaries|Wonder Nation|Weekend Academy|Free Assembly)/i);
  return m ? m[1] : (new URLSearchParams(location.search).get("facet") || "").replace("brand:", "");
}
function totalPages() {
  const nd = nextData();
  try {
    const p = JSON.stringify(nd).match(/"maxPage":(\d+)/) || JSON.stringify(nd).match(/"numberOfPages":(\d+)/);
    if (p) return parseInt(p[1]);
  } catch (e) {}
  // DOM fallback: last numbered pagination link
  const nums = [...document.querySelectorAll('nav[aria-label*="pagination" i] a, [data-testid*="pagination" i] a')]
    .map(a => parseInt(a.textContent)).filter(n => !isNaN(n));
  return nums.length ? Math.max(...nums) : 1;
}
function currentPage() { return parseInt(new URLSearchParams(location.search).get("page") || "1"); }

function scrapeList() {
  const brand = detectBrand();
  const items = findItems(nextData()) || [];
  const out = items.map(it => ({
    brand,
    name: it.name || it.title || "",
    price: (it.priceInfo && (it.priceInfo.linePrice || it.priceInfo.currentPrice)) || it.price || "",
    product_url: it.canonicalUrl ? ("https://www.walmart.com" + it.canonicalUrl) : (it.productPageUrl || ""),
    image_url: it.imageInfo && (it.imageInfo.thumbnailUrl || it.imageInfo.allImages?.[0]?.url) || it.image || "",
    category: (document.querySelector("h1") || {}).textContent?.replace(/\(\d+\).*/, "").trim() || "",
    department: "",
    id: it.usItemId || it.productId || "",
  })).filter(r => r.name && r.product_url);
  // DOM fallback if embedded JSON missed
  if (!out.length) {
    document.querySelectorAll('[data-item-id]').forEach(tile => {
      const a = tile.querySelector('a[link-identifier], a[href*="/ip/"]');
      const name = tile.querySelector('[data-automation-id="product-title"], span')?.textContent?.trim();
      const price = tile.querySelector('[data-automation-id="product-price"], [aria-hidden]')?.textContent?.trim();
      if (a && name) out.push({ brand: detectBrand(), name, price: price || "", product_url: a.href,
        image_url: tile.querySelector("img")?.src || "", category: "", department: "", id: tile.getAttribute("data-item-id") });
    });
  }
  return out;
}

async function fetchComposition(url) {
  try {
    const html = await (await fetch(url, { credentials: "include" })).text();
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) return "";
    const j = JSON.parse(m[1]); const str = JSON.stringify(j);
    // look for a "Fabric Material"/"Material" spec value
    const k = str.match(/"name":"(?:Fabric Material|Material|Fabric Content|Composition)","value":"([^"]+)"/);
    return k ? k[1] : "";
  } catch (e) { return ""; }
}

async function report(msg) { const j = await g(); if (j) { j.status = msg; await s(j); } }

async function step() {
  const j = await g(); if (!j || !j.active) return;

  if (j.phase === "list") {
    const page = currentPage();
    j.items.push(...scrapeList());
    j.pagesDone = page; j.totalPages = j.totalPages || totalPages();
    await s(j); await report(`수집 중… ${page}/${j.totalPages}p, ${j.items.length}개`);
    if (page < j.totalPages) {
      await sleep(1200 + Math.random() * 800);
      const u = new URL(location.href); u.searchParams.set("page", page + 1); location.href = u.toString();
    } else { j.phase = j.withSpec ? "spec" : "build"; await s(j); step(); }
    return;
  }

  if (j.phase === "spec") {
    for (let i = 0; i < j.items.length; i++) {
      if (j.items[i].fabric_composition) continue;
      j.items[i].fabric_composition = await fetchComposition(j.items[i].product_url);
      if (i % 3 === 0) { await report(`원단 조성 수집… ${i + 1}/${j.items.length}`); await s(j); }
      await sleep(500 + Math.random() * 500);
    }
    j.phase = "build"; await s(j); step(); return;
  }

  if (j.phase === "build") {
    await report("엑셀 생성 중…");
    const ab = await (await fetch(chrome.runtime.getURL("template.xlsx"))).arrayBuffer();
    const { bytes, kept, dropped } = WPB.fillWorkbook(XLSX, ab, j.items, { dedupe: true });
    const blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `Walmart_${(j.items[0]?.brand || "PB").replace(/\W+/g, "")}_filled.xlsx`;
    document.body.appendChild(a); a.click(); a.remove();
    const total = Object.values(kept).reduce((s, v) => s + v.length, 0);
    await report(`완료: ${total}개 기입, ${dropped.length}개 제외(스코프 밖)`);
    j.active = false; await s(j);
  }
}

chrome.runtime.onMessage.addListener((m, _s, send) => {
  if (m.type === "start") {
    s({ active: true, phase: "list", items: [], pagesDone: 0, totalPages: 0,
        withSpec: m.withSpec, status: "시작…" }).then(() => { step(); send({ ok: true }); });
    return true;
  }
  if (m.type === "cancel") { clear().then(() => send({ ok: true })); return true; }
  if (m.type === "context") send({ brand: detectBrand(), totalPages: totalPages(), page: currentPage() });
  if (m.type === "status") g().then(j => send(j || {}));
  return true;
});

// resume across page navigations
g().then(j => { if (j && j.active) step(); });
