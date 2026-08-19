/* Gymshark's collection grid: fifty-one products, and what a tile carries.

   Reported from row.gymshark.com/collections/everyday/womens?collections=t-shirts-tops:
   the page says 51, sixteen came back, the order was not the page's, and the
   names had the star rating stuck to the front — "4.3Everyday Seamless Ribbed
   Tank", "3.9Everyday Seamless Tight Fit Crew Neck Tee".

   Three shapes, none of them about this brand in particular:

     · the grid renders a first screen and grows as it is scrolled, with no
       button to press. Whatever stops the sweep early stops it at the first
       paint, which is what sixteen of fifty-one looks like.
     · a promotional tile sits INSIDE the grid — a banner with a headline, a
       paragraph and a link, and no product behind it. Anything that counts it
       as a product files a row that is not one.
     · the rating badge is a sibling of the name inside the same block, and
       textContent runs them together: "4.3" + "Everyday…" with no space
       between, so the name arrives with a number welded to it. Same shape as
       "Style Number 1" + "89,00 €" in v2.7.0 and "New In48 items" in v2.8.0.

   The address carries the shop's own filter, so the bulk JSON must not be used
   to top the grid up (v3.27.0) — the fifty-one have to come from the page.

   Run: NODE_PATH=/opt/node22/lib/node_modules xvfb-run -a node gymgrid-e2e.js */
"use strict";
const { chromium } = require("playwright");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const EXT = path.resolve(__dirname, "..");

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log("  ok  " + n); } else { fail++; console.log("FAIL  " + n + (x ? "\n      " + x : "")); } };

const N = 51, FIRST = 16;
const NAMES = ["Everyday Seamless Tight Fit Crew Neck Tee", "Everyday Seamless Wide Neck Long Sleeve Top",
  "Everyday Seamless Short Sleeve Top", "Everyday Seamless Long Sleeve Crop Top",
  "Everyday Seamless Shelf Tank", "Everyday Seamless Ribbed Tank"];
const COLOURS = ["Espresso Brown", "Cool Brown", "Butter Yellow", "Black"];
const CDN = "https://cdn.gymgrid.example";
const ALL = Array.from({ length: N }, (_, i) => ({
  handle: `everyday-seamless-${i}`,
  name: `${NAMES[i % NAMES.length]} ${i}`,
  colour: COLOURS[i % COLOURS.length],
  price: 35 + (i % 4) * 5,
  rating: (3.5 + (i % 15) / 10).toFixed(1),
}));

/* One tile, in the shape the screenshot shows: a "New" flag, the name, the
   rating beside it, the colourway, the price. */
const tile = (p, i) => `
  <li class="product-card">
    <a href="/products/${p.handle}"><img src="${CDN}/${p.handle}.jpg" alt="${p.name}"></a>
    <span class="flag">New</span>
    <div class="detail">
      <div class="product-card__title"><span class="rating"><svg viewBox="0 0 8 8"><path d="M4 0l1 3h3l-2 2 1 3-3-2-3 2 1-3-2-2h3z"/></svg>${p.rating}</span><a class="link" href="/products/${p.handle}">${p.name}</a></div>
      <div class="colour">${p.colour}</div>
      <div class="price">US$${p.price}</div>
    </div>
  </li>`;

/* …and a promotional tile in the middle of it, with no product behind it. */
const promo = `
  <li class="product-card promo">
    <img src="${CDN}/promo.jpg" alt="New Everyday Seamless colours">
    <div class="detail">
      <div class="product-card__title"><span class="link">NEW EVERYDAY SEAMLESS COLOURS</span></div>
      <div class="colour">Your fave soft, second-skin gym sets drop in new colours on 20th August, 8pm CEST.</div>
      <a class="cta" href="/pages/everyday-seamless">FIND OUT MORE</a>
    </div>
  </li>`;

const gridHtml = n => ALL.slice(0, n).map(tile).join("") + (n > 7 ? promo : "");

const collection = () => `<!doctype html><meta charset="utf-8">
<title>Womens T-Shirts &amp; Tops | Gymshark</title>
<script src="https://cdn.shopify.com/s/files/1/theme.js"></script>
<h1>T-Shirts &amp; Tops</h1>
<div class="count">${N} products</div>
<ul id="grid" class="product-grid">${gridHtml(FIRST)}</ul>
<div style="height:3000px"></div>
<script>
  var shown = ${FIRST};
  addEventListener("scroll", function () {
    if (shown >= ${N}) return;
    if (innerHeight + scrollY < document.body.offsetHeight - 900) return;
    shown = Math.min(${N}, shown + 12);          // a screenful at a time
    var html = ${JSON.stringify(ALL.map(tile))}.slice(0, shown).join("") +
      ${JSON.stringify(promo)};
    document.getElementById("grid").innerHTML = html;
  });
</script>`;


const pdp = h => `<!doctype html><meta charset="utf-8"><title>${h}</title>
<meta property="og:image" content="${CDN}/${h}.jpg">
<h3>MATERIALS &amp; CARE</h3><ul><li>92% Nylon, 8% Elastane</li><li>Machine wash cold</li></ul>`;

