/* Draw the exported report, because a layout is judged by looking at it. */
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const REPO = path.resolve(__dirname, "..");
global.self = global;                       // the modules attach to `self`
require(path.join(REPO, "report/report.js"));
const RG = require(path.join(REPO, "report/reportgen.js"));

const FIB = [["87% Nylon 13% Spandex","Nylon"],["95% Cotton 5% Elastane","Cotton"],
  ["100% Linen","Linen"],["65% Polyester 35% Cotton","Polyester"],["100% Cotton","Cotton"],
  ["70% Rayon 30% Linen","Rayon"],["92% Modal 8% Elastane","Modal"],["100% Silk","Silk"]];
const BRANDS = ["ALO YOGA","VUORI","LULULEMON","ARITZIA","COS","EDIKTED","GYMSHARK","ADANOLA"];
const CATS = ["New In","Tops","Dresses","Knitwear","Leggings"];
const COLS = ["Black","Ivory","Sage","Navy","Rust","Cream","Olive"];
const items = Array.from({ length: 96 }, (_, i) => ({
  brand: BRANDS[i % BRANDS.length], category: CATS[i % CATS.length],
  name: `${COLS[i % COLS.length]} ${["Ribbed Tank","Slip Dress","Crew Tee","Wide Leg Pant","Cardigan"][i % 5]}`,
  product_url: `https://shop.example/products/p${i}`,
  price: `$${(19 + (i * 7) % 90).toFixed(2)}`,
  price_was: i % 4 === 0 ? `$${(39 + (i * 7) % 90).toFixed(2)}` : "",
  fabric_composition: FIB[i % FIB.length][0],
  colorways: COLS.slice(0, 1 + (i % 5)).join(", "),
  addedAt: Date.now() - (i % 6) * 86400000,
}));
const html = RG.build(items, {}, {
  title: "Material Intelligence", scope: "Young Women's · Tops", period: "Last 6 months",
  source: "Market Lens · FABRIC list", generatedAt: "2026-08-18",
});
fs.writeFileSync("/tmp/report-out.html", html);
console.log("bytes:", html.length, "| external refs:",
  (html.match(/(src|href)="https?:\/\//g) || []).length, "| scripts:", (html.match(/<script/g) || []).length);

(async () => {
  const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const p = await b.newPage({ viewport: { width: 1440, height: 1000 } });
  const errs = []; p.on("pageerror", e => errs.push(e.message));
  await p.goto("file:///tmp/report-out.html");
  await p.waitForTimeout(900);
  await p.screenshot({ path: "rep-top.png" });
  await p.evaluate(() => window.scrollBy(0, 1000)); await p.waitForTimeout(300);
  await p.screenshot({ path: "rep-mid.png" });
  console.log(errs.length ? "ERRORS: " + errs.join(" | ") : "no page errors");
  await b.close();
})();
