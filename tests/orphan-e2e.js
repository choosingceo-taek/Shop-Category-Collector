/* A list reorganised leaves products behind. Count them, name them, and let
   the person decide.

   Asked: after tidying the URL list and re-scanning, should the products the
   dropped addresses collected stay or go?

   Neither, on its own. Removing them silently is a catalog shrinking without
   being asked (v1.82.0: nothing is ever deleted on a timer), and leaving them
   unmarked is what produced the screen that raised the question — a list of
   eight shops beside a wall of 432 products from eleven.

   So: the leftovers are countable, by shop and by number, in the Data box
   where the other housekeeping lives, and they only ever go when the button is
   pressed. What this test holds:

     · a row whose address is still in a list is never counted
     · a row whose address was dropped is
     · a row TWO addresses collected survives while either one remains
     · rows collected before pages were recorded are matched on the pair the
       list row shows (brand · category), and only when no surviving address
       claims that pair
     · with no addresses at all it refuses — every row would look orphaned, and
       "all of them" is how a catalog gets emptied by accident
     · the number offered is the number removed

   Run: NODE_PATH=/opt/node22/lib/node_modules xvfb-run -a node orphan-e2e.js */
"use strict";
const { chromium } = require("playwright");
const path = require("path");
const { execSync } = require("child_process");
const EXT = path.resolve(__dirname, "..");

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log("  ok  " + n); } else { fail++; console.log("FAIL  " + n + (x ? "\n      " + x : "")); } };

const SHOP = "https://www.everlane.com";
const KEPT = `${SHOP}/collections/new-in`;      // stays in the list
const DROPPED = `${SHOP}/collections/tops`;     // taken out of the list
const sig = u => u.replace(/^https?:\/\/(www\.)?/, "") + "||";

/* The list AFTER the tidy-up: one address, where there used to be two. */
const LISTS = [{ id: "F", name: "FABRIC", createdAt: 1, entries: [
  { brand: "EVERLANE", label: "New In", scannable: true, url: KEPT },
] }];

const mk = (n, over) => Object.assign({
  brand: "EVERLANE", category: "New In", name: `Piece ${n}`,
  product_url: `${SHOP}/products/piece-${n}`,
  image_url: "https://cdn.example/x.jpg", fabric_composition: "100% Cotton",
  price: "$40.00", addedAt: Date.UTC(2026, 7, 18) + n * 1000, listIds: ["F"],
}, over || {});

/* Six rows, in the four shapes that matter. */
const ROWS = [
  mk(1, { pages: [sig(KEPT)] }),                              // still asked for
  mk(2, { pages: [sig(KEPT)] }),
  mk(3, { pages: [sig(DROPPED)], category: "Tops" }),         // dropped address
  mk(4, { pages: [sig(DROPPED)], category: "Tops" }),
  mk(5, { pages: [sig(KEPT), sig(DROPPED)] }),                // both had it
  // collected before rows recorded their page: only the pair says where it is
  mk(6, { category: "Tops", brand: "TALA", pages: undefined }),
];

