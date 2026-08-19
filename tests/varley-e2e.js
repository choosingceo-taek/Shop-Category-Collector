/* A grid that previews its colourways — and what that did to the row.

   Reported from varley.com/collections/new-arrivals?o_cat=Tops&o_cat=Sweatshirts:
   the page says 30 Results, fifteen came back, the names read "Color swatch
   for Mid Tan" and "Color swatch for Ironwood", and the pictures were flat
   blocks of colour instead of the garment.

   Every one of those is the same shape. Under each photograph Varley puts the
   name, the price and a row of colour swatches, and the swatches are <img>
   with the shop's own alt — "Color swatch for Mid Tan". The name sits in a
   plain link with no heading and no title class, so the name reader falls
   through to the first alt in the tile, which is a swatch; and the tile that
   holds the info block does not hold the photograph, so the picture reader
   finds the swatch too. The swatch is not declared as 40px anywhere, so the
   guard that has kept chips out of the image column since v2.5.0 cannot see it.

   The other half: the grid renders fifteen and keeps the rest behind a button,
   and the address carries the shop's own filters (o_cat), so the bulk JSON
   must NOT be used to fill in the gap — those parameters are the designer's
   choice and products.json knows nothing about them (v3.27.0). The rest has to
   come from pressing.

   Run: NODE_PATH=/opt/node22/lib/node_modules xvfb-run -a node varley-e2e.js */
"use strict";
const { chromium } = require("playwright");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const EXT = path.resolve(__dirname, "..");

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log("  ok  " + n); } else { fail++; console.log("FAIL  " + n + (x ? "\n      " + x : "")); } };

const N = 30, FIRST = 15;
const NAMES = ["Hawley Half-Zip Sweat", "Ritchie Short Sleeve Sweat", "Peterson Half-Zip Knit",
  "Leighton Boyfriend Tee", "Bridget Cable Vest", "Rowan Sleeveless Knit",
  "Mila Half-Zip Sweat", "Callie Knit Top"];
const COLOURS = ["Mid Tan", "Ironwood", "Pristine", "Brown Stone", "Light Grey Marl"];
const CDN = "https://cdn.varley.example";
const prod = i => ({
  handle: `varley-${i}-${NAMES[i % NAMES.length].toLowerCase().replace(/[^a-z]+/g, "-")}`,
  name: `${NAMES[i % NAMES.length]} ${i}`,
  price: [98, 118, 178, 68, 148, 138][i % 6],
});
const ALL = Array.from({ length: N }, (_, i) => prod(i));

/* One tile, in the shape the screenshots show: the photograph in its own link,
   and BELOW it an info block with the name (a plain link — no heading, no
   title class), the price, and the colour swatches. */
const tile = p => `
  <li class="grid-item">
    <a class="media" href="/products/${p.handle}">
      <img src="${CDN}/${p.handle}-model.jpg" alt="${p.name}">
    </a>
    <div class="info">
      <a class="link" href="/products/${p.handle}">${p.name}</a>
      <span class="price">$${p.price}.00</span>
      <div class="swatches">
        ${COLOURS.map(c => `<a href="/products/${p.handle}?variant=4493664934&color=${encodeURIComponent(c)}&size=XXS">
          <img src="${CDN}/swatch-${c.toLowerCase().replace(/[^a-z]+/g, "")}.png" alt="Color swatch for ${c}">
        </a>`).join("")}
        <span class="more">+ more</span>
      </div>
    </div>
  </li>`;

const collection = (all) => `<!doctype html><meta charset="utf-8">
<title>New Arrivals | Varley</title>
<script src="https://cdn.shopify.com/s/files/1/theme.js"></script>
<h1>New Arrivals</h1>
<div class="head"><span class="results">${N} Results</span></div>
<ul class="product-grid">${(all ? ALL : ALL.slice(0, FIRST)).map(tile).join("")}</ul>
${all ? "" : `<button class="load-more">Load more</button>`}
<script>
  document.querySelector(".load-more") && document.querySelector(".load-more")
    .addEventListener("click", () => {
      document.querySelector(".product-grid").innerHTML = ${JSON.stringify(ALL.map(tile).join(""))};
      document.querySelector(".load-more").remove();
    });
</script>`;

/* The bulk JSON exists — and must not be used to top up a filtered address. */
const bulk = () => JSON.stringify({ products: ALL.map((p, i) => ({
  id: 700 + i, handle: p.handle, title: p.name, vendor: "Varley",
  product_type: "Tops", body_html: "<p>Soft brushed fleece.</p>",
  options: [{ name: "Color", values: COLOURS }],
  variants: [{ price: String(p.price) + ".00", compare_at_price: null }],
  images: [{ src: `${CDN}/${p.handle}-model.jpg` }],
})) });

const pdp = h => `<!doctype html><meta charset="utf-8"><title>${h} | Varley</title>
<meta property="og:image" content="${CDN}/${h}-model.jpg">
<h1>${h}</h1>
<h3>MATERIALS</h3><ul><li>92% Cotton, 8% Elastane</li><li>Machine wash cold</li></ul>`;

