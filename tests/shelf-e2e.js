/* The two shelves, on screen.

   The unit test fixes what a colourway and a composition are read as. This
   one checks that the LAB actually shows it: the COLOUR axis names colours
   rather than sales names, the fibre blocks name fibres rather than four
   spellings of one, and the filter rail offers twelve colours with a swatch
   beside each — the way a shop's own colour filter is drawn, which is where
   the list came from.

   Run: NODE_PATH=/opt/node22/lib/node_modules xvfb-run -a node shelf-e2e.js */
"use strict";
const { chromium } = require("playwright");
const path = require("path");
const EXT = path.resolve(__dirname, "..");

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log("  ok  " + n); } else { fail++; console.log("FAIL  " + n + (x ? "\n      " + x : "")); } };

const DAY = 86400000;
/* Colourways as shops actually write them, and compositions with the four
   spellings of one fibre that used to make four rows. */
const SHAPES = [
  ["ALO", "Deep Sea Navy", "92% Recycled Polyester, 8% Spandex"],
  ["GYMSHARK", "Off-White", "95% Organic Cotton, 5% Elastane"],
  ["VUORI", "Heather Grey Marl", "100% Polyester"],
  ["COS", "Ecru", "100% Linen"],
  ["ATHLETA", "Washed Olive Green", "78% Nylon, 22% LYCRA®"],
  ["VARLEY", "Blush", "100% Cotton"],
  ["TALA", "Burgundy", "70% Modal, 30% Cotton"],
  ["EDIKTED", "Camo Print", "100% Viscose"],
];
const items = Array.from({ length: 32 }, (_, n) => {
  const s = SHAPES[n % SHAPES.length];
  return {
    url: `https://example.com/p/${n}`,
    /* Names that carry a WEAVE word, the way the shops write them — that is
       what used to reach the fabric axis instead of the fibre. */
    brand: s[0], category: "New In",
    name: ["Ribbed Tank", "Terry Hoodie", "Jersey Tee", "Waffle Crew"][n % 4] + " " + n,
    price: "$" + (40 + (n % 9) * 10), image_url: "",
    colorways: s[1], fabric_composition: s[2],
    addedAt: Date.now() - (n % 3) * DAY,
    listIds: ["l0"],
  };
});

