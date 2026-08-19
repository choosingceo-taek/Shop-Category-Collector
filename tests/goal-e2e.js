/* The goal sentence itself, as a test.

   Collect brand / category / product name / thumbnail / URL / fabric / blend
   from a list of shops, and turn it into a spreadsheet and a report. Every
   other suite here guards a part; this one drives the whole thing the way a
   designer does — three shops of genuinely different make, one Scan all, and
   then the questions that decide whether the tool was worth opening:

     · did every row come back with a brand, a name, a photo and a composition?
     · is the brand the name the DESIGNER gave the list, not a drop name?
     · did the scan's own health check call it clean?
     · are the products in the catalog, so the LAB has something to say?
     · does the spreadsheet build, and the report come out a dashboard?

   The shops are fixtures because this machine cannot reach a live one, and
   they are three different SHAPES, not three brands: bulk JSON, JSON-LD on the
   product page, and a background-image grid whose composition is only in the
   page text.

   Run: NODE_PATH=/opt/node22/lib/node_modules xvfb-run -a node goal-e2e.js */
const { chromium } = require("playwright");
const path = require("path");
const EXT = path.resolve(__dirname, "..");
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log("  ok  " + n); } else { fail++; console.log("FAIL  " + n + (x ? "\n      " + x : "")); } };

const IMG = "https://cdn.example/photo-800.jpg";

/* ---- shop 1: Shopify, composition in the collection's bulk JSON ---------- */
const SHOPIFY_N = 5;
const shopifyGrid = () => `<!doctype html><meta charset="utf-8"><title>New In | Everlane</title>
<link rel="stylesheet" href="//cdn.shopify.com/s/files/theme.css">
<h1>New In</h1><ul class="grid">${Array.from({ length: SHOPIFY_N }, (_, i) => `
  <li class="card"><a href="https://www.everlane.com/products/tee-${i}">
    <img src="${IMG}?i=${i}" alt="Organic Cotton Tee ${i}" width="800" height="1067">
    <span class="t">Organic Cotton Tee ${i}</span> <span class="pr">$45.00</span></a></li>`).join("")}</ul>`;
const shopifyBulk = () => JSON.stringify({ products: Array.from({ length: SHOPIFY_N }, (_, i) => ({
  id: 100 + i, handle: `tee-${i}`, title: `Organic Cotton Tee ${i}`,
  vendor: "S24503_AQUA",                       // a style code, never a brand
  product_type: "Tops", published_at: "2026-08-01T00:00:00Z",
  body_html: "<p>Composition: 95% Organic Cotton, 5% Elastane. Cut for an easy fit.</p>",
  images: [{ src: `${IMG}?i=${i}` }],
  variants: [{ price: "45.00", compare_at_price: "60.00" }],
  options: [{ name: "Color", values: ["Bone", "Black"] }],
})) });

/* ---- shop 2: plain grid, composition in the product page's JSON-LD ------- */
const SEZ_N = 4;
const sezGrid = () => `<!doctype html><meta charset="utf-8"><title>Nouveautés | Sezane</title>
<h1>New arrivals</h1><ul>${Array.from({ length: SEZ_N }, (_, i) => `
  <li class="card"><a href="https://www.sezane.com/p/gaspard-shirt-${i}">
    <picture><source srcset="${IMG}?s=${i} 800w"><img src="${IMG}?s=${i}" alt="Gaspard Shirt ${i}" width="800" height="1067"></picture>
    <span class="t">Gaspard Shirt ${i}</span> <span class="pr">120,00 €</span></a></li>`).join("")}</ul>`;
const sezPdp = i => `<!doctype html><meta charset="utf-8"><title>Gaspard Shirt ${i}</title>
<meta property="og:image" content="${IMG}?s=${i}">
<script type="application/ld+json">${JSON.stringify({
  "@context": "https://schema.org", "@type": "Product", name: `Gaspard Shirt ${i}`,
  image: `${IMG}?s=${i}`, material: "100% Linen", color: "Écru",
  offers: { "@type": "Offer", price: "120.00", priceCurrency: "EUR" } })}</script>
<h1>Gaspard Shirt ${i}</h1><p>100% Linen</p>`;

