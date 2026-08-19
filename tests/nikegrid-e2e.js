/* Nike's /w/ listing: a grid that does not exist when the document is ready.

   Reported: https://www.nike.com/w/new-womens-sportswear-tops-t-shirts-3n82yz43h4uz5e1x6z9om13
   went into a list and nothing came back — no products, nothing in the LAB.

   Nike has no adapter, so this is the generic reader on the shapes that page
   is made of, and every one of them is a way to come back with zero:

     · the document arrives as a shell and the grid is painted from script
       seconds later. A sweep that decides "no products" before the paint
       reports an empty shop, and the band then blames the shop for our clock
       (v3.7.0 bought 9 seconds for exactly this; this fixture spends 4.5 of
       them before the first tile exists).
     · the tile's accessible name is an absolutely-positioned overlay LINK
       covering the card, with the product name as its text. Read the wrong
       element and every row is filed under the same interface phrase.
     · product addresses are /t/<slug>/<STYLE-COLOUR> — no /products/, no
       .html, and a code as the last segment. A name taken from the slug must
       not become that code.
     · the footer is enormous, so the trigger that loads the next page sits
       far above the end of the document.
     · the blend is on the product page under Product Details, as "Body: 100%
       Cotton" — a label, a colon, then the composition.

   Run: NODE_PATH=/opt/node22/lib/node_modules xvfb-run -a node nikegrid-e2e.js */
"use strict";
const { chromium } = require("playwright");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const EXT = path.resolve(__dirname, "..");

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log("  ok  " + n); } else { fail++; console.log("FAIL  " + n + (x ? "\n      " + x : "")); } };

const N = 48, FIRST = 24, PAINT_MS = 4500;
const TITLES = ["Nike Sportswear Chill Knit", "Nike Sportswear Essential",
  "Nike Dri-FIT One", "Nike Sportswear Phoenix Fleece"];
const SUBS = ["Women's Slim Cropped Tank Top", "Women's Ribbed Cropped Tee",
  "Women's Short-Sleeve Top", "Women's Oversized Crew-Neck Sweatshirt"];
const BLEND = ["100% Cotton", "60% Cotton/40% Polyester", "95% Cotton/5% Elastane",
  "80% Cotton/20% Polyester"];
const CDN = "https://static.nike.com";
const code = i => `F${String(11000 + i)}-0${i % 9}1`;
const slug = i => TITLES[i % TITLES.length].toLowerCase().replace(/[^a-z]+/g, "-") + "-" + i;
const ALL = Array.from({ length: N }, (_, i) => ({
  i, title: `${TITLES[i % TITLES.length]} ${i}`, sub: SUBS[i % SUBS.length],
  price: 40 + (i % 5) * 5, blend: BLEND[i % BLEND.length],
  href: `/t/${slug(i)}/${code(i)}`,
}));

/* One card, in the shape Nike builds: an overlay link carrying the name, the
   photograph, then title / subtitle / price. */
const card = p => `
  <div class="product-card">
    <figure>
      <a class="product-card__link-overlay" href="${p.href}">${p.title}</a>
      <div class="product-card__hero-image-container">
        <img class="product-card__hero-image" src="${CDN}/a/images/${p.i}.jpg" alt="${p.title}">
      </div>
      <figcaption class="product-card__body">
        <div class="product-card__titles">
          <div class="product-card__title" role="link">${p.title}</div>
          <div class="product-card__subtitle">${p.sub}</div>
        </div>
        <div class="product-price is--current-price">$${p.price}.00</div>
      </figcaption>
    </figure>
  </div>`;

const FOOTER = `<footer style="height:3200px">Nike. Just Do It.</footer>`;

/* The document is a shell. The grid arrives from script, late, and grows when
   the bottom of the list comes into view. */
const listing = () => `<!doctype html><meta charset="utf-8">
<title>New Women's Sportswear Tops &amp; T-Shirts. Nike.com</title>
<div id="app"><h1>New Women's Sportswear Tops &amp; T-Shirts</h1>
  <div id="grid" class="product-grid"></div>
</div>
${FOOTER}
<script>
  var CARDS = ${JSON.stringify(ALL.map(card))};
  var shown = 0;
  function paint(n) {
    shown = Math.min(${N}, n);
    document.getElementById("grid").innerHTML = CARDS.slice(0, shown).join("");
  }
  setTimeout(function () { paint(${FIRST}); }, ${PAINT_MS});
  addEventListener("scroll", function () {
    if (!shown || shown >= ${N}) return;
    var g = document.getElementById("grid");
    var end = g.getBoundingClientRect().bottom;
    if (end > innerHeight + 200) return;      // the trigger is the end of the GRID
    paint(shown + 24);
  });
</script>`;

/* The product page: server-rendered, with the blend under Product Details. */
const pdp = p => `<!doctype html><meta charset="utf-8">
<title>${p.title}. Nike.com</title>
<script type="application/ld+json">${JSON.stringify({
  "@context": "https://schema.org", "@type": "Product", name: p.title,
  brand: { "@type": "Brand", name: "Nike" },
  image: [`${CDN}/a/images/${p.i}.jpg`],
  offers: { "@type": "Offer", price: String(p.price) + ".00", priceCurrency: "USD" },
})}</script>
<h1>${p.title}</h1><h2>${p.sub}</h2>
<div class="product-price">$${p.price}.00</div>
<h3>Product Details</h3>
<ul>
  <li>Body: ${p.blend}</li>
  <li>Machine wash</li>
  <li>Imported</li>
  <li>Style: ${code(p.i)}</li>
</ul>`;

