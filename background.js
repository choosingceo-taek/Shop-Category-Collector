/* MV3 service worker — image fetcher.
   Content scripts can't read cross-origin image bytes (CORS uses the page's
   origin). The service worker CAN, using the extension's host_permissions for
   walmartimages.com. It fetches an image, detects its real type from the magic
   bytes, and returns base64 so the content script can embed it via ExcelJS. */

function detectExt(b) {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return "png";
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return "jpeg";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "webp";
  return "unknown";
}

function toBase64(bytes) {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

// ---- side panel + right-click clipping -------------------------------------
// The toolbar icon opens the research companion panel. Unlike the old popup it
// stays open while the user browses, which is what makes it read as a working
// assistant rather than a dialog.
// Scanning belongs to the in-page FAB (bottom-left): it sits where the work is,
// on the category the user is looking at. The toolbar icon is therefore NOT a
// second scan button — it opens the catalog, i.e. everything already collected
// plus the report builder. Two entry points that both said "scan" was the
// confusing part; each now has one job.
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL("catalog.html") });
});

chrome.runtime.onInstalled.addListener(() => {
  try { chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }); } catch (e) {}
  try {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({ id: "rc_image", title: "이미지를 컬렉션에 담기", contexts: ["image"] });
      chrome.contextMenus.create({ id: "rc_page", title: "이 상품을 컬렉션에 담기", contexts: ["page", "link", "selection"] });
    });
  } catch (e) {}
});
try { chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }); } catch (e) {}

const RC_KEY = "rc_store_v1";
function rcAdd(data) {
  return new Promise(res => {
    chrome.storage.local.get(RC_KEY, o => {
      const store = o[RC_KEY] || { collections: [], items: [], activeId: "" };
      if (!store.collections.length) {
        const id = "c" + Date.now();
        store.collections.push({ id, name: "리서치 " + new Date().toISOString().slice(0, 10), createdAt: Date.now() });
        store.activeId = id;
      }
      if (!store.collections.some(c => c.id === store.activeId)) store.activeId = store.collections[0].id;
      const dupe = store.items.some(i => i.collectionId === store.activeId &&
        i.product_url && i.product_url === data.product_url && i.type === data.type);
      if (!dupe) {
        store.items.push(Object.assign({
          id: "i" + Date.now() + Math.random().toString(36).slice(2, 6),
          collectionId: store.activeId, addedAt: Date.now(),
        }, data));
      }
      chrome.storage.local.set({ [RC_KEY]: store }, () => res(!dupe));
    });
  });
}
const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return ""; } };

// A context-menu click grants activeTab for that tab, so clipping works on ANY
// site with no standing host permission — the zero-permission path.
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab || !tab.id) return;
  try {
    if (info.menuItemId === "rc_image") {
      await rcAdd({
        type: "image", name: (tab.title || "").slice(0, 200), brand: "", price: "",
        image_url: info.srcUrl || "", product_url: info.linkUrl || info.pageUrl || tab.url || "",
        fabric_composition: "", colorways: "", size_range: "", category: "", design: "",
        source: hostOf(tab.url || info.pageUrl),
      });
    } else if (info.menuItemId === "rc_page") {
      const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["clip.js"] });
      const data = res && res.result;
      if (data && data.name) await rcAdd(data);
    }
    try { await chrome.sidePanel.open({ tabId: tab.id }); } catch (e) {}
  } catch (e) { /* restricted page (chrome://, web store) — nothing to clip */ }
});

// The catalog lives in IndexedDB in the extension origin. The content script
// can't reach it (it runs in the page's origin), so it posts finished scans
// here and the worker upserts them — which is also what lets the catalog tab
// and the side panel read the same data with no file passing.
try { importScripts("store.js"); } catch (e) {}

chrome.runtime.onMessage.addListener((msg, _sender, send) => {
  // A finished scan -> accumulate into the catalog.
  if (msg && msg.type === "catalogPut" && msg.scan) {
    (async () => {
      try {
        const r = await self.CatalogStore.putScan(msg.scan);
        send({ ok: true, ...r });
      } catch (e) { send({ ok: false, error: String((e && e.message) || e) }); }
    })();
    return true;
  }
  // Tell a content script which tab it runs in. A scan job is stored globally
  // (chrome.storage.local is shared by every tab), so the job records its
  // owning tab id and only that tab drives it — other tabs (e.g. the user
  // browsing another brand) must never resume or clear it.
  if (msg && msg.type === "whoami") {
    send({ tabId: (_sender && _sender.tab && _sender.tab.id != null) ? _sender.tab.id : null });
    return true;
  }
  // Save the built workbook via chrome.downloads — deterministic on every site.
  // The old in-page <a download> click is silently swallowed on some retailers
  // (Target), so the content script sends the bytes here as base64 instead.
  if (msg && msg.type === "downloadXlsx" && msg.b64 && msg.filename) {
    try {
      chrome.downloads.download({
        url: "data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64," + msg.b64,
        filename: String(msg.filename).replace(/[^\w.-]+/g, "_"),
        saveAs: false,
      }, id => {
        const err = chrome.runtime.lastError;
        send({ ok: !err && id != null, error: err && err.message });
      });
    } catch (e) { send({ ok: false, error: String((e && e.message) || e) }); }
    return true;
  }
  // Generic base64 download (e.g. the companion scan JSON for the Report app).
  if (msg && msg.type === "downloadFile" && msg.b64 && msg.filename) {
    try {
      chrome.downloads.download({
        url: "data:" + (msg.mime || "application/octet-stream") + ";base64," + msg.b64,
        filename: String(msg.filename).replace(/[^\w.-]+/g, "_"),
        saveAs: false,
      }, id => {
        const err = chrome.runtime.lastError;
        send({ ok: !err && id != null, error: err && err.message });
      });
    } catch (e) { send({ ok: false, error: String((e && e.message) || e) }); }
    return true;
  }
  if (msg && msg.type === "fetchImage" && msg.url) {
    (async () => {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 10000);
        let res;
        try { res = await fetch(msg.url, { signal: ctrl.signal }); }
        finally { clearTimeout(timer); }
        if (!res.ok) { send({ ok: false, error: "HTTP " + res.status }); return; }
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (!bytes.length || bytes.length > 8000000) { send({ ok: false, error: "size" }); return; }
        send({ ok: true, base64: toBase64(bytes), ext: detectExt(bytes) });
      } catch (e) {
        send({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;   // keep the message channel open for the async reply
  }
});
