/* The shop's own order, kept all the way through — and no prices on the LAB.

   A category page is laid out, not listed. The first tile is the one the
   merchandiser put first, and reading that order is half of what a designer
   does when they open the page themselves. The run has always held the rows in
   that order, but a database hands them back in no order at all, so every
   screen built from the catalog was showing them newest-first at best and
   arbitrarily at worst — the ranking was thrown away between the scan and the
   page. The scan now records the position and every list sorts back into it:
   the product wall, the two browsing feeds, and the workbook the LAB builds.

   The other half: the LAB page carries no price table. What a season is made
   of and what it costs are two different questions, and the second one sat
   between the axes and the record. The figures stay in trend.js and the
   exported dashboard still draws its own price distribution.

   Run: NODE_PATH=/opt/node22/lib/node_modules xvfb-run -a node siteorder-e2e.js */
"use strict";
const { chromium } = require("playwright");
const path = require("path");
const EXT = path.resolve(__dirname, "..");

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log("  ok  " + n); } else { fail++; console.log("FAIL  " + n + (x ? "\n      " + x : "")); } };

const DAY = 86400000;
const now = Date.now();
/* Two shops, one page each, twelve products in the order the shop shows them.
   The rows are handed to the store SHUFFLED and with collection times that
   run against the shop's order, so nothing but `pos` can put them back. */
const shops = [["ALO", "New In"], ["COS", "New In"]];
const items = [];
shops.forEach(([brand, cat], s) => {
  for (let i = 0; i < 12; i++) {
    items.push({
      url: `https://${brand.toLowerCase()}.example.com/p/${i}`,
      product_url: `https://${brand.toLowerCase()}.example.com/p/${i}`,
      brand, category: cat,
      name: `${brand} ${String(i + 1).padStart(2, "0")}`,
      price: "$" + (40 + i), image_url: "",
      colorways: "Black", fabric_composition: "100% Cotton",
      pos: i + 1,
      // the first tile on the page is the OLDEST here, so "newest collected"
      // would print the page upside down
      addedAt: now - (11 - i) * 60000 - s * DAY,
      listIds: ["l0"],
    });
  }
});
const shuffled = items.slice().sort((a, b) => (a.name.length - b.name.length) || (b.pos - a.pos));

