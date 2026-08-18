/* Draw the LAB in the current palette. The panel and the LAB share the same
   tokens, so a change to them has to be looked at on both screens or one of
   them quietly stops matching the other.

   Run: cd tests && NODE_PATH=/opt/node22/lib/node_modules xvfb-run -a node labshot.js
*/
"use strict";
const { chromium } = require("playwright");
const EXT = require("path").resolve(__dirname, "..");

const WEEKS = 6;
const BRANDS = ["ATHLETA", "GYMSHARK", "VUORI", "ALO YOGA"];
const FABRIC = ["95% Cotton 5% Elastane", "100% Linen", "88% Polyester 12% Spandex", "100% Cotton"];
const NAMES = ["Satin Slip Dress", "Linen Poplin Shirt", "Ribbed Tank", "Oversized Hoodie",
  "Ruched Midi Skirt", "Cropped Jersey Tee"];

const items = [];
const DAY = 86400000;
for (let w = 0; w < WEEKS; w++) {
  for (let i = 0; i < 14; i++) {
    const n = w * 14 + i;
    items.push({
      url: `https://example.com/p/${n}`,
      brand: BRANDS[n % BRANDS.length],
      category: "New In",
      name: NAMES[n % NAMES.length] + " " + n,
      price: "$" + (40 + (n % 9) * 10),
      image_url: "",
      fabric: FABRIC[n % FABRIC.length],
      addedAt: Date.now() - (WEEKS - w) * 7 * DAY,
      listIds: ["l0"],
    });
  }
}

(async () => {
  const ctx = await chromium.launchPersistentContext("/tmp/pw-labshot", {
    executablePath: "/opt/pw-browsers/chromium", headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-sandbox"],
  });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker");
  const id = sw.url().split("/")[2];
  const p = await ctx.newPage();
  await p.setViewportSize({ width: 1280, height: 900 });
  const errs = [];
  p.on("pageerror", e => errs.push(e.message));
  await p.goto(`chrome-extension://${id}/catalog.html`);
  await p.waitForTimeout(1200);
  await p.evaluate(l => new Promise(r => chrome.storage.local.set({
    wpb_lists: [{ id: "l0", name: "My references", createdAt: 1, entries: [] }],
  }, r)), null);
  await p.evaluate(rows => CatalogStore.putScan({ meta: { scanId: "shot" }, items: rows }), items);
  await p.reload();
  await p.waitForTimeout(2500);
  await p.screenshot({ path: "shot-lab.png" });
  console.log(errs.length ? "ERRORS:\n" + errs.join("\n") : "no page errors");
  await ctx.close();
})().catch(e => { console.log("HARNESS " + e.message); process.exit(1); });
