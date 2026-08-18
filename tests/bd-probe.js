/* Chrome's own data-removal engine, run against a seeded catalog.

   The settings dialog is a front end for the same C++ removal the
   chrome.browsingData API exposes, so a test copy of the extension is given
   that permission and asked to delete everything — first exactly as the dialog
   does (unprotectedWeb, which is the only origin type it offers), then with
   originTypes.extension, which the dialog never sets. */
const { chromium } = require("playwright");
const EXT = "/tmp/ml-bd";

const TYPES = { appcache:true, cache:true, cacheStorage:true, cookies:true,
  downloads:true, fileSystems:true, formData:true, history:true, indexedDB:true,
  localStorage:true, passwords:true, serviceWorkers:true, webSQL:true };

const seed = sw => sw.evaluate(async () => {
  await new Promise(r => chrome.storage.local.set({ wpb_lists: [{ id:"L", name:"FABRIC",
    createdAt:1, entries:[{brand:"ALO YOGA",label:"New In",url:"https://aloyoga.com/c/new"}] }] }, r));
  await self.CatalogStore.putScan({ site:"aloyoga.com", listIds:["L"], items:[
    { url:"https://aloyoga.com/products/a", name:"Airbrush Tank", brand:"ALO YOGA",
      category:"New In", fabric:"Nylon", spec:"87% Nylon 13% Spandex" },
    { url:"https://aloyoga.com/products/b", name:"Ribbed Bra", brand:"ALO YOGA",
      category:"New In", fabric:"Cotton", spec:"95% Cotton 5% Elastane" }] });
  return true;
});

const count = async sw => {
  for (let i = 0; i < 3; i++) {
    const r = await sw.evaluate(async () => {
      let products, lists;
      try { products = (await self.CatalogStore.allProducts()).length; }
      catch (e) { products = "ERR:" + e.name; }
      const o = await new Promise(r2 => chrome.storage.local.get("wpb_lists", r2));
      lists = ((o || {}).wpb_lists || []).length;
      return { products, lists };
    });
    if (typeof r.products === "number") return r;
    await new Promise(r2 => setTimeout(r2, 900));      // DB was closing; let it settle
  }
  return { products: "ERR", lists: "?" };
};

(async () => {
  const ctx = await chromium.launchPersistentContext("/tmp/pw-bd", {
    executablePath: "/opt/pw-browsers/chromium", headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-sandbox"] });
  let sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker");

  await seed(sw);
  console.log("after a scan                              :", JSON.stringify(await count(sw)));

  const run = (types, originTypes) => sw.evaluate(async ([t, o]) => {
    try {
      await new Promise((res, rej) => chrome.browsingData.remove(
        Object.assign({ since: 0 }, o ? { originTypes: o } : {}), t,
        () => chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res()));
      return "ok";
    } catch (e) { return "refused: " + e.message; }
  }, [types, originTypes]);

  // 1. exactly what the dialog does: all boxes, all time, web origins
  console.log("  browsingData.remove (as the dialog does):", await run(TYPES, null));
  await new Promise(r => setTimeout(r, 1200));
  sw = ctx.serviceWorkers()[0] || sw;
  console.log("after Chrome's Clear browsing data        :", JSON.stringify(await count(sw)));

  // 2. the same, but explicitly including extension origins
  console.log("  ...now with originTypes.extension       :",
    await run(TYPES, { unprotectedWeb: true, extension: true }));
  await new Promise(r => setTimeout(r, 1500));
  sw = ctx.serviceWorkers()[0] || sw;
  console.log("after clearing WITH extension origins     :", JSON.stringify(await count(sw)));

  // make sure that ERR is really deletion and not a database still closing
  await new Promise(r => setTimeout(r, 4000));
  sw = ctx.serviceWorkers()[0] || sw;
  console.log("…and again, 4s later                      :", JSON.stringify(await count(sw)));

  await ctx.close();
})().catch(e => console.log("ERROR " + (e && e.message || e)));
