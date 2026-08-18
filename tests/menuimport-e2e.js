/* Import moved off its own row and onto the list (right-click a chip).

   Presence in a menu is not the contract — opening a file picker is, and a
   picker needs user activation. The menu item presses a button that is in the
   DOM but not drawn, through a synthetic click inside a real one, so this
   drives the whole chain: right-click → "Import sites…" → the picker opens →
   a real file goes in → the rows land in the OPEN list. */
const { chromium } = require("playwright");
const fs = require("fs");
const EXT = "/home/user/Fabric-Scanner";
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log("  ok  " + n); } else { fail++; console.log("FAIL  " + n + (x ? "\n      " + x : "")); } };

const SHEET = "/tmp/ml-import-list.txt";
fs.writeFileSync(SHEET, [
  "https://www.everlane.com/collections/womens-new-arrivals",
  "https://www.sezane.com/us/category/nouveautes",
].join("\n"));

(async () => {
  const ctx = await chromium.launchPersistentContext("/tmp/pw-menuimport", {
    executablePath: "/opt/pw-browsers/chromium", headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-sandbox"] });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker");
  const id = sw.url().split("/")[2];

  const panel = await ctx.newPage();
  await panel.setViewportSize({ width: 380, height: 900 });
  const errs = [];
  panel.on("pageerror", e => errs.push(e.message));
  await panel.goto(`chrome-extension://${id}/sidepanel.html`);
  await panel.waitForTimeout(500);
  await panel.evaluate(() => new Promise(r => chrome.storage.local.set({ wpb_lists: [
    { id: "a", name: "FABRIC", createdAt: 1, entries: [] },
    { id: "b", name: "ACTIVE", createdAt: 2, entries: [] },
  ] }, r)));
  await panel.reload();
  await panel.waitForTimeout(1400);

  ok("no Import button standing above the list",
    await panel.locator(".addrow button:visible").count() === 0);

  /* Opened on the SECOND list, which is not the one selected — the menu opens
     its own list first, so what is imported must land there and not in the one
     that happened to be open. */
  await panel.click('#lchips button[data-id="b"]', { button: "right" });
  await panel.waitForTimeout(300);
  const items = await panel.locator("#lmenu button").allInnerTexts();
  ok("the list's own menu offers Import", items.some(t => /import/i.test(t)), JSON.stringify(items));

  const chooser = panel.waitForEvent("filechooser", { timeout: 5000 }).catch(() => null);
  await panel.click('#lmenu button[data-t="#importbtn"]');
  const fc = await chooser;
  ok("…and pressing it opens a real file picker", !!fc);
  if (fc) {
    await fc.setFiles(SHEET);
    await panel.waitForTimeout(2000);
  }

  const stored = await panel.evaluate(() => new Promise(r =>
    chrome.storage.local.get("wpb_lists", o => r(o.wpb_lists))));
  const a = stored.find(l => l.id === "a"), b = stored.find(l => l.id === "b");
  ok("the sites land in the list the menu was opened on",
    (b.entries || []).length === 2, JSON.stringify((b.entries || []).map(e => e.url)));
  ok("…and not in the one that happened to be selected",
    (a.entries || []).length === 0, JSON.stringify((a.entries || []).map(e => e.url)));
  ok("…named by the shop, the way any other route in names them",
    (b.entries || []).every(e => e.brand && !/^https?:/i.test(e.brand)),
    JSON.stringify((b.entries || []).map(e => e.brand)));

  /* The rows are drawn without a reload — the import repaints the list it
     filled, or the designer presses Import and sees nothing happen. */
  ok("the list on screen shows them straight away",
    await panel.locator("#listbody .ent").count() === 2,
    String(await panel.locator("#listbody .ent").count()));

  ok("no page errors", errs.length === 0, errs.join(" | "));
  console.log(`\n${pass} passed, ${fail} failed`);
  await ctx.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log("HARNESS ERROR: " + (e && e.message || e)); process.exit(1); });
