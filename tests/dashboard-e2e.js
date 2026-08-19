/* The exported HTML is the dashboard the designer asked for — and the figures
   on it are the same figures every other view shows.

   Layout was the request; the standing rule is the harder half. Since v3.8.0
   no two templates may print different numbers, so this checks the headline
   count, the fabric anchor and the ranking against each other rather than
   trusting that they were built from the same object.

   Run: NODE_PATH=/opt/node22/lib/node_modules node dashboard-e2e.js */
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const REPO = path.resolve(__dirname, "..");
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log("  ok  " + n); } else { fail++; console.log("FAIL  " + n + (x ? "\n      " + x : "")); } };

global.self = global;
require(path.join(REPO, "report/report.js"));
const RG = require(path.join(REPO, "report/reportgen.js"));

const FIB = ["87% Nylon 13% Spandex", "95% Cotton 5% Elastane", "100% Linen",
  "65% Polyester 35% Cotton", "100% Cotton", "70% Rayon 30% Linen"];
const BRANDS = ["ALO YOGA", "VUORI", "LULULEMON", "ARITZIA", "COS"];
const CATS = ["New In", "Tops", "Dresses"];
const COLS = ["Black", "Ivory", "Sage", "Navy"];
const items = Array.from({ length: 60 }, (_, i) => ({
  brand: BRANDS[i % BRANDS.length], category: CATS[i % CATS.length],
  name: `${COLS[i % COLS.length]} ${["Ribbed Tank", "Slip Dress", "Crew Tee"][i % 3]}`,
  product_url: `https://shop.example/products/p${i}`,
  price: `$${(19 + (i * 7) % 90).toFixed(2)}`,
  price_was: i % 4 === 0 ? `$${(59 + (i * 3) % 40).toFixed(2)}` : "",
  fabric_composition: FIB[i % FIB.length],
  colorways: COLS.slice(0, 1 + (i % 4)).join(", "),
  addedAt: Date.now() - (i % 5) * 86400000,
}));

