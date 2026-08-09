/* Market Lens side panel.

   The one job: while browsing Chrome, whenever a page is worth coming back to,
   add it to your own list of reference sites — and shape that list over time
   (rename, regroup, split into several lists). Everything else hangs off that.

   COLLECTOR  add the current page, curate the list, run the whole list
   PRODUCTS   what those scans collected, filter and export

   Adding works on ANY page, not just the shops with an adapter: a reference URL
   is worth keeping even when we can't scan it yet. Entries carry a SCAN/REF tag
   so the difference is visible, and "Run all" only walks the scannable ones. */
(function () {
  "use strict";
  const $ = s => document.querySelector(s);
  const RC = "rc_store_v1";     // clipped products/images
  const JOB = "wpb_job";        // the scan job the content script drives
  const QUEUE = "wpb_queue";    // batch run over the list
  const L = window.ScanLists;

  let store = { collections: [], items: [], activeId: "" };
  let tab = null, read = null, job = null, queue = null;
  let lists = [], curList = null;
  let products = [], picked = new Set();

  const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const load = k => new Promise(r => chrome.storage.local.get(k, o => r(o[k] || null)));
  const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return ""; } };

  let toastT;
  function toast(msg) {
    const t = $("#toast"); t.textContent = msg; t.classList.add("on");
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("on"), 1800);
  }

  // Can we actually scan this URL, or is it reference-only? SITES.active falls
  // back to the generic adapter for anything unknown, so "generic" means we have
  // no real support for it — keep the URL, but don't promise a scan.
  function adapterFor(url) {
    try {
      const a = window.SITES && window.SITES.active(url);
      return (a && a.id !== "generic") ? a : null;
    } catch (e) { return null; }
  }

  // ---- current page ---------------------------------------------------------
  function askAdapter(tabId) {
    return new Promise(res => {
      let done = false;
      const finish = v => { if (!done) { done = true; res(v); } };
      setTimeout(() => finish(null), 800);
      try {
        chrome.tabs.sendMessage(tabId, { type: "context" }, r => {
          void chrome.runtime.lastError;
          finish(r && r.site ? r : null);
        });
      } catch (e) { finish(null); }
    });
  }

  async function observe() {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = t || null;
    const url = (tab && tab.url) || "";
    const internal = !url || /^(chrome|edge|about|devtools|chrome-extension):/i.test(url);
    read = internal ? { kind: "internal" }
      : { kind: "page", host: hostOf(url), url,
          ctx: await askAdapter(tab.id).catch(() => null),
          adapter: adapterFor(url) };
    paintNow();
  }

  function paintNow() {
    const now = $("#now"), add = $("#addbtn"), clip = $("#clipbtn"), dot = $("#dot");
    dot.className = "dot" + (job && job.active && !job.paused ? " busy" : "");
    if (!read) { now.textContent = "페이지를 읽는 중…"; add.disabled = true; return; }
    if (read.kind === "internal") {
      now.innerHTML = "브라우저 내부 페이지입니다. <span class='badge'>담을 수 없음</span>";
      add.disabled = true; clip.disabled = true; return;
    }
    add.disabled = false; clip.disabled = false;
    const already = urlInList(read.url);
    const scannable = !!(read.ctx || read.adapter);
    const where = read.ctx ? [read.ctx.site, read.ctx.category].filter(Boolean).join(" · ") : "";
    now.innerHTML = `<span class="host">${esc(where || read.host)}</span>` +
      (scannable ? `<span class="badge ok">Scannable</span>` : `<span class="badge">Reference</span>`) +
      (already ? `<span class="badge ok">In list</span>` : "");
    add.textContent = already ? "✓ Already in list" : "＋ Add this page";
    add.disabled = already;
  }

  // ---- the list -------------------------------------------------------------
  async function loadLists() {
    lists = await L.load();
    if (!lists.length) {
      lists = [{ id: "l" + Date.now(), name: "My references", entries: [], createdAt: Date.now() }];
      await L.save(lists);
    }
    curList = lists.find(x => curList && x.id === curList.id) || lists[0];
  }
  function urlInList(url) {
    if (!url || !curList) return false;
    const k = L.normUrl(url);
    return (curList.entries || []).some(e => L.normUrl(e.url) === k);
  }

  async function addCurrentPage() {
    if (!tab || !tab.url || !read || read.kind === "internal") return;
    const a = read.ctx, ad = read.adapter;
    const entry = {
      brand: (a && a.site) || (ad && ad.label) || read.host,
      label: (a && a.category) || (tab.title || "").replace(/\s*[|·—-]\s*[^|·—-]*$/, "").trim().slice(0, 60) || read.host,
      url: tab.url,
      scannable: !!(a || ad),
    };
    const m = L.mergeEntries(curList.entries || [], [entry]);
    if (!m.added) return toast("이미 리스트에 있습니다");
    curList.entries = m.list;
    await L.save(lists);
    renderList(); paintNow();
    toast(`추가됨 — ${entry.brand} · ${entry.label}`);
  }

  function renderList() {
    const body = $("#listbody");
    const entries = (curList && curList.entries) || [];
    const running = !!(queue && queue.active);
    const scannableCount = entries.filter(e => e.scannable !== false).length;
    $("#runlist").disabled = !scannableCount || running;
    $("#runlist").textContent = scannableCount && scannableCount !== entries.length
      ? `▶ Run all (${scannableCount})` : "▶ Run all";

    if (!entries.length) {
      body.innerHTML = '<div class="lempty">아직 담은 사이트가 없습니다.<br>' +
        '참고하고 싶은 페이지에서 <b>＋ Add this page</b>를 누르세요.</div>';
      return;
    }
    const qIdx = e => running ? queue.list.findIndex(x => L.normUrl(x.url) === L.normUrl(e.url)) : -1;
    const groups = new Map();
    entries.forEach((e, i) => {
      const b = e.brand || hostOf(e.url) || "기타";
      if (!groups.has(b)) groups.set(b, []);
      groups.get(b).push({ e, i });
    });
    body.innerHTML = [...groups.entries()].map(([brand, rows]) => `<div class="grp">
      <div class="gname"><span>${esc(brand)}</span><span class="gn">${rows.length}</span></div>
      ${rows.map(({ e, i }) => {
        const qi = qIdx(e);
        const cls = running ? (qi > -1 && qi < queue.idx ? " done" : qi === queue.idx ? " cur" : "") : "";
        return `<div class="ent${cls}" data-i="${i}">
          <div class="txt">
            <div class="lb">${esc(e.label || e.url)}</div>
            <span class="u">${esc(e.url)}</span>
          </div>
          ${e.scannable === false ? '<span class="tag">Ref</span>' : '<span class="tag">Scan</span>'}
          <button class="act go" title="열기">↗</button>
          <button class="act ren" title="이름 변경">✎</button>
          <button class="act del" title="빼기">✕</button>
        </div>`;
      }).join("")}</div>`).join("");

    body.querySelectorAll(".ent").forEach(el => {
      const i = +el.dataset.i;
      el.querySelector(".go").addEventListener("click", () =>
        chrome.tabs.create({ url: curList.entries[i].url }));
      el.querySelector(".del").addEventListener("click", async () => {
        curList.entries.splice(i, 1); await L.save(lists); renderList(); paintNow();
      });
      el.querySelector(".ren").addEventListener("click", async () => {
        const e = curList.entries[i];
        const label = prompt("이름", e.label || "");
        if (label == null) return;
        const brand = prompt("브랜드 / 그룹", e.brand || "");
        if (brand == null) return;
        e.label = label.trim(); e.brand = brand.trim();
        await L.save(lists); renderList();
      });
    });
  }

  function fillListSelect() {
    const sel = $("#listsel");
    sel.innerHTML = lists.map(l =>
      `<option value="${esc(l.id)}">${esc(l.name)} · ${(l.entries || []).length}</option>`).join("");
    if (curList) sel.value = curList.id;
  }

  function paintQueue() {
    const box = $("#qstate");
    const running = !!(queue && queue.active);
    box.hidden = !running;
    $("#stoplist").hidden = !running;
    if (running) {
      const cur = queue.list[queue.idx] || {};
      box.innerHTML = `<b>${queue.idx + 1}/${queue.list.length}</b> ${esc(cur.brand || "")} · ${esc(cur.label || "")}`;
    }
    renderList();
  }
  function paintLive() {
    const on = !!(job && job.active);
    $("#live").classList.toggle("on", on);
    if (on) $("#livetext").textContent = job.status || "작업 중…";
    $("#dot").className = "dot" + (on && !job.paused ? " busy" : "");
  }

  // ---- products -------------------------------------------------------------
  async function refreshProducts() {
    try { products = await window.CatalogStore.allProducts(); } catch (e) { products = []; }
    const fill = (sel, values) => {
      const cur = sel.value;
      sel.innerHTML = '<option value="">All</option>' +
        [...values].sort((a, b) => a.localeCompare(b)).map(v => `<option>${esc(v)}</option>`).join("");
      sel.value = cur;
    };
    fill($("#pbrand"), new Set(products.map(p => p.brand).filter(Boolean)));
    fill($("#pcat"), new Set(products.map(p => p.category).filter(Boolean)));
    renderProducts();
  }
  const priceN = v => { const m = String(v || "").replace(/,/g, "").match(/\d+(?:\.\d+)?/); return m ? parseFloat(m[0]) : null; };
  function visibleProducts() {
    const q = $("#psearch").value.trim().toLowerCase();
    const b = $("#pbrand").value, c = $("#pcat").value;
    return products.filter(p => {
      if (b && p.brand !== b) return false;
      if (c && p.category !== c) return false;
      if (q && ![p.name, p.brand, p.fabric_composition, p.colorways].join(" ").toLowerCase().includes(q)) return false;
      return true;
    }).sort((x, y) => (y.addedAt || 0) - (x.addedAt || 0));
  }
  function renderProducts() {
    const rows = visibleProducts(), grid = $("#pgrid");
    if (!products.length) {
      grid.innerHTML = '<div class="pempty">아직 수집된 상품이 없습니다.<br>COLLECTOR에서 사이트를 담고 ▶ Run all 하세요.</div>';
    } else if (!rows.length) {
      grid.innerHTML = '<div class="pempty">조건에 맞는 상품이 없습니다.</div>';
    } else {
      grid.innerHTML = rows.slice(0, 400).map(p => {
        const sale = p.price_was && priceN(p.price_was) > priceN(p.price);
        const img = p.image_url ? `<img src="${esc(p.image_url)}" alt="" loading="lazy">` : '<div class="ph"></div>';
        return `<figure class="pc${picked.has(p.key) ? " sel" : ""}" data-k="${esc(p.key)}">
          ${img}<input class="ck" type="checkbox" ${picked.has(p.key) ? "checked" : ""}>
          <figcaption>
            ${p.brand ? `<span class="b">${esc(p.brand)}</span>` : ""}
            <span class="n">${esc(p.name || "")}</span>
            ${p.price ? `<span class="p">${esc(p.price)}${sale ? `<s>${esc(p.price_was)}</s>` : ""}</span>` : ""}
          </figcaption></figure>`;
      }).join("");
    }
    $("#selcount").textContent = "Selected " + picked.size;
  }

  // ---- clip (any site, via the injected extractor) --------------------------
  async function clipHere() {
    if (!tab) return;
    let origin; try { origin = new URL(tab.url).origin + "/*"; } catch (e) { return; }
    const ok = await chrome.permissions.request({ origins: [origin] }).catch(() => false);
    if (!ok) return toast("사이트 접근을 허용해야 담을 수 있습니다");
    let data = null;
    try {
      const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["clip.js"] });
      data = r && r.result;
    } catch (e) { return toast("읽지 못했습니다"); }
    if (!data) return toast("상품 정보를 찾지 못했습니다");
    if (!data.name) data.name = (tab.title || "").slice(0, 200);
    if (!store.collections.length) {
      store.collections.push({ id: "c" + Date.now(), name: "Clips", createdAt: Date.now() });
      store.activeId = store.collections[0].id;
    }
    store.items.push(Object.assign({ id: "i" + Date.now(), collectionId: store.activeId, addedAt: Date.now() }, data));
    chrome.storage.local.set({ [RC]: store });
    toast("클립에 담았습니다");
  }

  // ---- wiring ---------------------------------------------------------------
  document.querySelectorAll(".tab").forEach(b => b.addEventListener("click", () => {
    const v = b.dataset.view;
    document.querySelectorAll(".tab").forEach(x => x.classList.toggle("on", x === b));
    $("#v-collector").classList.toggle("on", v === "collector");
    $("#v-products").classList.toggle("on", v === "products");
    $("#selbar").classList.toggle("on", v === "products");
    if (v === "products") refreshProducts();
  }));

  $("#addbtn").addEventListener("click", addCurrentPage);
  $("#clipbtn").addEventListener("click", clipHere);
  $("#catalog").addEventListener("click", () =>
    chrome.tabs.create({ url: chrome.runtime.getURL("catalog.html") }));

  $("#listsel").addEventListener("change", e => {
    curList = lists.find(l => l.id === e.target.value) || curList;
    renderList(); paintNow();
  });
  $("#newlist").addEventListener("click", async () => {
    const name = prompt("새 리스트 이름", "My references");
    if (!name) return;
    curList = { id: "l" + Date.now(), name: name.trim(), entries: [], createdAt: Date.now() };
    lists.push(curList); await L.save(lists); fillListSelect(); renderList(); paintNow();
  });
  $("#renlist").addEventListener("click", async () => {
    if (!curList) return;
    const name = prompt("리스트 이름", curList.name);
    if (!name) return;
    curList.name = name.trim(); await L.save(lists); fillListSelect();
  });
  $("#dellist").addEventListener("click", async () => {
    if (!curList || lists.length < 2) return toast("리스트가 하나뿐입니다");
    if (!confirm(`"${curList.name}" 리스트를 삭제할까요?`)) return;
    lists = lists.filter(l => l.id !== curList.id);
    curList = lists[0]; await L.save(lists); fillListSelect(); renderList(); paintNow();
  });
  $("#addbulk").addEventListener("click", async () => {
    const parsed = L.parseList($("#bulk").value)
      .map(e => Object.assign(e, { scannable: !!adapterFor(e.url) }));
    if (!parsed.length) return toast("URL을 찾지 못했습니다");
    const m = L.mergeEntries(curList.entries || [], parsed);
    curList.entries = m.list;
    await L.save(lists); $("#bulk").value = "";
    fillListSelect(); renderList(); paintNow();
    toast(`${m.added}개 추가` + (m.skipped ? ` · ${m.skipped}개 중복` : ""));
  });

  $("#runlist").addEventListener("click", async () => {
    const entries = ((curList && curList.entries) || []).filter(e => e.scannable !== false);
    if (!entries.length) return toast("스캔 가능한 사이트가 없습니다");
    if (!confirm(`${entries.length}개 사이트를 순서대로 전체 스캔합니다. 시작할까요?`)) return;
    const t = await chrome.tabs.create({ url: entries[0].url, active: false });
    const send = () => chrome.tabs.sendMessage(t.id,
      { type: "runList", name: curList.name, list: entries, withSpec: true, filters: {} },
      r => { if (chrome.runtime.lastError || !r) return setTimeout(send, 900); toast("스캔을 시작했습니다"); });
    setTimeout(send, 1500);
  });
  $("#stoplist").addEventListener("click", () => {
    chrome.storage.local.get(QUEUE, o => {
      const q = o && o[QUEUE];
      if (q) { q.active = false; chrome.storage.local.set({ [QUEUE]: q }); }
    });
  });

  $("#pgrid").addEventListener("change", e => {
    const ck = e.target.closest(".ck"); if (!ck) return;
    const card = e.target.closest(".pc"), k = card.getAttribute("data-k");
    if (ck.checked) picked.add(k); else picked.delete(k);
    card.classList.toggle("sel", ck.checked);
    $("#selcount").textContent = "Selected " + picked.size;
  });
  ["psearch", "pbrand", "pcat"].forEach(id => $("#" + id).addEventListener("input", renderProducts));
  $("#selall").addEventListener("click", () => {
    const rows = visibleProducts();
    const allOn = rows.length && rows.every(p => picked.has(p.key));
    rows.forEach(p => allOn ? picked.delete(p.key) : picked.add(p.key));
    renderProducts();
  });
  $("#selreset").addEventListener("click", () => { picked.clear(); renderProducts(); });
  $("#selexport").addEventListener("click", async () => {
    const rows = products.filter(p => picked.has(p.key));
    if (!rows.length) return toast("선택한 상품이 없습니다");
    const btn = $("#selexport"); btn.disabled = true;
    try {
      const { bytes } = await window.WPBExcel.buildKnitWorkbook(rows, {
        ExcelJS: window.ExcelJS,
        fetchImage: url => new Promise(res => {
          if (!url) return res(null);
          try { chrome.runtime.sendMessage({ type: "fetchImage", url }, r => {
            void chrome.runtime.lastError; res(r && r.ok ? r : null); }); } catch (e) { res(null); }
        }),
        filters: {},
        onProgress: (i, total) => { $("#selcount").textContent = `Images ${i}/${total}`; },
      });
      let b64 = "";
      for (let i = 0; i < bytes.length; i += 0x8000)
        b64 += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      chrome.runtime.sendMessage({
        type: "downloadFile",
        filename: `selection_${rows.length}items_${new Date().toISOString().slice(0, 10)}.xlsx`,
        b64: btoa(b64),
        mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }, r => toast(r && r.ok ? `Excel 저장 — ${rows.length}개` : "내보내기 실패"));
    } catch (e) { toast("내보내기 실패"); }
    finally { btn.disabled = false; $("#selcount").textContent = "Selected " + picked.size; }
  });

  chrome.tabs.onActivated.addListener(observe);
  chrome.tabs.onUpdated.addListener((id, info) => {
    if (tab && id === tab.id && (info.status === "complete" || info.url)) observe();
  });
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== "local") return;
    if (ch[RC]) store = ch[RC].newValue || store;
    if (ch[JOB]) {
      const was = job; job = ch[JOB].newValue || null; paintLive();
      if (was && was.active && (!job || !job.active)) refreshProducts();
    }
    if (ch[QUEUE]) { queue = ch[QUEUE].newValue || null; paintQueue(); }
    if (ch[L.KEY]) {
      lists = ch[L.KEY].newValue || lists;
      curList = lists.find(x => curList && x.id === curList.id) || lists[0];
      fillListSelect(); renderList(); paintNow();
    }
  });

  (async () => {
    store = (await load(RC)) || store;
    job = await load(JOB);
    queue = await load(QUEUE);
    await loadLists();
    fillListSelect(); renderList(); paintLive(); paintQueue(); paintNow();
    refreshProducts();
    observe();
  })();
})();
