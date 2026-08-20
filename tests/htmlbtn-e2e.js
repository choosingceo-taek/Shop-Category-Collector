/* Pressing HTML has to look like something is happening, and finish.

   The report was reported as "ten minutes and no reaction at all", and that
   sentence has two halves that are two different faults:

     · the build fetched photographs ONE AT A TIME, asked for the same address
       once per row that used it, and gave a shop that does not answer the
       worker's ten-second timeout on every single row. Measured on a fixture
       at a generous 120ms shop: 120 products, 16.0s, 120 requests for 60
       distinct photographs. A real catalog is several times that.

     · the progress it wrote went onto #report — which the LAB does not draw.
       So the button being looked at said "Building…" and then nothing, for as
       long as it took. An unchanging button is a dead button as far as anyone
       can tell, and that is what got reported.

   What this holds, then, is not "it is fast" but the four things that make it
   possible to tell a slow build from a broken one:

     1. the button that was pressed counts
     2. one address, one round trip
     3. a host that refuses is asked a few times, not once per row
     4. what did not come says which host and why — and a build that throws
        says that too, instead of quietly re-enabling the button

   Run: NODE_PATH=/opt/node22/lib/node_modules xvfb-run -a node htmlbtn-e2e.js */
"use strict";
const { chromium } = require("playwright");
const https = require("https");
const fs = require("fs");
const path = require("path");
const EXT = path.resolve(__dirname, "..");

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log("  ok  " + n); } else { fail++; console.log("FAIL  " + n + (x ? "\n      " + x : "")); } };

const PORT = 8462;
const GOOD = "img.everlane.com";      // answers, slowly
const DEAD = "img.sezane.com";        // refuses, every time
const LAG = 60;

/* a real JPEG, padded so the bytes crossing the message channel are the size a
   shop's photograph actually is */
const TINY = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof" +
  "Hh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAAB" +
  "AAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
  "base64");
const P = 40000;
const JPEG = Buffer.concat([TINY.slice(0, 2),
  Buffer.from([0xff, 0xfe, (P + 2) >> 8, (P + 2) & 0xff]), Buffer.alloc(P, 0x20),
  TINY.slice(2)]);

const hits = { [GOOD]: [], [DEAD]: [] };
const server = https.createServer(
  { key: fs.readFileSync("/tmp/ml-key.pem"), cert: fs.readFileSync("/tmp/ml-cert.pem") },
  (req, res) => {
    const host = String(req.headers.host || "").split(":")[0];
    (hits[host] || (hits[host] = [])).push(req.url);
    if (host === DEAD) { res.writeHead(403); return res.end("no"); }
    setTimeout(() => {
      res.writeHead(200, { "content-type": "image/jpeg", "content-length": JPEG.length });
      res.end(JPEG);
    }, LAG);
  });
const ready = new Promise(r => server.listen(PORT, "127.0.0.1", r));

const DAY = 86400000;
const BRANDS = ["ATHLETA", "GYMSHARK", "VUORI"];
const FABRIC = ["95% Cotton 5% Elastane", "100% Linen", "88% Polyester 12% Spandex"];

/* 40 garments on a shop that answers, two colourways to a photograph — that
   repetition is what a real catalog looks like — and 30 on a shop that will
   not serve us at all. */
const GOOD_N = 40, GOOD_PHOTOS = 20, DEAD_N = 30;
const items = [
  ...Array.from({ length: GOOD_N }, (_, n) => ({
    product_url: `https://www.everlane.com/p/${n}`,
    brand: BRANDS[n % BRANDS.length], category: "New In",
    name: `Ribbed Tank ${n}`, price: "$" + (40 + (n % 9) * 10),
    image_url: `https://${GOOD}/photo-${n % GOOD_PHOTOS}.jpg`,
    fabric_composition: FABRIC[n % FABRIC.length],
    addedAt: Date.now() - (n % 4) * DAY, listIds: ["l0"],
  })),
  ...Array.from({ length: DEAD_N }, (_, n) => ({
    product_url: `https://www.sezane.com/p/${n}`,
    brand: "SEZANE", category: "New In",
    name: `Gaspard Shirt ${n}`, price: "120,00 €",
    image_url: `https://${DEAD}/photo-${n}.jpg`,
    fabric_composition: "100% Linen",
    addedAt: Date.now() - (n % 4) * DAY, listIds: ["l0"],
  })),
];

