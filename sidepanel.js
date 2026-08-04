/* Side-panel research companion.

   The panel is the always-there window: it survives navigation and tab switches
   (unlike the popup, which closes on any click, and the injected FAB, which the
   page can restyle and a reload wipes). It shows what the current tab is, lets
   the user clip the product they're looking at, keeps the running collection,
   and still launches the full category scan on supported retailers.

   Permission model (charter: 권한 최소): nothing is granted up front.
   - right-click clip: runs on activeTab, so it works on ANY site with no
     standing host permission at all (see background.js)
   - the panel's "이 상품 담기" button: asks for THAT origin only, the moment the
     user clicks, via optional_host_permissions — Chrome shows its own prompt and
     remembers the site afterwards. */
(function () {
  "use strict";
  const $ = s => document.querySelector(s);
  const KEY = "rc_store_v1";

  let store = { collections: [], items: [], activeId: "" };
  let tab = null, ctxInfo = null;

  // ---- storage -----------------------------------------------------------
  const load = () => new Promise(r => chrome.storage.local.get(KEY, o => r(o[KEY] || null)));
  const save = () => chrome.storage.local.set({ [KEY]: store });

  function ensureCollection() {
    if (!store.collections.length) {
      const id = "c" + Date.now();
      store.collections.push({ id, name: "리서치 " + new Date().toISOString().slice(0, 10), createdAt: Date.now() });
      store.activeId = id;
    }
    if (!store.collections.some(c => c.id === store.activeId)) store.activeId = store.collections[0].id;
  }

  // ---- page context ------------------------------------------------------
  // Ask the content script (present only on allow-listed shops) what it sees; a
  // tab without one simply answers nothing, which is the "generic site" case.
  function askContext(tabId) {
    return new Promise(res => {
      let done = false;
      const finish = v => { if (!done) { done = true; res(v); } };
      setTimeout(() => finish(null), 700);
      try {
        chrome.tabs.sendMessage(tabId, { type: "context" }, r => {
          void chrome.runtime.lastError;   // no content script here — fine
          finish(r && r.site ? r : null);
        });
      } catch (e) { finish(null); }
    });
  }

  async function refreshContext() {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = t || null;
    const url = tab && tab.url || "";
    const host = (() => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch (e) { return ""; } })();
    const internal = /^(chrome|edge|about|chrome-extension):/i.test(url);

    ctxInfo = internal ? null : await askContext(tab.id).catch(() => null);
    const ctxEl = $("#ctx");
    if (internal) {
      ctxEl.innerHTML = "브라우저 내부 페이지 — 쇼핑몰 탭에서 사용하세요";
    } else if (ctxInfo) {
      const bits = [ctxInfo.site, ctxInfo.category].filter(Boolean).join(" · ");
      ctxEl.innerHTML = `<b>${esc(bits || host)}</b> <span class="tag">지원 사이트</span>`;
    } else {
      ctxEl.innerHTML = `<b>${esc(host || "—")}</b> <span class="tag">일반 페이지</span>`;
    }
    // full scan only makes sense where an adapter drives pagination
    $("#scan").disabled = !ctxInfo;
    $("#scan").title = ctxInfo ? "이 카테고리의 모든 페이지를 수집합니다" : "이 사이트는 전체 스캔을 지원하지 않습니다 — 상품 담기를 사용하세요";
    $("#clip").disabled = internal;
  }

  // ---- clip --------------------------------------------------------------
  async function clipCurrent() {
    if (!tab) return;
    let origin;
    try { origin = new URL(tab.url).origin + "/*"; } catch (e) { return toast("이 페이지에서는 담을 수 없습니다"); }

    // ask for this origin only, at the moment of the click
    const granted = await chrome.permissions.request({ origins: [origin] }).catch(() => false);
    if (!granted) return toast("사이트 접근을 허용해야 담을 수 있습니다");

    let res;
    try {
      [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["clip.js"] });
    } catch (e) { return toast("읽지 못했습니다: " + (e.message || e)); }
    const data = res && res.result;
    if (!data || !data.name) return toast("상품 정보를 찾지 못했습니다");
    addItem(data);
  }

  function addItem(data) {
    ensureCollection();
    const dupe = store.items.some(i => i.collectionId === store.activeId &&
      i.product_url && i.product_url === data.product_url && i.type === data.type);
    if (dupe) return toast("이미 담긴 상품입니다");
    store.items.push(Object.assign({
      id: "i" + Date.now() + Math.random().toString(36).slice(2, 6),
      collectionId: store.activeId, addedAt: Date.now(),
    }, data));
    save(); render();
    toast("담았습니다");
  }

  // ---- export ------------------------------------------------------------
  function exportJson() {
    const col = store.collections.find(c => c.id === store.activeId);
    const items = store.items.filter(i => i.collectionId === store.activeId);
    if (!items.length) return toast("담긴 항목이 없습니다");
    const payload = {
      meta: {
        schema: "shop-scan/1", source: "clip", site: "리서치 컴패니언",
        collection: col ? col.name : "", scannedAt: new Date().toISOString(), count: items.length,
      },
      items: items.map(i => ({
        brand: i.brand || "", name: i.name || "", category: i.category || "",
        price: i.price || "", price_was: "", colorways: i.colorways || "", color_count: "",
        size_range: i.size_range || "", fabric_composition: i.fabric_composition || "",
        design: i.design || "", product_url: i.product_url || "", image_url: i.image_url || "",
        note: i.note || "", source: i.source || "",
      })),
    };
    const name = (col ? col.name : "collection").replace(/[^\w가-힣.-]+/g, "_") + ".json";
    const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(payload, null, 2))));
    chrome.runtime.sendMessage({ type: "downloadFile", filename: name, b64, mime: "application/json" },
      r => toast(r && r.ok ? "내보냈습니다" : "내보내기 실패"));
  }

  // ---- render ------------------------------------------------------------
  const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  let toastT;
  function toast(msg) {
    const t = $("#toast"); t.textContent = msg; t.classList.add("on");
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("on"), 1700);
  }

  function render() {
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

    const items = store.items.filter(i => i.collectionId === store.activeId)
      .sort((a, b) => b.addedAt - a.addedAt);
    $("#count").textContent = items.length ? `${items.length}개 담김` : "";
    const tray = $("#tray");
    tray.innerHTML = "";
    if (!items.length) {
      tray.innerHTML = '<div class="empty">아직 담은 항목이 없습니다.<br>' +
        '상품 페이지에서 <b>＋ 이 상품 담기</b>,<br>이미지는 <b>우클릭 → 컬렉션에 담기</b></div>';
      return;
    }
    items.forEach(i => {
      const row = document.createElement("div");
      row.className = "it";
      const img = i.image_url ? `<img src="${esc(i.image_url)}" alt="" loading="lazy">` : '<div style="width:46px;height:61px;border-radius:5px;background:var(--line)"></div>';
      const metaLine = [i.brand, i.price].filter(Boolean).join(" · ") || i.source || "";
      row.innerHTML =
        (i.product_url ? `<a href="${esc(i.product_url)}" target="_blank" rel="noopener">${img}</a>` : img) +
        `<div><div class="n">${i.product_url ? `<a href="${esc(i.product_url)}" target="_blank" rel="noopener">${esc(i.name || "(이미지)")}</a>` : esc(i.name || "(이미지)")}</div>` +
        (metaLine ? `<div class="m">${esc(metaLine)}</div>` : "") +
        (i.fabric_composition ? `<div class="f">${esc(i.fabric_composition)}</div>` : "") +
        `</div><button class="x" title="삭제">✕</button>`;
      row.querySelector(".x").addEventListener("click", () => {
        store.items = store.items.filter(x => x.id !== i.id); save(); render();
      });
      tray.appendChild(row);
    });
  }

  // ---- wiring ------------------------------------------------------------
  $("#clip").addEventListener("click", clipCurrent);
  $("#export").addEventListener("click", exportJson);
  $("#col").addEventListener("change", e => { store.activeId = e.target.value; save(); render(); });
  $("#newcol").addEventListener("click", () => {
    const name = prompt("새 컬렉션 이름", "리서치 " + new Date().toISOString().slice(0, 10));
    if (!name) return;
    const id = "c" + Date.now();
    store.collections.push({ id, name: name.trim(), createdAt: Date.now() });
    store.activeId = id; save(); render();
  });
  $("#scan").addEventListener("click", () => {
    if (!tab) return;
    chrome.tabs.sendMessage(tab.id, { type: "start", withSpec: true, filters: {} }, () => {
      void chrome.runtime.lastError;
      toast("스캔을 시작했습니다");
    });
  });

  // keep the panel in step with the browser: new tab, navigation, or a clip
  // added from the context menu
  chrome.tabs.onActivated.addListener(refreshContext);
  chrome.tabs.onUpdated.addListener((id, info) => { if (info.status === "complete" && tab && id === tab.id) refreshContext(); });
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === "local" && ch[KEY]) { store = ch[KEY].newValue || store; render(); }
  });

  (async () => {
    store = (await load()) || store;
    ensureCollection(); save();
    render();
    refreshContext();
  })();
})();