(async () => {
  const html = RG.build(items, {}, { title: "Material Intelligence",
    scope: "Young Women's · Tops", period: "Last 6 months",
    source: "Market Lens · FABRIC list", generatedAt: "2026-08-18" });
  fs.writeFileSync("/tmp/dash.html", html);

  // ---- it is still an archive -------------------------------------------------
  /* Still an archive: nothing is FETCHED from outside when the file opens.

     A link is not a fetch. The cards now carry the address each row was
     collected from, so pressing one opens the shop's own page — which is
     where the full-size photograph is and where a designer goes next. That
     costs the file nothing offline: no request is made until someone clicks.
     So the check is about what LOADS — src, and the stylesheet/preload kind
     of href — and not about anchors. */
  const loaded = (html.match(/src="(?!data:|#)[a-z]+:[^"]{0,60}/gi) || [])
    .concat(html.match(/<link[^>]+href="(?!data:|#)[a-z]+:[^"]{0,60}/gi) || []);
  ok("nothing is fetched from outside the file", loaded.length === 0,
    JSON.stringify(loaded.slice(0, 3)));
  ok("…and a card is a door to the shop's own page",
    /<a class="plink" href="https:\/\/[^"]+" target="_blank" rel="noopener"/.test(html),
    (html.match(/<a class="plink"[^>]{0,80}/) || ["(none)"])[0]);
  ok("one small script, for the tabs and the filters",
    (html.match(/<script/g) || []).length === 1);
  ok("the analysis reads in English", !/[가-힣]/.test(html.replace(/<!--[\s\S]*?-->/g, "")));

  /* What the overview stopped drawing (asked for), and what its headline says
     now. The price maths and the brand tally are still COMPUTED — they are in
     the data sheet and the By Brand section — they simply do not get a panel
     on the first screen. */
  ok("no price distribution panel on the overview",
    !/<b>Price distribution<\/b>/.test(html));
  ok("…no brand ranking panel", !/<b>Brand ranking<\/b>/.test(html));
  ok("…and no decision signals", !/Decision signals/.test(html) && !/class="sigs"/.test(html));
  /* One name on the sheet, and it is the tool's. This fixture passes a title
     of its own, so the default is checked where it applies — when the caller
     names none, which is what the LAB does now. */
  const untitled = RG.build(items, {}, { scope: "Young Women's · Tops" });
  ok("the sheet carries one name, the tool's",
    /<b>MARKET LENS<\/b>/.test(untitled) && !/Market research report/.test(untitled),
    (untitled.match(/<div><b>[^<]{0,40}/) || ["(none)"])[0]);
  ok("…and the headline is the words the shops used, not a fixed phrase",
    !/decoded\./.test(untitled) && /<h1>[A-Z][a-z]+/.test(untitled),
    (untitled.match(/<h1>[^<]{0,40}/) || ["(none)"])[0]);
  ok("no search box — the rail asks the questions this file can answer",
    !/type="search"/.test(html) && !/id="q"/.test(html));

  const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const p = await b.newPage({ viewport: { width: 1440, height: 1000 } });
  const errs = []; p.on("pageerror", e => errs.push(e.message));
  await p.goto("file:///tmp/dash.html");
  await p.waitForTimeout(600);

  // ---- the layout that was asked for -----------------------------------------
  for (const [what, sel] of [
    ["a top bar naming the sheet", ".topbar .brand b"],
    ["section pills", ".pills .nv"],
    ["a filter rail", ".rail .fgrp select"],
    ["a hero band", ".hero h1"],
    ["a row of KPI tiles", ".dtiles .dt"],
    ["ranking panels", ".panel .rank .rrow"],
    ["a fibre donut", ".donut svg circle"],
    ["a product wall", ".grid.wall .p"],
  ]) ok(what, await p.locator(sel).count() > 0, sel);

  ok("the lead tile is the filled one",
    await p.locator(".dt").first().evaluate(e => e.classList.contains("lead")));

  // ---- the numbers agree with each other -------------------------------------
  const n = items.length;
  const head = await p.locator(".dt.lead .dtv").innerText();
  ok("the headline count is the number of products collected",
    head.replace(/[^\d]/g, "") === String(n), head);
  const chip = await p.locator(".hchip").first().innerText();
  ok("…and the hero says the same", chip.replace(/[^\d]/g, "") === String(n), chip);

  /* One figure, two places. The decision signals that used to be the third
     are not drawn any more, so the check is between the ranking and the
     donut's legend — which is where two numbers could still disagree inside
     one file, and the whole reason both come from a single aggregate. */
  const topFib = await p.locator(".panel .rank .rrow").first().innerText();
  const legend = await p.locator(".dlegend li").first().innerText();
  const pct = s2 => (s2.match(/(\d+)\s*%/) || [])[1];
  ok("the fabric ranking and the donut legend are one figure",
    pct(topFib) && pct(topFib) === pct(legend),
    JSON.stringify([topFib, legend]));
  const name = s2 => s2.split("\n")[0].trim();
  ok("…and they name the same fibre", name(topFib) === name(legend),
    JSON.stringify([name(topFib), name(legend)]));

  // ---- it still carries the three sections that existed ----------------------
  for (const s2 of ["over", "new", "brand", "lab"])
    ok(`the ${s2} section is in the file`, await p.locator(`[data-sec="${s2}"]`).count() === 1);
  ok("Overview is what opens", await p.locator('[data-sec="over"]').isVisible() &&
    !await p.locator('[data-sec="new"]').isVisible());
  await p.click('.nv[data-s="new"]');
  await p.waitForTimeout(250);
  ok("a pill switches the section", await p.locator('[data-sec="new"]').isVisible() &&
    !await p.locator('[data-sec="over"]').isVisible());
  await p.click('.nv[data-s="over"]');
  await p.waitForTimeout(250);

  // ---- the rail narrows the wall ---------------------------------------------
  const before = await p.locator(".grid.wall .p:visible").count();
  await p.selectOption("#fbrand", "VUORI");
  await p.waitForTimeout(350);
  const after = await p.locator(".grid.wall .p:visible").count();
  ok("choosing a brand narrows the wall", after > 0 && after < before, `${before} → ${after}`);
  await p.click("#fclear");
  await p.waitForTimeout(350);
  ok("Clear all puts them back",
    await p.locator(".grid.wall .p:visible").count() === before);

  /* A unit printed twice ("38%%") is the kind of thing only a rendered page
     shows, so it is asserted rather than looked at. */
  const vals = await p.locator(".panel .rank .rv").allInnerTexts();
  ok("no figure carries its unit twice", !vals.some(v => /%%|\$\$/.test(v)),
    JSON.stringify(vals.slice(0, 4)));

  ok("no page errors", errs.length === 0, errs.join(" | "));
  console.log(`\n${pass} passed, ${fail} failed`);
  await b.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log("HARNESS ERROR: " + (e && e.message || e)); process.exit(1); });
