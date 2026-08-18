/* What happens where chrome.sidePanel is not there?

   Edge is Chromium, so nearly everything this extension uses is the same API.
   The panel is the exception worth measuring: it is the product's main screen,
   and if a missing chrome.sidePanel takes the worker down with it then the
   extension is not merely reduced on that browser, it is dead.

   Edge cannot be installed here, so this simulates the one thing that differs:
   the API is removed before the worker's code runs. */
const { chromium } = require("playwright");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const REPO = path.resolve(__dirname, "..");
const COPY = "/tmp/ml-nosidepanel";

execSync(`rm -rf ${COPY} && mkdir -p ${COPY}`);
execSync(`cd ${REPO} && git ls-files | tar -cf - -T - | tar -x -C ${COPY}`);
execSync(`rm -rf ${COPY}/tests`);
// take the API away exactly as a browser without it would
const bg = fs.readFileSync(`${COPY}/background.js`, "utf8");
fs.writeFileSync(`${COPY}/background.js`,
  "try { delete self.chrome.sidePanel; } catch (e) {}\n" + bg);
const m = JSON.parse(fs.readFileSync(`${COPY}/manifest.json`, "utf8"));

(async () => {
  const ctx = await chromium.launchPersistentContext("/tmp/pw-edge", {
    executablePath: "/opt/pw-browsers/chromium", headless: false,
    args: [`--disable-extensions-except=${COPY}`, `--load-extension=${COPY}`, "--no-sandbox"] });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker");
  const id = sw.url().split("/")[2];
  await sw.evaluate(() => new Promise(r => setTimeout(r, 800)));

  console.log("worker alive without sidePanel:",
    await sw.evaluate(() => typeof chrome.runtime.getManifest === "function" &&
      chrome.runtime.getManifest().version));
  console.log("does the worker still answer messages:",
    JSON.stringify(await sw.evaluate(() => new Promise(r =>
      chrome.storage.local.set({ probe: 1 }, () => r("storage ok"))))));

  // the panel page itself, opened as a tab the way a fallback would
  const p = await ctx.newPage();
  const errs = []; p.on("pageerror", e => errs.push(e.message));
  await p.goto(`chrome-extension://${id}/sidepanel.html`);
  await p.waitForTimeout(1500);
  console.log("panel page renders as a tab:",
    (await p.locator("#runlist").count()) === 1 ? "yes" : "NO");
  console.log("panel page errors:", errs.length ? errs.join(" | ") : "none");

  const lab = await ctx.newPage();
  const lerr = []; lab.on("pageerror", e => lerr.push(e.message));
  await lab.goto(`chrome-extension://${id}/catalog.html`);
  await lab.waitForTimeout(2000);
  console.log("LAB renders:", (await lab.locator("body").innerText()).slice(0, 40).replace(/\n/g, " "));
  console.log("LAB errors:", lerr.length ? lerr.join(" | ") : "none");

  // and what the toolbar button does with no panel to open
  console.log("action.onClicked listener registered:",
    await sw.evaluate(() => chrome.action.onClicked.hasListeners()));

  await ctx.close();
})().catch(e => console.log("ERROR " + (e && e.message || e)));
