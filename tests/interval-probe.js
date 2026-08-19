/* Draw the LAB at each interval and count what came out.
   A measuring tool. Run: node tests/interval-probe.js */
"use strict";
global.self = global;
const path = require("path"), fs = require("fs");
const ROOT = path.resolve(__dirname, "..");
console.log("manifest", JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")).version);
global.ReportCalc = require(path.join(ROOT, "report", "report.js"));
global.Calc = global.ReportCalc;
global.TrendCalc = require(path.join(ROOT, "report", "trend.js"));
const src = fs.readFileSync(path.join(ROOT, "lab.js"), "utf8");
global.window = global; global.document = { createElement: () => ({ style: {} }) };
new Function(src)();
const LabView = global.LabView;

const now = new Date(2026, 7, 19, 23).getTime();
const NAMES = ["Linen Wide Leg Pant", "Ribbed Tank", "Satin Midi Dress", "Terry Hoodie"];
const items = Array.from({ length: 200 }, (_, i) => ({
  brand: ["ADANOLA", "VUORI", "ALO YOGA", "GYMSHARK"][i % 4],
  category: "New In", name: NAMES[i % NAMES.length] + " " + i,
  fabric_composition: ["100% Linen", "95% Cotton, 5% Elastane", "100% Polyester"][i % 3],
  colorways: ["Deep Sea Navy", "Off-White", "Olive Green"][i % 3],
  price: "$" + (40 + (i % 60)) + ".00",
  product_url: "https://shop.example/p" + i, image_url: "",
  addedAt: now - Math.floor(i * 0.9) * 864e5,
}));

for (const g of ["month", "fortnight", "week", "day"]) {
  const el = { innerHTML: "", querySelectorAll: () => [], querySelector: () => null };
  LabView.render(el, items, { months: 6, granularity: g, dim: "fabric", now });
  const h = el.innerHTML || "";
  const bars = (h.match(/<rect /g) || []).length;
  const nums = (h.match(/font-size="9.5"/g) || []).length;
  const empty = /labempty/.test(h);
  console.log(String(g).padEnd(10), "bytes", String(h.length).padStart(7),
    "| rects", String(bars).padStart(4), "| bar figures", String(nums).padStart(4),
    empty ? "| EMPTY SCREEN" : "");
}
