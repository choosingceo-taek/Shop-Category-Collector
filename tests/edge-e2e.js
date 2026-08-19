/* Does this work on Edge as well as Chrome?

   Edge is Chromium, so nearly every API here is the same one. Edge cannot be
   installed on this machine, so what is measured is the single difference that
   could matter: the extension is loaded with chrome.sidePanel deleted before
   the worker's first line, which is what a browser without that API looks
   like from the inside.

   The point is not that the panel becomes a tab. It is that the toolbar button
   still does something: openPanelOnActionClick IS the button, so without a
   fallback the extension installs and then cannot be opened at all.

   Run: NODE_PATH=/opt/node22/lib/node_modules xvfb-run -a node edge-e2e.js */
const { chromium } = require("playwright");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const REPO = path.resolve(__dirname, "..");
const COPY = "/tmp/ml-nosidepanel";
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log("  ok  " + n); } else { fail++; console.log("FAIL  " + n + (x ? "\n      " + x : "")); } };

execSync(`rm -rf ${COPY} && mkdir -p ${COPY}`);
execSync(`cd ${REPO} && git ls-files | tar -cf - -T - | tar -x -C ${COPY}`);
execSync(`rm -rf ${COPY}/tests`);
const bg = fs.readFileSync(`${COPY}/background.js`, "utf8");
/* Deleting the property is not enough on its own: Chrome defines its API
   namespaces lazily, so the next access can put chrome.sidePanel back and the
   premise of this whole run quietly stops holding — every assertion after it
   is then measuring a browser that HAS a side panel. Define it away instead. */
fs.writeFileSync(`${COPY}/background.js`,
  "try { delete self.chrome.sidePanel;\n" +
  "  Object.defineProperty(self.chrome, 'sidePanel',\n" +
  "    { configurable: true, get() { return undefined; } });\n" +
  "} catch (e) {}\n" + bg);

(async () => {
  const ctx = await chromium.launchPersistentContext("/tmp/pw-edge", {
    executablePath: "/opt/pw-browsers/chromium", headless: false,
    args: [`--disable-extensions-except=${COPY}`, `--load-extension=${COPY}`, "--no-sandbox"] });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker");
  const id = sw.url().split("/")[2];
  await sw.evaluate(() => new Promise(r => setTimeout(r, 900)));

  ok("the API really is absent for this run",
    await sw.evaluate(() => typeof chrome.sidePanel === "undefined"));
  ok("the worker starts anyway",
    (await sw.evaluate(() => chrome.runtime.getManifest().version)).length > 0);
  ok("…and still answers", "storage ok" === await sw.evaluate(() =>
    new Promise(r => chrome.storage.local.set({ probe: 1 }, () => r("storage ok")))));

  /* The whole point: pressing the toolbar button must lead somewhere. */
  ok("the toolbar button has a handler of its own",
    await sw.evaluate(() => chrome.action.onClicked.hasListeners()));
  const before = ctx.pages().length;
  await sw.evaluate(() => new Promise(r => chrome.windows.getLastFocused(w =>
    { chrome.action.onClicked.dispatch ? chrome.action.onClicked.dispatch({ windowId: w.id })
      : openPanel(w.id); r(); })));
  await sw.evaluate(() => new Promise(r => setTimeout(r, 1200)));
  const opened = ctx.pages().find(p => p.url().includes("sidepanel.html"));
  ok("…and pressing it opens Market Lens", !!opened && ctx.pages().length > before,
    ctx.pages().map(p => p.url().slice(-24)).join(" | "));

  if (opened) {
    await opened.waitForTimeout(1200);
    ok("the panel is fully there in a tab",
      await opened.locator("#runlist").count() === 1 &&
      await opened.locator("#lchips").count() === 1);
    ok("…and keeps panel width instead of stretching across the window",
      await opened.evaluate(() => {
        const b = document.body;
        return b.classList.contains("astab") &&
          b.getBoundingClientRect().width <= 460;
      }));
  }

  const lab = await ctx.newPage();
  const lerr = []; lab.on("pageerror", e => lerr.push(e.message));
  await lab.goto(`chrome-extension://${id}/catalog.html`);
  await lab.waitForTimeout(2200);
  ok("the LAB opens with no side panel in the browser",
    /LAB/.test(await lab.locator("body").innerText()) && lerr.length === 0, lerr.join(" | "));

  /* Everything else this extension leans on is plain Chromium. Named here so
     a future browser question has a list to check rather than a hunch. */
  const apis = await sw.evaluate(() => ({
    storage: !!chrome.storage, alarms: !!chrome.alarms, scripting: !!chrome.scripting,
    downloads: !!chrome.downloads, tabs: !!chrome.tabs, permissions: !!chrome.permissions,
    action: !!chrome.action, runtime: !!chrome.runtime,
    decompression: typeof DecompressionStream === "function",
    indexeddb: typeof indexedDB === "object",
  }));
  ok("every other API it depends on is present",
    Object.values(apis).every(Boolean), JSON.stringify(apis));

  console.log(`\n${pass} passed, ${fail} failed`);
  await ctx.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log("HARNESS ERROR: " + (e && e.message || e)); process.exit(1); });
