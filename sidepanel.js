/* Side-panel research companion.

   What makes it read as an assistant rather than a form: it does the looking.
   Every time the tab changes or finishes loading it re-reads the page, says what
   it found in plain language, and offers the ONE action that fits — scan this
   category, clip this product, or ask for access it doesn't have yet. During a
   scan it narrates progress from the job the content script is already writing.

   Permission model (charter: 권한 최소). Nothing is granted up front:
   - allow-listed shops (existing host_permissions) → read via the content script
   - any other site → the panel asks for THAT origin at the moment the user
     clicks, through optional_host_permissions; Chrome prompts and remembers it
   - right-click clipping needs nothing at all (activeTab, see background.js) */
(function () {
  "use strict";
  const $ = s => document.querySelector(s);
  const RC = "rc_store_v1";     // collections
  const JOB = "wpb_job";        // the scan job the content script drives
  const QUEUE = "wpb_queue";    // the batch run over the scan list

  let store = { collections: [], items: [], activeId: "" };
  let tab = null;               // current tab
  let read = null;              // what we last understood about the page
  let job = null;
  let queue = null;             // live batch-run state
  let lists = [], curList = null;   // the curated brand/category URL list

  const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const load = k => new Promise(r => chrome.storage.local.get(k, o => r(o[k] || null)));
  const save = () => chrome.storage.local.set({ [RC]: store });

  let toastT;
  function toast(msg) {
    const t = $("#toast"); t.textContent = msg; t.classList.add("on");
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("on"), 1800);
  }

  function ensureCollection() {
    if (!store.collections.length) {
      const id = "c" + Date.now();
      store.collections.push({ id, name: "리서치 " + new Date().toISOString().slice(0, 10), createdAt: Date.now() });
      store.activeId = id;
    }
    if (!store.collections.some(c => c.id === store.activeId)) store.activeId = store.collections[0].id;
  }

  // ---- looking at the page -------------------------------------------------
  // Ask the content script (only present on allow-listed shops). A tab without
  // one just doesn't answer, which is the "site we can't see yet" case.
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
  const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return ""; } };
  const originOf = u => { try { return new URL(u).origin + "/*"; } catch (e) { return ""; } };

  async function observe() {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = t || null;
    const url = (tab && tab.url) || "";
    const internal = !url || /^(chrome|edge|about|devtools|chrome-extension):/i.test(url);

    if (internal) { read = { kind: "internal" }; return paint(); }

    const adapter = await askAdapter(tab.id).catch(() => null);
    if (adapter) { read = { kind: "shop", adapter, host: hostOf(url) }; return paint(); }

    // not an allow-listed shop: can we already read this origin?
    const origin = originOf(url);
    const allowed = origin ? await chrome.permissions.contains({ origins: [origin] }).catch(() => false) : false;
    if (!allowed) { read = { kind: "locked", host: hostOf(url), origin }; return paint(); }

    // we have access — actually look at the page
    let data = null;
    try {
      const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["clip.js"] });
      data = r && r.result;
    } catch (e) {}
    read = { kind: "page", host: hostOf(url), origin, data: (data && data.name) ? data : null };
    paint();
  }

  // ---- saying what it sees, and offering the fitting action ----------------
  function paint() {
    const obs = $("#obs"), cta = $("#cta"), alt = $("#alt"), dot = $("#dot");
    alt.hidden = true; cta.disabled = false;
    dot.className = "dot" + (job && job.active && !job.paused ? " busy" : (read && read.kind !== "internal" ? "" : " idle"));

    if (!read) { obs.textContent = "페이지를 읽는 중…"; cta.disabled = true; cta.textContent = "확인 중"; return; }

    if (read.kind === "internal") {
      obs.innerHTML = "브라우저 내부 페이지입니다.<span class='sub'>쇼핑몰이나 참고할 페이지를 열면 바로 읽겠습니다.</span>";
      cta.disabled = true; cta.textContent = "읽을 페이지가 없습니다";
      return;
    }

    if (read.kind === "shop") {
      const a = read.adapter;
      const where = [a.site, a.category].filter(Boolean).join(" · ");
      const inList = urlInList(tab && tab.url);
      // The panel's job on a category page is curating the scan list: this is
      // where the user builds their own set of brand categories to re-run.
      // (An immediate one-off scan stays on the FAB at bottom-left.)
      obs.innerHTML = `<b>${esc(where || read.host)}</b> 카테고리를 보고 있습니다.` +
        `<span class='sub'>${inList
          ? "이미 스캔 목록에 있는 카테고리입니다. ▶ 전체 스캔으로 목록 전체를 수집하세요."
          : "목록에 담아두면 ▶ 전체 스캔 한 번으로 매주 같은 카테고리들을 다시 수집합니다. 지금 바로 이 페이지만 스캔하려면 좌측 하단 동그란 아이콘."}</span>`;
      if (inList) {
        cta.textContent = "✓ 목록에 있음 — 이 상품만 담기";
        cta.onclick = clipHere;
      } else {
        cta.textContent = "＋ 이 카테고리를 목록에 담기";
        cta.onclick = () => addCategoryToList(a);
      }
      alt.hidden = false; alt.textContent = "📁 카탈로그 열기";
      alt.onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL("catalog.html") });
      return;
    }

    if (read.kind === "locked") {
      obs.innerHTML = `<b>${esc(read.host)}</b> — 아직 이 사이트를 읽을 권한이 없습니다.` +
        `<span class='sub'>허용하면 이 사이트의 상품과 이미지를 바로 담을 수 있습니다. 허용 없이 담으려면 페이지에서 우클릭 → 컬렉션에 담기.</span>`;
      cta.textContent = "이 사이트 읽기 허용";
      cta.onclick = async () => {
        const ok = await chrome.permissions.request({ origins: [read.origin] }).catch(() => false);
        if (ok) observe(); else toast("허용하지 않으면 우클릭으로 담을 수 있습니다");
      };
      return;
    }

    // a readable, non-shop page
    const d = read.data;
    if (d) {
      const bits = [d.brand, d.price].filter(Boolean).join(" · ");
      obs.innerHTML = `상품 페이지로 보입니다: <b>${esc(d.name.slice(0, 70))}</b>` +
        (bits ? `<span class='sub'>${esc(bits)}${d.fabric_composition ? " · " + esc(d.fabric_composition) : ""}</span>`
              : `<span class='sub'>${esc(read.host)}</span>`);
      cta.textContent = "＋ 컬렉션에 담기";
      cta.onclick = clipHere;
    } else {
      obs.innerHTML = `<b>${esc(read.host)}</b>에서 상품 정보를 찾지 못했습니다.` +
        `<span class='sub'>참고 이미지는 페이지에서 우클릭 → 이미지를 컬렉션에 담기로 저장할 수 있습니다.</span>`;
      cta.textContent = "그래도 이 페이지 담기";
      cta.onclick = clipHere;
    }
  }

  // ---- acting --------------------------------------------------------------
  async function clipHere() {
    if (!tab) return;
    const origin = originOf(tab.url || "");
    if (origin) {
      const ok = await chrome.permissions.request({ origins: [origin] }).catch(() => false);
      if (!ok) return toast("사이트 접근을 허용해야 담을 수 있습니다");
    }
    let data = null;
    try {
      const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["clip.js"] });
      data = r && r.result;
    } catch (e) { return toast("읽지 못했습니다: " + (e.message || e)); }
    if (!data) return toast("상품 정보를 찾지 못했습니다");
    if (!data.name) data.name = (tab.title || "(제목 없음)").slice(0, 200);
    addItem(data);
  }

  function addItem(data) {
    ensureCollection();
    const dupe = store.items.some(i => i.collectionId === store.activeId &&
      i.product_url && i.product_url === data.product_url && i.type === data.type);
    if (dupe) return toast("이미 담긴 항목입니다");
    store.items.push(Object.assign({
      id: "i" + Date.now() + Math.random().toString(36).slice(2, 6),
      collectionId: store.activeId, addedAt: Date.now(),
    }, data));
    save(); renderTray(); toast("담았습니다");
  }

  // ---- narrating the running scan -----------------------------------------
  function paintLive() {
    const box = $("#live");
    const on = !!(job && job.active);
    box.classList.toggle("on", on);
    if (on) $("#livetext").textContent = job.status || "작업 중…";
    $("#dot").className = "dot" + (on && !job.paused ? " busy" : (read && read.kind !== "internal" ? "" : " idle"));
  }

  // ---- the scan list: curated brand categories, managed visually -----------
  const L = window.ScanLists;

  async function loadLists() {
    lists = await L.load();
    if (!lists.length) {
      lists = [{ id: "l" + Date.now(), name: "주간 리서치", entries: [], createdAt: Date.now() }];
      await L.save(lists);
    }
    curList = lists[0];   // the panel curates the primary list; others live in the catalog tab
  }
  function urlInList(url) {
    if (!url || !curList) return false;
    const k = L.normUrl(url);
    return (curList.entries || []).some(e => L.normUrl(e.url) === k);
  }
  async function addCategoryToList(adapterInfo) {
    if (!tab || !tab.url) return;
    const entry = {
      brand: (adapterInfo && adapterInfo.site) || read.host || "",
      label: (adapterInfo && adapterInfo.category) || (tab.title || "").slice(0, 60),
      url: tab.url,
    };
    const m = L.mergeEntries(curList.entries || [], [entry]);
    if (!m.added) return toast("이미 목록에 있습니다");
    curList.entries = m.list;
    await L.save(lists);
    renderList(); paint();
    toast(`목록에 담았습니다 — ${entry.brand} · ${entry.label}`);
  }

  // The list, drawn as brand groups of category chips. During a batch run the
  // finished ones dim and the current one is highlighted, so progress is
  // visible at a glance.
  function renderList() {
    const body = $("#listbody");
    const entries = (curList && curList.entries) || [];
    $("#lcount").textContent = entries.length ? entries.length + "개 카테고리" : "";
    $("#runlist").disabled = !entries.length || !!(queue && queue.active);
    if (!entries.length) {
      body.innerHTML = '<div class="lempty">쇼핑몰 카테고리 페이지에서 <b>＋ 목록에 담기</b>를 누르면 여기에 쌓입니다.<br>여러 개 담아두고 ▶ 전체 스캔 한 번으로 전부 수집하세요.</div>';
      return;
    }
    const running = queue && queue.active;
    const idxOf = e => running ? queue.list.findIndex(x => L.normUrl(x.url) === L.normUrl(e.url)) : -1;
    const groups = new Map();
    entries.forEach(e => {
      const b = e.brand || "기타";
      if (!groups.has(b)) groups.set(b, []);
      groups.get(b).push(e);
    });
    body.innerHTML = [...groups.entries()].map(([brand, es]) => `<div class="bgroup">
      <div class="bname">${esc(brand)}</div>
      <div class="chips">${es.map(e => {
        const qi = idxOf(e);
        const cls = running ? (qi > -1 && qi < queue.idx ? " done" : qi === queue.idx ? " cur" : "") : "";
        return `<span class="chip${cls}" data-u="${esc(e.url)}">
          <a href="${esc(e.url)}" target="_blank" rel="noopener" title="${esc(e.url)}">${esc(e.label || e.url)}</a>
          <button class="cx" title="목록에서 빼기">✕</button></span>`;
      }).join("")}</div></div>`).join("");
    body.querySelectorAll(".cx").forEach(b => b.addEventListener("click", async ev => {
      ev.preventDefault();
      const u = b.closest(".chip").getAttribute("data-u");
      curList.entries = curList.entries.filter(e => e.url !== u);
      await L.save(lists);
      renderList(); paint();
    }));
  }

  function paintQueue() {
    const box = $("#qstate");
    const running = !!(queue && queue.active);
    box.hidden = !running;
    $("#stoplist").hidden = !running;
    $("#runlist").hidden = running;
    if (running) {
      const cur = queue.list[queue.idx] || {};
      box.innerHTML = `<b>${queue.idx + 1}/${queue.list.length}</b> ${esc(cur.brand || "")} · ${esc(cur.label || "")} 수집 중`;
    }
    renderList();
  }

  $("#runlist").addEventListener("click", async () => {
    const entries = (curList && curList.entries) || [];
    if (!entries.length) return;
    if (!confirm(`${entries.length}개 카테고리를 순서대로 전체 스캔합니다. 시작할까요?`)) return;
    const t = await chrome.tabs.create({ url: entries[0].url, active: false });
    const send = () => chrome.tabs.sendMessage(t.id,
      { type: "runList", name: curList.name, list: entries, withSpec: true, filters: {} },
      r => { if (chrome.runtime.lastError || !r) return setTimeout(send, 900); toast("전체 스캔을 시작했습니다"); });
    setTimeout(send, 1500);
  });
  $("#stoplist").addEventListener("click", () => {
    chrome.storage.local.get(QUEUE, o => {
      const q = o && o[QUEUE];
      if (q) { q.active = false; chrome.storage.local.set({ [QUEUE]: q }); }
    });
  });

  // ---- collection ----------------------------------------------------------
  function exportJson() {
    const col = store.collections.find(c => c.id === store.activeId);
    const items = store.items.filter(i => i.collectionId === store.activeId);
    if (!items.length) return toast("담긴 항목이 없습니다");
    const payload = {
      meta: { schema: "shop-scan/1", source: "clip", site: "리서치 컴패니언",
        collection: col ? col.name : "", scannedAt: new Date().toISOString(), count: items.length },
      items: items.map(i => ({
        brand: i.brand || "", name: i.name || "", category: i.category || "",
        price: i.price || "", price_was: "", colorways: i.colorways || "", color_count: "",
        size_range: i.size_range || "", fabric_composition: i.fabric_composition || "",
        design: i.design || "", product_url: i.product_url || "", image_url: i.image_url || "",
        source: i.source || "",
      })),
    };
    const name = (col ? col.name : "collection").replace(/[^\w가-힣.-]+/g, "_") + ".json";
    const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(payload, null, 2))));
    chrome.runtime.sendMessage({ type: "downloadFile", filename: name, b64, mime: "application/json" },
      r => toast(r && r.ok ? "내보냈습니다 — 리포트에 올리면 됩니다" : "내보내기 실패"));
  }

  function renderTray() {
    ensureCollection();
    const sel = $("#col");
    sel.innerHTML = "";
    store.collections.forEach(c => {
      const n = store.items.filter(i => i.collectionId === c.id).length;
      const o = document.createElement("option");
      o.value = c.id; o.textContent = `${c.name} (${n})`;
      sel.appendChild(o);
    });
    sel.value = store.activeId;

    const items = store.items.filter(i => i.collectionId === store.activeId).sort((a, b) => b.addedAt - a.addedAt);
    $("#count").textContent = items.length ? `${items.length}개 담김` : "";
    const tray = $("#tray");
    tray.innerHTML = "";
    if (!items.length) {
      tray.innerHTML = '<div class="empty">아직 담은 항목이 없습니다.<br>' +
        '위의 제안 버튼을 누르거나,<br>페이지에서 <b>우클릭 → 컬렉션에 담기</b></div>';
      return;
    }
    items.forEach(i => {
      const row = document.createElement("div");
      row.className = "it";
      const img = i.image_url ? `<img src="${esc(i.image_url)}" alt="" loading="lazy">` : '<div class="ph"></div>';
      const metaLine = [i.brand, i.price].filter(Boolean).join(" · ") || i.source || "";
      row.innerHTML =
        (i.product_url ? `<a href="${esc(i.product_url)}" target="_blank" rel="noopener">${img}</a>` : img) +
        `<div><div class="n">${i.product_url
          ? `<a href="${esc(i.product_url)}" target="_blank" rel="noopener">${esc(i.name || "(이미지)")}</a>`
          : esc(i.name || "(이미지)")}</div>` +
        (metaLine ? `<div class="m">${esc(metaLine)}</div>` : "") +
        (i.fabric_composition ? `<div class="f">${esc(i.fabric_composition)}</div>` : "") +
        `</div><button class="x" title="삭제">✕</button>`;
      row.querySelector(".x").addEventListener("click", () => {
        store.items = store.items.filter(x => x.id !== i.id); save(); renderTray();
      });
      tray.appendChild(row);
    });
  }

  // ---- wiring --------------------------------------------------------------
  $("#catalog").addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("catalog.html") });
  });
  $("#export").addEventListener("click", exportJson);
  $("#clear").addEventListener("click", () => {
    const n = store.items.filter(i => i.collectionId === store.activeId).length;
    if (!n || !confirm(`이 컬렉션의 ${n}개 항목을 모두 지울까요?`)) return;
    store.items = store.items.filter(i => i.collectionId !== store.activeId);
    save(); renderTray();
  });
  $("#col").addEventListener("change", e => { store.activeId = e.target.value; save(); renderTray(); });
  $("#newcol").addEventListener("click", () => {
    const name = prompt("새 컬렉션 이름", "리서치 " + new Date().toISOString().slice(0, 10));
    if (!name) return;
    const id = "c" + Date.now();
    store.collections.push({ id, name: name.trim(), createdAt: Date.now() });
    store.activeId = id; save(); renderTray();
  });

  // keep looking as the user browses — this is what makes it feel present
  chrome.tabs.onActivated.addListener(observe);
  chrome.tabs.onUpdated.addListener((id, info) => {
    if (tab && id === tab.id && (info.status === "complete" || info.url)) observe();
  });
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== "local") return;
    if (ch[RC]) { store = ch[RC].newValue || store; renderTray(); }
    if (ch[JOB]) { job = ch[JOB].newValue || null; paintLive(); }
    if (ch[QUEUE]) { queue = ch[QUEUE].newValue || null; paintQueue(); }
    if (ch[L.KEY]) {   // list edited elsewhere (catalog tab) — stay in sync
      lists = ch[L.KEY].newValue || lists;
      curList = lists.find(x => curList && x.id === curList.id) || lists[0];
      renderList(); paint();
    }
  });

  (async () => {
    store = (await load(RC)) || store;
    job = await load(JOB);
    queue = await load(QUEUE);
    await loadLists();
    ensureCollection(); save();
    renderTray(); paintLive(); paintQueue(); paint();
    observe();
  })();
})();
