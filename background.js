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

// ---- side panel --------------------------------------------------------------
// The toolbar icon opens the research companion panel. Unlike a popup it stays
// open while the user browses, which is what makes it read as a working
// assistant rather than a dialog: it reads the page, curates the scan list
// (brand categories the user re-runs weekly), shows batch progress, and leads
// to LAB. Scanning a single page stays on the in-page FAB at bottom-left —
// one job per entry point.
//
// Right-click "clip this product" lived here too and was removed: it was a
// second, quieter way to add things that nobody could tell apart from
// "Add this page", and its samples were hand-picked, so LAB had to exclude
// them anyway. Dropping it also retired the contextMenus permission.
chrome.runtime.onInstalled.addListener(() => {
  try { chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }); } catch (e) {}
});
try { chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }); } catch (e) {}

// The catalog lives in IndexedDB in the extension origin. The content script
// can't reach it (it runs in the page's origin), so it posts finished scans
// here and the worker upserts them — which is also what lets the catalog tab
// and the side panel read the same data with no file passing.
try { importScripts("store.js"); } catch (e) {}
try { importScripts("update.js"); } catch (e) {}

/* Update notice — checked at most every 6 hours, whenever the worker happens
   to be awake. When the repo carries a newer version the toolbar icon gets a
   NEW badge and the panel shows a download banner; a failed check just means
   no notice (never an error — the extension works fine without it). */
const UPDATE_KEY = "wpb_update";
async function refreshUpdate(force) {
  const cur = chrome.runtime.getManifest().version;
  const prev = await new Promise(r => chrome.storage.local.get(UPDATE_KEY, o => r(o[UPDATE_KEY] || null)));
  if (!force && prev && prev.current === cur && Date.now() - (prev.checkedAt || 0) < 6 * 3600e3) return prev;
  const res = await self.LensUpdate.check({ current: cur });
  const rec = {
    checkedAt: Date.now(), current: cur,
    ok: !!res.ok, latest: (res.ok && res.latest) || (prev && prev.latest) || "",
    newer: !!(res.ok && res.newer), zip: self.LensUpdate.ZIP,
  };
  await new Promise(r => chrome.storage.local.set({ [UPDATE_KEY]: rec }, r));
  try {
    chrome.action.setBadgeText({ text: rec.newer ? "NEW" : "" });
    if (rec.newer) chrome.action.setBadgeBackgroundColor({ color: "#d03b3b" });
  } catch (e) {}
  return rec;
}
refreshUpdate(false);

/* ---- on-demand engine injection -------------------------------------------

   The manifest injects the engine into the sites we ship support for. Anything
   else — a shop the designer finds this week — had no engine at all, so adding
   it to a list produced a row that could never be scanned no matter what the
   panel labelled it. That is the real reason "Reference" existed.

   With a granted host permission we can inject the same files ourselves, so
   ANY http(s) shop becomes scannable: the panel asks for the origin at the
   moment the user clicks (that click is the gesture Chrome requires), and this
   puts the engine in the page. Ping before injecting — a static content script
   is already there on supported sites, and injecting twice would run the
   queue-resume logic twice. */
const ENGINE_FILES = ["exceljs.min.js", "excel.js", "sites.js", "lists.js", "content.js", "fab.js"];

function pingTab(tabId, ms) {
  return new Promise(res => {
    let done = false;
    const finish = v => { if (!done) { done = true; res(v); } };
    setTimeout(() => finish(false), ms || 700);
    try {
      chrome.tabs.sendMessage(tabId, { type: "context" }, r => {
        void chrome.runtime.lastError; finish(!!r);
      });
    } catch (e) { finish(false); }
  });
}

