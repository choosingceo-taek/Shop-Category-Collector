/* Render the exported report and print what it actually contains.

   A measuring tool, not a contract — it prints facts and is run by hand when a
   question comes up.

   It exists because a commit message is not evidence. Reading the source to
   decide whether a change is in it failed twice in one session: once claiming
   four report changes were missing when they were shipped, once the other way
   round. Building the thing and looking at the output does not have that
   failure mode.

   It prints the manifest version FIRST, deliberately. Both wrong readings came
   from measuring a checkout that had quietly reverted to an older commit, and
   an output with no version on it cannot tell you that happened.

   Run: node tests/report-probe.js */
"use strict";
global.self = global;
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
require(path.join(ROOT, "report", "report.js"));
require(path.join(ROOT, "report", "reportgen.js"));
const RG = global.ReportGen || (global.self && global.self.ReportGen);

let version = "(unreadable)";
try { version = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")).version; } catch (e) {}
const head = (() => {
  try {
    return require("child_process").execSync("git -C " + JSON.stringify(ROOT) +
      " log --oneline -1", { encoding: "utf8" }).trim();
  } catch (e) { return "(no git)"; }
})();
console.log("manifest version  " + version);
console.log("checkout          " + head);
console.log("");

const NAMES = ["Linen Blend Wide Leg Pant", "Ribbed Seamless Tank",
  "Linen Shirt", "Wide Leg Trouser", "Linen Dress", "Terry Stripe Hoodie"];
const items = Array.from({ length: 12 }, (_, i) => ({
  brand: ["ADANOLA", "VUORI", "ALO YOGA"][i % 3],
  category: "New In",
  name: NAMES[i % NAMES.length] + " " + i,
  price: "$" + (40 + i) + ".00",
  product_url: "https://shop.example/products/p" + i,
  image_url: "https://cdn.example/p" + i + ".jpg",
  fabric_composition: "100% Linen",
  addedAt: Date.now() - i * 86400000,
}));

const html = RG.build(items, {}, { scope: "FABRIC", generatedAt: "2026-08-19" });
const one = re => { const m = html.match(re); return m ? m[1].replace(/<br>/g, " / ") : "(none)"; };
const many = re => (html.match(re) || []).length;

console.log("bytes             " + html.length.toLocaleString());
console.log("hero <h1>         " + one(/<h1>([\s\S]{0,90}?)<\/h1>/));
console.log("topbar name       " + one(/<div class="bmark">ML<\/div>[\s\S]{0,140}?<b>([^<]{0,60})<\/b>/));
console.log("search inputs     " + many(/<input[^>]+type="search"/gi));
console.log("decision signals  " + many(/class="sig"/g));
console.log("links to the shop " + many(/<a[^>]+href="https?:\/\/shop\.example/g));
console.log("loads from outside " + (many(/src="(?!data:|#)[a-z]+:/gi) +
  many(/<link[^>]+href="(?!data:|#)[a-z]+:/gi)));
