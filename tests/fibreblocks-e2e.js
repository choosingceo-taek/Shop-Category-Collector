/* The fibre read of the window, back on the LAB.

   v3.0.0 moved the LAB to four axis blocks — FABRIC / COLOUR / FIT / DETAIL,
   counted in brands — and took out the watch list, the frequency ranking, the
   volume bars, the share lines and the risers/fallers pair on the grounds that
   the axes answered the same question in one place.

   They answer a NEIGHBOURING question, which is why this is back. The axes
   count fabricfam: the cloth a shop NAMES — satin, poplin, jersey. These count
   the fibres the compositions state, which is the measured half; a shop can
   call a thing whatever it likes and the percentages still say cotton. Both
   are true, neither replaces the other.

   None of the arithmetic is new. Every one of these was computed all along in
   report/trend.js and held by pulse-test and compare-test; what had been taken
   out was the wiring that drew it.

   The fixture is eight weeks that actually MOVE — cotton and polyester early,
   linen and lyocell (the TENCEL row) late — because a rotation where every week looks the same
   produces empty risers and would let this pass while drawing nothing.

   Run: NODE_PATH=/opt/node22/lib/node_modules xvfb-run -a node fibreblocks-e2e.js */
"use strict";
const { chromium } = require("playwright");
const path = require("path");
const EXT = path.resolve(__dirname, "..");

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log("  ok  " + n); } else { fail++; console.log("FAIL  " + n + (x ? "\n      " + x : "")); } };

const DAY = 86400000;
const BR = ["ATHLETA", "GYMSHARK", "VUORI", "ALO"];
const F = {
  cotton: "95% Cotton 5% Elastane",
  linen: "100% Linen",
  poly: "88% Polyester 12% Spandex",
  viscose: "70% Viscose 30% Polyamide",
  modal: "60% Modal 40% Cotton",
  lyocell: "100% Lyocell",
};
const NM = ["Satin Slip Dress", "Linen Poplin Shirt", "Ribbed Tank",
  "Oversized Hoodie", "Ruched Midi Skirt", "Cropped Jersey Tee"];
const WEEKS = 8, PER = 22;
const items = [];
for (let w = 0; w < WEEKS; w++) {
  for (let i = 0; i < PER; i++) {
    const n = w * PER + i;
    items.push({
      url: `https://example.com/p/${n}`, product_url: `https://example.com/p/${n}`,
      brand: BR[n % BR.length], category: "New In",
      name: NM[n % NM.length] + " " + n,
      price: "$" + (40 + (n % 9) * 10), image_url: "",
      // the season moves: cotton and polyester early, linen and lyocell late
      fabric_composition: w < 4
        ? (i % 3 === 0 ? F.cotton : i % 3 === 1 ? F.poly : F.modal)
        : (i % 4 === 0 ? F.linen : i % 4 === 1 ? F.lyocell : i % 4 === 2 ? F.viscose : F.cotton),
      addedAt: Date.now() - (WEEKS - w) * 7 * DAY,
    });
  }
}

