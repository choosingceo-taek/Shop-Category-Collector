/* A grid that hands over four of fourteen, and says nothing about it.

   Reported from setactive.co/collections/new: the scan came back with four
   products. The rescue that exists for this — press the shop's "load more",
   sweep the grid again — is gated on the page PRINTING how many it is showing
   ("66 items"), and this theme prints no such number anywhere. With nothing to
   be short of, nothing was pressed, nothing was swept, and four of fourteen
   graded itself complete. That is the worst outcome this tool has: the
   spreadsheet looks whole.

   So the fixture is exactly that shape and nothing more forgiving:
     · four tiles rendered, and no more arrive however far you scroll
     · no count anywhere on the page
     · no load-more button to press
     · the collection's own products.json lists fourteen

   And the second address is the same shop with a filter on it, where the
   rendered page must keep deciding — products.json knows nothing about the
   facets a designer chose, so topping that up would put back the very items
   they filtered out.

   Run: NODE_PATH=/opt/node22/lib/node_modules xvfb-run -a node shortgrid-e2e.js */
"use strict";
const { chromium } = require("playwright");
const https = require("https");
const fs = require("fs");
const { execSync } = require("child_process");
const path = require("path");
const EXT = path.resolve(__dirname, "..");

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log("  ok  " + n); } else { fail++; console.log("FAIL  " + n + (x ? "\n      " + x : "")); } };

const IMG = "https://cdn.example/photo-800.jpg";
const RENDERED = 4;          // what the theme paints
const IN_COLLECTION = 14;    // what the collection actually holds
const FILTERED = 3;          // what the filtered address paints

const tile = i => `
  <li class="card"><a href="https://setactive.co/products/towel-terry-${i}">
    <img src="${IMG}?i=${i}" alt="Towel Terry Stripe ${i}" width="800" height="1067">
    <span class="t">Towel Terry Stripe ${i}</span> <span class="pr">$120.00</span></a></li>`;

/* No count, no load-more, and a tall footer under the grid — the page gives
   the reader nothing to work with except the tiles it chose to paint. */
const grid = n => `<!doctype html><meta charset="utf-8"><title>New | Set Active</title>
<link rel="stylesheet" href="//cdn.shopify.com/s/files/theme.css">
<h1>New</h1><ul class="grid">${Array.from({ length: n }, (_, i) => tile(i)).join("")}</ul>
<footer style="height:3000px">Set Active</footer>`;

const bulk = () => JSON.stringify({ products: Array.from({ length: IN_COLLECTION }, (_, i) => ({
  id: 500 + i, handle: `towel-terry-${i}`, title: `Towel Terry Stripe ${i}`,
  vendor: "AUG 2026 - CORE",                    // a drop name, never a brand
  product_type: "Tops", published_at: "2026-08-19T00:00:00Z",
  body_html: "<p>60% Polyester, 35% Rayon, 5% Spandex</p>",
  images: [{ src: `${IMG}?i=${i}` }],
  variants: [{ price: "120.00" }],
  options: [{ name: "Color", values: ["Reef", "Toucan"] }],
})) });

/* ---- the second shape: a button, and no count either --------------------

   athleta.gap.com is not Shopify, so there is no collection JSON to fall back
   on. What it has is a "View More" under the grid — and the press that exists
   for exactly that was gated on the shop stating a count, which this page
   never does. So the grid went stable at the first screenful and the scan
   stopped with eight. The vocabulary already matched the button; nothing ever
   reached it. */
const GAP_FIRST = 8, GAP_TOTAL = 20, GAP_STEP = 6;
const gapTile = i => `
  <li class="card"><a href="https://athleta.gap.com/browse/product.do?pid=${900 + i}">
    <img src="${IMG}?g=${i}" alt="Brooklyn Jogger ${i}" width="800" height="1067">
    <span class="t">Brooklyn Jogger ${i}</span> <span class="pr">$79.00</span></a></li>`;
const gapGrid = shown => `<!doctype html><meta charset="utf-8"><title>New Arrivals | Athleta</title>
<h1>All New Arrivals</h1>
<ul class="grid" id="g">${Array.from({ length: shown }, (_, i) => gapTile(i)).join("")}</ul>
<button id="vm">View More</button>
<footer style="height:2500px">Athleta</footer>
<script>
  var shown = ${shown};
  document.getElementById("vm").addEventListener("click", function () {
    var add = Math.min(${GAP_STEP}, ${GAP_TOTAL} - shown);
    var html = "";
    for (var i = shown; i < shown + add; i++) {
      html += '<li class="card"><a href="https://athleta.gap.com/browse/product.do?pid=' + (900 + i) + '">' +
        '<img src="${IMG}?g=' + i + '" alt="Brooklyn Jogger ' + i + '" width="800" height="1067">' +
        '<span class="t">Brooklyn Jogger ' + i + '</span> <span class="pr">$79.00</span></a></li>';
    }
    document.getElementById("g").insertAdjacentHTML("beforeend", html);
    shown += add;
    if (shown >= ${GAP_TOTAL}) document.getElementById("vm").remove();
  });
</script>`;
const gapPdp = i => `<!doctype html><meta charset="utf-8"><title>Brooklyn Jogger ${i}</title>
<meta property="og:image" content="${IMG}?g=${i}">
<h1>Brooklyn Jogger ${i}</h1><p>88% Nylon, 12% Elastane</p>`;

