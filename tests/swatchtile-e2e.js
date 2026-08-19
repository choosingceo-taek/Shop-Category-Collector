/* The tile drew a colourway swatch; the shop's own gallery has the garment.

   Reported from setactive.co: striped pieces came back as flat bands of colour
   with no garment in them — "terry stripe funnel zip hoodie", "easy stripe
   shorts", "essential stripe double take long sleeve" — while the product page
   opens on the model wearing it.

   The tile's picture was winning. readDetail brought the shop's own product
   JSON back with images[0] in it, and the merge said "only if the row has no
   picture yet" — so a swatch the theme happened to render was final. That is
   backwards from the first rule in this project: structured data over DOM
   heuristics. The title already followed it (v1.68, which stopped a whole
   Edikted sheet reading "Select Size"); the picture did not.

   Two shapes here, and they must land differently:

     · a product whose gallery states its photograph  -> the gallery wins over
       whatever the tile drew
     · a product with NO gallery, only a picture hung off a colour variant ->
       the tile keeps its own, because a variant asset IS a colourway and
       promoting it would install the swatch deliberately

   And the second half: a re-scan must show the correction. Rows already
   holding the old answer were being reused for a month (FRESH_MS), so the
   person who asked for the fix would have re-scanned and seen nothing change.
   A row records which reader produced it and only a current one is trusted.

   Run: NODE_PATH=/opt/node22/lib/node_modules xvfb-run -a node swatchtile-e2e.js */
"use strict";
const { chromium } = require("playwright");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const EXT = path.resolve(__dirname, "..");

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log("  ok  " + n); } else { fail++; console.log("FAIL  " + n + (x ? "\n      " + x : "")); } };

const CDN = "https://cdn.shopify.com/s/files/1/set";
const NAMES = ["terry stripe funnel zip hoodie", "easy stripe shorts",
  "essential stripe double take long sleeve", "terry stripe shorts",
  "weekend knit funnel zip", "everyday rib tank"];
/* The last one is the other shape: no gallery at all, only a variant asset. */
const VARIANT_ONLY = NAMES.length - 1;

const ALL = NAMES.map((name, i) => ({
  i, name, handle: name.replace(/\s+/g, "-"),
  price: 58 + i * 5,
  worn: `${CDN}/worn-${i}.jpg`,          // the garment, on a model
  swatch: `${CDN}/colorway-${i}.jpg`,    // a flat band of the colourway
}));

/* The grid draws the colourway, not the garment. */
const tile = p => `
  <li class="card">
    <a href="/products/${p.handle}">
      <img src="${p.swatch}" alt="${p.name}" width="800" height="1000">
    </a>
    <div class="meta">
      <span class="vendor">SET ACTIVE</span>
      <span class="t">${p.name}</span>
      <span class="pr">$${p.price}.00</span>
    </div>
  </li>`;

const collection = () => `<!doctype html><meta charset="utf-8">
<title>Set Sweats | Set Active</title>
<link rel="stylesheet" href="//cdn.shopify.com/s/files/theme.css">
<h1>Set Sweats</h1>
<ul class="grid">${ALL.map(tile).join("")}</ul>`;

/* The shop's own JSON: the gallery opens on the garment. The last product has
   no gallery — only a colour variant with an asset of its own. */
const jsonOf = p => ({
  id: 900 + p.i, handle: p.handle, title: p.name, vendor: "Set Active",
  product_type: "Sweats",
  body_html: "<p>Fabric: 60% Polyester, 35% Rayon, 5% Spandex</p>",
  options: [{ name: "Color", values: ["Heatwave"] }],
  variants: [{ price: String(p.price) + ".00", compare_at_price: null,
    featured_image: { src: p.swatch } }],
  images: p.i === VARIANT_ONLY ? [] : [{ src: p.worn }, { src: p.swatch }],
});
const bulk = () => JSON.stringify({ products: ALL.map(jsonOf) });

const PORT = 8487;
const HOSTS = ["setactive.co", "cdn.shopify.com"];
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
    if (host === "cdn.shopify.com") {
      if (/\.jpg$/.test(url)) return send(GIF, "image/gif");
      return send("/* theme */", "text/css");
    }
    if (/products\.json/.test(url)) return send(bulk(), "application/json");
    const m = url.match(/\/products\/([^/?.]+)/);
    if (m) {
      const p = ALL.find(x => x.handle === m[1]);
      if (!p) return send("<!doctype html><title>404</title>");
      if (/\.js(\?|$)/.test(url)) return send(JSON.stringify(jsonOf(p)), "application/json");
      return send(`<!doctype html><meta charset="utf-8"><title>${p.name}</title>
        <meta property="og:image" content="${p.worn}">
        <h1>${p.name}</h1><p>60% Polyester, 35% Rayon, 5% Spandex</p>`);
    }
    return send(collection());
  });