const PORT = 8483;
const HOSTS = ["www.nike.com", "static.nike.com"];
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
    if (host === "static.nike.com") return send(GIF, "image/gif");
    const m = url.match(/^\/t\/[^/]+\/([A-Z0-9-]+)/);
    if (m) {
      const p = ALL.find(x => code(x.i) === m[1]);
      return send(p ? pdp(p) : "<!doctype html><title>404</title>");
    }
    return send(listing());
  });
const serverReady = new Promise(r => server.listen(PORT, "127.0.0.1", r));

const URL_ = "https://www.nike.com/w/new-womens-sportswear-tops-t-shirts-3n82yz43h4uz5e1x6z9om13";
const ENTRY = [{ brand: "NIKE", label: "New Womens Sportswear Tops T Shirts",
  scannable: true, url: URL_ }];

(async () => {
  const MAP = HOSTS.map(h => `MAP ${h} 127.0.0.1:${PORT}`).join(",");
  execSync("rm -rf /tmp/pw-nikegrid");
  const ctx = await chromium.launchPersistentContext("/tmp/pw-nikegrid", {
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
    wpb_lists: [{ id: "N", name: "ACTIVE", createdAt: 1, entries: es }] }, r)), ENTRY);
  await panel.reload();
  await panel.waitForTimeout(1400);
  await panel.click("#runlist");
  await panel.waitForTimeout(600);
  if (!await panel.locator("#ask").isHidden()) await panel.click("#askok");

  let rows = [], waited = 0;
  while (waited < 200000) {
    await panel.waitForTimeout(2500); waited += 2500;
    rows = await sw.evaluate(() => self.CatalogStore.allProducts().then(p =>
      p.map(x => ({ name: x.name, url: x.product_url, brand: x.brand, pos: x.pos || 0,
        image: x.image_url || "", price: x.price || "",
        fabric: x.fabric_composition || "" })))).catch(() => []);
    const q = await panel.evaluate(() => new Promise(r =>
      chrome.storage.local.get("wpb_queue", o => r((o || {}).wpb_queue || {}))));
    if (!q.active && rows.length >= N) break;
    if (!q.active && waited > 40000) break;
  }
  const health = await panel.evaluate(() => new Promise(r =>
    chrome.storage.local.get("wpb_sitehealth", o => r((o || {}).wpb_sitehealth || {}))));
  const say = Object.values(health)[0] || {};
  console.log(`    (${rows.length} rows of ${N} · grade ${say.mark || "?"} · ${say.why || ""})`);

  ok("the shop is not reported empty because we looked too early",
    rows.length > 0, "nothing came back");
  ok(`all ${N} came back, not the ${FIRST} of the first paint`,
    rows.length === N, `${rows.length} rows`);
  ok("every row is a garment name, not one interface phrase repeated",
    new Set(rows.map(r => r.name)).size === rows.length,
    [...new Set(rows.map(r => r.name))].slice(0, 3).join(" | "));
  ok("…and it is the name Nike gives it",
    rows.every(r => TITLES.some(t => (r.name || "").startsWith(t))),
    rows.filter(r => !TITLES.some(t => (r.name || "").startsWith(t)))
      .slice(0, 3).map(r => r.name).join(" | "));
  ok("no row is named after the style code",
    !rows.some(r => /^[A-Z]?\d{4,}/.test(r.name || "")),
    rows.filter(r => /^[A-Z]?\d{4,}/.test(r.name || "")).slice(0, 3).map(r => r.name).join(" | "));
  ok("the addresses are Nike's product pages",
    rows.every(r => /\/t\/[^/]+\/[A-Z0-9-]+$/.test(r.url || "")),
    rows.filter(r => !/\/t\//.test(r.url || "")).slice(0, 3).map(r => r.url).join(" | "));
  ok("every row has a photograph", rows.every(r => /^https?:/.test(r.image)),
    rows.filter(r => !/^https?:/.test(r.image)).length + " without one");
  ok("every row has the price Nike shows", rows.every(r => /^\$\d+\.00$/.test(r.price)),
    [...new Set(rows.map(r => r.price))].slice(0, 4).join(" | "));
  ok("the blend under Product Details is read",
    rows.filter(r => /%/.test(r.fabric)).length === rows.length,
    rows.filter(r => !/%/.test(r.fabric)).length + " without a composition");
  ok("the care line is not filed as the fabric",
    rows.every(r => !/machine wash|imported|style:/i.test(r.fabric)),
    rows.map(r => r.fabric).join(" | ").slice(0, 120));
  ok("the shop's order is recorded", rows.every(r => r.pos > 0),
    rows.filter(r => !r.pos).length + " without a position");
  /* The card says the model on one line and the garment on the next, and the
     title block holds both — so the name is the two of them, which is what the
     card reads as. What matters here is the ORDER. */
  ok("…and it is the order the grid lays them out in",
    rows.slice().sort((a, b) => a.pos - b.pos).map(r => r.name).join("|") ===
      ALL.map(p => `${p.title} ${p.sub}`).join("|"),
    rows.slice().sort((a, b) => a.pos - b.pos).slice(0, 3).map(r => r.name).join(" · "));
  ok("a scan that came back short says so", rows.length === N || !!say.why,
    "graded " + (say.mark || "?") + " with no reason");

  ok("no page errors", errs.length === 0, errs.join(" | "));
  console.log(`\n${pass} passed, ${fail} failed`);
  await ctx.close();
  server.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log("HARNESS ERROR: " + (e && e.message || e)); process.exit(1); });