/* ---- the third shape: a filtered address that opens four at a time ------

   TALA's new-in carries a Shopify filter, so the collection JSON is off the
   table — products.json knows nothing about the facet. What is left is the
   button, and eight presses was a fixed allowance: a grid that opens four at a
   time stopped at forty-two however much it had left. The allowance exists to
   stop us hammering a button that does nothing, so only a press that changes
   nothing should spend it. */
const TALA_FIRST = 10, TALA_TOTAL = 58, TALA_STEP = 4;
const talaGrid = () => `<!doctype html><meta charset="utf-8"><title>New In | TALA</title>
<link rel="stylesheet" href="//cdn.shopify.com/s/files/theme.css">
<h1>New In</h1><ul class="grid" id="g">${Array.from({ length: TALA_FIRST }, (_, i) => `
  <li class="card"><a href="https://www.wearetala.com/products/dayflex-${i}">
    <img src="${IMG}?t=${i}" alt="Dayflex Legging ${i}" width="800" height="1067">
    <span class="t">Dayflex Legging ${i}</span> <span class="pr">£62.00</span></a></li>`).join("")}</ul>
<button id="lm">Load more</button>
<footer style="height:2200px">TALA</footer>
<script>
  var shown = ${TALA_FIRST};
  document.getElementById("lm").addEventListener("click", function () {
    var add = Math.min(${TALA_STEP}, ${TALA_TOTAL} - shown), html = "";
    for (var i = shown; i < shown + add; i++) {
      html += '<li class="card"><a href="https://www.wearetala.com/products/dayflex-' + i + '">' +
        '<img src="${IMG}?t=' + i + '" alt="Dayflex Legging ' + i + '" width="800" height="1067">' +
        '<span class="t">Dayflex Legging ' + i + '</span> <span class="pr">£62.00</span></a></li>';
    }
    document.getElementById("g").insertAdjacentHTML("beforeend", html);
    shown += add;
    if (shown >= ${TALA_TOTAL}) document.getElementById("lm").remove();
  });
</script>`;
/* ...and a button that answers nothing, which is what the allowance is for.
   The run must stop AND say the page still had it. */
const DUD_N = 6;
const dudGrid = () => `<!doctype html><meta charset="utf-8"><title>Shop | TALA</title>
<link rel="stylesheet" href="//cdn.shopify.com/s/files/theme.css">
<h1>Shop</h1><ul class="grid">${Array.from({ length: DUD_N }, (_, i) => `
  <li class="card"><a href="https://www.wearetala.com/products/dud-${i}">
    <img src="${IMG}?d=${i}" alt="Dud ${i}" width="800" height="1067">
    <span class="t">Dud ${i}</span> <span class="pr">£20.00</span></a></li>`).join("")}</ul>
<button id="lm">Load more</button><footer style="height:2000px">TALA</footer>`;
const talaPdp = i => `<!doctype html><meta charset="utf-8"><title>Dayflex ${i}</title>
<meta property="og:image" content="${IMG}?t=${i}">
<h1>Dayflex Legging ${i}</h1><p>75% Recycled Polyester, 25% Elastane</p>`;

const PORT = 8452;
const HOSTS = ["setactive.co", "athleta.gap.com", "www.wearetala.com", "cdn.example"];
const GIF = Buffer.from("R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==", "base64");

if (!fs.existsSync("/tmp/ml-key.pem")) {
  execSync('openssl req -x509 -newkey rsa:2048 -nodes -keyout /tmp/ml-key.pem ' +
    '-out /tmp/ml-cert.pem -days 365 -subj "/CN=localhost" 2>/dev/null');
}

