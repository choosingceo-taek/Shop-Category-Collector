/* Taking an address out of a list takes out what it collected.

   Asked for: "LIST내 URL리스트 중 기존에 SCRAPPING했던 URL를 없애면 해당 상품
   정보들은 LAB에서도 자동 없어지도록." Removing the row used to remove only the
   plan — everything that address had already scraped stayed in the catalog, so
   PRODUCTS and the LAB went on counting a page the list says is gone, and the
   only way to undo a scan was to empty the whole catalog.

   What has to hold, and why each one is its own test:

     · the products that address collected go, and the LAB stops showing them
     · a garment ANOTHER saved address also collects stays — the shared rows
       here are the ones that would be lost by a careless "delete this brand"
     · rows scanned before this release carry no record of the page they came
       off, so they are matched on the pair the list row itself shows (brand ·
       category) — and only when no surviving address claims that pair
     · the person is told the number BEFORE pressing, and it is the number that
       is actually removed
     · the last address out empties the catalog, leaving nothing orphaned

   Run: NODE_PATH=/opt/node22/lib/node_modules xvfb-run -a node unfile-e2e.js */
"use strict";
const { chromium } = require("playwright");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const EXT = path.resolve(__dirname, "..");

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log("  ok  " + n); } else { fail++; console.log("FAIL  " + n + (x ? "\n      " + x : "")); } };

const CDN = "https://cdn.everlane.example";
const NEWIN = [0, 1, 2, 3, 4, 5];        // the New In page
const TOPS = [4, 5, 6, 7, 8, 9];         // the Tops page — 4 and 5 are on both
const nameOf = i => `Seamless Piece ${i}`;

const tile = i => `
  <li class="product-card">
    <a href="/products/piece-${i}"><img src="${CDN}/p${i}.jpg" alt="${nameOf(i)}"></a>
    <h3 class="title"><a href="/products/piece-${i}">${nameOf(i)}</a></h3>
    <div class="price">$${40 + i}.00</div>
  </li>`;

const listing = (title, ids) => `<!doctype html><meta charset="utf-8">
<title>${title} | Everlane</title><h1>${title}</h1>
<ul class="product-grid">${ids.map(tile).join("")}</ul>`;

const pdp = i => `<!doctype html><meta charset="utf-8"><title>${nameOf(i)}</title>
<meta property="og:image" content="${CDN}/p${i}.jpg">
<h3>Composition</h3><ul><li>95% Cotton, 5% Elastane</li><li>Machine wash cold</li></ul>`;

const PORT = 8481;
const HOSTS = ["www.everlane.com", "cdn.everlane.example"];
const GIF = Buffer.from("R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==", "base64");

if (!fs.existsSync("/tmp/ml-key.pem")) {
  execSync('openssl req -x509 -newkey rsa:2048 -nodes -keyout /tmp/ml-key.pem ' +
    '-out /tmp/ml-cert.pem -days 365 -subj "/CN=localhost" 2>/dev/null');
}
const server = https.createServer(
  { key: fs.readFileSync("/tmp/ml-key.pem"), cert: fs.readFileSync("/tmp/ml-cert.pem") },
  (req, res) => {
    const host = String(req.headers.host || "").split(":")[0];
    const url = req.url || "/";
    const send = (b, t) => { res.writeHead(200, { "content-type": t || "text/html; charset=utf-8" }); res.end(b); };
    if (host === "cdn.everlane.example") return send(GIF, "image/gif");
    const m = url.match(/\/products\/piece-(\d+)/);
    if (m) return send(pdp(+m[1]));
    if (/\/collections\/tops/.test(url)) return send(listing("Tops", TOPS));
    return send(listing("New In", NEWIN));
  });
const serverReady = new Promise(r => server.listen(PORT, "127.0.0.1", r));

const BASE = "https://www.everlane.com";
const ENTRIES = [
  { brand: "EVERLANE", label: "New In", scannable: true, url: `${BASE}/collections/new-in` },
  { brand: "EVERLANE", label: "Tops", scannable: true, url: `${BASE}/collections/tops` },
];

const rowsIn = sw => sw.evaluate(() => self.CatalogStore.allProducts().then(p =>
  p.map(x => ({ name: x.name, url: x.product_url, pages: x.pages || [] })))).catch(() => []);

