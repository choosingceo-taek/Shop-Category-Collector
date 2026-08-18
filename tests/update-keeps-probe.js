/* "Does updating the version wipe the collected data?"

   Read out of the code, the answer is no: the IndexedDB upgrade handler only
   ever creates a store it does not already have. But reading is not measuring,
   and the stake is a year of a team's scans — so this performs a real update.

   An older build is put in a folder and used to collect. The browser is
   closed. The folder is overwritten with the new build, exactly as ⚡ Update
   now and as unzipping over the folder both do. The browser comes back on the
   same profile and the same folder, and the catalog is counted again.

   Then the way that DOES lose it: the same new build loaded from a DIFFERENT
   folder — because an unpacked extension's identity is its path.

   Run: NODE_PATH=/opt/node22/lib/node_modules xvfb-run -a node update-keeps-probe.js */
const { chromium } = require("playwright");
const { execSync } = require("child_process");
const fs = require("fs");
const REPO = require("path").resolve(__dirname, "..");

const LIVE = "/tmp/ml-live";          // the folder Chrome is pointed at
const MOVED = "/tmp/ml-moved";        // the same build, somewhere else
const PROFILE = "/tmp/pw-upkeep";

const build = (dest, ref) => {
  execSync(`rm -rf ${dest} && mkdir -p ${dest}`);
  if (ref) execSync(`cd ${REPO} && git archive ${ref} | tar -x -C ${dest}`);
  else execSync(`cd ${REPO} && git ls-files | tar -cf - -T - | tar -x -C ${dest}`);
  execSync(`rm -rf ${dest}/tests`);
};

const open = async (folder) => {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: "/opt/pw-browsers/chromium", headless: false,
    args: [`--disable-extensions-except=${folder}`, `--load-extension=${folder}`, "--no-sandbox"] });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker");
  await sw.evaluate(() => new Promise(r => setTimeout(r, 600)));
  return { ctx, sw, id: sw.url().split("/")[2] };
};

const count = async (sw) => sw.evaluate(async () => {
  let products = "ERR", lists = 0, ver = "";
  try { ver = chrome.runtime.getManifest().version; } catch (e) {}
  try { products = (await self.CatalogStore.allProducts()).length; }
  catch (e) { products = "ERR:" + e.message.slice(0, 40); }
  try {
    const o = await new Promise(r => chrome.storage.local.get("wpb_lists", r));
    lists = ((o || {}).wpb_lists || []).length;
  } catch (e) {}
  return { version: ver, products, lists };
});

(async () => {
  execSync(`rm -rf ${PROFILE}`);

  // ---- an older build, with the catalog at an older database version -------
  build(LIVE, "10ff196");                                  // v3.11.0
  const s = fs.readFileSync(LIVE + "/store.js", "utf8");
  fs.writeFileSync(LIVE + "/store.js", s.replace('VER = 4', 'VER = 3'));
  console.log("installed  :", JSON.parse(fs.readFileSync(LIVE + "/manifest.json", "utf8")).version,
    "(database at v3, to force an upgrade on the way in)");

  let { ctx, sw, id } = await open(LIVE);
  const idBefore = id;
  await sw.evaluate(() => new Promise(async r => {
    chrome.storage.local.set({ wpb_lists: [{ id: "L", name: "FABRIC", createdAt: 1,
      entries: [{ brand: "ALO YOGA", label: "New In", url: "https://aloyoga.com/c/new" }] }] }, async () => {
      await self.CatalogStore.putScan({ site: "aloyoga.com", listIds: ["L"], items: [
        { url: "https://aloyoga.com/products/a", name: "Airbrush Tank", brand: "ALO YOGA",
          category: "New In", fabric: "Nylon", spec: "87% Nylon 13% Spandex" },
        { url: "https://aloyoga.com/products/b", name: "Ribbed Bra", brand: "ALO YOGA",
          category: "New In", fabric: "Cotton", spec: "95% Cotton 5% Elastane" },
        { url: "https://aloyoga.com/products/c", name: "Sueded Legging", brand: "ALO YOGA",
          category: "New In", fabric: "Polyester", spec: "78% Polyester 22% Elastane" }] });
      r();
    });
  }));
  console.log("after scans:", JSON.stringify(await count(sw)));
  await ctx.close();

  // ---- the update: same folder, new files ---------------------------------
  build(LIVE, null);                                        // current working tree
  console.log("\noverwrote the SAME folder with the new build (what ⚡ Update now does)");
  ({ ctx, sw, id } = await open(LIVE));
  console.log("after update:", JSON.stringify(await count(sw)),
    "| same extension id:", id === idBefore);
  await ctx.close();

  // ---- the way it IS lost: the same build from another folder --------------
  build(MOVED, null);
  ({ ctx, sw, id } = await open(MOVED));
  console.log("\nsame build, DIFFERENT folder:", JSON.stringify(await count(sw)),
    "| same extension id:", id === idBefore);
  await ctx.close();
})().catch(e => console.log("ERROR " + (e && e.message || e)));
