/* Does a new version actually reach the person?

   The check itself was never the problem — it worked, wrote a NEW badge, and
   the panel chip read "v3.11.0 → 3.12.0". What it did not do was survive:
   three functions wrote the toolbar badge and two of them cleared it
   unconditionally, one of those on a five-minute alarm. Measured before the
   fix: badge "NEW" → one disk check → "". So the mark existed for at most five
   minutes and the stored record went on saying a newer version was out.

   And a badge is only seen by someone already looking at the toolbar, which
   is not where a designer is. So the second half is a real notification,
   asked for by a click because it is an optional permission.

   Run with NODE_PATH set to the global node_modules. */
const { chromium } = require("playwright");
const EXT = require("path").resolve(__dirname, "..");
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log("  ok  " + n); } else { fail++; console.log("FAIL  " + n + (x ? "\n      " + x : "")); } };

/* The worker's own fetch is not reachable by ctx.route, so the network answer
   is injected at the one seam that exists for it (LensUpdate.check already
   takes an injectable fetch for the Node suite). */
const SAY_NEWER = `(() => {
  self.__realCheck = self.__realCheck || self.LensUpdate.check;
  self.LensUpdate.check = async () => ({ ok: true,
    current: chrome.runtime.getManifest().version, latest: "99.0.0", newer: true });
})()`;