async function ensureEngine(tabId) {
  let url = "";
  try { url = (await chrome.tabs.get(tabId)).url || ""; } catch (e) { return { ok: false, reason: "no-tab" }; }
  if (!/^https?:/i.test(url)) return { ok: false, reason: "not-a-web-page" };
  if (await pingTab(tabId)) return { ok: true, already: true };
  const origin = (() => { try { return new URL(url).origin + "/*"; } catch (e) { return ""; } })();
  const granted = origin && await new Promise(r => {
    try { chrome.permissions.contains({ origins: [origin] }, v => { void chrome.runtime.lastError; r(!!v); }); }
    catch (e) { r(false); }
  });
  if (!granted) return { ok: false, reason: "no-access", origin };
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ENGINE_FILES });
  } catch (e) { return { ok: false, reason: String((e && e.message) || e) }; }
  return { ok: await pingTab(tabId, 1500), injected: true };
}

/* Keep the grab button on every site the user has actually allowed.

   Collecting now happens on the page, at the round button in its corner — so
   a shop where that button never appears has no way in at all. The manifest
   covers the team's known list, but the whole point is finding shops that are
   NOT on it yet: the user allows the site once, and from then on Chrome must
   put the engine there by itself. A granted optional origin does not do that
   on its own; it has to be registered.

   Registered once per grant, so it survives browser restarts and applies to
   every future tab on that site. Static matches are excluded so a site the
   manifest already covers is never injected twice. */
const DYN_ID = "wpb-granted-sites";
const staticMatches = () =>
  (chrome.runtime.getManifest().content_scripts || []).flatMap(c => c.matches || []);

async function syncDynamicScripts() {
  let origins = [];
  try {
    const mf = chrome.runtime.getManifest();
    /* Only the origins the USER added. The manifest's own host_permissions are
       there so the worker can fetch images and product pages — putting the
       whole engine into raw.githubusercontent.com would be noise, and the
       shops among them already have static content scripts. */
    const builtIn = new Set(mf.host_permissions || []);
    const p = await chrome.permissions.getAll();
    origins = (p.origins || [])
      .filter(o => /^(https?|\*):\/\//i.test(o))
      .filter(o => !builtIn.has(o));
  } catch (e) { return; }
  try { await chrome.scripting.unregisterContentScripts({ ids: [DYN_ID] }); } catch (e) {}
  if (!origins.length) return;
  const script = {
    id: DYN_ID, matches: origins, js: ENGINE_FILES,
    runAt: "document_idle", allFrames: false, persistAcrossSessions: true,
  };
  try {
    await chrome.scripting.registerContentScripts([
      Object.assign({ excludeMatches: staticMatches() }, script)]);
  } catch (e) {
    /* Some Chrome builds cap how many exclude patterns one script may carry.
       Registering anyway still beats no button: a doubly-injected engine
       aborts on its own re-declared top-level bindings, and the grab button
       has always guarded itself with __wpbFabInjected. */
    try { await chrome.scripting.registerContentScripts([script]); } catch (e2) {}
  }
}
chrome.runtime.onInstalled.addListener(() => { syncDynamicScripts(); });
chrome.runtime.onStartup.addListener(() => { syncDynamicScripts(); });
try {
  chrome.permissions.onAdded.addListener(() => { syncDynamicScripts(); });
  chrome.permissions.onRemoved.addListener(() => { syncDynamicScripts(); });
} catch (e) {}

/* A list run navigates one tab through every URL. On sites without a static
   content script nothing would come back to life after each navigation, so the
   run would stop at the first such URL — re-inject as each page finishes
   loading, but only for the tab that owns the active run. */
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== "complete") return;
  chrome.storage.local.get("wpb_queue", o => {
    const q = o && o.wpb_queue;
    if (!q || !q.active || q.tabId !== tabId) return;
    ensureEngine(tabId).catch(() => {});
  });
});

chrome.runtime.onMessage.addListener((msg, _sender, send) => {
  if (msg && msg.type === "ensureEngine" && msg.tabId != null) {
    ensureEngine(msg.tabId).then(send).catch(e => send({ ok: false, reason: String(e) }));
    return true;
  }
  if (msg && msg.type === "updateStatus") {
    refreshUpdate(!!msg.force).then(send).catch(() => send(null));
    return true;
  }
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