const PORT = 8475;
const HOSTS = ["www.varley.com", "cdn.varley.example", "cdn.shopify.com"];
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
    if (host === "cdn.varley.example") return send(GIF, "image/gif");
    if (host === "cdn.shopify.com") return send("/* theme */", "application/javascript");
    if (/products\.json/.test(url)) return send(bulk(), "application/json");
    const m = url.match(/\/products\/([a-z0-9-]+)/);
    if (m) {
      if (/\.js(\?|$)/.test(url)) return send(JSON.stringify({
        title: m[1], vendor: "Varley", description: "<p>Soft brushed fleece.</p>",
        options: [], price: 9800 }), "application/json");
      return send(pdp(m[1]));
    }
    return send(collection(false));
  });
const serverReady = new Promise(r => server.listen(PORT, "127.0.0.1", r));

const ENTRY = [{ brand: "VARLEY", label: "New In", scannable: true,
  url: "https://www.varley.com/collections/new-arrivals?o_cat=Tops&o_cat=Sweatshirts" }];

(async () => {
  const MAP = HOSTS.map(h => `MAP ${h} 127.0.0.1:${PORT}`).join(",");
  execSync("rm -rf /tmp/pw-varley");
  const ctx = await chromium.launchPersistentContext("/tmp/pw-varley", {
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
    wpb_lists: [{ id: "V", name: "ACTIVE", createdAt: 1, entries: es }] }, r)), ENTRY);
  await panel.reload();
  await panel.waitForTimeout(1400);
  await panel.click("#runlist");
  await panel.waitForTimeout(600);
  if (!await panel.locator("#ask").isHidden()) await panel.click("#askok");

  let rows = [], waited = 0;
  while (waited < 150000) {
    await panel.waitForTimeout(2500); waited += 2500;
    rows = await sw.evaluate(() => self.CatalogStore.allProducts().then(p =>
      p.map(x => ({ url: x.product_url, name: x.name, brand: x.brand, pos: x.pos || 0,
        image: x.image_url || "", price: x.price || "",
        fabric: x.fabric_composition || "" })))).catch(() => []);
    const q = await panel.evaluate(() => new Promise(r =>
      chrome.storage.local.get("wpb_queue", o => r((o || {}).wpb_queue || {}))));
    if (!q.active && rows.length >= N) break;
    if (!q.active && waited > 25000) break;
  }
  console.log(`    (${rows.length} rows of ${N})`);

  // ---- the count -----------------------------------------------------------
  ok(`all ${N} products came back, not the ${FIRST} the grid rendered first`,
    rows.length === N, `${rows.length} rows`);

  // ---- the name ------------------------------------------------------------
  const swatchNames = rows.filter(r => /swatch/i.test(r.name || ""));
  ok("no row is named after a colour swatch", swatchNames.length === 0,
    swatchNames.slice(0, 4).map(r => r.name).join(" | "));
  ok("every row carries the shop's product name",
    rows.every(r => NAMES.some(n => (r.name || "").startsWith(n))),
    rows.filter(r => !NAMES.some(n => (r.name || "").startsWith(n)))
      .slice(0, 4).map(r => r.name).join(" | "));

  // ---- the picture ---------------------------------------------------------
  const swatchPics = rows.filter(r => /\/swatch-/.test(r.image || ""));
  ok("no row shows a swatch instead of the garment", swatchPics.length === 0,
    swatchPics.slice(0, 4).map(r => r.image).join(" | "));
  ok("every row has the model photograph",
    rows.every(r => /-model\.jpg/.test(r.image || "")),
    rows.filter(r => !/-model\.jpg/.test(r.image || "")).length + " without one");

  // ---- the order -----------------------------------------------------------
  const inOrder = rows.slice().sort((a, b) => a.pos - b.pos).map(r => r.name);
  const want = ALL.map(p => p.name);
  ok("the shop's own order is recorded", rows.every(r => r.pos > 0),
    rows.filter(r => !r.pos).length + " rows with no position");
  ok("…and it is the order the page lays them out in",
    inOrder.join("|") === want.join("|"),
    inOrder.slice(0, 5).join(" · ") + "   vs   " + want.slice(0, 5).join(" · "));

  // ---- and the rest of the row still works ---------------------------------
  ok("prices are the shop's", rows.every(r => /^\$\d+\.00$/.test(r.price || "")),
    [...new Set(rows.map(r => r.price))].slice(0, 4).join(" | "));
  ok("compositions were read", rows.every(r => /%/.test(r.fabric || "")),
    rows.filter(r => !/%/.test(r.fabric || "")).length + " without one");
  ok("the shop is filed under its own name", rows.every(r => /varley/i.test(r.brand || "")),
    [...new Set(rows.map(r => r.brand))].join(" | "));

  ok("no page errors", errs.length === 0, errs.join(" | "));
  console.log(`\n${pass} passed, ${fail} failed`);
  await ctx.close();
  server.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log("HARNESS ERROR: " + (e && e.message || e)); process.exit(1); });