(async () => {
  execSync("rm -rf /tmp/pw-orphan");
  const ctx = await chromium.launchPersistentContext("/tmp/pw-orphan", {
    executablePath: "/opt/pw-browsers/chromium", headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-sandbox"] });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker");
  const id = sw.url().split("/")[2];

  const p = await ctx.newPage();
  const errs = []; p.on("pageerror", e => errs.push(e.message));
  await p.goto(`chrome-extension://${id}/catalog.html`);
  await p.waitForTimeout(1500);
  await p.evaluate(async ({ rows, lists }) => {
    await new Promise(r => chrome.storage.local.set({ wpb_lists: lists }, r));
    await window.CatalogStore.putScan({ meta: { scanId: "orph" }, items: rows });
    // putScan stamps its own addedAt; put the fixture's back
    await Promise.all(rows.map(async r => {
      const k = window.CatalogStore.productKey(r);
      const got = await window.CatalogStore.getMany([k]);
      const rec = got[k];
      if (!rec) return;
      rec.addedAt = r.addedAt;
      if (r.pages) rec.pages = r.pages; else delete rec.pages;
      await new Promise(res => {
        const req = indexedDB.open("shopcat");
        req.onsuccess = () => {
          const t = req.result.transaction("products", "readwrite");
          t.objectStore("products").put(rec);
          t.oncomplete = () => res();
        };
      });
    }));
  }, { rows: ROWS, lists: LISTS });
  await p.reload();
  await p.waitForTimeout(2000);

  const live = await p.evaluate(() => {
    const sigs = [], pairs = [];
    return new Promise(r => chrome.storage.local.get("wpb_lists", o => {
      (o.wpb_lists || []).forEach(l => (l.entries || []).forEach(e => {
        sigs.push(window.ScanLists.pageSig(e.url));
        pairs.push(String(e.brand || "").trim().toLowerCase() + " :: " +
          String(e.label || "").trim().toLowerCase());
      }));
      r({ sigs, pairs });
    }));
  });

  const found = await p.evaluate(l =>
    window.CatalogStore.orphans(Object.assign({ dry: true }, l)), live);
  console.log(`    (${found.total} of 6 from addresses no longer listed · ` +
    found.brands.map(b => b.join(" ")).join(" · ") + ")");

  ok("the rows the surviving address collects are not counted",
    found.total === 3, `${found.total} counted, expected 3`);
  ok("…and a garment BOTH addresses had is one of the survivors",
    !found.keys.some(k => /piece-5$/.test(k)), JSON.stringify(found.keys));
  ok("the dropped address's rows are counted",
    found.keys.filter(k => /piece-3$|piece-4$/.test(k)).length === 2,
    JSON.stringify(found.keys));
  ok("…and so is a row from before pages were recorded",
    found.keys.some(k => /piece-6$/.test(k)), JSON.stringify(found.keys));
  ok("it says which shops they came from",
    found.brands.some(([b]) => b === "TALA") && found.brands.some(([b]) => b === "EVERLANE"),
    JSON.stringify(found.brands));

  /* The guard. With nothing to compare against, everything looks orphaned. */
  const refused = await p.evaluate(() =>
    window.CatalogStore.orphans({ sigs: [], pairs: [], dry: true }));
  ok("with no addresses at all it refuses rather than answering 'all of them'",
    refused.refused === true && refused.total === 0, JSON.stringify(refused));

  /* The Data box says it, with the number, and only offers. */
  await p.click("#datachip");
  await p.waitForTimeout(600);
  const btn = await p.evaluate(() => {
    const b = document.querySelector("#dataorph");
    return { hidden: !b || b.hidden, text: b ? b.textContent.trim() : "",
      title: b ? b.title : "" };
  });
  ok("the Data box offers to remove them, with the count on the button",
    !btn.hidden && /\b3 products\b/.test(btn.text), JSON.stringify(btn));
  ok("…and names the shops in the tooltip", /TALA/.test(btn.title), btn.title);

  const before = await p.evaluate(() => window.CatalogStore.allProducts().then(r => r.length));
  ok("nothing has been removed by looking at it", before === 6, String(before));

  // the number offered is the number that goes
  const gone = await p.evaluate(l => window.CatalogStore.forgetOrphans(l), live);
  const after = await p.evaluate(() => window.CatalogStore.allProducts()
    .then(r => r.map(x => x.product_url)));
  ok("pressing it removes exactly that many", gone.removed === 3, JSON.stringify(gone));
  ok("…and what is left is what the list still asks for",
    after.length === 3 && after.every(u => /piece-(1|2|5)$/.test(u)),
    JSON.stringify(after));

  ok("no page errors", errs.length === 0, errs.join(" | "));
  console.log(`\n${pass} passed, ${fail} failed`);
  await ctx.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log("HARNESS ERROR: " + (e && e.message || e)); process.exit(1); });