let bulkHits = 0;
const server = https.createServer(
  { key: fs.readFileSync("/tmp/ml-key.pem"), cert: fs.readFileSync("/tmp/ml-cert.pem") },
  (req, res) => {
    const host = String(req.headers.host || "").split(":")[0];
    const url = req.url || "/";
    const send = (b, t) => { res.writeHead(200, { "content-type": t || "text/html; charset=utf-8" }); res.end(b); };
    if (host === "cdn.example") return send(GIF, "image/gif");
    if (host === "www.wearetala.com") {
      const m = url.match(/dayflex-(\d+)|dud-(\d+)/);
      if (m) return send(talaPdp(m[1] || m[2]));
      return send(/\/collections\/shop/.test(url) ? dudGrid() : talaGrid());
    }
    if (host === "athleta.gap.com") {
      const m = url.match(/product\.do\?pid=(\d+)/);
      return send(m ? gapPdp(m[1]) : gapGrid(GAP_FIRST));
    }
    if (url.includes("products.json")) {
      bulkHits++;
      // page=2 and beyond are empty, the way a 14-product collection answers
      return send(/page=([2-9])/.test(url) ? JSON.stringify({ products: [] }) : bulk(), "application/json");
    }
    if (url.includes("/products/")) return send(
      `<!doctype html><meta charset=utf-8><title>Towel Terry</title><h1>Towel Terry</h1>
       <p>60% Polyester, 35% Rayon, 5% Spandex</p>`);
    if (/filter\.|o_cat=|collections=/.test(url)) return send(grid(FILTERED));
    return send(grid(RENDERED));
  });
const serverReady = new Promise(r => server.listen(PORT, "127.0.0.1", r));

const run = async (panel, sw, entries, want, waitMs) => {
  await panel.evaluate(es => new Promise(r => chrome.storage.local.set({
    wpb_autoupdate: false,
    wpb_lists: [{ id: "S", name: "ACTIVE", createdAt: 1, entries: es }],
  }, r)), entries);
  await sw.evaluate(() => self.CatalogStore.clearAll()).catch(() => {});
  await panel.reload();
  await panel.waitForTimeout(1400);
  await panel.click("#runlist");
  await panel.waitForTimeout(600);
  if (!await panel.locator("#ask").isHidden()) await panel.click("#askok");
  let rows = [], waited = 0;
  while (waited < (waitMs || 90000)) {
    await panel.waitForTimeout(2500); waited += 2500;
    rows = await sw.evaluate(() => self.CatalogStore.allProducts().then(p =>
      p.map(x => ({ brand: x.brand, name: x.name, url: x.product_url,
        image: x.image_url || "", fabric: x.fabric_composition || x.fabric || "" })))).catch(() => []);
    const q = await panel.evaluate(() => new Promise(r =>
      chrome.storage.local.get("wpb_queue", o => r((o || {}).wpb_queue || {}))));
    if (!q.active && rows.length) break;
    if (rows.length >= want) break;
  }
  return rows;
};

