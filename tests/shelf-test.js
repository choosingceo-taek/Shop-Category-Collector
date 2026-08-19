/* The two closed vocabularies the LAB counts on, and what they are for.

   Both axes were counting the shops' own words. A colourway is a sales name —
   "Deep Sea Navy", "Off White", "Heather Grey Marl" — so the COLOUR axis was a
   list of marketing names seen once each, with no colour anywhere in it. And a
   fibre arrives spelled four ways — "Polyester", "Recycled Polyester",
   "Organic Cotton", "BCI Cotton" — so one fibre sat in four rows that each
   looked small.

   The designer named both shelves: twelve colours (the set a shop's own colour
   filter offers) and fifteen fibres. What is not on a shelf is not counted on
   that axis — it is still collected, still in PRODUCTS, still in the Excel as
   the shop wrote it.

   Run: node tests/shelf-test.js
*/
"use strict";
const path = require("path");
const Calc = require(path.resolve(__dirname, "../report/report.js"));
const Colour = require(path.resolve(__dirname, "../report/colour.js"));
const Trend = (() => {
  // trend.js reads ReportCalc off the global in a browser
  global.ReportCalc = Calc;
  return require(path.resolve(__dirname, "../report/trend.js"));
})();

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "  ok  " : "FAIL  "}${name}${!cond && extra ? "\n      " + extra : ""}`);
};
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const same = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want),
  `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// ---- the colour shelf -------------------------------------------------------
same("twelve colours, the ones on the shop's own filter", Calc.COLOURS,
  ["Beige", "Black", "Blue", "Brown", "Green", "Grey", "Orange", "Pink",
    "Purple", "Red", "White", "Yellow"]);

/* The head of an English colour phrase is its last word. */
eq("a sales name is read by its head noun", Calc.colourFamily("Deep Sea Navy"), "Blue");
eq("…including a hyphenated one", Calc.colourFamily("Off-White"), "White");
eq("…and one buried in modifiers", Calc.colourFamily("Washed Vintage Olive Green"), "Green");
eq("…the last colour word wins, not the first",
  Calc.colourFamily("Blue Heather Grey"), "Grey");
eq("heather grey is grey", Calc.colourFamily("Heather Grey Marl"), "Grey");
eq("ivory is white", Calc.colourFamily("Ivory"), "White");
eq("ecru is beige", Calc.colourFamily("Ecru"), "Beige");
eq("burgundy is red", Calc.colourFamily("Burgundy"), "Red");
eq("lilac is purple", Calc.colourFamily("Lilac"), "Purple");
eq("mustard is yellow", Calc.colourFamily("Mustard"), "Yellow");
eq("chocolate is brown", Calc.colourFamily("Chocolate"), "Brown");
eq("terracotta is orange", Calc.colourFamily("Terracotta"), "Orange");
eq("blush is pink", Calc.colourFamily("Blush"), "Pink");
eq("sage is green", Calc.colourFamily("Sage"), "Green");
eq("jet is black", Calc.colourFamily("Jet"), "Black");

/* A colourway that names no colour is not guessed at — a wrong bucket is worse
   than an empty one, because a bucket is what the season gets read from. */
eq("a print is not a colour", Calc.colourFamily("Camo Print"), "");
eq("nor is multi", Calc.colourFamily("Multi"), "");
eq("nor is nothing", Calc.colourFamily(""), "");

same("a colourway list becomes shelf colours, without repeats",
  Calc.colourFamilies("Deep Sea Navy / Off-White, Navy Blue; Camo Print"),
  ["Blue", "White"]);

/* Every colour word declared has to land on the shelf — a typo in the table
   would silently drop a colour out of the axis. */
const strays = Object.keys(Calc.COLOURS).length && [
  "beige", "black", "navy", "chocolate", "sage", "charcoal", "peach", "blush",
  "lavender", "burgundy", "ivory", "mustard",
].filter(w => Calc.COLOURS.indexOf(Calc.colourFamily(w)) < 0);
ok("every word in the table lands on the shelf", strays.length === 0, String(strays));

/* One vocabulary, two ways in: a colour read from a photograph has to land in
   the same twelve as a colour read from a word, or one garment counts twice
   under two spellings of one colour. */