const PORT = 8479;
const HOSTS = ["row.gymshark.com", "cdn.gymgrid.example", "cdn.shopify.com"];
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
    if (host === "cdn.gymgrid.example") return send(GIF, "image/gif");
    if (host === "cdn.shopify.com") return send("/* theme */", "application/javascript");
    /* Shopify's own JSON is NOT available on this shop.

       It has to be off for this fixture to be the page that was reported at
       all: product.title is authoritative (v1.68), so if either endpoint
       answered, the title would overwrite whatever the tile said and the names
       could not have come back with the rating welded to the front. Plenty of
       shops turn both off, and this one evidently has — which is also what
       leaves the page itself as the only statement of the fifty-one. */
    if (/products\.json/.test(url) || /\/products\/[^/?]+\.js(\?|$)/.test(url)) {
      res.writeHead(404); return res.end("Not Found");
    }
    const m = url.match(/\/products\/(everyday-seamless-\d+)/);
    if (m) return send(pdp(m[1]));
    return send(collection());
  });
const serverReady = new Promise(r => server.listen(PORT, "127.0.0.1", r));

const ENTRY = [{ brand: "GYMSHARK", label: "New In", scannable: true,
  url: "https://row.gymshark.com/collections/everyday/womens?collections=t-shirts-tops" }];

(async () => {
  const MAP = HOSTS.map(h => `MAP ${h} 127.0.0.1:${PORT}`).join(",");
  execSync("rm -rf /tmp/pw-gymgrid");
  const ctx = await chromium.launchPersistentContext("/tmp/pw-gymgrid", {
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
    wpb_lists: [{ id: "G", name: "ACTIVE", createdAt: 1, entries: es }] }, r)), ENTRY);
  await panel.reload();
  await panel.waitForTimeout(1400);
  await panel.click("#runlist");
  await panel.waitForTimeout(600);
  if (!await panel.locator("#ask").isHidden()) await panel.click("#askok");

  let rows = [], waited = 0;
  while (waited < 180000) {
    await panel.waitForTimeout(2500); waited += 2500;
    rows = await sw.evaluate(() => self.CatalogStore.allProducts().then(p =>
      p.map(x => ({ url: x.product_url, name: x.name, brand: x.brand, pos: x.pos || 0,
        image: x.image_url || "", price: x.price || "",
        fabric: x.fabric_composition || "" })))).catch(() => []);
    const q = await panel.evaluate(() => new Promise(r =>
      chrome.storage.local.get("wpb_queue", o => r((o || {}).wpb_queue || {}))));
    if (!q.active && rows.length >= N) break;
    if (!q.active && waited > 30000) break;
  }
  const health = await panel.evaluate(() => new Promise(r =>
    chrome.storage.local.get("wpb_sitehealth", o => r((o || {}).wpb_sitehealth || {}))));
  const say = Object.values(health)[0] || {};
  console.log(`    (${rows.length} rows of ${N} · grade ${say.mark || "?"} · ${say.why || ""})`);

  // ---- the count -----------------------------------------------------------
  ok(`all ${N} came back, not the ${FIRST} of the first screen`,
    rows.length === N, `${rows.length} rows`);

  // ---- the name ------------------------------------------------------------
  const rated = rows.filter(r => /^\s*[★\d]/.test(r.name || ""));
  ok("no row wears its star rating as a name", rated.length === 0,
    rated.slice(0, 4).map(r => r.name).join(" | "));
  ok("every row is one of the shop's product names",
    rows.every(r => NAMES.some(n => (r.name || "").includes(n))),
    rows.filter(r => !NAMES.some(n => (r.name || "").includes(n)))
      .slice(0, 4).map(r => r.name).join(" | "));

  // ---- the promotional tile ------------------------------------------------
  ok("the banner in the middle of the grid is not filed as a product",
    !rows.some(r => /FIND OUT MORE|NEW EVERYDAY SEAMLESS COLOURS/i.test(r.name || "") ||
      /\/pages\//.test(r.url || "")),
    rows.filter(r => /\/pages\//.test(r.url || "")).map(r => r.name).join(" | "));

  // ---- the order -----------------------------------------------------------
  const byPos = rows.slice().sort((a, b) => a.pos - b.pos).map(r => r.name);
  ok("the shop's order is recorded", rows.every(r => r.pos > 0),
    rows.filter(r => !r.pos).length + " rows without a position");
  ok("…and it is the order the grid lays them out in",
    byPos.join("|") === ALL.map(p => p.name).join("|"),
    byPos.slice(0, 4).join(" · ") + "\n         vs " + ALL.slice(0, 4).map(p => p.name).join(" · "));

  // ---- the rest of the row -------------------------------------------------
  ok("every row has a composition", rows.every(r => /%/.test(r.fabric)),
    rows.filter(r => !/%/.test(r.fabric)).length + " without one");
  ok("every row has a photograph", rows.every(r => /^https?:/.test(r.image)),
    rows.filter(r => !/^https?:/.test(r.image)).length + " without one");
  ok("prices are the shop's", rows.every(r => /^US\$\d+$/.test(r.price)),
    [...new Set(rows.map(r => r.price))].slice(0, 4).join(" | "));

  ok("no page errors", errs.length === 0, errs.join(" | "));
  console.log(`\n${pass} passed, ${fail} failed`);
  await ctx.close();
  server.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log("HARNESS ERROR: " + (e && e.message || e)); process.exit(1); });
