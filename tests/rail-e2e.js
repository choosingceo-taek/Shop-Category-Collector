/* What the LAB is for, and what the rail asks.

   Three things the designer asked for, all of them about a page that had
   grown other people's furniture on it:

     · Products and Scan lists are not tabs here. The product wall lives in the
       side panel beside the list it belongs to, and collecting is the panel's
       job. The two things on the Scan lists tab that could NOT go with it —
       the backup door, which is a catalog's only route to another laptop, and
       the site grades, which are what stop a half scan grading itself clean —
       sit at the foot of the LAB, under the figures rather than over them.
     · The rail is drawn the way the shops draw theirs: a rule, a word in
       spaced capitals, a chevron at the far right. No box around the column,
       no figure beside the name.
     · Silhouette, Fit and Detail are off the rail. They are read from words in
       a product name, so they run to hundreds of values — the reported screen
       showed DETAIL offering 1,172 — and a filter with a thousand answers is a
       list, not a filter. They are still counted on the LAB's own axes.
     · The order is the order the questions are asked in: BRAND, CATEGORY,
       FABRIC, COLOUR.

   Run: NODE_PATH=/opt/node22/lib/node_modules xvfb-run -a node rail-e2e.js */
"use strict";
const { chromium } = require("playwright");
const path = require("path");
const EXT = path.resolve(__dirname, "..");

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log("  ok  " + n); } else { fail++; console.log("FAIL  " + n + (x ? "\n      " + x : "")); } };

const DAY = 86400000, now = Date.now();
const BR = ["adanola", "VUORI", "ALO YOGA", "set active", "LULULEMON", "adidas"];
const CW = ["Deep Sea Navy", "Off-White", "Heather Grey Marl", "Blush"];
const FB = ["95% Organic Cotton 5% Elastane", "100% Linen", "88% Recycled Polyester 12% Spandex"];
const NM = ["Satin Slip Dress", "Linen Poplin Shirt", "Ruched Midi Skirt", "Oversized Hoodie"];
const items = Array.from({ length: 60 }, (_, n) => ({
  url: `https://x.example.com/p/${n}`, product_url: `https://x.example.com/p/${n}`,
  brand: BR[n % BR.length], category: "New In", name: NM[n % NM.length] + " " + n,
  price: "$" + (40 + (n % 9) * 10), image_url: "",
  colorways: CW[n % CW.length], fabric_composition: FB[n % FB.length],
  pos: (n % 12) + 1, addedAt: now - (n % 3) * DAY, listIds: ["l0"],
}));