const fine = ["White", "Cream", "Light grey", "Grey", "Black", "Navy", "Blue",
  "Teal", "Beige", "Brown", "Peach", "Orange", "Yellow", "Green", "Pink",
  "Magenta", "Purple", "Red"];
const unmapped = fine.filter(f => Calc.COLOURS.indexOf(Colour.shelfOf(f)) < 0);
ok("the pixel reader's names all fold into the same twelve", unmapped.length === 0,
  String(unmapped));
eq("…navy folds into blue", Colour.shelfOf("Navy"), "Blue");
eq("…cream into white", Colour.shelfOf("Cream"), "White");
eq("…light grey into grey", Colour.shelfOf("Light grey"), "Grey");

// ---- the fibre shelf --------------------------------------------------------
same("fifteen fibres, in the order they were given", Calc.FIBRES,
  ["Polyester", "Cotton", "Elastane/Spandex", "Nylon", "Viscose", "Polyamide",
    "Silk", "Linen", "Acrylic", "Rayon", "Wool", "Tencel", "Polyurethane",
    "Cupro", "Acetate"]);

eq("recycled polyester is polyester", Calc.fibreFamily("Recycled Polyester"), "Polyester");
eq("organic cotton is cotton", Calc.fibreFamily("Organic Cotton"), "Cotton");
eq("BCI cotton is cotton", Calc.fibreFamily("BCI Cotton"), "Cotton");
eq("supima cotton is cotton", Calc.fibreFamily("Supima Cotton"), "Cotton");
eq("a cotton twill is still cotton", Calc.fibreFamily("Cotton Twill"), "Cotton");
eq("spandex is the elastane row", Calc.fibreFamily("Spandex"), "Elastane/Spandex");
eq("…and so is elastane", Calc.fibreFamily("Elastane"), "Elastane/Spandex");
eq("…and lycra, which is a brand of it", Calc.fibreFamily("LYCRA®"), "Elastane/Spandex");
eq("merino is wool", Calc.fibreFamily("Merino Wool"), "Wool");
eq("lyocell is the tencel row", Calc.fibreFamily("Lyocell"), "Tencel");
eq("tencel is too", Calc.fibreFamily("TENCEL™ Lyocell"), "Tencel");
eq("cupro", Calc.fibreFamily("Cupro"), "Cupro");
eq("acetate", Calc.fibreFamily("Acetate"), "Acetate");
eq("polyurethane is not polyester", Calc.fibreFamily("Polyurethane"), "Polyurethane");
eq("polyamide is its own row", Calc.fibreFamily("Polyamide"), "Polyamide");
eq("viscose and rayon are separate rows, as asked",
  [Calc.fibreFamily("Viscose"), Calc.fibreFamily("Rayon")].join("/"), "Viscose/Rayon");
eq("…and a string naming both is filed by the first on the list",
  Calc.fibreFamily("Viscose Rayon"), "Viscose");

/* Off the shelf is off the axis — not guessed onto a neighbouring fibre. */
eq("modal is not on the shelf", Calc.fibreFamily("Modal"), "");
eq("nor cashmere", Calc.fibreFamily("Cashmere"), "");
eq("nor a heading the shop wrote above the blend", Calc.fibreFamily("Main Fabric"), "");
eq("nor a lining label", Calc.fibreFamily("Lining"), "");

same("a composition becomes shelf fibres",
  Calc.fibreFamilies("95% Organic Cotton, 5% Spandex"),
  ["Cotton", "Elastane/Spandex"]);
same("…and the same fibre twice is one row",
  Calc.fibreFamilies("60% Cotton, 35% Recycled Cotton, 5% Elastane"),
  ["Cotton", "Elastane/Spandex"]);
same("…while what is off the shelf is simply not there",
  Calc.fibreFamilies("70% Modal, 30% Polyester"), ["Polyester"]);

/* What the garment is MOSTLY made of. */
eq("the main fibre is the largest share", Calc.mainFibre("95% Cotton, 5% Elastane"), "Cotton");
eq("…whatever order the shop wrote them in",
  Calc.mainFibre("5% Elastane, 95% Cotton"), "Cotton");
eq("…and if the largest share is off the shelf, there is no answer",
  Calc.mainFibre("95% Modal, 5% Elastane"), "");