(async () => {
  const ctx = await chromium.launchPersistentContext("/tmp/pw-updnote-e2e", {
    executablePath: "/opt/pw-browsers/chromium", headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-sandbox"] });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker");
  const id = sw.url().split("/")[2];
  const badge = () => sw.evaluate(() => chrome.action.getBadgeText({}));
  const wait = ms => sw.evaluate(m => new Promise(r => setTimeout(r, m)), ms);

  // ---- the mark appears, and stays ------------------------------------------
  await sw.evaluate(SAY_NEWER);
  const rec = await sw.evaluate(() => refreshUpdate(true));
  ok("the check finds the newer version", rec && rec.newer === true && rec.latest === "99.0.0",
    JSON.stringify(rec));
  await wait(300);
  ok("…and the toolbar says NEW", await badge() === "NEW", JSON.stringify(await badge()));

  /* The five-minute disk watcher used to write "" here, wiping it. */
  await sw.evaluate(() => checkForReplacedFiles());
  await wait(400);
  ok("a disk check does not erase it", await badge() === "NEW", JSON.stringify(await badge()));

  /* Nor does the pass that runs once after a new version starts. */
  await sw.evaluate(() => new Promise(r => chrome.storage.local.remove("wpb_ranversion", r)));
  await sw.evaluate(() => reinjectOpenTabs());
  await wait(400);
  ok("nor does the first run of a new version", await badge() === "NEW", JSON.stringify(await badge()));

  /* Files already in the folder are closer to done than a download, so that
     mark wins — and the NEW mark comes back when they are no longer there. */
  await sw.evaluate(() => new Promise(r =>
    chrome.storage.local.set({ wpb_filesready: { onDisk: "99.0.0", running: "1.0.0", at: Date.now() } }, r)));
  await sw.evaluate(() => paintBadge());
  await wait(250);
  ok("files waiting in the folder outrank a download", await badge() === "↻",
    JSON.stringify(await badge()));
  await sw.evaluate(() => new Promise(r => chrome.storage.local.remove("wpb_filesready", r)));
  await sw.evaluate(() => paintBadge());
  await wait(250);
  ok("…and NEW returns when they are gone", await badge() === "NEW", JSON.stringify(await badge()));

  // ---- the repo is consulted without anyone opening the panel ---------------
  const alarmWired = await sw.evaluate(async () => {
    const a = await chrome.alarms.get("wpb_diskcheck");
    return a ? Math.round(a.periodInMinutes) : 0;
  });
  ok("a recurring alarm exists to do the asking", alarmWired === 5, String(alarmWired));

  // ---- the notification ------------------------------------------------------
  const manifest = await sw.evaluate(() => chrome.runtime.getManifest());
  ok("notifications is optional, not required",
    (manifest.optional_permissions || []).includes("notifications") &&
    !(manifest.permissions || []).includes("notifications"),
    JSON.stringify([manifest.permissions, manifest.optional_permissions]));

  ok("without the permission nothing is announced and nothing throws",
    await sw.evaluate(() => announceUpdate({ newer: true, latest: "99.0.0", current: "1.0.0" })) === false);

  /* Granted, it fires — once. A notice that comes back every five minutes is
     one people learn to dismiss without reading.

     The grant itself is not made here: chrome.permissions.request needs a
     gesture, which a worker evaluation does not have, and Chrome's own
     confirmation bubble is not something this harness can answer. So the
     permission answer is stubbed and what is under test is the behaviour that
     depends on it — the panel side, that a click really does the asking, is
     checked below. */
  const shown = await sw.evaluate(async () => {
    const realCan = self.canNotify;
    self.canNotify = async () => true;
    const seen = [];
    self.chrome.notifications = self.chrome.notifications ||
      { create: null, onClicked: { addListener() {} }, clear() {} };
    const realCreate = chrome.notifications.create;
    chrome.notifications.create = (i, o, cb) => { seen.push(o); if (cb) cb(i); };
    await new Promise(r => chrome.storage.local.remove("wpb_notifiedfor", r));
    await announceUpdate({ newer: true, latest: "99.0.0", current: "1.0.0" });
    await announceUpdate({ newer: true, latest: "99.0.0", current: "1.0.0" });
    await announceUpdate({ newer: true, latest: "99.1.0", current: "1.0.0" });
    const quiet = await announceUpdate({ newer: false, latest: "99.1.0", current: "99.1.0" });
    chrome.notifications.create = realCreate;
    self.canNotify = realCan;
    return { seen, quiet };
  });
  ok("granted, a new version raises a notification", shown.seen.length >= 1,
    JSON.stringify(shown.seen.map(s => s.title)));
  ok("…which names the version and what to do",
    /99\.0\.0/.test(shown.seen[0].title) && /press the version/i.test(shown.seen[0].message),
    JSON.stringify(shown.seen[0]));
  ok("…said once per version, not on every check", shown.seen.length === 2,
    JSON.stringify(shown.seen.map(s => s.title)));
  ok("…and nothing at all when there is nothing newer", shown.quiet === false);

  // ---- the panel offers it where the person is thinking about updates -------
  const panel = await ctx.newPage();
  await panel.setViewportSize({ width: 380, height: 900 });
  const errs = []; panel.on("pageerror", e => errs.push(e.message));
  await panel.goto(`chrome-extension://${id}/sidepanel.html`);
  await panel.waitForTimeout(1200);
  ok("the offer is not on screen until the update box is opened",
    await panel.locator("#unotify").isHidden());
  await panel.click("#verchip");
  await panel.waitForTimeout(900);
  const label = await panel.locator("#unotify").innerText();
  ok("…and it is there once it is", await panel.locator("#unotify").isVisible(), label);
  ok("…saying what it will do in words, not a switch",
    /new version/i.test(label), label);

  /* Chrome grants only inside the gesture, and the first await spends it — so
     the handler must call request() straight out of the click rather than
     checking the current state first. Watched here on a real click. */
  const asked = await panel.evaluate(() => new Promise(res => {
    const real = chrome.permissions.request;
    let awaited = false;
    const p = Promise.resolve(); p.then(() => { awaited = true; });
    chrome.permissions.request = (o, cb) => {
      chrome.permissions.request = real;
      res({ perms: (o || {}).permissions || [], afterAwait: awaited });
      if (cb) cb(false);
    };
    document.querySelector("#unotify").click();
    setTimeout(() => res({ perms: [], afterAwait: null }), 2000);
  }));
  ok("pressing it asks Chrome for the permission", asked.perms.includes("notifications"),
    JSON.stringify(asked));
  ok("…inside the click, before anything is awaited", asked.afterAwait === false,
    JSON.stringify(asked));

  /* A check that cannot be made must not draw what a successful one draws.
     The repository is private, so raw.githubusercontent.com answers 404 to
     every request this extension can make — and for release after release
     that failure was painted as "you are up to date".

     Driven through the worker rather than by stubbing the panel's own
     sendMessage: the chip is repainted by the startup check, and the one on
     opening the box sits behind a `knownFolder() &&` that short-circuits when
     no folder has been chosen. */
  await sw.evaluate(() => new Promise(r => chrome.storage.local.remove("wpb_update", r)));
  await sw.evaluate(() => { self.LensUpdate.check = async () => ({ ok: false }); });
  await panel.reload();
  await panel.waitForTimeout(1600);
  const unsure = await panel.evaluate(() => {
    const c = document.querySelector("#verchip");
    return { text: c.textContent, cls: c.className, title: c.title }; });
  ok("a check that could not be made says so on the chip",
    /\?/.test(unsure.text) && /unsure/.test(unsure.cls), JSON.stringify(unsure));
  ok("…and never claims to be the latest",
    !/the latest/i.test(unsure.title) && /could not reach/i.test(unsure.title),
    JSON.stringify(unsure));

  /* Fear of losing a year of scans is a reason to put an update off, and
     putting it off is what this box exists to cure. Measured before it was
     written (update-keeps-probe): an older build collected, the folder was
     overwritten with a newer one across a database version bump, and the
     catalog came back whole. */
  await panel.click("#verchip");
  await panel.waitForTimeout(600);
  const keep = await panel.locator(".ukeep").innerText();
  ok("the update box says what an update does to the data",
    /keeps everything/i.test(keep) && /same folder/i.test(keep), keep);

  /* The folder is not automatically the newest thing.

     Reported from a real panel: the chip read `v3.33.0 → 3.36.0` while the
     banner underneath said "Version 3.35.0 is in your folder, ready to run" —
     an install that had landed earlier. Pressing the one button there restarts
     onto 3.35.0, which is already behind, and the chip goes on saying a newer
     one exists. One-click update never reaches the newest version. So the
     newer of the two decides which banner this is. */
  await sw.evaluate(() => { self.LensUpdate.check = async () => ({
    ok: true, current: chrome.runtime.getManifest().version, latest: "99.0.0", newer: true }); });
  /* The folder record is written by the worker's own disk check, and opening
     the panel asks for that check — so the state is set up by telling the
     worker what the folder holds, not by writing the record behind its back
     (which it would immediately correct). */
  await sw.evaluate(() => { self.diskVersion = async () => "3.35.0"; });
  await sw.evaluate(() => checkForReplacedFiles());
  await panel.reload();
  await panel.waitForTimeout(1800);
  ok("a folder holding an older build does not offer the restart",
    await panel.locator("#upready").isHidden());
  ok("…it offers the install that reaches the newest",
    await panel.locator("#upnote").isVisible(),
    await panel.locator("#upnote").innerText().catch(() => "(absent)"));
  ok("…and says what the folder is currently holding",
    /3\.35\.0/.test(await panel.locator("#updisk").innerText().catch(() => "")),
    await panel.locator("#updisk").innerText().catch(() => "(absent)"));

  /* And once the folder holds the newest, the restart is the whole job — that
     banner has to come back, or the install runs forever. */
  await sw.evaluate(() => { self.diskVersion = async () => "99.0.0"; });
  await sw.evaluate(() => checkForReplacedFiles());
  await panel.reload();
  await panel.waitForTimeout(1800);
  ok("with the newest in the folder, the restart is what is offered",
    await panel.locator("#upready").isVisible() && await panel.locator("#upnote").isHidden(),
    await panel.locator("#upready").innerText().catch(() => "(absent)"));

  ok("no page errors", errs.length === 0, errs.join(" | "));
  console.log(`\n${pass} passed, ${fail} failed`);
  await ctx.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log("HARNESS ERROR: " + (e && e.message || e)); process.exit(1); });
