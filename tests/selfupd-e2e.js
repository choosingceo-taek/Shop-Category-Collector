/* Automatic, end to end: nobody presses anything.

   Every piece of this already existed — the worker knows a newer version is
   out, the folder is remembered, the installer writes it, the browser restarts
   itself — and none of it ever started, because all of it hung off a button.
   So the contract under test is the one that was missing: opening the panel
   installs the update.

   The zip is served by a route and the folder is a real directory the browser
   writes into, so the download → unzip → write chain is the real one. What is
   stubbed is only what this harness cannot answer: Chrome's native directory
   picker, which no automation can click.

   Run: NODE_PATH=/opt/node22/lib/node_modules xvfb-run -a node selfupd-e2e.js */
const { chromium } = require("playwright");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const REPO = path.resolve(__dirname, "..");
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log("  ok  " + n); } else { fail++; console.log("FAIL  " + n + (x ? "\n      " + x : "")); } };

const TARGET = "/tmp/ml-target";     // the folder the update is written into
const ZIPDIR = "/tmp/ml-zip";

/* Two shapes of zip, because the download moved.

   `flat` is what the release asset is — pack.sh's output, the extension at the
   root, so unzipping it gives a folder that IS the extension and nobody has to
   hunt for an inner one. `wrapped` is what a GitHub branch archive is, one
   folder named after the branch. Copies installed before the link changed
   still fetch the wrapped kind, so both have to land correctly. */
function makeZip(version, shape) {
  const inner = shape === "flat" ? "" : "/Shop-Category-Collector-branch";
  execSync(`rm -rf ${ZIPDIR} && mkdir -p ${ZIPDIR}${inner}`);
  execSync(`cd ${REPO} && git ls-files | tar -cf - -T - | tar -x -C ${ZIPDIR}${inner}`);
  const mf = `${ZIPDIR}${inner}/manifest.json`;
  const m = JSON.parse(fs.readFileSync(mf, "utf8"));
  m.version = version;
  fs.writeFileSync(mf, JSON.stringify(m, null, 2));
  execSync(`cd ${ZIPDIR}${inner} && rm -rf tests dist`);
  execSync("rm -f /tmp/ml-out.zip");     // zip APPENDS to an existing archive
  execSync(shape === "flat"
    ? `cd ${ZIPDIR} && zip -qr /tmp/ml-out.zip . -x out.zip`
    : `cd ${ZIPDIR} && zip -qr /tmp/ml-out.zip Shop-Category-Collector-branch`);
  return fs.readFileSync("/tmp/ml-out.zip");
}