(async () => {
  const ctx = await chromium.launchPersistentContext("/tmp/pw-shelf", {
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
  await p.evaluate(rows => CatalogStore.putScan({ meta: { scanId: "shelf" }, items: rows }), items);
  await p.reload();
  await p.waitForTimeout(2800);

  const COLOURS = ["Beige", "Black", "Blue", "Brown", "Green", "Grey", "Orange",
    "Pink", "Purple", "Red", "White", "Yellow"];

  // ---- the COLOUR axis --------------------------------------------------
  const axis = await p.evaluate(() => {
    const sec = [...document.querySelectorAll("section.sec.ax")]
      .find(s => /Colour/i.test((s.querySelector("h3") || {}).textContent || ""));
    return sec ? [...sec.querySelectorAll(".axk")].map(e => e.textContent.trim()) : null;
  });
  ok("the LAB has a COLOUR axis", Array.isArray(axis) && axis.length > 0, JSON.stringify(axis));
  ok("…and every card on it is a shelf colour",
    axis && axis.every(k => COLOURS.includes(k)), JSON.stringify(axis));
  ok("…so a sales name is not a colour card",
    axis && !axis.some(k => /navy|marl|heather|ecru|blush|olive/i.test(k)), JSON.stringify(axis));
  ok("…and the colourways really did fold together",
    axis && axis.includes("Blue") && axis.includes("Grey") && axis.includes("White"),
    JSON.stringify(axis));

  const axisInk = await p.evaluate(() => {
    const sec = [...document.querySelectorAll("section.sec.ax")]
      .find(s => /Colour/i.test((s.querySelector("h3") || {}).textContent || ""));
    if (!sec) return null;
    return [...sec.querySelectorAll(".axk")].map(k => {
      const sw = k.querySelector(".sw");
      return sw ? getComputedStyle(sw).backgroundColor : "";
    });
  });
  ok("…each card shows the colour it is about",
    axisInk && axisInk.length > 0 && axisInk.every(c => /^rgb/.test(c)),
    JSON.stringify(axisInk));

  /* The FABRIC axis answers in fibres — the same fifteen the rail offers. It
     used to answer in the cloth a shop NAMES in a title, which put RIBBED,
     TERRY, RIB, HEATHER and JERSEY beside COTTON and NYLON: two vocabularies
     on one axis, so nothing on it could be added up. */
  const FIBRES = ["Polyester", "Cotton", "Elastane/Spandex", "Nylon", "Viscose",
    "Polyamide", "Silk", "Linen", "Acrylic", "Rayon", "Wool", "Tencel",
    "Polyurethane", "Cupro", "Acetate"];
  const fabAxis = await p.evaluate(() => {
    const sec = [...document.querySelectorAll("section.sec.ax")]
      .find(s => /Fabric/i.test((s.querySelector("h3") || {}).textContent || ""));
    return sec ? [...sec.querySelectorAll(".axk")].map(e => e.textContent.trim()) : null;
  });
  ok("the LAB has a FABRIC axis", Array.isArray(fabAxis) && fabAxis.length > 0,
    JSON.stringify(fabAxis));
  ok("…and every card on it is one of the fifteen fibres",
    fabAxis && fabAxis.every(k => FIBRES.includes(k)), JSON.stringify(fabAxis));
  ok("…so a weave name is not a fabric card",
    fabAxis && !fabAxis.some(k => /ribbed|terry|\brib\b|heather|jersey|satin|poplin/i.test(k)),
    JSON.stringify(fabAxis));

  /* What a card shows: its place in the ranking, the count of items that
     really carry it, and that count drawn week by week. "2 /6 brands" over a
     slash was the honest adoption unit but not readable at a glance, and the
     figure that says how much there IS of it was the small grey one. */
  const cards = await p.evaluate(() => {
    const sec = [...document.querySelectorAll("section.sec.ax")]
      .find(s => /Fabric/i.test((s.querySelector("h3") || {}).textContent || ""));
    if (!sec) return null;
    return [...sec.querySelectorAll(".axc")].map(c => ({
      rank: (c.querySelector(".axrank") || {}).textContent || "",
      key: (c.querySelector(".axk") || {}).textContent || "",
      num: (c.querySelector(".axnum b") || {}).textContent || "",
      unitWord: (c.querySelector(".axnum i") || {}).textContent || "",
      bars: c.querySelectorAll("svg.axline path").length,
      blend: /\b\d{2,3}\b/.test(((c.querySelector(".axmeta") || {}).textContent || "")),
      slash: /\/\s*\d+\s*brands/.test((c.querySelector(".axnum") || {}).textContent || ""),
    }));
  });
  ok("every card is numbered by its place in the ranking",
    cards && cards.length > 0 && cards.every((c, i) => c.rank === String(i + 1)),
    JSON.stringify(cards && cards.map(c => c.rank)));
  ok("…the big figure is the item count", cards && cards.every(c => /^\d+$/.test(c.num) &&
    /item/i.test(c.unitWord)), JSON.stringify(cards && cards.map(c => c.num + " " + c.unitWord)));
  ok("…and it is ordered by that count, most first",
    cards && cards.every((c, i) => i === 0 || +c.num <= +cards[i - 1].num),
    JSON.stringify(cards && cards.map(c => c.num)));
  ok("…with no figure-over-a-slash on the face", cards && !cards.some(c => c.slash),
    JSON.stringify(cards && cards.map(c => c.num + c.unitWord)));
  ok("…and the weeks drawn under it as a line", cards && cards.every(c => c.bars > 0),
    JSON.stringify(cards && cards.map(c => c.bars)));
  ok("…with no percentage line under the card",
    cards && !cards.some(c => c.blend), JSON.stringify(cards && cards.map(c => c.blend)));

  /* One scale for the whole axis. Scaled to its own row, a keyword with 42
     items and one with 21 drew exactly the same shape — the designer asked
     why the heights did not follow the numbers. */
  const scale = await p.evaluate(() => {
    const sec = [...document.querySelectorAll("section.sec.ax")]
      .find(s => /Fabric/i.test((s.querySelector("h3") || {}).textContent || ""));
    if (!sec) return null;
    return [...sec.querySelectorAll(".axc")].map(c => {
      const n = parseInt((c.querySelector(".axnum b") || {}).textContent || "0", 10);
      const path = c.querySelector("svg.axline path");
      const ys = (path ? (path.getAttribute("d") || "") : "")
        .split(/[ML]/).slice(1).map(seg => parseFloat(seg.split(",")[1]));
      return { n, lowestY: ys.length ? Math.min(...ys) : null };
    });
  });
  const twoDifferent = scale && scale.filter(s => s.lowestY != null);
  ok("a bigger count draws a higher line",
    twoDifferent && twoDifferent.length > 1 &&
    twoDifferent.every((s, i) => i === 0 || s.n === twoDifferent[i - 1].n ||
      s.lowestY > twoDifferent[i - 1].lowestY - 0.6),
    JSON.stringify(twoDifferent));

  // ---- the fibre blocks --------------------------------------------------
  const fibres = await p.evaluate(() => {
    const sec = [...document.querySelectorAll("section.sec")]
      .find(s => /Most seen fabric/i.test((s.querySelector("h3") || {}).textContent || ""));
    return sec ? [...sec.querySelectorAll(".rk, .rank-k, li, tr")]
      .map(e => e.textContent.trim()).filter(Boolean) : null;
  });
  const fibreText = (fibres || []).join(" | ");
  ok("the fibre ranking names the shelf fibre", /Polyester/.test(fibreText), fibreText);
  ok("…not the shop's four spellings of it",
    !/Recycled Polyester|Organic Cotton|LYCRA/i.test(fibreText), fibreText);
  ok("…and spandex and elastane are one row",
    !/\bSpandex\b(?!\/)/i.test(fibreText.replace(/Elastane\/Spandex/g, "")), fibreText);

  // ---- the filter rail, on the browsing tabs ------------------------------
  await p.click('.tab[data-view="new"]');
  await p.waitForTimeout(900);
  const rail = await p.evaluate(() => {
    const g = [...document.querySelectorAll(".rail .rgrp")]
      .find(d => /Colour/i.test((d.querySelector("summary") || {}).textContent || ""));
    if (!g) return null;
    g.open = true;
    const more = g.querySelector(".rmore");
    if (more) more.click();
    return null;
  });
  void rail;
  await p.waitForTimeout(400);
  const railVals = await p.evaluate(() => {
    const g = [...document.querySelectorAll(".rail .rgrp")]
      .find(d => /Colour/i.test((d.querySelector("summary") || {}).textContent || ""));
    if (!g) return null;
    return [...g.querySelectorAll("label")].map(l => ({
      v: (l.querySelector(".rv") || {}).textContent || "",
      swatch: !!l.querySelector(".sw"),
      ink: l.querySelector(".sw") ? getComputedStyle(l.querySelector(".sw")).backgroundColor : "",
    }));
  });
  ok("the rail has a colour group", Array.isArray(railVals) && railVals.length > 0,
    JSON.stringify(railVals));
  ok("…listing shelf colours only",
    railVals && railVals.every(r => COLOURS.includes(r.v.trim())), JSON.stringify(railVals));
  ok("…each drawn as a colour, the way a shop's filter is",
    railVals && railVals.every(r => r.swatch), JSON.stringify(railVals));
  ok("…with a real ink behind it",
    railVals && railVals.every(r => /^rgb/.test(r.ink) && r.ink !== "rgba(0, 0, 0, 0)"),
    JSON.stringify(railVals));

  /* Picking one narrows the wall — a filter that lists a value has to be able
     to act on it, or the rail is a legend. */
  const picked = await p.evaluate(async () => {
    const shown = () => document.querySelectorAll("#v-new .grid .c").length;
    const before = shown();
    const box = [...document.querySelectorAll('.rail input[data-k="color"]')]
      .find(i => i.dataset.v === "Blue");
    if (!box) return { before, after: -1, value: "(no Blue)" };
    box.click();
    await new Promise(r => setTimeout(r, 900));
    return { before, after: shown(), value: "Blue" };
  });
  ok("choosing a colour narrows the products",
    picked.after > 0 && picked.after < picked.before, JSON.stringify(picked));

  /* The counts of the collection are off this page — how many rows there are,
     how many weeks have any, how many arrived last, and the week table that
     repeated the axes in percentages. What is left answers what the season is
     made of. */
  const home = await p.evaluate(() => {
    const el = document.querySelector("#v-lab");
    return { tiles: el.querySelectorAll(".labhead .tile").length,
      heads: [...el.querySelectorAll("h3")].map(h => String((h.firstChild || {}).textContent || h.textContent).trim()),
      text: (el.innerText || "").replace(/\s+/g, " ") };
  });
  ok("no count tiles on the analysis page", home.tiles === 0, String(home.tiles));
  ok("…nor the week-by-week record table",
    !home.heads.some(h => /record by/i.test(h)), home.heads.join(" | "));
  ok("…and no DETAIL axis", !home.heads.some(h => /^detail$/i.test(h)), home.heads.join(" | "));
  ok("…while FABRIC and COLOUR are still there",
    home.heads.some(h => /^fabric$/i.test(h)) && home.heads.some(h => /^colour$/i.test(h)),
    home.heads.join(" | "));

  ok("no page errors", errs.length === 0, errs.join(" | "));
  console.log(`\n${pass} passed, ${fail} failed`);
  await ctx.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log("HARNESS ERROR: " + (e && e.message || e)); process.exit(1); });