(async () => {
  const MAP = HOSTS.map(h => `MAP ${h} 127.0.0.1:${PORT}`).join(",");
  const ctx = await chromium.launchPersistentContext("/tmp/pw-shortgrid", {
    executablePath: "/opt/pw-browsers/chromium", headless: false, ignoreHTTPSErrors: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-sandbox",
      `--host-resolver-rules=${MAP}`, "--ignore-certificate-errors", "--no-proxy-server"] });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker");
  const id = sw.url().split("/")[2];
  await serverReady;

  const probe = await ctx.newPage();
  const resp = await probe.goto("https://setactive.co/collections/new").catch(e => ({ err: e.message }));
  const tiles = resp && resp.err ? -1 : await probe.locator("li.card").count();
  console.log("    fixture origin:", resp && resp.err ? "FAILED " + resp.err.split("\n")[0]
    : `HTTP ${resp.status()} · ${tiles} tiles rendered`);
  ok("the fixture really renders only four", tiles === RENDERED, String(tiles));
  await probe.close();

  const panel = await ctx.newPage();
  await panel.setViewportSize({ width: 380, height: 900 });
  const errs = []; panel.on("pageerror", e => errs.push(e.message));
  await panel.goto(`chrome-extension://${id}/sidepanel.html`);
  await panel.waitForTimeout(500);

  // ---- the plain collection: everything the shop says is in it -------------
  const rows = await run(panel, sw, [{ brand: "SET ACTIVE", label: "New In",
    url: "https://setactive.co/collections/new", scannable: true }], IN_COLLECTION, 120000);

  ok(`the whole collection came back, not the four the grid painted`,
    rows.length === IN_COLLECTION, `${rows.length} rows`);
  ok("the tiles that DID render lead, so the shop's order survives",
    rows.length > 4 && /Towel Terry Stripe 0$/.test(rows[0].name || ""),
    rows.slice(0, 3).map(r => r.name).join(" | "));
  ok("every row has a name", rows.every(r => (r.name || "").trim().length > 3),
    rows.filter(r => !(r.name || "").trim()).length + " without one");
  ok("every row has a photo", rows.every(r => /^https?:/.test(r.image || "")),
    rows.filter(r => !/^https?:/.test(r.image || "")).length + " without one");
  ok("every row has a composition", rows.every(r => /%/.test(r.fabric || "")),
    rows.filter(r => !/%/.test(r.fabric || "")).length + " without one");
  ok("the brand is the name the designer gave the list, not the drop name",
    rows.every(r => r.brand === "SET ACTIVE"),
    [...new Set(rows.map(r => r.brand))].join(" | "));
  ok("the addresses are the shop's own product pages",
    rows.every(r => /^https:\/\/setactive\.co\/products\//.test(r.url || "")),
    (rows.find(r => !/^https:\/\/setactive\.co\/products\//.test(r.url || "")) || {}).url);
  ok("one bulk request per page of it, not one per product",
    bulkHits <= 4, `${bulkHits} requests`);

  // ---- with a filter on the address, the rendered page still decides -------
  bulkHits = 0;
  const filtered = await run(panel, sw, [{ brand: "SET ACTIVE", label: "New In",
    url: "https://setactive.co/collections/new?filter.v.option.color=Reef", scannable: true }],
  FILTERED, 60000);
  ok("a filtered address is not topped up from the collection",
    filtered.length === FILTERED, `${filtered.length} rows, expected ${FILTERED}`);

  /* Every theme invents its own facet parameter, so the ones that narrow a
     collection cannot be listed — Varley writes ?o_cat=Tops&o_cat=Sweatshirts
     and Gymshark writes ?collections=t-shirts-tops, and against a list of
     known filters both read as "no filter at all". Topping those up puts back
     exactly the products the designer excluded, which is worse than being
     short: it is wrong, and it looks right. */
  for (const [name, addr] of [
    ["a theme's own facet (Varley's o_cat)",
      "https://setactive.co/collections/new?o_cat=Tops&o_cat=Sweatshirts"],
    ["a theme's own facet (Gymshark's collections)",
      "https://setactive.co/collections/new?collections=t-shirts-tops"],
  ]) {
    const r = await run(panel, sw, [{ brand: "SET ACTIVE", label: "New In",
      url: addr, scannable: true }], FILTERED, 60000);
    ok(`${name} is treated as a filter`, r.length === FILTERED,
      `${r.length} rows, expected ${FILTERED}`);
  }

  // ---- a shop with no JSON, no count, and a button ------------------------
  const gap = await run(panel, sw, [{ brand: "ATHLETA", label: "All New Arrivals",
    url: "https://athleta.gap.com/browse/new/all-new-arrivals?cid=1006482", scannable: true }],
  GAP_TOTAL, 150000);
  ok("the View More was pressed until the grid ran out",
    gap.length === GAP_TOTAL, `${gap.length} rows, expected ${GAP_TOTAL}`);
  ok("…and those rows carry a name and a photo",
    gap.length > GAP_FIRST && gap.every(r => (r.name || "").trim().length > 3 &&
      /^https?:/.test(r.image || "")),
    gap.filter(r => !(r.name || "").trim() || !/^https?:/.test(r.image || "")).length + " incomplete");

  // ---- a filtered address whose button opens four at a time ---------------
  const tala = await run(panel, sw, [{ brand: "TALA", label: "New In",
    url: "https://www.wearetala.com/en-us/collections/new-in?filter.v.m.variant_data.availability=Online+Store",
    scannable: true }], TALA_TOTAL, 180000);
  ok("the presses kept going while the grid kept answering",
    tala.length === TALA_TOTAL, `${tala.length} rows, expected ${TALA_TOTAL}`);

  // ---- a button that answers nothing: stop, and SAY the page still had it --
  const dud = await run(panel, sw, [{ brand: "TALA", label: "Shop",
    url: "https://www.wearetala.com/collections/shop?o_cat=Tops", scannable: true }],
  DUD_N, 90000);
  ok("a dud button does not become an endless loop", dud.length === DUD_N,
    `${dud.length} rows`);
  const health = await panel.evaluate(() => new Promise(r =>
    chrome.storage.local.get("wpb_sitehealth", o => r((o || {}).wpb_sitehealth || {}))));
  const said = Object.values(health).map(v => (v && v.why) || "").join(" ");
  ok("…and the run says the page still had a Load more on it",
    /still had a Load more/i.test(said), said.slice(0, 300) || "(nothing said)");

  ok("no page errors", errs.length === 0, errs.join(" | "));
  console.log(`\n${pass} passed, ${fail} failed`);
  server.close();
  await ctx.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log("HARNESS " + (e && e.message || e)); server.close(); process.exit(1); });
