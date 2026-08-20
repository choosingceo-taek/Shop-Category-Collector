/* One address, one fetch.

   Reported: the same page is scraped several times. Counted, on a two-address
   list: the FIRST address was fetched three times and every other address
   once. Two of the three came from the run's own start — the queue is written,
   the tab is sent to the first address it is already showing, and the assign
   plus the reload that followed it were two fetches 3ms apart.

   The cost is not only time: every extra fetch is another hit on a shop that
   did nothing to deserve it, and the run bar sits there looking stuck.

   Run: NODE_PATH=/opt/node22/lib/node_modules xvfb-run -a node revisit-e2e.js */
"use strict";
const { chromium } = require("playwright");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const EXT = path.resolve(__dirname, "..");

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log("  ok  " + n); } else { fail++; console.log("FAIL  " + n + (x ? "\n      " + x : "")); } };

const N = 8;
const CDN = "https://cdn.everlane.example";
const tile = i => `
  <li class="card">
    <a href="/products/piece-${i}"><img src="${CDN}/p${i}.jpg" alt="Piece ${i}" width="800" height="1000"></a>
    <h3 class="title"><a href="/products/piece-${i}">Linen Piece ${i}</a></h3>
    <div class="price">$${40 + i}.00</div>
  </li>`;
const listing = (title, ids) => `<!doctype html><meta charset="utf-8">
<title>${title}</title><h1>${title}</h1>
<div class="count">${ids.length} products</div>
<ul class="grid">${ids.map(tile).join("")}</ul>
<footer style="height:1800px">shop</footer>`;
const pdp = i => `<!doctype html><meta charset="utf-8"><title>Piece ${i}</title>
<meta property="og:image" content="${CDN}/p${i}.jpg">
<h3>Composition</h3><ul><li>100% Linen</li><li>Machine wash</li></ul>`;

const PORT = 8491;
const HOSTS = ["www.everlane.com", "cdn.everlane.example"];
const GIF = Buffer.from("R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==", "base64");
if (!fs.existsSync("/tmp/ml-key.pem")) {
  execSync('openssl req -x509 -newkey rsa:2048 -nodes -keyout /tmp/ml-key.pem ' +
    '-out /tmp/ml-cert.pem -days 365 -subj "/CN=localhost" 2>/dev/null');
}
const hits = new Map();
const order = [];
const server = https.createServer(
  { key: fs.readFileSync("/tmp/ml-key.pem"), cert: fs.readFileSync("/tmp/ml-cert.pem") },
  (req, res) => {
    const host = String(req.headers.host || "").split(":")[0];
    const url = req.url || "/";
    if (host !== "cdn.everlane.example") {
      const key = url.split("?")[0] + (url.includes("?") ? "?…" : "");
      hits.set(key, (hits.get(key) || 0) + 1);
      if (/\/collections\//.test(key)) order.push([Date.now(), key, req.headers["sec-fetch-mode"] || "-"]);
    }
    const send = (b, t) => { res.writeHead(200, { "content-type": t || "text/html; charset=utf-8" }); res.end(b); };
    if (host === "cdn.everlane.example") return send(GIF, "image/gif");
    const m = url.match(/\/products\/piece-(\d+)/);
    if (m) return send(pdp(+m[1]));
    if (/products\.json/.test(url)) { res.writeHead(404); return res.end("no"); }
    if (/\/collections\/tops/.test(url)) return send(listing("Tops", [4,5,6,7]));
    return send(listing("New In", [0,1,2,3]));
  });
const ready = new Promise(r => server.listen(PORT, "127.0.0.1", r));

const BASE = "https://www.everlane.com";
const ENTRIES = [
  { brand: "EVERLANE", label: "New In", scannable: true, url: `${BASE}/collections/new-in` },
  { brand: "EVERLANE", label: "Tops", scannable: true, url: `${BASE}/collections/tops` },
];

(async () => {
  const MAP = HOSTS.map(h => `MAP ${h} 127.0.0.1:${PORT}`).join(",");
  execSync("rm -rf /tmp/pw-revisit");
  const ctx = await chromium.launchPersistentContext("/tmp/pw-revisit", {
    executablePath: "/opt/pw-browsers/chromium", headless: false, ignoreHTTPSErrors: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-sandbox",
      `--host-resolver-rules=${MAP}`, "--ignore-certificate-errors", "--no-proxy-server"] });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker");
  const id = sw.url().split("/")[2];
  await ready;

  const panel = await ctx.newPage();
  await panel.setViewportSize({ width: 400, height: 900 });
  await panel.goto(`chrome-extension://${id}/sidepanel.html`);
  await panel.waitForTimeout(1200);
  await panel.evaluate(es => new Promise(r => chrome.storage.local.set({
    wpb_autoupdate: false,
    wpb_lists: [{ id: "R", name: "ACTIVE", createdAt: 1, entries: es }] }, r)), ENTRIES);
  await panel.reload();
  await panel.waitForTimeout(1400);
  hits.clear();                                   // count only the run
  await panel.click("#runlist");
  await panel.waitForTimeout(600);
  if (!await panel.locator("#ask").isHidden()) await panel.click("#askok");

  let waited = 0, rows = 0;
  while (waited < 150000) {
    await panel.waitForTimeout(2500); waited += 2500;
    rows = await sw.evaluate(() => self.CatalogStore.allProducts().then(p => p.length)).catch(() => 0);
    const q = await panel.evaluate(() => new Promise(r =>
      chrome.storage.local.get("wpb_queue", o => r((o || {}).wpb_queue || {}))));
    if (!q.active && rows >= N) break;
    if (!q.active && waited > 25000) break;
  }

  const list = [...hits.entries()].sort((a, b) => b[1] - a[1]);
  const collections = list.filter(([k]) => /\/collections\//.test(k));
  const products = list.filter(([k]) => /\/products\//.test(k));
  console.log(`\n${rows} products collected from ${ENTRIES.length} addresses\n`);
  console.log("LISTING PAGES — how many times each was loaded");
  collections.forEach(([k, n]) => console.log(`  ${String(n).padStart(3)}x  ${k}`));
  console.log("\nPRODUCT PAGES");
  console.log(`  ${products.length} distinct, ${products.reduce((a, b) => a + b[1], 0)} requests` +
    (products.some(([, n]) => n > 1) ? "  ← some fetched more than once" : "  (each fetched once)"));
  products.filter(([, n]) => n > 1).forEach(([k, n]) => console.log(`  ${String(n).padStart(3)}x  ${k}`));
  console.log("\nORDER of listing loads (ms from the first)");
  const t0 = order.length ? order[0][0] : 0;
  order.forEach(([t, k, mode]) => console.log(`  +${String(t - t0).padStart(6)}ms  ${k}   mode=${mode}`));
  const other = list.filter(([k]) => !/\/collections\/|\/products\//.test(k));
  if (other.length) { console.log("\nOTHER"); other.forEach(([k, n]) => console.log(`  ${String(n).padStart(3)}x  ${k}`)); }

  console.log("");
  ok("every product was collected", rows === N, `${rows} of ${N}`);
  ok("both addresses were visited", collections.length === 2,
    JSON.stringify(collections));
  ok("…and each of them exactly once — including the one the run starts on",
    collections.every(([, n]) => n === 1), JSON.stringify(collections));
  ok("no product page was read twice", products.every(([, n]) => n === 1),
    JSON.stringify(products.filter(([, n]) => n > 1)));

  console.log(`\n${pass} passed, ${fail} failed`);
  await ctx.close(); server.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log("HARNESS ERROR: " + (e && e.message || e)); process.exit(1); });
