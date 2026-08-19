/* Where Gymshark states what a garment is made of.

   The designer sent the page and the place:
     row.gymshark.com/products/gymshark-everyday-seamless-t-shirt-black-ss24
     → Description tab → MATERIALS & CARE → 100% Nylon

   That is a shape worth pinning, because everything about it is a way the
   reading can go wrong:

     · it is a Shopify shop, so the collection's bulk JSON answers first — and
       that JSON carries the marketing copy WITHOUT the composition. A bulk hit
       is enrichment, not a verdict (v1.68); if the chain stopped there the
       fabric column would be empty on every row.
     · on the product page the line sits in a TAB PANEL that is not the open
       one, and inside a list. Panels behind a tab are usually marked hidden,
       and a reader that only takes visible text would never see it.
     · the same panel says "…stretchy material, great for all kinds of
       training" ABOVE the real answer, and "Machine wash cold" under it. A
       reader that takes the first thing after the word "material", or that
       runs the list items together, gets prose or care instructions instead
       of the blend.

   The fixture is that page: same tab strip, same headings, same bullet, and
   the composition nowhere else. What is asserted is the cell — 100% Nylon.

   Run: NODE_PATH=/opt/node22/lib/node_modules xvfb-run -a node gymshark-e2e.js */
"use strict";
const { chromium } = require("playwright");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const EXT = path.resolve(__dirname, "..");

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log("  ok  " + n); } else { fail++; console.log("FAIL  " + n + (x ? "\n      " + x : "")); } };

const N = 4;
const IMG = "https://cdn.gymshark.example/photo-800.jpg";
const HANDLES = Array.from({ length: N }, (_, i) => `gymshark-everyday-seamless-t-shirt-${i}`);
/* The compositions the page states, one per product — a single fibre like the
   screenshot, and blends, which is how the rest of the shop reads. */
const COMP = ["100% Nylon", "92% Nylon, 8% Elastane", "88% Polyester, 12% Elastane", "100% Cotton"];

/* The shop's own marketing copy — this is ALL the bulk JSON carries. Note the
   word "material" in the first bullet: a reader that trusts the first label it
   meets files that sentence as the composition. */
const MARKETING = `<h3>SOFT, SECOND-SKIN GYM SETS</h3>
<p>Once you put Everyday Seamless on, you'll probably never want to take it off.</p>
<ul><li>Soft, lightweight, stretchy material, great for all kinds of training</li>
<li>The comfiest affordable gym staple</li></ul>`;

const collection = () => `<!doctype html><meta charset="utf-8"><title>Womens T-Shirts | Gymshark</title>
<script src="https://cdn.shopify.com/s/files/1/theme.js"></script>
<h1>T-Shirts &amp; Tops</h1>
<ul class="product-grid">${HANDLES.map((h, i) => `
  <li class="card"><a href="https://row.gymshark.com/products/${h}">
    <img src="${IMG}?i=${i}" alt="Everyday Seamless T-Shirt ${i}" width="800" height="1067">
    <span class="t">Everyday Seamless T-Shirt ${i}</span>
    <span class="pr">£30.00</span></a></li>`).join("")}</ul>`;

const bulk = () => JSON.stringify({ products: HANDLES.map((h, i) => ({
  id: 900 + i, handle: h, title: `Everyday Seamless T-Shirt ${i}`,
  vendor: "Gymshark", product_type: "T-Shirts",
  body_html: MARKETING,                       // no composition anywhere in here
  published_at: "2026-08-01T00:00:00Z",
  options: [{ name: "Color", values: ["Black"] }],
  variants: [{ price: "30.00", compare_at_price: null }],
  images: [{ src: `${IMG}?i=${i}` }],
})) });

/* The product page, in the shape the screenshot shows: a tab strip, and the
   Description panel — the one carrying MATERIALS & CARE — sitting behind the
   open tab, marked hidden the way a tab panel is. */
const pdp = i => `<!doctype html><meta charset="utf-8">
<title>Everyday Seamless T-Shirt ${i} | Gymshark</title>
<meta property="og:image" content="${IMG}?i=${i}">
<script type="application/ld+json">${JSON.stringify({
  "@context": "https://schema.org", "@type": "Product",
  name: `Everyday Seamless T-Shirt ${i}`, brand: { name: "Gymshark" },
  description: "Once you put Everyday Seamless on, you'll probably never want to take it off.",
  image: [`${IMG}?i=${i}`],
})}</script>
<h1>Everyday Seamless T-Shirt ${i}</h1>
<div class="tabs" role="tablist">
  <button role="tab" aria-selected="false">Designed For</button>
  <button role="tab" aria-selected="true">Description</button>
  <button role="tab" aria-selected="false">Features</button>
</div>
<div class="panel" role="tabpanel" hidden aria-hidden="true">
  ${MARKETING}
  <h3>SIZE &amp; FIT</h3>
  <ul><li>Regular fit</li><li>Model is 5'9" and wears size XS</li></ul>
  <h3>MATERIALS &amp; CARE</h3>
  <ul><li>${COMP[i]}</li><li>Machine wash cold</li></ul>
  <p>SKU: B8A4N-BB2J</p>
</div>`;