(async () => {
  await ready;
  const ctx = await chromium.launchPersistentContext("/tmp/pw-htmlbtn", {
    executablePath: "/opt/pw-browsers/chromium", headless: false,
    ignoreHTTPSErrors: true, acceptDownloads: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-sandbox",
      `--host-resolver-rules=MAP ${GOOD} 127.0.0.1:${PORT},MAP ${DEAD} 127.0.0.1:${PORT}`,
      "--ignore-certificate-errors", "--no-proxy-server"] });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker");
  const id = sw.url().split("/")[2];
  const p = await ctx.newPage();
  await p.setViewportSize({ width: 1280, height: 900 });

  const dialogs = [];
  p.on("dialog", async d => { dialogs.push(d.message()); await d.dismiss().catch(() => {}); });
  p.on("download", d => { d.saveAs("/tmp/htmlbtn-report.html").catch(() => {}); });

  await p.goto(`chrome-extension://${id}/catalog.html`);
  await p.waitForTimeout(1200);
  await p.evaluate(() => new Promise(r => chrome.storage.local.set({
    wpb_lists: [{ id: "l0", name: "FABRIC", createdAt: 1, entries: [] }] }, r)));
  await p.evaluate(rows => CatalogStore.putScan({ meta: { scanId: "hb" }, items: rows }), items);
  await p.reload();
  await p.waitForTimeout(2600);

  ok("the shared photo fetcher is on the page",
    await p.evaluate(() => !!(window.Photos && window.Photos.warm && window.Photos.get)));

  hits[GOOD].length = 0; hits[DEAD].length = 0;

  /* ---- 1. the button that was pressed counts ---- */
  const said = new Set();
  const sampler = setInterval(async () => {
    try {
      const t = await p.evaluate(() => {
        const b = document.querySelector("#labhtml");
        if (!b) return "";
        const r = b.getBoundingClientRect();
        return r.width > 0 && r.height > 0 ? b.innerText.trim() : "(not drawn)";
      });
      if (t) said.add(t);
    } catch (e) {}
  }, 150);

  const t0 = Date.now();
  await p.click("#labhtml");
  while (!dialogs.length && Date.now() - t0 < 5 * 60 * 1000) await p.waitForTimeout(200);
  clearInterval(sampler);
  const took = Date.now() - t0;

  ok("the build finished", dialogs.length > 0, `${(took / 1000).toFixed(1)}s`);
  const counting = [...said].filter(t => /\d+\s*\/\s*\d+/.test(t));
  ok("the button being looked at showed a count, not one frozen word",
    counting.length > 0, JSON.stringify([...said]));
  ok("…and that count moved", new Set(counting).size > 1, JSON.stringify(counting));

  /* ---- 2. one address, one round trip ---- */
  ok("every photograph was asked for once, not once per row that uses it",
    hits[GOOD].length === GOOD_PHOTOS,
    `${hits[GOOD].length} requests for ${GOOD_PHOTOS} photographs across ${GOOD_N} products`);

  /* ---- 3. a shop that refuses is asked a few times, not once per row ---- */
  ok("a host that refuses is not asked once per product",
    hits[DEAD].length < DEAD_N,
    `${hits[DEAD].length} of ${DEAD_N}`);
  ok("…it is asked about as many times as there are lanes",
    hits[DEAD].length <= 14, String(hits[DEAD].length));

  /* ---- 4. what did not come says which host and why ---- */
  const msg = dialogs[0] || "";
  ok("the finishing line says the photos are missing", /did not come/i.test(msg), msg.slice(0, 200));
  ok("…names the host", msg.includes(DEAD), msg.slice(0, 300));
  ok("…and gives the shop's own reason, not our abort", /403/.test(msg), msg.slice(0, 300));
  ok("the reason is not the AbortController's wording",
    !/signal is aborted/i.test(msg), msg.slice(0, 300));

  /* ---- and the file still carries the photographs it did get ---- */
  const html = fs.existsSync("/tmp/htmlbtn-report.html")
    ? fs.readFileSync("/tmp/htmlbtn-report.html", "utf8") : "";
  ok("the file was written", html.length > 1000, String(html.length));
  ok("the photographs are inside it", (html.match(/data:image\/jpeg;base64,/g) || []).length >= GOOD_PHOTOS,
    String((html.match(/data:image\/jpeg;base64,/g) || []).length));
  ok("nothing in it points at the shop", !html.includes(GOOD + "/photo-"));

  /* ---- 5. a build that throws says so ---- */
  dialogs.length = 0;
  await p.evaluate(() => { window.ReportGen.build = () => { throw new Error("boom"); }; });
  await p.click("#labhtml");
  const t1 = Date.now();
  while (!dialogs.length && Date.now() - t1 < 60000) await p.waitForTimeout(200);
  ok("a build that throws says so instead of ending in silence",
    /could not be built/i.test(dialogs[0] || ""), JSON.stringify(dialogs[0] || "(nothing)"));
  ok("…and names what went wrong", /boom/.test(dialogs[0] || ""), dialogs[0] || "");
  ok("…and the button is usable again",
    await p.evaluate(() => !document.querySelector("#labhtml").disabled));

  await ctx.close(); server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); server.close(); process.exit(1); });