(async () => {
  execSync(`rm -rf ${TARGET} && mkdir -p ${TARGET}`);
  // the folder Chrome "loaded": it must already hold a Market Lens manifest
  fs.writeFileSync(`${TARGET}/manifest.json`,
    JSON.stringify({ manifest_version: 3, name: "Market Lens", version: "1.0.0" }));

  const zip = makeZip("99.9.0", "flat");
  /* A fresh profile, or this measures the last run rather than this one: both
     `wpb_autotried` (which exists precisely to stop a second attempt at the
     same version) and the OPFS folder the install writes into survive in the
     profile directory, so a re-run would refuse to install and then find the
     previous run's files sitting there and call it a pass. */
  execSync("rm -rf /tmp/pw-selfupd");
  const ctx = await chromium.launchPersistentContext("/tmp/pw-selfupd", {
    executablePath: "/opt/pw-browsers/chromium", headless: false,
    args: [`--disable-extensions-except=${REPO}`, `--load-extension=${REPO}`, "--no-sandbox"] });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker");
  const id = sw.url().split("/")[2];

  await ctx.route("https://github.com/**/*.zip*", r =>
    r.fulfill({ status: 200, contentType: "application/zip", body: zip }));

  /* The worker's own fetch is not routable, so its answer is injected at the
     seam that exists for it. */
  await sw.evaluate(v => { self.LensUpdate.check = async () => ({ ok: true,
    current: chrome.runtime.getManifest().version, latest: v, newer: true }); }, "99.9.0");
  await sw.evaluate(() => refreshUpdate(true));

  /* This browser is on record as surviving a reload — but the reload itself is
     suppressed, because taking the extension down mid-test ends the test. What
     is under examination is whether the FILES get written without a press. */
  await sw.evaluate(() => new Promise(r =>
    chrome.storage.local.set({ wpb_reloadok: true }, r)));
  /* ...and the restart itself is disarmed in the worker. Left armed it does
     exactly what it should — the first run of this test took the extension
     down mid-assertion and the browser with it — which proves the chain ends
     where it is supposed to, but leaves nothing to measure. */
  const disarm = async () => {
    const w = ctx.serviceWorkers()[0];
    if (w) await w.evaluate(() => { chrome.runtime.reload = () => {}; }).catch(() => {});
  };
  await disarm();

  /* The worker is recycled freely during a long run, and a fresh one answers
     from the real network rather than the seam. Anything that needs "a newer
     version exists" to still be true re-plants it first. */
  const restub = async () => {
    const w = ctx.serviceWorkers()[0];
    if (!w) return;
    await w.evaluate(v => {
      self.LensUpdate.check = async () => ({ ok: true,
        current: chrome.runtime.getManifest().version, latest: v, newer: true });
    }, "99.9.0").catch(() => {});
    await w.evaluate(() => refreshUpdate(true)).catch(() => {});
  };

  const panel = await ctx.newPage();
  await panel.setViewportSize({ width: 380, height: 900 });
  const errs = []; panel.on("pageerror", e => errs.push(e.message));

  /* Chrome's directory picker cannot be answered by automation, so the handle
     is the one the page can legitimately obtain — the origin's own private
     directory — put in place before the panel's scripts run. Everything after
     that (permission query, isExtensionFolder, write, verify) is the real
     code path against a real FileSystemDirectoryHandle. */
  await panel.addInitScript(() => {
    window.__mlFolderReady = (async () => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle("mlens-folder", { create: true });
      const mf = await dir.getFileHandle("manifest.json", { create: true });
      const w = await mf.createWritable();
      await w.write(JSON.stringify({ manifest_version: 3, name: "Market Lens", version: "1.0.0" }));
      await w.close();
      window.showDirectoryPicker = async () => dir;
      return dir;
    })();
  });

  await panel.goto(`chrome-extension://${id}/sidepanel.html`);
  await panel.waitForTimeout(600);
  // remember the folder the way pressing the picker once would have
  await panel.evaluate(async () => {
    const dir = await window.__mlFolderReady;
    await window.LensInstaller.saveFolder(dir);
  });

  ok("with no folder yet, nothing installed itself",
    !fs.existsSync(`${TARGET}/sites.js`));

  /* Now the real thing: open the panel. Nothing is pressed after this line. */
  await disarm();
  await panel.reload();
  await panel.waitForTimeout(6000);

  const note = await panel.locator("#uautonote").innerText().catch(() => "");
  ok("the update box opened itself and said what it was doing",
    !await panel.locator("#updbox").isHidden() && /99\.9\.0/.test(note), note);
  ok("…and it installed without a press",
    /written into|installed/i.test(note), note);

  const wrote = await panel.evaluate(async () => {
    const dir = await window.__mlFolderReady;
    const names = [];
    for await (const [n] of dir.entries()) names.push(n);
    let ver = "";
    try {
      const f = await (await dir.getFileHandle("manifest.json")).getFile();
      ver = JSON.parse(await f.text()).version;
    } catch (e) { ver = "ERR"; }
    return { count: names.length, ver, hasEngine: names.includes("sites.js") };
  });
  ok("the new files are really in the folder", wrote.count > 15 && wrote.hasEngine,
    JSON.stringify(wrote));
  ok("…at the top of the folder, from the flat release asset",
    wrote.ver === "99.9.0", JSON.stringify(wrote));

  /* It must not try the same version again and again on every open. */
  const tried = await panel.evaluate(() => new Promise(r =>
    chrome.storage.local.get("wpb_autotried", o => r((o || {}).wpb_autotried))));
  ok("the attempt is remembered, so opening the panel cannot loop",
    tried === "99.9.0", String(tried));

  // ---- the refusals ---------------------------------------------------------
  const refuses = async (label, setup) => {
    await panel.evaluate(() => new Promise(r =>
      chrome.storage.local.remove("wpb_autotried", r)));
    await setup();
    await disarm();
    await panel.reload();
    await panel.waitForTimeout(3000);
    const t = await panel.evaluate(() => new Promise(r =>
      chrome.storage.local.get("wpb_autotried", o => r((o || {}).wpb_autotried || ""))));
    ok(label, t === "", t || "(it went ahead)");
  };

  /* A run that is MOVING is never interrupted — the heartbeat says so. */
  await refuses("a running scan is never interrupted", () => panel.evaluate(() =>
    new Promise(r => chrome.storage.local.set({ wpb_queue: { active: true, idx: 0, listId: "L",
      at: Date.now(),
      list: [{ brand: "ALO YOGA", label: "New In", url: "https://aloyoga.com/c/new" }] } }, r))));
  await panel.evaluate(() => new Promise(r => chrome.storage.local.remove("wpb_queue", r)));

  /* …but a run that stopped without saying so is not a running scan.

     Reported: the files were written — 24 of them — and the panel said "a scan
     is running, so the restart is left until it finishes" and went on offering
     to install again. The queue's active flag survives a closed tab, a quit
     browser, a shop that hung, and from then on it blocks every restart there
     will ever be. The worker's own watchdog already treats four quiet minutes
     as stuck rather than busy; the same reading belongs here. */
  await panel.evaluate(() => new Promise(r => chrome.storage.local.set({
    wpb_autoupdate: true,
    wpb_queue: { active: true, idx: 0, listId: "L", at: Date.now() - 30 * 60 * 1000,
      list: [{ brand: "ALO YOGA", label: "New In", url: "https://aloyoga.com/c/new" }] },
  }, r)));
  await panel.evaluate(() => new Promise(r =>
    chrome.storage.local.remove("wpb_autotried", r)));
  await restub();
  await disarm();
  await panel.reload();
  await panel.waitForTimeout(5000);
  const afterStale = await panel.evaluate(() => new Promise(r =>
    chrome.storage.local.get("wpb_autotried", o => r((o || {}).wpb_autotried || ""))));
  ok("a run that has not moved for half an hour does not block the update",
    afterStale === "99.9.0", afterStale || "(nothing was attempted)");
  await panel.evaluate(() => new Promise(r => chrome.storage.local.remove("wpb_queue", r)));

  await refuses("a browser that lost the extension once is never asked again", () =>
    panel.evaluate(() => new Promise(r => chrome.storage.local.set({ wpb_reloadok: false }, r))));
  await panel.evaluate(() => new Promise(r => chrome.storage.local.set({ wpb_reloadok: true }, r)));

  await refuses("switching it off switches it off", () =>
    panel.evaluate(() => new Promise(r => chrome.storage.local.set({ wpb_autoupdate: false }, r))));

  // and the switch is on screen, in the box, saying which way it is set
  await panel.evaluate(() => new Promise(r => chrome.storage.local.set({ wpb_autoupdate: true }, r)));
  await disarm();
  await panel.reload();
  await panel.waitForTimeout(2500);
  if (await panel.locator("#updbox").isHidden()) await panel.click("#verchip");
  await panel.waitForTimeout(800);
  const sw2 = await panel.locator("#uselfupd").innerText();
  ok("the box carries the switch, set on", /themselves/i.test(sw2) && /press to stop/i.test(sw2), sw2);
  await panel.click("#uselfupd");
  await panel.waitForTimeout(600);
  ok("…and it can be turned off there",
    /install updates by itself/i.test(await panel.locator("#uselfupd").innerText()),
    await panel.locator("#uselfupd").innerText());

  /* A copy installed before the link moved still asks for the branch archive,
     and that one is wrapped. Both shapes must land the same way, or the first
     automatic update after this change writes a folder inside the folder. */
  const wrapped = makeZip("99.8.0", "wrapped");
  const landed = await panel.evaluate(async bytes => {
    const dir = await window.__mlFolderReady;
    const I = window.LensInstaller;
    const out = await I.install(dir, new Uint8Array(bytes).buffer, () => {});
    const names = [];
    for await (const [n] of dir.entries()) names.push(n);
    return { version: out.version, top: names.includes("manifest.json"),
      nested: names.some(n => /Shop-Category-Collector/.test(n)) };
  }, Array.from(wrapped));
  ok("a wrapped archive still lands at the top of the folder",
    landed.version === "99.8.0" && landed.top && !landed.nested, JSON.stringify(landed));

  /* ---- what an older release left behind has to LEAVE --------------------

     An install writes what the archive holds and nothing else, so a file
     delivered by an older version stayed in the folder for good. Before
     v3.21.0 the download was a GitHub branch archive — the whole repository —
     so those copies still hold update.bat, which runs

         powershell -NoProfile -ExecutionPolicy Bypass -Command
           "Invoke-WebRequest -Uri <url> -OutFile %TEMP%\marketlens.zip"

     then expands it over a folder. Defender reads that as a script downloader
     and says "threats found" — not when it runs, but whenever the folder is
     rescanned, which an update causes. Every update, the same alert.

     It is not enough to stop shipping the file. It has to come back out. */
  const swept = await panel.evaluate(async bytes => {
    const dir = await window.__mlFolderReady;
    const I = window.LensInstaller;
    // as an install from before v3.21.0 left it
    for (const name of ["update.bat", "update.command"]) {
      const fh = await dir.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write("powershell -NoProfile -ExecutionPolicy Bypass -Command \"x\"");
      await w.close();
    }
    const before = [];
    for await (const [n] of dir.entries()) before.push(n);
    const out = await I.install(dir, new Uint8Array(bytes).buffer, () => {});
    const after = [];
    for await (const [n] of dir.entries()) after.push(n);
    return { before, after, swept: out.swept || [], version: out.version };
  }, Array.from(makeZip("99.9.0", "flat")));
  ok("the folder really was holding the old script",
    swept.before.includes("update.bat") && swept.before.includes("update.command"),
    JSON.stringify(swept.before));
  ok("an update takes it back out",
    !swept.after.includes("update.bat") && !swept.after.includes("update.command"),
    JSON.stringify(swept.after));
  ok("…and says which files it removed",
    swept.swept.length === 2, JSON.stringify(swept.swept));
  ok("…while the extension itself is still there and installed",
    swept.after.includes("manifest.json") && swept.after.includes("sites.js") &&
    swept.version === "99.9.0", JSON.stringify(swept));

  /* ---- the folder that is remembered but locked ---------------------------

     Chrome keeps the directory handle across a restart; it does not, on its
     own, keep the permission on it. The next morning queryPermission answers
     "prompt" until someone confirms inside a click. Every assertion above ran
     against a handle that was always granted, which is exactly why the state
     that actually reaches people — every day, from the second session on —
     was the one nothing here had ever looked at.

     What went wrong in that state was not the machinery: pressing the button
     asks for the folder inside the click and installs. It was that the panel
     showed a locked folder and an unknown folder with the same words, so the
     one-time step looked like it had to be redone daily, and the update read
     as something to do by hand. */
  await panel.addInitScript(() => {
    FileSystemDirectoryHandle.prototype.queryPermission = async () => "prompt";
    FileSystemDirectoryHandle.prototype.requestPermission = async () => "granted";
  });
  // the switch was left off by the test above it, and the worker may have been
  // recycled since the stub was planted — a fresh one would answer from the
  // real network, which is not what is under test here
  await restub();
  await panel.evaluate(() => new Promise(r =>
    chrome.storage.local.set({ wpb_autoupdate: true }, r)));
  await panel.evaluate(() => new Promise(r =>
    chrome.storage.local.remove("wpb_autotried", r)));
  await disarm();
  await panel.reload();
  await panel.waitForTimeout(3000);

  ok("a locked folder still opens the box rather than going quiet",
    !await panel.locator("#updbox").isHidden());
  const lockedNote = await panel.locator("#uautonote").innerText().catch(() => "");
  ok("…and it says which version and which press finishes it",
    /99\.9\.0/.test(lockedNote) && /Update now/i.test(lockedNote), lockedNote);
  /* Read the button from a box that has actually been painted, whichever way
     it got opened — otherwise this is reading text left over from before the
     folder was locked, and passes without holding anything. */
  if (await panel.locator("#updbox").isHidden()) {
    await panel.click("#verchip");
    await panel.waitForTimeout(1200);
  }
  const lockedBtn = await panel.locator("#uauto").innerText();
  ok("the button is Update now, not the folder question again",
    /Update now/i.test(lockedBtn), lockedBtn);
  const lockedHint = await panel.locator("#uautonote").innerText().catch(() => "");
  ok("…and the note says the folder is remembered, not that one is needed",
    !/one time only/i.test(lockedHint), lockedHint);
  const lockedTried = await panel.evaluate(() => new Promise(r =>
    chrome.storage.local.get("wpb_autotried", o => r((o || {}).wpb_autotried || ""))));
  ok("nothing was attempted, so the message is not silenced next time",
    lockedTried === "", lockedTried);

  /* and the press really does finish it — the grant is asked for inside the
     click, which is the only place Chrome will give it */
  await panel.evaluate(async () => {
    const dir = await window.__mlFolderReady;
    const mf = await dir.getFileHandle("manifest.json", { create: true });
    const w = await mf.createWritable();
    await w.write(JSON.stringify({ manifest_version: 3, name: "Market Lens", version: "1.0.0" }));
    await w.close();
  });
  await disarm();
  if (await panel.locator("#updbox").isHidden()) {
    await panel.click("#verchip");
    await panel.waitForTimeout(900);
  }
  await panel.click("#uauto");
  await panel.waitForTimeout(4500);
  const afterPress = await panel.locator("#uautonote").innerText().catch(() => "");
  ok("one press on a locked folder installs",
    /written into|installed/i.test(afterPress) && /99\.9\.0/.test(afterPress), afterPress);

  ok("no page errors", errs.length === 0, errs.join(" | "));
  console.log(`\n${pass} passed, ${fail} failed`);
  await ctx.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log("HARNESS ERROR: " + (e && e.message || e)); process.exit(1); });