(async () => {
  const ctx = await chromium.launchPersistentContext("/tmp/pw-fibre", {
    executablePath: "/opt/pw-browsers/chromium", headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-sandbox"] });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker");
  const id = sw.url().split("/")[2];
  const p = await ctx.newPage();
  await p.setViewportSize({ width: 1360, height: 1000 });
  const errs = []; p.on("pageerror", e => errs.push(e.message));

  await p.goto(`chrome-extension://${id}/catalog.html`);
  await p.waitForTimeout(1200);
  await p.evaluate(() => new Promise(r => chrome.storage.local.set({
    wpb_lists: [{ id: "l0", name: "FABRIC", createdAt: 1, entries: [] }] }, r)));
  await p.evaluate(rows => CatalogStore.putScan({ meta: { scanId: "fb" }, items: rows }), items);
  /* putScan stamps addedAt itself — first observation is its call to make — so
     a fixture that needs several weeks writes the dates in afterwards. Without
     this every row lands in one week, and half of what is under test here needs
     two periods to exist at all. */
  await p.evaluate(rows => new Promise(res => {
    const when = {};
    rows.forEach(r => { when[r.product_url] = r.addedAt; });
    CatalogStore.open().then(db => {
      const t = db.transaction("products", "readwrite");
      const P = t.objectStore("products");
      const q = P.getAll();
      q.onsuccess = () => q.result.forEach(r => {
        const w = when[r.product_url];
        if (w) { r.addedAt = w; P.put(r); }
      });
      t.oncomplete = res; t.onerror = res;
    });
  }), items);
  await p.reload();
  await p.waitForTimeout(3000);

  const weeks = await p.evaluate(async () => {
    const all = await CatalogStore.allProducts();
    return new Set(all.map(r => new Date(r.addedAt).toISOString().slice(0, 10))).size;
  });
  ok("the fixture really spans several weeks", weeks >= 6, `${weeks} distinct days`);

  const secs = await p.evaluate(() =>
    [...document.querySelectorAll("#v-lab .sec h3")].map(h => h.firstChild.textContent.trim()));
  const has = t => secs.some(s => s.toLowerCase().startsWith(t));
  ok("the four axes are still there", has("fabric") && has("colour") && has("fit") && has("detail"),
    secs.join(" | "));
  ok("what to watch now is back", has("fabric to watch"), secs.join(" | "));
  ok("the frequency ranking is back", has("most seen"), secs.join(" | "));
  ok("the volume bars are back", has("new arrivals per"), secs.join(" | "));
  ok("the share lines are back", has("fabric share over time"), secs.join(" | "));
  ok("and the pair that reads the window", has("rising over the window") && has("falling over the window"),
    secs.join(" | "));

  /* Rising and falling are one reading and have to be read together. */
  const cols = await p.evaluate(() => {
    const c = document.querySelector("#v-lab .labcols");
    if (!c) return { there: false };
    const k = [...c.children].map(x => x.getBoundingClientRect());
    return { there: true, n: k.length,
      sideBySide: k.length === 2 && Math.abs(k[0].top - k[1].top) < 4 && k[0].right <= k[1].left + 1 };
  });
  ok("they sit side by side", cols.there && cols.sideBySide, JSON.stringify(cols));

  /* The figures, not just the headings: this is the fibre read, so the names
     have to be fibres and the direction has to match the fixture's season. */
  const read = await p.evaluate(() => {
    const cols = document.querySelector("#v-lab .labcols");
    const side = i => [...cols.children[i].querySelectorAll(".mv .mk")]
      .map(e => e.textContent.replace(/NEW$/, "").trim());
    const ranked = [...document.querySelectorAll("#v-lab .sec")]
      .find(s => /most seen/i.test(s.querySelector("h3").textContent));
    return {
      rising: side(0), falling: side(1),
      ranked: ranked ? [...ranked.querySelectorAll(".rk, .rank, li, tr")].length : 0,
      rankedText: ranked ? ranked.textContent.replace(/\s+/g, " ").slice(0, 120) : "",
      chartPaths: document.querySelectorAll("#v-lab svg path").length,
    };
  });
  /* Lyocell is read onto the fifteen-fibre shelf, where the designer named
     that row TENCEL — same fibre, one row instead of two spellings. */
  ok("linen and lyocell are named as rising — the fixture's late season",
    read.rising.includes("Linen") && read.rising.includes("Tencel"), read.rising.join(", "));
  ok("cotton and polyester are named as falling — its early one",
    read.falling.includes("Cotton") && read.falling.includes("Polyester"), read.falling.join(", "));
  ok("the ranking names fibres, from the compositions",
    /Cotton/.test(read.rankedText) && /Elastane|Polyester/.test(read.rankedText), read.rankedText);
  ok("the charts actually drew something", read.chartPaths > 5, `${read.chartPaths} paths`);

  ok("no page errors", errs.length === 0, errs.join(" | "));
  console.log(`\n${pass} passed, ${fail} failed`);
  await ctx.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log("HARNESS " + (e && e.message || e)); process.exit(1); });
