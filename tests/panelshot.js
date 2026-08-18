/* Draw the panel as the designer sees it — the only way to judge whether a
   restyle actually reads. Generation, not report. */
const { chromium } = require("playwright");
const EXT = "/home/user/Fabric-Scanner";
(async () => {
  const ctx = await chromium.launchPersistentContext("", {
    executablePath: "/opt/pw-browsers/chromium", headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-sandbox"] });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker");
  const id = sw.url().split("/")[2];
  const p = await ctx.newPage();
  await p.setViewportSize({ width: 350, height: 800 });
  const errs = []; p.on("pageerror", e => errs.push(e.message));
  p.on("console", m => { if (m.type() === "error") errs.push("C:" + m.text()); });
  await p.goto(`chrome-extension://${id}/sidepanel.html`);
  await p.evaluate(() => new Promise(r => chrome.storage.local.set({ wpb_lists: [{
    id: "s1", name: "Young Women's", createdAt: 1, entries: [
      { brand: "ZARA", label: "New In", url: "https://www.zara.com/us/en/woman-new-in-l1180.html" },
      { brand: "ZARA", label: "Dresses", url: "https://www.zara.com/us/en/woman-dresses-l1066.html" },
      { brand: "COS", label: "New In", url: "https://www.cos.com/en_usd/women/new-arrivals.html" },
      { brand: "ARITZIA", label: "Tops", url: "https://www.aritzia.com/us/en/clothing/tops" },
      { brand: "EDIKTED", label: "New In", url: "https://edikted.com/collections/new-in" },
      { brand: "GYMSHARK", label: "Everyday Womens", url: "https://www.gymshark.com/collections/everyday/womens" },
      { brand: "VUORI", label: "New Arrivals", url: "https://vuoriclothing.com/collections/womens-new" },
      { brand: "ALO YOGA", label: "New In", url: "https://www.aloyoga.com/collections/new-arrivals" },
    ] }, { id: "s2", name: "Actives", createdAt: 2, entries: [] }] }, r)));
  await p.reload(); await p.waitForTimeout(1400);
  await p.screenshot({ path: "shot-panel-boxes.png" });
  await p.click('.tab[data-view="products"]').catch(() => {});
  await p.waitForTimeout(500);
  await p.screenshot({ path: "shot-panel-products.png" });
  console.log(errs.length ? "ERRORS:\n" + errs.join("\n") : "no console errors");
  await ctx.close();
})();
