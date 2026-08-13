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
// lists.js first: the store repairs brand names on write, using the one set of
// naming rules that lives there.
try { importScripts("lists.js"); } catch (e) {}
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

/* ---- noticing that the folder was replaced ---------------------------------

   Until the team is on the Web Store, updating means replacing the folder on
   disk — and the step people skip is the one after that: reload the extension,
   refresh the tab. Nothing looks wrong when it is skipped; the old code just
   keeps running, and the next bug report is about a bug fixed a week ago.

   Chrome re-reads an unpacked extension's files on request, so the worker can
   simply look: fetch its own manifest and compare the version on disk with the
   version it is running. When they differ, update.bat (or update.command) has
   already put the new files there and the panel says so in one line, with the
   one step left.

   It does NOT reload itself. chrome.runtime.reload() unloads an unpacked
   extension and — measured, not assumed — does not reliably bring it back; an
   extension that disappears from a designer's browser is a far worse outcome
   than one click on chrome://extensions. What IS automatic is the part after
   the reload: the engine goes back into the shop tabs that are already open,
   which is what the F5 in the old instructions was for (and why "Extension
   context invalidated" used to greet anyone who skipped it). */
const DISK_CHECK = "wpb_diskcheck";
const DISK_READY = "wpb_filesready";      // { onDisk, running, at }

async function diskVersion() {
  try {
    const url = chrome.runtime.getURL("manifest.json") + "?t=" + Date.now();
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return "";
    return String(((await res.json()) || {}).version || "");
  } catch (e) { return ""; }
}

async function checkForReplacedFiles() {
  try {
    const running = chrome.runtime.getManifest().version;
    const onDisk = await diskVersion();
    const ready = onDisk && onDisk !== running ? { onDisk, running, at: Date.now() } : null;
    await new Promise(r => (ready
      ? chrome.storage.local.set({ [DISK_READY]: ready }, r)
      : chrome.storage.local.remove(DISK_READY, r)));
    try {
      chrome.action.setBadgeText({ text: ready ? "↻" : "" });
      if (ready) chrome.action.setBadgeBackgroundColor({ color: "#2e8b57" });
    } catch (e) {}
    return !!ready;
  } catch (e) { return false; }
}

/* Straight after a reload, put the engine back into the shops already open.
   The version is remembered so this runs once per new version rather than on
   every worker wake-up. */
async function reinjectOpenTabs() {
  try {
    const running = chrome.runtime.getManifest().version;
    const seen = await new Promise(r => chrome.storage.local.get("wpb_ranversion", o => r(o.wpb_ranversion || "")));
    if (seen === running) return;
    await new Promise(r => chrome.storage.local.set({ wpb_ranversion: running }, r));
    await new Promise(r => chrome.storage.local.remove(DISK_READY, r));
    try { chrome.action.setBadgeText({ text: "" }); } catch (e) {}
    if (!seen) return;                       // first ever run — nothing to refresh
    const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
    for (const t of tabs) { try { await ensureEngine(t.id); } catch (e) {} }
  } catch (e) {}
}

chrome.runtime.onStartup.addListener(() => { reinjectOpenTabs(); checkForReplacedFiles(); });
chrome.runtime.onInstalled.addListener(() => {
  reinjectOpenTabs();
  try { chrome.alarms.create(DISK_CHECK, { periodInMinutes: 5 }); } catch (e) {}
});
reinjectOpenTabs();
try { chrome.alarms.create(DISK_CHECK, { periodInMinutes: 5 }); } catch (e) {}

/* ---- a list that scans itself ---------------------------------------------

   The LAB compares week to week, and a week nobody remembered to scan is a
   hole in the trend rather than a quiet week. So a list can carry a time, and
   the worker keeps that appointment: one alarm per scheduled list, re-armed
   after every firing (`ScanLists.nextRun` decides "next", and the panel shows
   the same answer, because both call the same function).

   What it does at the appointed minute is exactly what the ▶ button does —
   open a tab on the first URL and hand the whole list to the engine. It asks
   for no permissions: there is no click to carry them, so a scheduled run
   reaches the origins the user has already allowed and reports the rest as
   unreachable, the same as a manual run would.

   Chrome only fires alarms while Chrome is running. A missed appointment
   fires shortly after the browser is next opened rather than being skipped —
   for a weekly trend, yesterday's scan arriving this morning is worth far
   more than no scan at all. */
const ALARM = "wpb_run_";

async function scheduledLists() {
  const lists = await new Promise(r => chrome.storage.local.get("wpb_lists", o => r(o.wpb_lists || [])));
  return lists.filter(l => l && l.schedule && l.schedule.on);
}