(async () => {
  const ctx = await chromium.launchPersistentContext("/tmp/pw-rail", {
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
  await p.evaluate(rows => CatalogStore.putScan({ meta: { scanId: "rl" }, items: rows }), items);
  await p.reload();
  await p.waitForTimeout(2600);

  // ---- 1. three tabs -------------------------------------------------------
  const tabs = await p.evaluate(() => [...document.querySelectorAll(".tab")].map(t => ({
    view: t.dataset.view, text: (t.innerText || "").replace(/\s+/g, " ").trim() })));
  ok("the page has three tabs", tabs.length === 3, JSON.stringify(tabs));
  ok("…LAB, New In, By Brand",
    tabs.map(t => t.view).join(",") === "lab,new,brands", JSON.stringify(tabs.map(t => t.view)));
  ok("no Products tab", !tabs.some(t => /product/i.test(t.text)), JSON.stringify(tabs));
  ok("no Scan lists tab", !tabs.some(t => /scan lists/i.test(t.text)), JSON.stringify(tabs));

  // ---- 2. the doors that could not go with them ----------------------------
  const foot = await p.evaluate(() => {
    const chip = document.querySelector("#datachip");
    const r = chip && chip.getBoundingClientRect();
    const body = document.querySelector("#labbody");
    const br = body && body.getBoundingClientRect();
    return {
      inLab: !!(chip && chip.closest("#v-lab")),
      visible: !!r && r.width > 0 && r.height > 0,
      belowTheFigures: !!(r && br) && r.top >= br.top,
      inHeader: !!(chip && chip.closest("header")),
    };
  });
  ok("Data is on the LAB", foot.inLab && foot.visible, JSON.stringify(foot));
  ok("…at its foot, under the figures", foot.belowTheFigures, JSON.stringify(foot));
  ok("…and not back on the title line", !foot.inHeader, JSON.stringify(foot));
  await p.click("#datachip");
  await p.waitForTimeout(500);
  const box = await p.evaluate(() => {
    const b = document.querySelector("#databox");
    return { open: !!b && !b.hidden, text: (b && b.innerText) || "" };
  });
  ok("…and the backup door really opens",
    box.open && /Back up/i.test(box.text) && /Merge in/i.test(box.text),
    box.text.slice(0, 100));

  // ---- 3. the rail ---------------------------------------------------------
  await p.click('.tab[data-view="new"]');
  await p.waitForTimeout(1200);
  const rail = await p.evaluate(() => {
    const groups = [...document.querySelectorAll("#rail .rgrp")];
    const railEl = document.querySelector("#rail");
    const cs = getComputedStyle(railEl);
    const sum = groups.map(g => {
      const s = g.querySelector("summary");
      const cst = getComputedStyle(s);
      const car = s.querySelector(".rcar");
      const rs = s.getBoundingClientRect(), rc = car && car.getBoundingClientRect();
      return {
        label: (s.textContent || "").replace(/[⌄▾▴▶]/g, "").replace(/\s+/g, " ").trim(),
        upper: cst.textTransform === "uppercase",
        spaced: parseFloat(cst.letterSpacing) >= 1,
        chevron: !!car,
        chevronRight: !!rc && (rs.right - rc.right) < 14,
        rule: cst.borderBottomWidth !== "" && getComputedStyle(g).borderBottomWidth === "1px",
        digits: /\d/.test((s.textContent || "")),
      };
    });
    return { sum, boxed: cs.borderTopWidth !== "0px" || cs.backgroundColor !== "rgba(0, 0, 0, 0)" };
  });
  const labels = rail.sum.map(g => g.label);
  ok("the rail asks four questions", labels.length === 4, JSON.stringify(labels));
  ok("…in the order they are asked: brand, category, fabric, colour",
    labels.join(",") === "Brand,Category,Fabric,Colour", JSON.stringify(labels));
  ok("silhouette, fit and detail are not among them",
    !labels.some(l => /silhouette|fit|detail/i.test(l)), JSON.stringify(labels));
  ok("each name is set in spaced capitals",
    rail.sum.every(g => g.upper && g.spaced), JSON.stringify(rail.sum));
  ok("…with a chevron at the far right",
    rail.sum.every(g => g.chevron && g.chevronRight), JSON.stringify(rail.sum));
  ok("…a rule under each group", rail.sum.every(g => g.rule), JSON.stringify(rail.sum));
  ok("…and no figure beside the name", rail.sum.every(g => !g.digits),
    JSON.stringify(labels.map((l, i) => l + (rail.sum[i].digits ? " (has a number)" : ""))));
  ok("the column itself is not a box", !rail.boxed, JSON.stringify(rail.boxed));

  /* By Brand keeps its own brand column, so the rail drops that group there —
     two selectors for one thing drift apart. */
  await p.click('.tab[data-view="brands"]');
  await p.waitForTimeout(1200);
  const onBrands = await p.evaluate(() => [...document.querySelectorAll("#rail .rgrp summary")]
    .map(s => (s.textContent || "").replace(/[⌄▾▴▶]/g, "").replace(/\s+/g, " ").trim()));
  ok("By Brand asks the other three", onBrands.join(",") === "Category,Fabric,Colour",
    JSON.stringify(onBrands));

  /* And it still filters. */
  const narrowed = await p.evaluate(async () => {
    const shown = () => document.querySelectorAll("#v-brands .grid .c").length;
    const before = shown();
    const box2 = [...document.querySelectorAll('.rail input[data-k="fabric"]')][0];
    if (!box2) return { before, after: -1 };
    const value = box2.dataset.v;
    box2.click();
    await new Promise(r => setTimeout(r, 800));
    return { before, after: shown(), value };
  });
  ok("choosing a value still narrows the screen",
    narrowed.after > 0 && narrowed.after < narrowed.before, JSON.stringify(narrowed));

  /* ---- 4. one filter per question, and no tallies ------------------------

     The middle of the feed carried a second brand filter, three inches from
     the one on the left: two controls for one question drift apart, and the
     screen stops saying which of them is narrowing it. What is left over the
     feed is the weeks, which is what this tab is for.

     And the counts are off the browsing chrome (the designer asked): the week
     chips, the day and brand headings, the brand column, the list chips. What
     came in and how much of it is the LAB's question and the LAB answers it
     properly, by brand; here the figures were decoration on controls whose
     meaning is which week, which brand, which list. */
  await p.click('.tab[data-view="new"]');
  await p.waitForTimeout(1200);
  const feed = await p.evaluate(() => {
    const el = document.querySelector("#v-new");
    const txt = s => [...el.querySelectorAll(s)].map(e => (e.textContent || "").replace(/\s+/g, " ").trim());
    return {
      brandChipRow: [...el.querySelectorAll(".catchips")].filter(c => c.querySelector("[data-b]")).length,
      weekChips: txt(".weekchips button"),
      days: txt(".dayhead"),
      brandHeads: txt(".brandsec"),
      kicker: txt(".kicker")[0] || "",
    };
  });
  ok("no brand row across the middle — the rail asks that", feed.brandChipRow === 0,
    String(feed.brandChipRow));
  ok("the weeks are still there", feed.weekChips.length > 0, JSON.stringify(feed.weekChips));
  ok("…as dates, without a tally", feed.weekChips.every(t => !/\d+\s*$/.test(t.replace(/^\d+\/\d+/, ""))),
    JSON.stringify(feed.weekChips));
  ok("a day heading is a day", feed.days.every(t => !/\d+$/.test(t.replace(/\)$/, ""))),
    JSON.stringify(feed.days));
  ok("a brand heading is a brand", feed.brandHeads.every(t => !/\d/.test(t)),
    JSON.stringify(feed.brandHeads));
  ok("and the line above says what it is, not how many", !/\d/.test(feed.kicker), feed.kicker);

  const chips = await p.evaluate(() =>
    [...document.querySelectorAll("#scopechips button")].map(b => (b.textContent || "").trim()));
  ok("the list chips carry no figure", chips.length > 0 && chips.every(t => !/\d/.test(t)),
    JSON.stringify(chips));

  await p.click('.tab[data-view="brands"]');
  await p.waitForTimeout(1200);
  const bybrand = await p.evaluate(() => {
    const el = document.querySelector("#v-brands");
    return {
      catChipRow: [...el.querySelectorAll(".catchips")].filter(c => c.querySelector("[data-c]")).length,
      column: [...el.querySelectorAll(".brail button")].map(b => (b.textContent || "").trim()),
    };
  });
  ok("no category row on By Brand either", bybrand.catChipRow === 0, String(bybrand.catChipRow));
  ok("…and the brand column is names only",
    bybrand.column.length > 0 && bybrand.column.every(t => !/\d/.test(t)),
    JSON.stringify(bybrand.column));

  ok("no page errors", errs.length === 0, errs.join(" | "));
  console.log(`\n${pass} passed, ${fail} failed`);
  await ctx.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log("HARNESS ERROR: " + (e && e.message || e)); process.exit(1); });