const serverReady = new Promise(r => server.listen(PORT, "127.0.0.1", r));

const ENTRY = [{ brand: "SET ACTIVE", label: "New In", scannable: true,
  url: "https://setactive.co/collections/set-sweats" }];

const rowsIn = sw => sw.evaluate(() => self.CatalogStore.allProducts().then(p =>
  p.map(x => ({ name: x.name, image: x.image_url || "", readerV: x.readerV || 0,
    fabric: x.fabric_composition || "" })))).catch(() => []);

(async () => {
  const MAP = HOSTS.map(h => `MAP ${h} 127.0.0.1:${PORT}`).join(",");
  execSync("rm -rf /tmp/pw-swatchtile");
  const ctx = await chromium.launchPersistentContext("/tmp/pw-swatchtile", {
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
    wpb_lists: [{ id: "S", name: "ACTIVE", createdAt: 1, entries: es }] }, r)), ENTRY);
  await panel.reload();
  await panel.waitForTimeout(1400);

  const run = async () => {
    await panel.click("#runlist");
    await panel.waitForTimeout(600);
    if (!await panel.locator("#ask").isHidden()) await panel.click("#askok");
    let rows = [], waited = 0;
    while (waited < 160000) {
      await panel.waitForTimeout(2500); waited += 2500;
      rows = await rowsIn(sw);
      const q = await panel.evaluate(() => new Promise(r =>
        chrome.storage.local.get("wpb_queue", o => r((o || {}).wpb_queue || {}))));
      if (!q.active && rows.length >= ALL.length) break;
      if (!q.active && waited > 30000) break;
    }
    return rows;
  };

  const rows = await run();
  const of = n => (rows.find(r => r.name === n) || {});
  console.log(`    (${rows.length} rows · ${rows.filter(r => /colorway-/.test(r.image)).length} still showing a colourway)`);

  ok("every product came back", rows.length === ALL.length, `${rows.length} rows`);
  ok("the garment is what got filed, not the band of colour",
    ALL.filter(p => p.i !== VARIANT_ONLY).every(p => /worn-/.test(of(p.name).image || "")),
    ALL.filter(p => p.i !== VARIANT_ONLY).map(p => `${p.name}: ${of(p.name).image}`).join("\n         "));
  ok("…and no row kept the swatch the tile drew",
    !ALL.filter(p => p.i !== VARIANT_ONLY).some(p => /colorway-/.test(of(p.name).image || "")),
    rows.filter(r => /colorway-/.test(r.image)).map(r => r.name).join(" | "));

  /* The other shape: nothing but a variant asset. Promoting that would be
     installing a swatch on purpose, so the tile's own picture stands. */
  const vo = of(NAMES[VARIANT_ONLY]);
  ok("a picture hung off a colour variant does not outrank the tile",
    /colorway-/.test(vo.image || ""), JSON.stringify(vo));

  ok("the blend is still read", rows.every(r => /%/.test(r.fabric)),
    rows.filter(r => !/%/.test(r.fabric)).map(r => r.name).join(" | "));
  ok("every row records which reader produced it",
    rows.every(r => r.readerV >= 2), JSON.stringify(rows.map(r => r.readerV)));

  /* ---- and a re-scan must not freeze yesterday's answer ------------------ */
  await sw.evaluate(() => self.CatalogStore.allProducts().then(rs => Promise.all(
    rs.map(r => new Promise(res => {
      r.image_url = r.image_url.replace("worn-", "colorway-");   // as an older reader left it
      r.readerV = 1;
      const req = indexedDB.open("shopcat");
      req.onsuccess = () => {
        const t = req.result.transaction("products", "readwrite");
        t.objectStore("products").put(r);
        t.oncomplete = () => res();
      };
    })))));
  const stale = await rowsIn(sw);
  ok("the fixture really did put the old answer back",
    stale.every(r => /colorway-/.test(r.image)), JSON.stringify(stale.map(r => r.image)));

  const again = await run();
  const of2 = n => (again.find(r => r.name === n) || {});
  ok("a re-scan reads them again rather than trusting an older reader",
    ALL.filter(p => p.i !== VARIANT_ONLY).every(p => /worn-/.test(of2(p.name).image || "")),
    again.map(r => `${r.name}: ${r.image}`).join("\n         "));

  ok("no page errors", errs.length === 0, errs.join(" | "));
  console.log(`\n${pass} passed, ${fail} failed`);
  await ctx.close();
  server.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log("HARNESS ERROR: " + (e && e.message || e)); process.exit(1); });