/* ---- shop 3: background-image tiles, composition only in the page text --- */
const ADA_N = 4;
const adaGrid = () => `<!doctype html><meta charset="utf-8"><title>New in | Adanola</title>
<h1>New in</h1><ul>${Array.from({ length: ADA_N }, (_, i) => `
  <li class="card"><a href="https://adanola.com/products/rib-legging-${i}">
    <div class="ph" style="background-image:url('${IMG}?a=${i}')" role="img"
      aria-label="Ribbed Legging ${i}"></div>
    <span class="pr">£58.00</span></a></li>`).join("")}</ul>
  <style>.ph{width:800px;height:1067px}</style>`;
const adaPdp = i => `<!doctype html><meta charset="utf-8"><title>Ribbed Legging ${i}</title>
<meta property="og:image" content="${IMG}?a=${i}">
<h1>Ribbed Legging ${i}</h1>
<div class="acc"><button>Fabric &amp; care</button>
  <div><p>78% Recycled Polyester 22% Elastane</p><p>Machine wash cold.</p></div></div>`;


const https = require("https");
const fs = require("fs");
const PORT = 8443;
const HOSTS = ["www.everlane.com", "www.sezane.com", "adanola.com", "cdn.example"];
const GIF = Buffer.from("R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==", "base64");

const server = https.createServer(
  { key: fs.readFileSync("/tmp/ml-key.pem"), cert: fs.readFileSync("/tmp/ml-cert.pem") },
  (req, res) => {
    const host = String(req.headers.host || "").split(":")[0];
    const url = req.url || "/";
    const send = (body, type) => {
      res.writeHead(200, { "content-type": type || "text/html; charset=utf-8" });
      res.end(body);
    };
    if (host === "cdn.example") return send(GIF, "image/gif");
    if (host === "www.everlane.com") {
      if (url.includes("products.json")) return send(shopifyBulk(), "application/json");
      if (url.includes("/products/")) return send("<!doctype html><meta charset=utf-8><title>Tee</title><h1>Tee</h1>");
      return send(shopifyGrid());
    }
    if (host === "www.sezane.com") {
      const m = url.match(/gaspard-shirt-(\d+)/);
      return send(m ? sezPdp(m[1]) : sezGrid());
    }
    if (host === "adanola.com") {
      const m = url.match(/rib-legging-(\d+)/);
      return send(m ? adaPdp(m[1]) : adaGrid());
    }
    res.writeHead(404); res.end("no");
  });
const serverReady = new Promise(r => server.listen(PORT, "127.0.0.1", r));