// ---- what the axes now count ------------------------------------------------
const item = {
  name: "Airbrush Tank", brand: "ALO", category: "New In", addedAt: Date.now(),
  colorways: "Deep Sea Navy / Off-White", fabric_composition: "92% Recycled Polyester, 8% Spandex",
};
same("the COLOUR axis counts shelf colours", Trend.DIMS.color.keysOf(item), ["Blue", "White"]);
same("the fibre axis counts shelf fibres", Trend.DIMS.fabric.keysOf(item),
  ["Polyester", "Elastane/Spandex"]);
same("the FABRIC axis names the cloth by its main fibre",
  Trend.DIMS.fabricfam.keysOf(item), ["Polyester"]);
same("…and the shop's own weave still wins when it names one",
  Trend.DIMS.fabricfam.keysOf(Object.assign({}, item, { name: "Satin Slip Dress" })), ["Satin"]);

/* The dashboard's own figures come off the same shelves — one page cannot
   have a Cotton row and an Organic Cotton row saying different things. */
const agg = Calc.aggregate([
  item,
  { name: "Poplin Shirt", brand: "COS", colorways: "Navy", fabric_composition: "100% Organic Cotton" },
  { name: "Tee", brand: "COS", colorways: "Ivory", fabric_composition: "100% Cotton" },
]);
same("the dashboard counts colours on the shelf too",
  agg.colorFreq.map(r => r.key + ":" + r.value), ["Blue:2", "White:2"]);
same("…and fibres", agg.fiberPresence.map(r => r.key + ":" + r.value),
  ["Cotton:2", "Polyester:1", "Elastane/Spandex:1"]);

/* A week frozen before the shelves existed holds the shops' own words. Read
   back as written it would put "Deep Sea Navy" beside "Blue" on one chart, and
   every old week would read as a collapse of the colour that "replaced" it. */
const WEEK = 7 * 24 * 3600e3;
const now = Date.now();
const lastWeek = Trend.bucketStart(now - WEEK, "week");
const frozen = {
  id: "old", granularity: "week", start: lastWeek, end: lastWeek + WEEK, label: "old",
  products: 10, brands: 4, sites: 4,
  dims: { color: { "Deep Sea Navy": 4, "Navy": 2, "Off-White": 3, "Multi": 1 },
    fabric: { "Recycled Polyester": 6, "Polyester": 2, "Modal": 2 } },
  bdims: { color: { "Deep Sea Navy": 3, "Navy": 2, "Off-White": 2, "Multi": 1 },
    fabric: { "Recycled Polyester": 3, "Polyester": 2, "Modal": 1 } },
};
const thisWeek = [{ name: "Tee", brand: "COS", addedAt: now,
  colorways: "Navy", fabric_composition: "100% Cotton" }];
const sOpt = { granularity: "week", months: 1, now, snapshots: [frozen], top: 9 };
const frozenKeys = Trend.series(thisWeek, Object.assign({ dim: "color" }, sOpt))
  .series.map(s => s.key);
ok("a frozen week's colourways are read onto the shelf too",
  frozenKeys.indexOf("Blue") >= 0 && frozenKeys.indexOf("Deep Sea Navy") < 0,
  JSON.stringify(frozenKeys));
const frozenFib = Trend.series(thisWeek, Object.assign({ dim: "fabric" }, sOpt))
  .series.map(s => s.key);
ok("…and its fibres", frozenFib.indexOf("Polyester") >= 0 &&
  frozenFib.indexOf("Recycled Polyester") < 0, JSON.stringify(frozenFib));

/* Products add up when two old spellings fold together; brands do not — one
   shop that put out a "Navy" and a "Deep Sea Navy" is one shop. */
const perProd = Trend.series(thisWeek, Object.assign({ dim: "color" }, sOpt))
  .series.find(s => s.key === "Blue");
const perBrand = Trend.series(thisWeek, Object.assign({ dim: "color", unit: "brands" }, sOpt))
  .series.find(s => s.key === "Blue");
ok("folded product counts add", perProd && perProd.values.indexOf(60) >= 0,
  JSON.stringify(perProd));    // (4+2) of that week's 10 products
ok("…folded brand counts do not exceed the roster",
  perBrand && perBrand.values.indexOf(75) >= 0, JSON.stringify(perBrand));  // max(3,2) of 4

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