const PORT = 8473;
const HOSTS = ["row.gymshark.com", "cdn.gymshark.example", "cdn.shopify.com"];
const GIF = Buffer.from("R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==", "base64");
let pdpHits = 0, bulkHits = 0;

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
    if (host === "cdn.gymshark.example") return send(GIF, "image/gif");
    if (host === "cdn.shopify.com") return send("/* theme */", "application/javascript");
    if (/products\.json/.test(url)) { bulkHits++; return send(bulk(), "application/json"); }
    const m = url.match(/\/products\/gymshark-everyday-seamless-t-shirt-(\d+)/);
    if (m) {
      // the .js endpoint carries the same copy and no composition either
      if (/\.js(\?|$)/.test(url)) return send(JSON.stringify({
        title: `Everyday Seamless T-Shirt ${m[1]}`, vendor: "Gymshark",
        description: MARKETING, options: [], price: 3000 }), "application/json");
      pdpHits++;
      return send(pdp(m[1]));
    }
    return send(collection());
  });
const serverReady = new Promise(r => server.listen(PORT, "127.0.0.1", r));

const ENTRY = [{ brand: "GYMSHARK", label: "New In",
  url: "https://row.gymshark.com/collections/everyday/womens", scannable: true }];

(async () => {
  const MAP = HOSTS.map(h => `MAP ${h} 127.0.0.1:${PORT}`).join(",");
  execSync("rm -rf /tmp/pw-gymshark");
  const ctx = await chromium.launchPersistentContext("/tmp/pw-gymshark", {
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
  while (waited < 120000) {
    await panel.waitForTimeout(2000); waited += 2000;
    rows = await sw.evaluate(() => self.CatalogStore.allProducts().then(p =>
      p.map(x => ({ url: x.product_url, name: x.name, brand: x.brand,
        fabric: x.fabric_composition || "", image: x.image_url || "" })))).catch(() => []);
    const q = await panel.evaluate(() => new Promise(r =>
      chrome.storage.local.get("wpb_queue", o => r((o || {}).wpb_queue || {}))));
    if (!q.active && rows.length >= N) break;
    if (!q.active && waited > 20000) break;
  }
  console.log(`    (${rows.length} rows · bulk ${bulkHits} · product pages ${pdpHits})`);

  ok("the page was collected", rows.length === N, `${rows.length} rows`);
  ok("the bulk JSON answered first, as it should", bulkHits >= 1, `${bulkHits} requests`);
  ok("…and it was not treated as the last word", pdpHits >= 1,
    `${pdpHits} product pages — the composition is only on them`);

  const byIdx = i => rows.find(r => new RegExp(`t-shirt-${i}(\\b|$)`).test(r.url)) || {};
  ok("MATERIALS & CARE is read: 100% Nylon", byIdx(0).fabric === "100% Nylon", byIdx(0).fabric);
  ok("…and a blend under the same heading", /92%\s*Nylon/i.test(byIdx(1).fabric || "") &&
    /8%\s*Elastane/i.test(byIdx(1).fabric || ""), byIdx(1).fabric);
  ok("every row has a composition", rows.every(r => /%/.test(r.fabric)),
    rows.filter(r => !/%/.test(r.fabric)).map(r => r.url.slice(-30)).join(" | "));

  /* The traps on that page, named one at a time so a regression says which. */
  ok("the marketing sentence is not filed as the fabric",
    rows.every(r => !/great for all kinds|stretchy material/i.test(r.fabric)),
    rows.map(r => r.fabric).join(" | "));
  ok("nor the care instruction next to it",
    rows.every(r => !/machine wash/i.test(r.fabric)), rows.map(r => r.fabric).join(" | "));
  ok("nor the size note above it",
    rows.every(r => !/regular fit|wears size/i.test(r.fabric)), rows.map(r => r.fabric).join(" | "));

  ok("the shop is filed under its own name", rows.every(r => /gymshark/i.test(r.brand)),
    [...new Set(rows.map(r => r.brand))].join(" | "));
  ok("and every row kept its photograph", rows.every(r => /^https?:/.test(r.image)),
    rows.filter(r => !/^https?:/.test(r.image)).length + " without one");

  ok("no page errors", errs.length === 0, errs.join(" | "));
  console.log(`\n${pass} passed, ${fail} failed`);
  await ctx.close();
  server.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log("HARNESS ERROR: " + (e && e.message || e)); process.exit(1); });
