/* Scanning the same page again — what is kept, what is refreshed, and what is
   no longer paid for.

   Three questions a designer actually asked:

     · does a re-scan wipe what was there?      no. the product URL is the key,
       so the row is updated in place and its first-seen date is kept — which
       is what the LAB counts as "new this week".
     · does it pick up changes?                 yes. a non-empty new value wins,
       so a re-photographed or re-priced product is corrected.
     · can it skip what has not changed?        that is what this adds. The
       detail step is most of a scan's wall time and it is spent waiting for
       product pages; a composition does not change for a given product URL.

   Measured here rather than asserted: the fixture counts how many product
   pages each run asks for.

   Run: NODE_PATH=/opt/node22/lib/node_modules xvfb-run -a node rescan-e2e.js */
"use strict";
const { chromium } = require("playwright");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const EXT = path.resolve(__dirname, "..");

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log("  ok  " + n); } else { fail++; console.log("FAIL  " + n + (x ? "\n      " + x : "")); } };

const IMG = "https://cdn.example/photo-800.jpg";
const N = 8;   // adanola.com: a host the manifest declares, so the run is not
               // stopped by a Chrome permission prompt nothing can click
let price = "$60.00";           // the shop's price, changed between the runs
let pdpHits = 0;

const grid = () => `<!doctype html><meta charset="utf-8"><title>New | Rescan</title>
<h1>New arrivals</h1><ul>${Array.from({ length: N }, (_, i) => `
  <li class="card"><a href="https://adanola.com/p/item-${i}">
    <img src="${IMG}?i=${i}" alt="Ribbed Tank ${i}" width="800" height="1067">
    <span class="t">Ribbed Tank ${i}</span> <span class="pr">${price}</span></a></li>`).join("")}</ul>`;
const pdp = i => `<!doctype html><meta charset="utf-8"><title>Ribbed Tank ${i}</title>
<meta property="og:image" content="${IMG}?i=${i}">
<h1>Ribbed Tank ${i}</h1><p>92% Cotton, 8% Elastane</p>`;

const PORT = 8471;
const HOSTS = ["adanola.com", "cdn.example"];
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
    if (host === "cdn.example") return send(GIF, "image/gif");
    const m = url.match(/\/p\/item-(\d+)/);
    if (m) { pdpHits++; return send(pdp(m[1])); }
    return send(grid());
  });
const serverReady = new Promise(r => server.listen(PORT, "127.0.0.1", r));

const ENTRY = [{ brand: "RESCAN", label: "New In",
  url: "https://adanola.com/collections/new", scannable: true }];

const runScan = async (panel, sw, want) => {
  await panel.reload();
  await panel.waitForTimeout(1400);
  await panel.click("#runlist");
  await panel.waitForTimeout(600);
  if (!await panel.locator("#ask").isHidden()) await panel.click("#askok");
  let rows = [], waited = 0;
  while (waited < 120000) {
    await panel.waitForTimeout(2000); waited += 2000;
    rows = await sw.evaluate(() => self.CatalogStore.allProducts().then(p =>
      p.map(x => ({ url: x.product_url, name: x.name, price: x.price,
        fabric: x.fabric_composition || "", addedAt: x.addedAt,
        seenCount: x.seenCount || 0 })))).catch(() => []);
    const q = await panel.evaluate(() => new Promise(r =>
      chrome.storage.local.get("wpb_queue", o => r((o || {}).wpb_queue || {}))));
    if (!q.active && rows.length >= want) break;
  }
  return rows;
};

(async () => {
  const MAP = HOSTS.map(h => `MAP ${h} 127.0.0.1:${PORT}`).join(",");
  const ctx = await chromium.launchPersistentContext("/tmp/pw-rescan", {
    executablePath: "/opt/pw-browsers/chromium", headless: false, ignoreHTTPSErrors: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-sandbox",
      `--host-resolver-rules=${MAP}`, "--ignore-certificate-errors", "--no-proxy-server"] });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker");
  const id = sw.url().split("/")[2];
  await serverReady;

  const panel = await ctx.newPage();
  await panel.setViewportSize({ width: 380, height: 900 });
  const errs = []; panel.on("pageerror", e => errs.push(e.message));
  await panel.goto(`chrome-extension://${id}/sidepanel.html`);
  await panel.waitForTimeout(700);
  await panel.evaluate(es => new Promise(r => chrome.storage.local.set({
    wpb_autoupdate: false,
    wpb_lists: [{ id: "R", name: "ACTIVE", createdAt: 1, entries: es }] }, r)), ENTRY);

  // ---- first scan ---------------------------------------------------------
  pdpHits = 0;
  const first = await runScan(panel, sw, N);
  const firstHits = pdpHits;
  ok("the first scan collected the page", first.length === N, `${first.length} rows`);
  ok("…with a composition on every row", first.every(r => /%/.test(r.fabric)),
    first.filter(r => !/%/.test(r.fabric)).length + " without one");
  ok("…and it read one product page per product", firstHits >= N, `${firstHits} requests`);

  // ---- the shop re-prices, and we scan again ------------------------------
  price = "$45.00";
  pdpHits = 0;
  const second = await runScan(panel, sw, N);
  const secondHits = pdpHits;
  console.log(`    product pages requested: first ${firstHits} · again ${secondHits}`);

  ok("nothing was wiped — the same rows, updated in place",
    second.length === N, `${second.length} rows`);
  ok("the first-seen date is kept, so nothing counts as new twice",
    second.every(r => {
      const was = first.find(f => f.url === r.url);
      return was && was.addedAt === r.addedAt;
    }), "an addedAt moved");
  ok("it was seen again, and says so",
    second.every(r => r.seenCount >= 2),
    Math.min(...second.map(r => r.seenCount)) + " lowest seenCount");
  ok("today's price won — the shop's markdown is not a week old",
    second.every(r => r.price === "$45.00"),
    [...new Set(second.map(r => r.price))].join(" | "));
  ok("the composition survived without being fetched again",
    second.every(r => /%/.test(r.fabric)),
    second.filter(r => !/%/.test(r.fabric)).length + " without one");
  ok("and the product pages were not opened a second time",
    secondHits === 0, `${secondHits} requests`);

  // ---- a stale row is read again ------------------------------------------
  /* Beyond a month the page is read again, so a shop's edits — and every
     improvement to our own parsers — reach rows collected before them. */
  await sw.evaluate(async () => {
    const rows = await self.CatalogStore.allProducts();
    const old = Date.now() - 40 * 24 * 3600e3;
    await self.CatalogStore.putScan({ meta: { scanId: "age" },
      items: rows.map(r => Object.assign({}, r, { updatedAt: old })) });
    // putScan stamps updatedAt itself, so age it in place afterwards
    const db = await self.CatalogStore.open();
    await new Promise(res => {
      const t = db.transaction("products", "readwrite");
      const P = t.objectStore("products");
      const q = P.getAll();
      q.onsuccess = () => {
        q.result.forEach(r => { r.updatedAt = old; P.put(r); });
      };
      t.oncomplete = res; t.onerror = res;
    });
  });
  pdpHits = 0;
  const third = await runScan(panel, sw, N);
  ok("a row older than a month is read again", pdpHits >= N, `${pdpHits} requests`);
  ok("…and still comes back complete", third.length === N && third.every(r => /%/.test(r.fabric)),
    `${third.length} rows`);

  ok("no page errors", errs.length === 0, errs.join(" | "));
  console.log(`\n${pass} passed, ${fail} failed`);
  server.close();
  await ctx.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log("HARNESS " + (e && e.message || e)); server.close(); process.exit(1); });
