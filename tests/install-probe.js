/* The exact file a teammate downloads, unzipped into a folder and loaded the
   way they would load it. Nothing from the repo is used. */
const { chromium } = require("playwright");
(async () => {
  const ctx = await chromium.launchPersistentContext("/tmp/pw-fromzip", {
    executablePath: "/opt/pw-browsers/chromium", headless: false,
    args: ["--disable-extensions-except=/tmp/ml-fromzip",
           "--load-extension=/tmp/ml-fromzip", "--no-sandbox"] });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker");
  const id = sw.url().split("/")[2];
  await sw.evaluate(() => new Promise(r => setTimeout(r, 900)));
  const m = await sw.evaluate(() => chrome.runtime.getManifest());
  console.log("loaded:", m.name, m.version, "| id", id.slice(0, 8) + "…");

  const p = await ctx.newPage();
  const errs = []; p.on("pageerror", e => errs.push(e.message));
  await p.goto(`chrome-extension://${id}/sidepanel.html`);
  await p.waitForTimeout(1600);
  console.log("panel:", (await p.locator("#runlist").count()) === 1 ? "opens" : "MISSING",
    "| version chip:", (await p.locator("#verchip").innerText()).trim(),
    "| errors:", errs.length || "none");

  const lab = await ctx.newPage();
  const le = []; lab.on("pageerror", e => le.push(e.message));
  await lab.goto(`chrome-extension://${id}/catalog.html`);
  await lab.waitForTimeout(2200);
  console.log("LAB:", /LAB/.test(await lab.locator("body").innerText()) ? "opens" : "MISSING",
    "| errors:", le.length || "none");
  await p.screenshot({ path: "install-panel.png" });
  await ctx.close();
})().catch(e => console.log("ERROR " + (e && e.message || e)));
