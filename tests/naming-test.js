/* What a page gets FILED AS — the brand and the category.

   Both are grouping keys: the Excel groups brand → category, and the LAB
   counts by them. A wrong one does not look like a bug, it looks like a
   finding — four shops merged into one bar, or a whole scan filed under a
   sentence the shop never meant as a name.

   Two faults, both reported from a real page (athleta.gap.com):

     brand    GAP        — the house brand lives on the parent's domain, and
                           reading the registrable domain files Athleta,
                           Banana Republic and Old Navy as one shop
     category "Want to shop athleta.com?" — an interstitial <h1> sits above
                           the grid, and it got there before the category did

   Run: node tests/naming-test.js
*/
"use strict";
global.self = global;
const L = require("../lists.js");
const SITES = require("../sites.js");

let pass = 0, fail = 0;
const ok = (name, got, want) => {
  const good = got === want;
  good ? pass++ : fail++;
  if (!good) console.log(`  FAIL ${name}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
};

console.log("brandFromHost — a house brand on its parent's domain");
ok("athleta.gap.com", L.brandFromHost("athleta.gap.com"), "Athleta");
ok("www.athleta.gap.com", L.brandFromHost("www.athleta.gap.com"), "Athleta");
ok("bananarepublic.gap.com", L.brandFromHost("bananarepublic.gap.com"), "Bananarepublic");
ok("oldnavy.gap.com", L.brandFromHost("oldnavy.gap.com"), "Oldnavy");

console.log("brandFromHost — routing labels are still not brands");
ok("shop.lululemon.com", L.brandFromHost("shop.lululemon.com"), "Lululemon");
ok("row.gymshark.com", L.brandFromHost("row.gymshark.com"), "Gymshark");
ok("us.boohoo.com", L.brandFromHost("us.boohoo.com"), "Boohoo");
ok("m.asos.com", L.brandFromHost("m.asos.com"), "Asos");
ok("www2.hm.com", L.brandFromHost("www2.hm.com"), "Hm");
ok("intl.aritzia.com", L.brandFromHost("intl.aritzia.com"), "Aritzia");

console.log("brandFromHost — the plain cases are untouched");
ok("www.zara.com", L.brandFromHost("www.zara.com"), "Zara");
ok("gap.com", L.brandFromHost("gap.com"), "Gap");
ok("cottonon.com", L.brandFromHost("cottonon.com"), "Cottonon");
ok("setactive.co", L.brandFromHost("setactive.co"), "Setactive");
ok("www.cos.com hyphens", L.brandFromHost("www.set-active.com"), "Set Active");

console.log("notACategory — a category is a noun phrase");
const na = SITES.notACategory;
ok("question", na("Want to shop athleta.com?"), true);
ok("bare question", na("Continue to your local site?"), true);
ok("address in it", na("Shop athleta.com"), true);
ok("real category", na("All New Arrivals"), false);
ok("real category 2", na("Women's T-Shirts"), false);
ok("real category 3", na("New In"), false);
ok("size in name", na("Plus 14 24"), false);
ok("brand with a dot", na("3.1 Phillip Lim"), false);
ok("empty", na(""), false);

console.log(`\n${pass} passed, ${fail} failing`);
process.exit(fail ? 1 : 0);
