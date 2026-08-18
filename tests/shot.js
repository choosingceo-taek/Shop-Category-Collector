const { chromium } = require("playwright");
const EXT = require("path").resolve(__dirname, "..");
(async () => {
  const ctx = await chromium.launchPersistentContext("", {
    executablePath: "/opt/pw-browsers/chromium", headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-sandbox"] });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker");
  const id = sw.url().split("/")[2];
  const p = await ctx.newPage();
  await p.setViewportSize({ width: 350, height: 830 });
  const errs = []; p.on("pageerror", e => errs.push(e.message));
  const ent = (b, l, h) => ({ brand: b, label: l, url: `https://${h}/c/${l.toLowerCase().replace(/\W+/g,"-")}` });
  await p.goto(`chrome-extension://${id}/sidepanel.html`);
  await p.evaluate(es => new Promise(r => chrome.storage.local.set({ wpb_lists: [
    { id:"a", name:"FABRIC", createdAt:1, entries: es },
    { id:"b", name:"ACTIVE", createdAt:2, entries: es.slice(0,1) },
    { id:"c", name:"GRAPHIC", createdAt:3, entries: es.slice(0,1) },
  ] }, r)), [
    ent("ALO YOGA","new arrivals","aloyoga.com"), ent("LULULEMON","Women New Styles","lululemon.com"),
    ent("VUORI","womens new","vuoriclothing.com"), ent("NIKE","new womens tops t shirts","nike.com"),
    ent("ADIDAS","women shorts","adidas.com"), ent("SET ACTIVE","new","setactive.co"),
    ent("Aritzia","New Arrivals","aritzia.com"), ent("Aritzia","Sweatshirts & Hoodies","aritzia.com"),
    ent("Adanola","Tops","adanola.com"), ent("Adanola","new arrivals","adanola.com"),
    ent("Adanola","sweatpants","adanola.com"),
  ]);
  await p.reload(); await p.waitForTimeout(1500);
  await p.screenshot({ path: "shot-panel.png" });
  await p.click('.tab[data-view="products"]').catch(()=>{});
  await p.waitForTimeout(500);
  await p.screenshot({ path: "shot-products.png" });
  const lab = await ctx.newPage();
  await lab.setViewportSize({ width: 1280, height: 850 });
  lab.on("pageerror", e => errs.push("LAB " + e.message));
  await lab.goto(`chrome-extension://${id}/catalog.html`);
  await lab.waitForTimeout(2500);
  await lab.screenshot({ path: "shot-lab.png" });
  console.log(errs.length ? "ERRORS:\n"+errs.join("\n") : "no console errors");
  await ctx.close();
})();
