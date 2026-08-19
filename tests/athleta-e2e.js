/* Athleta: the shop's own order, and where it states the blend.

   Reported from athleta.gap.com/browse/new/all-new-arrivals: the products came
   back in an order that is not the page's, and the fabric column was empty
   although the product page says it plainly — Fabric & care → 100% Nylon.

   Both are shapes, not brands:

     · the grid renders in waves and RECYCLES its tiles, so a later sweep can
       hand back a different slice in a different order. Keeping the order rows
       were first seen in is then not the order the page lays them out in. The
       sweep that rendered the most tiles is the best statement of the layout,
       and that is the one that decides.
     · the product page is a shell — the visible text arrives from script, so a
       fetch sees a heading and nothing under it, and the composition sits in
       an embedded JSON blob further down the source. Reading the page's own
       source last picks that up, and costs nothing when the text answered.

   The fixture serves both product-page shapes: one server-rendered with the
   Fabric & care bullets, one shell with the blend only in the JSON.

   Run: NODE_PATH=/opt/node22/lib/node_modules xvfb-run -a node athleta-e2e.js */
"use strict";
const { chromium } = require("playwright");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const EXT = path.resolve(__dirname, "..");

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log("  ok  " + n); } else { fail++; console.log("FAIL  " + n + (x ? "\n      " + x : "")); } };

/* The page, in the order the screenshot shows it. */
const PRODUCTS = [
  ["Momentum Flex Tee", 59, "97% Nylon, 3% Spandex"],
  ["Favorite Cotton Classic Tee", 45, "100% Cotton"],
  ["TrainKnit Tee", 59, "94% Recycled Polyester, 6% Spandex"],
  ["Favorite Cotton Cinched Tee", 49, "100% Cotton"],
  ["Intuition Tee", 59, "53% Cotton, 17% Recycled Polyester, 16% Spandex, 14% Tencel"],
  ["Move With Ease Draped Tee", 55, "56% Recycled Polyester, 37% Tencel, 7% Elastane"],
  ["Seasoft Classic 1/4 Zip Sweatshirt", 99, "49% Polyester, 43% Tencel, 8% Spandex"],
  ["Ultimate Train Tee", 54, "100% Nylon"],
  ["Breezy Linen Shirt", 89, "100% Linen"],
  ["Studio Long Sleeve", 69, "88% Nylon, 12% Elastane"],
  ["Coastal Rib Tank", 39, "95% Cotton, 5% Elastane"],
  ["Endless Crew", 79, "100% Polyester"],
];
const CDN = "https://cdn.athleta.example";
const pid = i => 845689000 + i;
const FIRST = 4;              // what the grid renders before it is scrolled

const tile = (p, i) => `
  <div class="product-card">
    <a href="/browse/product.do?pid=${pid(i)}&vid=1&pcid=1006482&cid=1023334">
      <img src="${CDN}/p${i}.jpg" alt="${p[0]}">
    </a>
    <div class="brand">ATHLETA</div>
    <a class="name" href="/browse/product.do?pid=${pid(i)}&vid=1&pcid=1006482&cid=1023334">${p[0]}</a>
    <div class="price">$${p[1]}.00</div>
  </div>`;

/* A grid that renders in waves AND recycles: the first paint holds the first
   four, and once it has been scrolled it holds all twelve — the same shape
   that made "first seen" stop meaning "first on the page". */
const collection = () => `<!doctype html><meta charset="utf-8">
<title>New Arrivals | Athleta</title>
<h1>New Tops</h1><div class="results">${PRODUCTS.length} Results</div>
<div id="grid" class="product-grid">${PRODUCTS.slice(0, FIRST).map(tile).join("")}</div>
<div style="height:2400px"></div>
<script>
  var full = false;
  addEventListener("scroll", function () {
    if (full || scrollY < 200) return;
    full = true;
    document.getElementById("grid").innerHTML = ${JSON.stringify(PRODUCTS.map(tile).join(""))};
  });
</script>`;

/* Half the product pages are server-rendered with the bullets the screenshot
   shows; the other half are a shell whose only statement of the blend is the
   JSON the page ships with. */
const pdpRendered = (p, i) => `<!doctype html><meta charset="utf-8">
<title>${p[0]} | Athleta</title>
<meta property="og:image" content="${CDN}/p${i}.jpg">
<h1>${p[0]}</h1>
<h3>Size &amp; fit</h3>
<ul><li>Fitted next to the body</li><li>Regular length, hits at hip</li></ul>
<h3>Fabric &amp; care</h3>
<ul><li>${p[2]}</li><li>Machine wash cold</li><li>Product #${pid(i)}</li></ul>`;

