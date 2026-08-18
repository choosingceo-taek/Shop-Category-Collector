/* The Data box tells the truth about where a year of scans lives.

   Measured in a real Chrome (bd-probe.js): Chrome's own removal engine, every
   data type and all time — the exact thing its Delete browsing data dialog
   runs — leaves an extension's IndexedDB and chrome.storage.local untouched.
   The catalog only goes when originTypes.extension is set, which that dialog
   does not offer. So the box must not leave the worry hanging, and must name
   what really does take it. */
const { chromium } = require("playwright");
const EXT = require("path").resolve(__dirname, "..");
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log("  ok  " + n); } else { fail++; console.log("FAIL  " + n + (x ? "\n      " + x : "")); } };

(async () => {
  const ctx = await chromium.launchPersistentContext("/tmp/pw-databox", {
    executablePath: "/opt/pw-browsers/chromium", headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-sandbox"] });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker");
  const id = sw.url().split("/")[2];
  await sw.evaluate(() => self.CatalogStore.putScan({ site:"aloyoga.com", listIds:["L"], items:[
    { url:"https://aloyoga.com/products/a", name:"Airbrush Tank", brand:"ALO YOGA",
      category:"New In", fabric:"Nylon", spec:"87% Nylon 13% Spandex" }] }));

  const lab = await ctx.newPage();
  await lab.setViewportSize({ width: 1280, height: 850 });
  const errs = []; lab.on("pageerror", e => errs.push(e.message));
  await lab.goto(`chrome-extension://${id}/catalog.html`);
  await lab.waitForTimeout(2500);

  ok("the box costs no height until it is asked for",
    await lab.locator("#databox").isHidden());
  await lab.click("#datachip");
  await lab.waitForTimeout(700);
  const facts = await lab.locator("#datafacts").innerText();

  ok("it still says the catalog is local to this browser",
    /this browser only/i.test(facts), facts);
  ok("…and settles the question people actually ask",
    /clearing your browsing data does not touch it/i.test(facts), facts);
  ok("…while naming what really does take it",
    /removing market lens/i.test(facts) && /moving its folder/i.test(facts), facts);
  ok("…and says a backup has never been taken", /never backed up/i.test(facts), facts);

  /* Taking one changes that line — otherwise the box offers a backup without
     ever saying whether the offer was taken. */
  const dl = lab.waitForEvent("download", { timeout: 15000 }).catch(() => null);
  await lab.click("#dataout");
  const got = await dl;
  ok("Back up really writes a file", !!got && /marketlens_catalog_.*\.json$/.test(got.suggestedFilename()),
    got ? got.suggestedFilename() : "no download");
  await lab.waitForTimeout(1200);
  const after = await lab.locator("#datafacts").innerText();
  ok("…and the box now says when, not 'never'",
    !/never backed up/i.test(after) && /last backup \d{4}/i.test(after), after);

  ok("no page errors", errs.length === 0, errs.join(" | "));
  console.log(`\n${pass} passed, ${fail} failed`);
  await ctx.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log("HARNESS ERROR: " + (e && e.message || e)); process.exit(1); });