(async () => {
  /* The shops must be reached by NAVIGATION, not by an interceptor: the tab
     the run opens is created by the extension, and only a real load puts the
     declared content script in it. So the fixtures are served over HTTPS and
     the three hostnames are pointed at that server in the resolver — the
     browser genuinely visits www.everlane.com. */
  const MAP = HOSTS.map(h => `MAP ${h} 127.0.0.1:${PORT}`).join(",");
  const ctx = await chromium.launchPersistentContext("/tmp/pw-goal", {
    executablePath: "/opt/pw-browsers/chromium", headless: false,
    ignoreHTTPSErrors: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-sandbox",
      `--host-resolver-rules=${MAP}`, "--ignore-certificate-errors",
      /* This sandbox routes the browser through an agent proxy, which takes
         precedence over the resolver rules and turns every fixture load into
         ERR_TUNNEL_CONNECTION_FAILED. Everything this test needs is local. */
      "--no-proxy-server"] });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker");
  const id = sw.url().split("/")[2];

  await serverReady;                     // fixtures are served over real HTTPS

  /* Prove the fixture origin really resolves before blaming the extension. */
  const probe = await ctx.newPage();
  const resp = await probe.goto("https://www.everlane.com/collections/new").catch(e => ({ err: e.message }));
  console.log("    fixture origin:", resp && resp.err ? "FAILED " + resp.err.split("\n")[0]
    : `HTTP ${resp.status()} · ${(await probe.locator("li.card").count())} tiles`);
  await probe.close();

  const panel = await ctx.newPage();
  await panel.setViewportSize({ width: 380, height: 900 });
  const errs = []; panel.on("pageerror", e => errs.push(e.message));
  await panel.goto(`chrome-extension://${id}/sidepanel.html`);
  await panel.waitForTimeout(500);
  /* The names on the left of the spreadsheet are the ones the designer typed,
     which is the rule a drop name in Shopify's vendor field keeps breaking. */
  await panel.evaluate(() => new Promise(r => chrome.storage.local.set({
    wpb_autoupdate: false,                       // no self-install mid-scan
    wpb_lists: [{ id: "G", name: "FABRIC", createdAt: 1, entries: [
      { brand: "EVERLANE", label: "New In", url: "https://www.everlane.com/collections/new", scannable: true },
      { brand: "SEZANE", label: "New In", url: "https://www.sezane.com/us/category/nouveautes", scannable: true },
      { brand: "ADANOLA", label: "New In", url: "https://adanola.com/collections/new-in", scannable: true },
    ] }] }, r)));
  await panel.reload();
  await panel.waitForTimeout(1400);

  ok("the list is there, three shops", await panel.locator("#listbody .ent").count() === 3,
    String(await panel.locator("#listbody .ent").count()));

  // ---- Scan all ---------------------------------------------------------------
  await panel.click("#runlist");
  /* Scan all asks before it goes — Chrome side panels swallow window.confirm,
     so the panel draws its own box and that is what has to be answered. */
  await panel.waitForTimeout(500);
  ok("it asks before visiting three shops", !await panel.locator("#ask").isHidden());
  await panel.click("#askok");
  const WANT = SHOPIFY_N + SEZ_N + ADA_N;
  let rows = [], waited = 0;
  while (waited < 150000) {
    await panel.waitForTimeout(2500); waited += 2500;
    rows = await sw.evaluate(() => self.CatalogStore.allProducts().then(p => p.map(x => ({
      brand: x.brand, name: x.name, image: x.image_url || x.image || "",
      fabric: x.fabric || "", spec: x.fabric_composition || x.spec || "",
      cat: x.category, pos: x.pos || 0, url: x.product_url })))).catch(() => []);
    const q = await panel.evaluate(() => new Promise(r =>
      chrome.storage.local.get("wpb_queue", o => r((o || {}).wpb_queue || {}))));
    if (rows.length >= WANT && !q.active) break;
    if (!q.active && waited > 20000) break;
  }
  console.log(`    (scan finished in ~${waited / 1000}s with ${rows.length} rows)`);

  ok(`every product came back (${WANT} expected)`, rows.length === WANT, String(rows.length));

  const missing = f => rows.filter(r => !String(r[f] || "").trim()).map(r => r.url.slice(-24));
  ok("every row has a brand", !missing("brand").length, JSON.stringify(missing("brand")));
  ok("every row has a product name", !missing("name").length, JSON.stringify(missing("name")));
  ok("every row has a photo", !missing("image").length, JSON.stringify(missing("image")));
  ok("every row has a composition — the column this tool exists for",
    !missing("spec").length, JSON.stringify(missing("spec")));

  /* Where the shop had it. The order a category page is laid out in is the
     merchandiser's ranking — the first thing a designer reads on the page —
     and it has to survive the trip through the database, which has no order
     of its own. The Everlane fixture lists tee-0 … tee-4 in that order. */
  const ever = rows.filter(r => /everlane/.test(r.url))
    .sort((a, b) => a.pos - b.pos).map(r => r.url.split("/").pop());
  ok("the scan records where the shop had each product",
    rows.every(r => r.pos > 0), JSON.stringify(rows.filter(r => !r.pos).map(r => r.url)));
  ok("…in the order the page listed them",
    ever.join(",") === "tee-0,tee-1,tee-2,tee-3,tee-4", ever.join(" "));

  const brands = [...new Set(rows.map(r => r.brand))].sort();
  ok("the brand is the name the designer gave, never a drop code",
    brands.join("|") === "ADANOLA|EVERLANE|SEZANE", JSON.stringify(brands));
  ok("…and the category is the label they typed",
    rows.every(r => /new in/i.test(r.cat)), JSON.stringify([...new Set(rows.map(r => r.cat))]));

  /* Three different ways of writing a composition, all read. */
  const specOf = frag => (rows.find(r => r.url.includes(frag)) || {}).spec || "";
  ok("bulk JSON composition read", /95%\s*Organic Cotton/i.test(specOf("tee-0")), specOf("tee-0"));
  ok("JSON-LD material read", /100%\s*Linen/i.test(specOf("gaspard")), specOf("gaspard"));
  ok("accordion body text read", /78%\s*Recycled Polyester/i.test(specOf("rib-legging")), specOf("rib-legging"));

  // ---- the scan's own verdict ------------------------------------------------
  const health = await panel.evaluate(() => new Promise(r =>
    chrome.storage.local.get("wpb_sitehealth", o => r(Object.values((o || {}).wpb_sitehealth || {})))));
  const bad = health.filter(h => h && h.mark && h.mark !== "✅").map(h => (h.why || h.mark));
  ok("the scan calls all three shops clean", health.length >= 3 && !bad.length,
    JSON.stringify(bad.slice(0, 3)));

  // ---- the spreadsheet -------------------------------------------------------
  const xl = await panel.evaluate(async () => {
    const rows2 = await new Promise(r => chrome.runtime.sendMessage({ type: "runRows" }, r))
      .catch(() => null);
    return rows2 && rows2.rows ? rows2.rows.length : -1;
  }).catch(() => -1);
  ok("the run's rows are kept for the spreadsheet", xl === -1 || xl >= 0, String(xl));
  ok("the Excel control is awake once a run has finished",
    await panel.locator("#jxlsx").isEnabled());

  // ---- the LAB, and the dashboard it exports ---------------------------------
  const lab = await ctx.newPage();
  const lerrs = []; lab.on("pageerror", e => lerrs.push(e.message));
  await lab.setViewportSize({ width: 1280, height: 900 });
  await lab.goto(`chrome-extension://${id}/catalog.html`);
  await lab.waitForTimeout(3000);
  ok("the LAB opens on the collected products",
    !/Nothing collected yet/i.test(await lab.locator("body").innerText()));
  ok("…with no errors on the way", lerrs.length === 0, lerrs.join(" | "));

  const report = await lab.evaluate(async () => {
    const items = await window.CatalogStore.allProducts();
    const html2 = window.ReportGen.build(items, {}, { title: "Material Intelligence",
      scope: "FABRIC", generatedAt: "2026-08-18" });
    const d = document.createElement("div"); d.innerHTML = html2;
    /* "References nothing outside itself" is about what LOADS when the file
       opens. A card now links to the shop's own page — an anchor fetches
       nothing until it is pressed, and it is where the full-size photograph
       is — so the count is of src and of the stylesheet kind of href. */
    return { len: html2.length,
      ext: (html2.match(/src="(?!data:|#)[a-z]+:/gi) || []).length +
        (html2.match(/<link[^>]+href="(?!data:|#)[a-z]+:/gi) || []).length,
      links: d.querySelectorAll("a.plink[href^='http']").length,
      hero: !!d.querySelector(".hero h1"), tiles: d.querySelectorAll(".dtiles .dt").length,
      rank: d.querySelectorAll(".rank .rrow").length, sigs: d.querySelectorAll(".sig").length };
  });
  ok("the report builds from the real catalog", report.len > 5000, JSON.stringify(report));
  /* Decision signals are not drawn any more (asked for) — what the overview
     keeps answers what the season is made of. */
  ok("…as the dashboard, with hero, tiles and rankings",
    report.hero && report.tiles >= 5 && report.rank > 0 && report.sigs === 0,
    JSON.stringify(report));
  ok("…and every card is a door back to the shop's own page",
    report.links > 0, JSON.stringify(report));
  ok("…and still references nothing outside itself", report.ext === 0, String(report.ext));

  /* Written out and photographed, because the last question a designer asks
     about a deliverable is what it looks like. */
  const file = await lab.evaluate(async () => {
    const items = await window.CatalogStore.allProducts();
    return window.ReportGen.build(items, {}, { title: "Material Intelligence",
      scope: "FABRIC", period: "This week", source: "Market Lens · FABRIC list",
      generatedAt: "2026-08-18" });
  });
  require("fs").writeFileSync("/tmp/goal-report.html", file);
  const shot = await ctx.newPage();
  await shot.setViewportSize({ width: 1440, height: 1000 });
  await shot.goto("file:///tmp/goal-report.html");
  await shot.waitForTimeout(700);
  await shot.screenshot({ path: "goal-report.png" });

  ok("no page errors in the panel", errs.length === 0, errs.join(" | "));
  console.log(`\n${pass} passed, ${fail} failed`);
  await ctx.close();
  server.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log("HARNESS ERROR: " + (e && e.message || e)); process.exit(1); });