(async () => {
  const MAP = HOSTS.map(h => `MAP ${h} 127.0.0.1:${PORT}`).join(",");
  execSync("rm -rf /tmp/pw-unfile");
  const ctx = await chromium.launchPersistentContext("/tmp/pw-unfile", {
    executablePath: "/opt/pw-browsers/chromium", headless: false, ignoreHTTPSErrors: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-sandbox",
      `--host-resolver-rules=${MAP}`, "--ignore-certificate-errors", "--no-proxy-server"] });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker");
  const id = sw.url().split("/")[2];
  await serverReady;

  const panel = await ctx.newPage();
  await panel.setViewportSize({ width: 400, height: 900 });
  const errs = []; panel.on("pageerror", e => errs.push(e.message));
  await panel.goto(`chrome-extension://${id}/sidepanel.html`);
  await panel.waitForTimeout(1200);
  await panel.evaluate(es => new Promise(r => chrome.storage.local.set({
    wpb_autoupdate: false,
    wpb_lists: [{ id: "U", name: "ACTIVE", createdAt: 1, entries: es }] }, r)), ENTRIES);
  await panel.reload();
  await panel.waitForTimeout(1400);
  await panel.click("#runlist");
  await panel.waitForTimeout(600);
  if (!await panel.locator("#ask").isHidden()) await panel.click("#askok");

  let rows = [], waited = 0;
  while (waited < 150000) {
    await panel.waitForTimeout(2500); waited += 2500;
    rows = await rowsIn(sw);
    const q = await panel.evaluate(() => new Promise(r =>
      chrome.storage.local.get("wpb_queue", o => r((o || {}).wpb_queue || {}))));
    if (!q.active && rows.length >= 10) break;
    if (!q.active && waited > 30000) break;
  }
  console.log(`    (${rows.length} products from two pages)`);
  ok("both pages were collected", rows.length === 10, `${rows.length} rows`);
  ok("every row records the page it came off",
    rows.every(r => r.pages.length), rows.filter(r => !r.pages.length).length + " without one");
  ok("a garment on both pages records both",
    rows.filter(r => r.pages.length === 2).length === 2,
    rows.map(r => r.name + ":" + r.pages.length).join(" | "));

  /* A row from before this release: no record of its page, filed under the
     list and the pair the list row shows. */
  await sw.evaluate(() => new Promise(res => {
    const req = indexedDB.open("shopcat");
    req.onsuccess = () => {
      const t = req.result.transaction("products", "readwrite");
      t.objectStore("products").put({
        key: "https://www.everlane.com/products/old-row",
        brand: "EVERLANE", category: "New In", name: "Old Row",
        product_url: "https://www.everlane.com/products/old-row",
        image_url: "https://cdn.everlane.example/old.jpg",
        fabric_composition: "100% Cotton", listIds: ["U"], listName: "ACTIVE",
        addedAt: Date.now(), updatedAt: Date.now(), seenCount: 1,
      });
      t.oncomplete = () => res(true);
    };
  }));
  const before = await rowsIn(sw);
  ok("the older row has no page recorded",
    [].concat((before.find(r => r.name === "Old Row") || {}).pages || []).length === 0,
    JSON.stringify((before.find(r => r.name === "Old Row") || {}).pages));

  // ---- remove the New In address -------------------------------------------
  await panel.reload();
  await panel.waitForTimeout(1400);
  await panel.locator('.ent[data-i="0"] .del').click();
  await panel.waitForTimeout(400);
  const asked = (await panel.locator("#asktext").textContent()) || "";
  console.log(`    (asked: ${asked})`);
  ok("it says what will go before anything goes", /\b5 products\b/.test(asked), asked);
  ok("…and names the address", /New In/.test(asked), asked);

  // On a build that never asks, the box is not there — say so and carry on,
  // rather than ending the run at a click that cannot land.
  const confirmIt = async () => {
    if (await panel.locator("#ask").isHidden()) return false;
    await panel.click("#askok"); return true;
  };
  await confirmIt();
  await panel.waitForTimeout(2500);
  const left = await rowsIn(sw);
  const names = left.map(r => r.name).sort();
  ok("the products that address collected are gone",
    !names.some(n => /Piece [0-3]$|Old Row/.test(n)), names.join(" | "));
  ok("the ones another saved address also collects stay",
    ["Seamless Piece 4", "Seamless Piece 5"].every(n => names.includes(n)), names.join(" | "));
  ok("the other page is untouched",
    [6, 7, 8, 9].every(i => names.includes(nameOf(i))), names.join(" | "));
  ok("six products left, not ten", left.length === 6, `${left.length} rows`);
  ok("the address is out of the list",
    (await panel.locator(".ent").count()) === 1,
    await panel.locator(".ent").count() + " rows still listed");

  // ---- and the LAB shows what is left, not what was ------------------------
  const lab = await ctx.newPage();
  await lab.goto(`chrome-extension://${id}/catalog.html`);
  await lab.waitForTimeout(2500);
  await lab.locator('.tab[data-view="brands"]').click();
  await lab.waitForTimeout(900);
  const cards = await lab.locator("#v-brands .grid .c").count();
  ok("the LAB draws six, not ten", cards === 6, cards + " cards");
  const labText = await lab.locator("#v-brands").innerText();
  ok("…and none of the removed ones are on the screen",
    !/Seamless Piece [0-3]\b/.test(labText),
    (labText.match(/Seamless Piece \d/g) || []).join(" | "));
  await lab.close();

  // ---- the last address out leaves nothing behind --------------------------
  await panel.locator('.ent[data-i="0"] .del').click();
  await panel.waitForTimeout(400);
  await confirmIt();
  await panel.waitForTimeout(2500);
  const end = await rowsIn(sw);
  ok("the last address out empties the catalog — nothing orphaned",
    end.length === 0, end.map(r => r.name).join(" | "));

  ok("no page errors", errs.length === 0, errs.join(" | "));
  console.log(`\n${pass} passed, ${fail} failed`);
  await ctx.close();
  server.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log("HARNESS ERROR: " + (e && e.message || e)); process.exit(1); });