(async () => {
  const ctx = await chromium.launchPersistentContext("/tmp/pw-siteorder", {
    executablePath: "/opt/pw-browsers/chromium", headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-sandbox"] });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker");
  const id = sw.url().split("/")[2];
  const p = await ctx.newPage();
  await p.setViewportSize({ width: 1280, height: 900 });
  const errs = []; p.on("pageerror", e => errs.push(e.message));

  await p.goto(`chrome-extension://${id}/catalog.html`);
  await p.waitForTimeout(1200);
  await p.evaluate(() => new Promise(r => chrome.storage.local.set({
    wpb_lists: [{ id: "l0", name: "FABRIC", createdAt: 1, entries: [] }] }, r)));
  await p.evaluate(rows => CatalogStore.putScan({ meta: { scanId: "so" }, items: rows }), shuffled);
  await p.reload();
  await p.waitForTimeout(2600);

  const namesOf = sel => p.evaluate(s => [...document.querySelectorAll(s)]
    .map(e => (e.textContent || "").trim()), sel);

  /* ---- 1. no price table on the LAB --------------------------------------
     Checked first: the ordering assertions below cannot even start on a build
     that has no "Site order" option, and this half has to be measurable on the
     old code too. */
  await p.waitForTimeout(600);
  const lab = await p.evaluate(() => {
    const el = document.querySelector("#v-lab");
    const heads = [...el.querySelectorAll("h3")].map(h => h.textContent.trim());
    return { heads, text: (el.innerText || "").replace(/\s+/g, " ") };
  });
  ok("the LAB has no price section",
    !lab.heads.some(h => /price|markdown/i.test(h)), lab.heads.join(" | "));
  ok("…and no median-price or markdown tile either",
    !/median price|average markdown|on sale/i.test(lab.text),
    (lab.text.match(/.{0,40}(median price|average markdown|on sale).{0,40}/i) || [""])[0]);
  ok("…while the axes it is there for are still drawn",
    /FABRIC/.test(lab.text) && /COLOUR/.test(lab.text), lab.heads.join(" | "));

  // ---- 2. the product wall, which lives in the side panel ------------------
  const panel = await ctx.newPage();
  await panel.setViewportSize({ width: 400, height: 900 });
  const perrs = []; panel.on("pageerror", e => perrs.push(e.message));
  await panel.goto(`chrome-extension://${id}/sidepanel.html`);
  await panel.waitForTimeout(1500);
  await panel.click('.tab[data-view="products"]');
  await panel.waitForTimeout(1200);
  /* The wall is scoped to the open list, and both shops are in it. */
  const wall = await panel.evaluate(() => [...document.querySelectorAll("#pgrid .pc")]
    .map(c => ((c.innerText || "").match(/(ALO|COS) \d\d/) || [""])[0]).filter(Boolean));
  const alo = wall.filter(t => t.startsWith("ALO"));
  const cos = wall.filter(t => t.startsWith("COS"));
  ok("both shops are on the wall", alo.length === 12 && cos.length === 12,
    `${alo.length} / ${cos.length}`);
  ok("ALO is in the order ALO's page had it",
    alo.join(",") === items.filter(i => i.brand === "ALO").map(i => i.name).join(","),
    alo.join(" "));
  ok("COS is in the order COS's page had it",
    cos.join(",") === items.filter(i => i.brand === "COS").map(i => i.name).join(","),
    cos.join(" "));
  ok("…and one shop's page is not interleaved with the other's",
    wall.join(",").indexOf("COS") > wall.join(",").lastIndexOf("ALO 12") - 1,
    wall.join(" "));
  ok("no page errors in the panel", perrs.length === 0, perrs.join(" | "));

  // ---- 3. the browsing feeds ----------------------------------------------
  await p.click('.tab[data-view="brands"]');
  await p.waitForTimeout(1000);
  const brandFeed = await p.evaluate(() =>
    [...document.querySelectorAll("#v-brands .grid .c")]
      .map(c => (c.textContent || "").match(/(ALO|COS) \d\d/))
      .filter(Boolean).map(m => m[0]));
  ok("By Brand lists that brand's page in the shop's order",
    brandFeed.length > 1 && brandFeed.join(",") ===
      items.filter(i => i.brand === brandFeed[0].split(" ")[0]).map(i => i.name).join(","),
    brandFeed.join(" "));

  await p.click('.tab[data-view="new"]');
  await p.waitForTimeout(1000);
  const newFeed = await p.evaluate(() =>
    [...document.querySelectorAll("#v-new .grid")].map(g =>
      [...g.querySelectorAll(".c")].map(c => (c.textContent || "").match(/(ALO|COS) \d\d/))
        .filter(Boolean).map(m => m[0])).filter(a => a.length > 1));
  const feedOrdered = newFeed.every(sec => {
    const nums = sec.map(n => parseInt(n.slice(-2), 10));
    return nums.every((v, i) => i === 0 || v > nums[i - 1]);
  });
  ok("New In lists each brand's block in the shop's order too", newFeed.length > 0 && feedOrdered,
    JSON.stringify(newFeed));

  // ---- 4. the workbook -----------------------------------------------------
  const book = await p.evaluate(async () => {
    const rows = await CatalogStore.allProducts();
    const out = await window.WPBExcel.buildKnitWorkbook(rows, {
      ExcelJS: window.ExcelJS, groups: [{ name: "FABRIC", items: rows }], filters: {},
    });
    const wb = new window.ExcelJS.Workbook();
    await wb.xlsx.load(out.bytes.buffer);
    const ws = wb.worksheets[0];
    const names = [];
    ws.eachRow((row, n) => { if (n > 1) names.push(String(row.getCell(3).value || "").trim()); });
    return names;
  });
  const bookAlo = book.filter(t => t.startsWith("ALO"));
  ok("the workbook keeps the shop's order inside a brand's page",
    bookAlo.join(",") === items.filter(i => i.brand === "ALO").map(i => i.name).join(","),
    bookAlo.join(" "));

  ok("no page errors", errs.length === 0, errs.join(" | "));
  console.log(`\n${pass} passed, ${fail} failed`);
  await ctx.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log("HARNESS ERROR: " + (e && e.message || e)); process.exit(1); });
