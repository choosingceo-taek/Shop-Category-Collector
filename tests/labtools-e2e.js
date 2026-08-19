/* Where the file is made from, and what the rail says.

   Three changes, all of them about a control being in the place the decision
   is made:

     · Build report / Export Excel / the template picker are off the PRODUCTS
       tab. That tab is a wall of photographs — the one screen in here where
       nobody is deciding to publish anything.
     · The LAB's own bar carries an HTML button at its right end, after the
       three selects that decide what the file will contain. It presses the
       same builder rather than calling it again: two callers is two things to
       keep in step.
     · The filter rail no longer prints a number beside every value. The
       counts were faceted, so a value with nothing behind it is not listed at
       all — the figure only restated that, once per row, down a rail of forty.

   Run: NODE_PATH=/opt/node22/lib/node_modules xvfb-run -a node labtools-e2e.js */
"use strict";
const { chromium } = require("playwright");
const path = require("path");
const EXT = path.resolve(__dirname, "..");

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log("  ok  " + n); } else { fail++; console.log("FAIL  " + n + (x ? "\n      " + x : "")); } };

const DAY = 86400000;
const BRANDS = ["ATHLETA", "GYMSHARK", "VUORI"];
const FABRIC = ["95% Cotton 5% Elastane", "100% Linen", "88% Polyester 12% Spandex"];
const NAMES = ["Satin Slip Dress", "Linen Poplin Shirt", "Ribbed Tank",
  "Oversized Hoodie", "Ruched Midi Skirt", "Cropped Jersey Tee"];
const items = Array.from({ length: 30 }, (_, n) => ({
  url: `https://example.com/p/${n}`,
  brand: BRANDS[n % BRANDS.length], category: "New In",
  name: NAMES[n % NAMES.length] + " " + n,
  price: "$" + (40 + (n % 9) * 10), image_url: "",
  fabric_composition: FABRIC[n % FABRIC.length],
  addedAt: Date.now() - (n % 4) * DAY, listIds: ["l0"],
}));

(async () => {
  const ctx = await chromium.launchPersistentContext("/tmp/pw-labtools", {
    executablePath: "/opt/pw-browsers/chromium", headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-sandbox"] });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker");
  const id = sw.url().split("/")[2];
  const p = await ctx.newPage();
  await p.setViewportSize({ width: 1280, height: 900 });
  const errs = []; p.on("pageerror", e => errs.push(e.message));
  const dialogs = [];
  p.on("dialog", async d => { dialogs.push(d.message()); await d.dismiss().catch(() => {}); });

  await p.goto(`chrome-extension://${id}/catalog.html`);
  await p.waitForTimeout(1200);
  await p.evaluate(() => new Promise(r => chrome.storage.local.set({
    wpb_lists: [{ id: "l0", name: "My references", createdAt: 1, entries: [] }] }, r)));
  await p.evaluate(rows => CatalogStore.putScan({ meta: { scanId: "lt" }, items: rows }), items);
  await p.reload();
  await p.waitForTimeout(2600);

  /* ---- 1. the take-away controls are off the product wall ---- */
  const products = await p.evaluate(() => {
    const vis = s => {
      const e = document.querySelector(s);
      if (!e) return false;
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    return { report: vis("#report"), xlsx: vis("#xlsx"), tmpl: vis("#tmpl"),
      stillThere: !!document.querySelector("#report") && !!document.querySelector("#tmpl") };
  });
  ok("Build report is not drawn on the product wall", !products.report);
  ok("Export Excel is not drawn there either", !products.xlsx);
  ok("nor the template picker", !products.tmpl);
  ok("…but they are still in the page, so one handler serves both",
    products.stillThere);

  /* ---- 2. the HTML button, at the end of the bar that decides ---- */
  const bar = await p.evaluate(() => {
    const b = document.querySelector("#labhtml");
    if (!b) return { there: false };
    const br = b.getBoundingClientRect();
    const bar = document.querySelector(".labbar").getBoundingClientRect();
    const sels = [...document.querySelectorAll(".labbar select")]
      .map(s => s.getBoundingClientRect().right);
    return {
      there: true, text: (b.innerText || "").trim(),
      right: br.right, barRight: bar.right, sameRow: Math.abs(br.top - bar.top) < 60,
      afterSelects: sels.length > 0 && br.left > Math.max(...sels),
      marks: !!b.querySelector("svg"),
    };
  });
  ok("the LAB bar carries an HTML button", bar.there);
  ok("it is at the right end of that bar", bar.there && bar.barRight - bar.right < 40,
    `${(bar.barRight - bar.right).toFixed(0)}px from the end`);
  ok("after the three selects, not among them", bar.afterSelects);
  ok("on the same row — it costs no height", bar.sameRow);
  ok("it says HTML and carries a mark", /HTML/i.test(bar.text || "") && bar.marks, bar.text);

  /* ---- 3. and pressing it really builds the file ---- */
  await p.click("#labhtml");
  await p.waitForTimeout(9000);
  ok("pressing it produced a report",
    dialogs.some(d => /Report saved/i.test(d)), dialogs.join(" | ") || "(no dialog)");
  ok("the button came back to itself",
    /HTML/i.test((await p.locator("#labhtml").innerText()).trim()),
    await p.locator("#labhtml").innerText());
  ok("on the dashboard template, which is what the LAB is",
    await p.locator("#tmpl").inputValue() === "standard",
    await p.locator("#tmpl").inputValue());

  /* ---- 4. the rail lists values, not counts ---- */
  await p.click('.tab[data-view="brands"]');
  await p.waitForTimeout(1800);
  const rail = await p.evaluate(() => {
    const rows = [...document.querySelectorAll("#rail .rvals label")];
    return {
      n: rows.length,
      counts: rows.filter(r => r.querySelector(".rc")).length,
      trailingDigits: rows.filter(r => /\s\d+$/.test((r.innerText || "").trim())).length,
      sample: rows.slice(0, 4).map(r => (r.innerText || "").replace(/\s+/g, " ").trim()),
    };
  });
  ok("the rail has values to show", rail.n >= 4, `${rail.n} rows`);
  ok("no count element beside a value", rail.counts === 0, `${rail.counts} of ${rail.n}`);
  ok("and no number trailing the name", rail.trailingDigits === 0, rail.sample.join(" | "));

  ok("no page errors", errs.length === 0, errs.join(" | "));
  console.log(`\n${pass} passed, ${fail} failed`);
  await ctx.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log("HARNESS " + (e && e.message || e)); process.exit(1); });