const pdpShell = (p, i) => `<!doctype html><meta charset="utf-8">
<title>${p[0]} | Athleta</title>
<meta property="og:image" content="${CDN}/p${i}.jpg">
<div id="root"><h1>${p[0]}</h1><p>Loading…</p></div>
<script>window.__PRELOADED__ = ${JSON.stringify({
  product: { name: p[0], businessCatalogItemId: String(pid(i)),
    fabricAndCare: { header: "Fabric & care", bullets: [p[2], "Machine wash cold"] } },
})};</script>`;

const PORT = 8477;
const HOSTS = ["athleta.gap.com", "cdn.athleta.example"];
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
    if (host === "cdn.athleta.example") return send(GIF, "image/gif");
    const m = url.match(/product\.do\?pid=(\d+)/);
    if (m) {
      const i = +m[1] - 845689000;
      const p = PRODUCTS[i];
      if (!p) return send("<!doctype html><title>404</title>");
      return send(i % 2 === 0 ? pdpRendered(p, i) : pdpShell(p, i));
    }
    return send(collection());
  });
const serverReady = new Promise(r => server.listen(PORT, "127.0.0.1", r));

const ENTRY = [{ brand: "ATHLETA", label: "New In", scannable: true,
  url: "https://athleta.gap.com/browse/new/all-new-arrivals?cid=1006482#style=1023334" }];

(async () => {
  const MAP = HOSTS.map(h => `MAP ${h} 127.0.0.1:${PORT}`).join(",");
  execSync("rm -rf /tmp/pw-athleta");
  const ctx = await chromium.launchPersistentContext("/tmp/pw-athleta", {
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
    wpb_lists: [{ id: "A", name: "ACTIVE", createdAt: 1, entries: es }] }, r)), ENTRY);
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
    if (!q.active && rows.length >= PRODUCTS.length) break;
    if (!q.active && waited > 25000) break;
  }
  console.log(`    (${rows.length} rows of ${PRODUCTS.length})`);

  ok("the whole page came back, not the first paint",
    rows.length === PRODUCTS.length, `${rows.length} rows`);

  // ---- the order the page lays them out in ---------------------------------
  const byPos = rows.slice().sort((a, b) => a.pos - b.pos).map(r => r.name);
  ok("every row records where the shop had it", rows.every(r => r.pos > 0),
    rows.filter(r => !r.pos).length + " without a position");
  ok("…and that order is the page's own",
    byPos.join(" | ") === PRODUCTS.map(p => p[0]).join(" | "),
    byPos.slice(0, 5).join(" · ") + "\n         vs " + PRODUCTS.slice(0, 5).map(p => p[0]).join(" · "));

  // ---- Fabric & care -------------------------------------------------------
  const of = name => (rows.find(r => r.name === name) || {}).fabric || "";
  ok("the blend under Fabric & care is read", /100%\s*Nylon/i.test(of("Ultimate Train Tee")),
    of("Ultimate Train Tee"));
  ok("…including the four-fibre ones",
    /53%\s*Cotton/i.test(of("Intuition Tee")) && /14%\s*Tencel/i.test(of("Intuition Tee")),
    of("Intuition Tee"));
  ok("…and on a page whose text arrives from script",
    /97%\s*Nylon/i.test(of("Momentum Flex Tee")), of("Momentum Flex Tee"));
  ok("every row has a composition", rows.every(r => /%/.test(r.fabric)),
    rows.filter(r => !/%/.test(r.fabric)).map(r => r.name).join(" | "));
  ok("the care line is not filed as the fabric",
    rows.every(r => !/machine wash|product #/i.test(r.fabric)),
    rows.map(r => r.fabric).join(" | ").slice(0, 120));

  // ---- and the rest of the row ---------------------------------------------
  ok("the shop is filed as Athleta, not its parent",
    rows.every(r => /athleta/i.test(r.brand)), [...new Set(rows.map(r => r.brand))].join(" | "));
  ok("every row has a photograph", rows.every(r => /^https?:/.test(r.image)),
    rows.filter(r => !/^https?:/.test(r.image)).length + " without one");
  ok("prices are the shop's", rows.every(r => /^\$\d+\.00$/.test(r.price)),
    [...new Set(rows.map(r => r.price))].slice(0, 4).join(" | "));

  ok("no page errors", errs.length === 0, errs.join(" | "));
  console.log(`\n${pass} passed, ${fail} failed`);
  await ctx.close();
  server.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log("HARNESS ERROR: " + (e && e.message || e)); process.exit(1); });
