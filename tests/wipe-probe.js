/* "If someone clears their browsing data, do the collected products go?"

   A year of a team's scans is the answer's stake, so this does not reason from
   documentation — it seeds a real catalog in a real Chrome, runs the clearing
   a designer would actually run, and looks again.

   Three erasures, in the order a person is likely to reach for them:
     1. clearing a SHOP's cookies and site data
     2. Chrome's own Clear browsing data, "All time", every box ticked
     3. removing the extension

   Run: NODE_PATH=/opt/node22/lib/node_modules xvfb-run -a node wipe-probe.js */
const { chromium } = require("playwright");
const EXT = require("path").resolve(__dirname, "..");

const seed = async (sw) => sw.evaluate(async () => {
  await new Promise(r => chrome.storage.local.set({ wpb_lists: [
    { id: "L", name: "FABRIC", createdAt: 1,
      entries: [{ brand: "ALO YOGA", label: "New In", url: "https://aloyoga.com/collections/new" }] }] }, r));
  await self.CatalogStore.putScan({
    site: "aloyoga.com", listIds: ["L"],
    items: [
      { url: "https://aloyoga.com/products/a", name: "Airbrush Tank", brand: "ALO YOGA",
        category: "New In", fabric: "Nylon", spec: "87% Nylon 13% Spandex" },
      { url: "https://aloyoga.com/products/b", name: "Ribbed Bra", brand: "ALO YOGA",
        category: "New In", fabric: "Cotton", spec: "95% Cotton 5% Elastane" },
    ],
  });
  return true;
});

const count = async (sw) => sw.evaluate(async () => {
  let products = -1, lists = -1;
  try { products = (await self.CatalogStore.allProducts()).length; } catch (e) { products = "ERR " + e.message; }
  try {
    const o = await new Promise(r => chrome.storage.local.get("wpb_lists", r));
    lists = ((o || {}).wpb_lists || []).length;
  } catch (e) { lists = "ERR " + e.message; }
  return { products, lists };
});

(async () => {
  const ctx = await chromium.launchPersistentContext("/tmp/pw-wipe", {
    executablePath: "/opt/pw-browsers/chromium", headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-sandbox"] });
  let sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker");
  const id = sw.url().split("/")[2];

  await seed(sw);
  console.log("after a scan            :", JSON.stringify(await count(sw)));

  // --- 1. clear a SHOP's storage, the way "delete this site's data" does -----
  const shop = await ctx.newPage();
  await ctx.route("https://aloyoga.com/**", r => r.fulfill({ status: 200,
    contentType: "text/html", body: "<!doctype html><meta charset=utf-8><title>Alo</title>hello" }));
  await shop.goto("https://aloyoga.com/collections/new");
  await shop.evaluate(() => { localStorage.setItem("x", "1"); });
  const cdp = await ctx.newCDPSession(shop);
  await cdp.send("Storage.clearDataForOrigin", { origin: "https://aloyoga.com",
    storageTypes: "all" });
  await ctx.clearCookies();
  console.log("after wiping the shop   :", JSON.stringify(await count(sw)));

  // --- 2. Chrome's Clear browsing data, all time, everything ----------------
  /* Driven through the browser-level CDP the settings page itself uses. */
  const bcdp = await ctx.newCDPSession(shop);
  const types = "appcache,cookies,file_systems,indexeddb,local_storage,shader_cache," +
    "websql,service_workers,cache_storage";
  let cbdNote = "ok";
  try {
    await bcdp.send("Storage.clearDataForOrigin", { origin: "*", storageTypes: types });
  } catch (e) { cbdNote = "origin:* refused (" + e.message.split("\n")[0] + ")"; }
  console.log("after Clear browsing data (CDP, all types, origin *) :",
    JSON.stringify(await count(sw)), "|", cbdNote);

  /* And the real thing: Chrome's own settings page, All time, every box. */
  const settings = await ctx.newPage();
  let uiNote = "";
  try {
    await settings.goto("chrome://settings/clearBrowserData");
    await settings.waitForTimeout(1500);
    // the dialog lives several shadow roots deep; reach it through the DOM
    const clicked = await settings.evaluate(async () => {
      const deep = (root, sel) => {
        const out = [];
        const walk = n => {
          if (!n) return;
          if (n.shadowRoot) { out.push(...n.shadowRoot.querySelectorAll(sel)); walk2(n.shadowRoot); }
        };
        const walk2 = r => r.querySelectorAll("*").forEach(walk);
        walk(root); walk2(root);
        return out;
      };
      const d = document.querySelector("settings-ui");
      const boxes = deep(d, "cr-checkbox");
      boxes.forEach(b => { if (!b.checked) b.click(); });
      const btns = deep(d, "cr-button");
      const go = btns.find(b => /clear data/i.test(b.textContent || ""));
      if (!go) return "no Clear data button found";
      go.click();
      return `clicked (checkboxes: ${boxes.length})`;
    });
    uiNote = String(clicked);
    await settings.waitForTimeout(3500);
  } catch (e) { uiNote = "settings UI not drivable: " + e.message.split("\n")[0]; }
  // the worker may have been torn down; reattach
  sw = ctx.serviceWorkers()[0] || sw;
  console.log("after Clear browsing data (settings UI)              :",
    JSON.stringify(await count(sw)), "|", uiNote);

  console.log("\nextension id:", id);
  await ctx.close();
})().catch(e => console.log("ERROR " + (e && e.message || e)));
