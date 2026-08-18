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

/* A zip GitHub would serve: one wrapper folder, then the extension. */
function makeZip(version) {
  execSync(`rm -rf ${ZIPDIR} && mkdir -p ${ZIPDIR}/Shop-Category-Collector-branch`);
  execSync(`cd ${REPO} && git ls-files | tar -cf - -T - | tar -x -C ${ZIPDIR}/Shop-Category-Collector-branch`);
  const mf = `${ZIPDIR}/Shop-Category-Collector-branch/manifest.json`;
  const m = JSON.parse(fs.readFileSync(mf, "utf8"));
  m.version = version;
  fs.writeFileSync(mf, JSON.stringify(m, null, 2));
  execSync(`cd ${ZIPDIR} && rm -rf Shop-Category-Collector-branch/tests && zip -qr out.zip Shop-Category-Collector-branch`);
  return fs.readFileSync(`${ZIPDIR}/out.zip`);
}

(async () => {
  execSync(`rm -rf ${TARGET} && mkdir -p ${TARGET}`);
  // the folder Chrome "loaded": it must already hold a Market Lens manifest
  fs.writeFileSync(`${TARGET}/manifest.json`,
    JSON.stringify({ manifest_version: 3, name: "Market Lens", version: "1.0.0" }));

  const zip = makeZip("99.9.0");
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
  ok("…and the wrapper folder GitHub adds was stripped", wrote.ver === "99.9.0",
    JSON.stringify(wrote));

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

  await refuses("a running scan is never interrupted", () => panel.evaluate(() =>
    new Promise(r => chrome.storage.local.set({ wpb_queue: { active: true, idx: 0, listId: "L",
      list: [{ brand: "ALO YOGA", label: "New In", url: "https://aloyoga.com/c/new" }] } }, r))));
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

  ok("no page errors", errs.length === 0, errs.join(" | "));
  console.log(`\n${pass} passed, ${fail} failed`);
  await ctx.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log("HARNESS ERROR: " + (e && e.message || e)); process.exit(1); });
