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
/* Two lists, the way a designer keeps them — and one product in both, since
   listIds is a union and a garment really can answer two questions. */
const items = Array.from({ length: 30 }, (_, n) => ({
  url: `https://example.com/p/${n}`,
  brand: BRANDS[n % BRANDS.length], category: "New In",
  name: NAMES[n % NAMES.length] + " " + n,
  price: "$" + (40 + (n % 9) * 10), image_url: "",
  fabric_composition: FABRIC[n % FABRIC.length],
  addedAt: Date.now() - (n % 4) * DAY,
  listIds: n === 0 ? ["l0", "l1"] : (n % 3 === 0 ? ["l1"] : ["l0"]),
}));
const IN_L0 = items.filter(i => i.listIds.includes("l0")).length;
const IN_L1 = items.filter(i => i.listIds.includes("l1")).length;

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
    wpb_lists: [
      { id: "l0", name: "FABRIC", createdAt: 1, entries: [] },
      { id: "l1", name: "WMN", createdAt: 2, entries: [] },
    ] }, r)));
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

  /* ---- 3b. the spreadsheet: one tab per list ------------------------------

     A list is one research question, and a single sheet with every list
     poured into it answers none of them. */
  const xl = await p.evaluate(() => {
    const b = document.querySelector("#labxlsx");
    if (!b) return { there: false };
    const br = b.getBoundingClientRect();
    const hr = document.querySelector("#labhtml").getBoundingClientRect();
    return { there: true, text: (b.innerText || "").trim(),
      beforeHtml: br.right <= hr.left + 1, sameRow: Math.abs(br.top - hr.top) < 4 };
  });
  ok("the LAB bar carries an Excel button too", xl.there);
  ok("beside the HTML one, on the same row", xl.there && xl.beforeHtml && xl.sameRow,
    JSON.stringify(xl));

  /* Build the book in the page and read its tabs back, rather than trusting
     that a download happened: what matters is what is INSIDE the file. */
  const book = await p.evaluate(async () => {
    const rows = await CatalogStore.allProducts();
    const lists = await new Promise(r =>
      chrome.storage.local.get("wpb_lists", o => r((o || {}).wpb_lists || [])));
    const groups = [];
    lists.forEach(l => {
      const mine = rows.filter(x => [].concat(x.listIds || []).includes(l.id));
      if (mine.length) groups.push({ name: l.name, items: mine });
    });
    const out = await window.WPBExcel.buildKnitWorkbook(rows, {
      ExcelJS: window.ExcelJS, groups, filters: {},
    });
    const wb = new window.ExcelJS.Workbook();
    await wb.xlsx.load(out.bytes.buffer);
    return {
      tabs: wb.worksheets.map(w => w.name),
      counts: wb.worksheets.map(w => w.rowCount - 1),   // minus the header
      bytes: out.bytes.length,
    };
  });
  ok("the book has a tab per list, named after it",
    book.tabs.join("|") === "FABRIC|WMN", book.tabs.join(" | "));
  ok("FABRIC's tab holds FABRIC's rows", book.counts[0] === IN_L0,
    `${book.counts[0]} rows, expected ${IN_L0}`);
  ok("WMN's tab holds WMN's rows", book.counts[1] === IN_L1,
    `${book.counts[1]} rows, expected ${IN_L1}`);
  ok("a product in both lists is on both tabs",
    book.counts[0] + book.counts[1] > 30, `${book.counts[0] + book.counts[1]} of 30 products`);
  ok("and it is a real workbook", book.bytes > 3000, `${book.bytes} bytes`);

  /* ---- 3c. housekeeping is off the analysis header ------------------------

     An orange "7 need a look" on the LAB's title line reads as an error over
     work that is fine, and the Data chip is a filing cabinet in the middle of
     a report. Neither is deleted — the backup door is the only route a
     catalog has to another laptop, and the site grades are what stop a half
     scan grading itself clean. They lived on the Scan lists tab until that tab
     was taken off this page too, and now they sit at the FOOT of the LAB:
     under the figures, past the footnote, behind a hairline. */
  const house = await p.evaluate(() => {
    const where = sel => {
      const e = document.querySelector(sel);
      if (!e) return "missing";
      if (e.closest("header")) return "header";
      if (e.closest("#v-lists")) return "scan lists";
      if (e.closest(".housekeep")) return "lab foot";
      return "elsewhere";
    };
    const headerText = (document.querySelector("header") || {}).innerText || "";
    return {
      data: where("#datachip"), databox: where("#databox"),
      check: where("#checkchip"), checkbar: where("#checkbar"),
      headerSaysNeedsLook: /need a look/i.test(headerText),
      headerSaysData: /\bData\b/.test(headerText),
    };
  });
  ok("the Data chip is off the header", house.data === "lab foot", house.data);
  ok("…and its box went with it", house.databox === "lab foot", house.databox);
  ok("the site grades are off the header", house.check === "lab foot", house.check);
  ok("…and their list went too", house.checkbar === "lab foot", house.checkbar);
  ok("nothing on the header says anything needs a look", !house.headerSaysNeedsLook);
  ok("nor offers Data there", !house.headerSaysData);

  const reachable = await p.evaluate(() => {
    const e = document.querySelector("#datachip");
    const r = e && e.getBoundingClientRect();
    return { visible: !!r && r.width > 0 && r.height > 0 };
  });
  ok("but Data is right there under the report — the backup door still opens",
    reachable.visible);
  await p.click("#datachip");
  await p.waitForTimeout(500);
  const opened = await p.evaluate(() => {
    const b = document.querySelector("#databox");
    return { open: !!b && !b.hidden, text: (b && b.innerText) || "" };
  });
  ok("…and it still offers backup and merge", opened.open &&
    /Back up/i.test(opened.text) && /Merge in/i.test(opened.text), opened.text.slice(0, 120));
  await p.click('.tab[data-view="lab"]');
  await p.waitForTimeout(500);

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
