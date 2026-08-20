/* How long does the HTML button actually take, and what does the screen say
   while it takes it?

   The designer pressed HTML and reported ten minutes of nothing. This measures
   the two halves of that sentence separately, because they are different
   faults: how long the build runs, and what a person can see while it runs.

   The photographs are served from img.everlane.com — an origin the manifest
   holds, so the worker's permission check passes and the fetch is a real
   round trip, which is what a live catalog does. Latency is a switch, so the
   cost per photograph is visible rather than assumed.

   Run: NODE_PATH=/opt/node22/lib/node_modules xvfb-run -a node htmlbuild-probe.js
        N=120 MS=120 xvfb-run -a node htmlbuild-probe.js */
"use strict";
const { chromium } = require("playwright");
const https = require("https");
const fs = require("fs");
const path = require("path");
const EXT = path.resolve(__dirname, "..");

const N = parseInt(process.env.N || "120", 10);     // products in the catalog
const MS = parseInt(process.env.MS || "120", 10);   // how slow the CDN answers
const PORT = 8461;

/* a valid JPEG, padded through a comment segment so the bytes crossing the
   message channel are the size a shop's photograph actually is */
const TINY = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof" +
  "Hh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAAB" +
  "AAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
  "base64");
const pad = 80000;
const com = Buffer.concat([Buffer.from([0xff, 0xfe, (pad + 2) >> 8, (pad + 2) & 0xff]),
  Buffer.alloc(pad, 0x20)]);
const JPEG = Buffer.concat([TINY.slice(0, 2), com, TINY.slice(2)]);

const hits = [];
const server = https.createServer(
  { key: fs.readFileSync("/tmp/ml-key.pem"), cert: fs.readFileSync("/tmp/ml-cert.pem") },
  (req, res) => {
    hits.push(req.url);
    // DEAD=1: the shop accepts the connection and never answers — the shape
    // that costs the worker's ten-second abort, once per row
    if (process.env.DEAD) return;
    setTimeout(() => {
      res.writeHead(200, { "content-type": "image/jpeg", "content-length": JPEG.length });
      res.end(JPEG);
    }, MS);
  });
const ready = new Promise(r => server.listen(PORT, "127.0.0.1", r));

const DAY = 86400000;
const BRANDS = ["ATHLETA", "GYMSHARK", "VUORI", "ALO YOGA"];
const FABRIC = ["95% Cotton 5% Elastane", "100% Linen", "88% Polyester 12% Spandex"];
/* Colourways of one garment share a photograph — the same address, asked for
   again. That repetition is normal in a real catalog. */
const items = Array.from({ length: N }, (_, n) => ({
  product_url: `https://www.everlane.com/p/${n}`,
  brand: BRANDS[n % BRANDS.length], category: "New In",
  name: `Ribbed Tank ${n}`, price: "$" + (40 + (n % 9) * 10),
  image_url: `https://img.everlane.com/photo-${Math.floor(n / 2)}.jpg`,
  fabric_composition: FABRIC[n % FABRIC.length],
  addedAt: Date.now() - (n % 4) * DAY, listIds: ["l0"],
}));

(async () => {
  await ready;
  const ctx = await chromium.launchPersistentContext("/tmp/pw-htmlbuild", {
    executablePath: "/opt/pw-browsers/chromium", headless: false,
    ignoreHTTPSErrors: true, acceptDownloads: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-sandbox",
      `--host-resolver-rules=MAP img.everlane.com 127.0.0.1:${PORT}`,
      "--ignore-certificate-errors", "--no-proxy-server"] });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker");
  const id = sw.url().split("/")[2];
  const p = await ctx.newPage();
  await p.setViewportSize({ width: 1280, height: 900 });

  const dialogs = [];
  p.on("dialog", async d => { dialogs.push(d.message()); await d.dismiss().catch(() => {}); });
  p.on("download", d => { d.saveAs("/tmp/htmlbuild-report.html").catch(() => {}); });

  await p.goto(`chrome-extension://${id}/catalog.html`);
  await p.waitForTimeout(1200);
  await p.evaluate(() => new Promise(r => chrome.storage.local.set({
    wpb_lists: [{ id: "l0", name: "FABRIC", createdAt: 1, entries: [] }] }, r)));
  await p.evaluate(rows => CatalogStore.putScan({ meta: { scanId: "hb" }, items: rows }), items);
  await p.reload();
  await p.waitForTimeout(2600);

  hits.length = 0;
  const t0 = Date.now();

  /* what a person can see: sample the button and anything else that moves */
  const seen = new Set();
  const sampler = setInterval(async () => {
    try {
      const s = await p.evaluate(() => {
        const b = document.querySelector("#labhtml");
        const vis = e => { if (!e) return false; const r = e.getBoundingClientRect();
          return r.width > 0 && r.height > 0; };
        return { btn: b ? b.innerText.trim() : "(gone)", btnVisible: vis(b),
          hidden: (document.querySelector("#report") || {}).textContent,
          hiddenVisible: vis(document.querySelector("#report")) };
      });
      seen.add(`${s.btnVisible ? "" : "(offscreen) "}${s.btn}`);
    } catch (e) {}
  }, 400);

  await p.click("#labhtml");
  // wait for the alert that ends the build
  const cap = 15 * 60 * 1000;
  while (!dialogs.length && Date.now() - t0 < cap) await p.waitForTimeout(300);
  clearInterval(sampler);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  const uniq = new Set(hits);
  console.log("");
  console.log(`  products in the catalog     ${N}`);
  console.log(`  distinct photographs        ${new Set(items.map(i => i.image_url)).size}`);
  console.log(`  shop latency per photo      ${MS} ms`);
  console.log(`  ---`);
  console.log(`  BUILD TOOK                  ${secs} s${dialogs.length ? "" : "  (never finished)"}`);
  console.log(`  image requests made         ${hits.length}   (${uniq.size} distinct)`);
  console.log(`  per photograph              ${(((Date.now() - t0) / 1000) / Math.max(1, hits.length)).toFixed(2)} s`);
  console.log(`  ---`);
  console.log(`  what the button said        ${JSON.stringify([...seen])}`);
  console.log(`  finished with               ${JSON.stringify(dialogs[0] || "(no dialog)")}`);
  const f = fs.existsSync("/tmp/htmlbuild-report.html") ? fs.statSync("/tmp/htmlbuild-report.html").size : 0;
  console.log(`  file on disk                ${(f / 1048576).toFixed(2)} MB`);
  console.log("");

  await ctx.close(); server.close();
})().catch(e => { console.error(e); server.close(); process.exit(1); });