async function syncSchedules() {
  try {
    const want = await scheduledLists();
    const existing = await chrome.alarms.getAll();
    for (const a of existing) {
      if (a.name.startsWith(ALARM) && !want.some(l => ALARM + l.id === a.name))
        await chrome.alarms.clear(a.name);
    }
    for (const l of want) {
      const when = self.ScanLists.nextRun(l.schedule, Date.now());
      if (!when) { await chrome.alarms.clear(ALARM + l.id); continue; }
      const cur = existing.find(a => a.name === ALARM + l.id);
      /* Leave an alarm that already points at the right minute alone — and
         leave an EARLIER one alone too: that is a run postponed because the
         browser was busy, and re-arming it would push a delayed scan past its
         own day. Editing a list must not cost that list its appointment. */
      if (cur && (cur.scheduledTime <= when || Math.abs(cur.scheduledTime - when) < 60000)) continue;
      await chrome.alarms.create(ALARM + l.id, { when });
    }
  } catch (e) {}
}

// Start the run the same way the panel does: a foreground tab (Chrome throttles
// hidden ones until a run crawls), then the engine, then the whole list.
async function startScheduledRun(list) {
  const entries = (list.entries || []).filter(e => e.scannable !== false && /^https?:/i.test(e.url || ""));
  if (!entries.length) return;
  const tab = await chrome.tabs.create({ url: entries[0].url, active: true });
  const msg = { type: "runList", listId: list.id, name: list.name, list: entries, withSpec: true, filters: {} };
  for (let i = 0; i < 14; i++) {
    await new Promise(r => setTimeout(r, i ? 900 : 1800));
    const ok = await new Promise(res => {
      try {
        chrome.tabs.sendMessage(tab.id, msg, r => { void chrome.runtime.lastError; res(!!(r && r.ok)); });
      } catch (e) { res(false); }
    });
    if (ok) return;
    if (i === 2) await ensureEngine(tab.id).catch(() => {});
  }
}

/* Kept as its own function, not buried in the listener, so the appointment
   can be exercised without waiting for a wall clock — Chrome's part (firing at
   the minute) is verified by the alarm registration itself. */
async function onScheduleAlarm(name) {
  if (!String(name || "").startsWith(ALARM)) return;
  const id = name.slice(ALARM.length);
  let postponed = false;
  try {
    const lists = await new Promise(r => chrome.storage.local.get("wpb_lists", o => r(o.wpb_lists || [])));
    const list = lists.find(l => l.id === id);
    if (!list || !list.schedule || !list.schedule.on) return;
    /* Never start on top of a run in progress — two scans sharing one queue
       would interleave into one meaningless spreadsheet. Try again in ten
       minutes instead of dropping the appointment. */
    const q = await new Promise(r => chrome.storage.local.get("wpb_queue", o => r(o.wpb_queue || null)));
    if (q && q.active) {
      await chrome.alarms.create(name, { when: Date.now() + 10 * 60000 });
      postponed = true;                 // …and keep that minute (see below)
      return;
    }
    await startScheduledRun(list);
  } catch (e) {
  } finally {
    /* Re-arm from a moment after now, so today's slot is not picked again.
       Never when the run was postponed: `return` still runs this block, and
       replacing the ten-minute retry with tomorrow's appointment is how a busy
       morning would quietly become a skipped day. */
    if (!postponed) {
      try {
        const lists = await new Promise(r => chrome.storage.local.get("wpb_lists", o => r(o.wpb_lists || [])));
        const list = lists.find(l => l.id === id);
        const when = list && list.schedule ? self.ScanLists.nextRun(list.schedule, Date.now() + 60000) : 0;
        if (when) await chrome.alarms.create(name, { when });
      } catch (e2) {}
    }
  }
}
chrome.alarms.onAlarm.addListener(a => {
  const n = (a && a.name) || "";
  if (n === DISK_CHECK) return void checkForReplacedFiles();
  onScheduleAlarm(n);
});

chrome.runtime.onInstalled.addListener(() => { syncSchedules(); });
chrome.runtime.onStartup.addListener(() => { syncSchedules(); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.wpb_lists) syncSchedules();
});

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
  /* A list run's collected rows. The page origin cannot reach the extension's
     database, so the worker keeps them — see store.js runrows for why they are
     no longer carried in the run record itself. */
  if (msg && msg.type === "runRows") {
    (async () => {
      try {
        if (msg.op === "append") return send({ ok: true, n: await self.CatalogStore.appendRunRows(msg.runId, msg.items) });
        if (msg.op === "get") return send({ ok: true, rows: await self.CatalogStore.getRunRows(msg.runId) });
        if (msg.op === "clear") { await self.CatalogStore.clearRunRows(msg.runId); return send({ ok: true }); }
        send({ ok: false });
      } catch (e) { send({ ok: false, reason: String((e && e.message) || e) }); }
    })();
    return true;
  }
  /* Fetch a file to the user's Downloads under a name they will recognise.
     The panel cannot name a cross-origin download by itself. */
  if (msg && msg.type === "downloadUrl" && msg.url) {
    chrome.downloads.download({ url: msg.url, filename: msg.filename || "download" },
      id => send({ ok: !chrome.runtime.lastError && id != null, id }));
    return true;
  }
  if (msg && msg.type === "checkFiles") {
    checkForReplacedFiles().then(v => send({ ready: v })).catch(() => send({ ready: false }));
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
