/* Money the way the shops actually write it.

   Found by goal-e2e: a scan of a euro shop put "120,00 €" through the report
   layer and a dashboard printed a price range of "$45.00 – $12000.00". The
   spreadsheet was right — it keeps the shop's own characters — so nothing
   between the scrape and the chart had any reason to complain.

   Run: node tests/price-test.js */
const path = require("path");
global.self = global;
const Calc = require(path.join(__dirname, "..", "report/report.js"));
let pass = 0, fail = 0;
const eq = (label, got, want) => {
  if (got === want) { pass++; console.log("  ok  " + label); }
  else { fail++; console.log(`FAIL  ${label}\n      got ${got}, wanted ${want}`); }
};

// plain
eq("$45.00", Calc.parsePrice("$45.00"), 45);
eq("45", Calc.parsePrice("45"), 45);
eq("£58.00", Calc.parsePrice("£58.00"), 58);
eq("A$89.00 keeps its number", Calc.parsePrice("A$89.00"), 89);
eq("CHF 89.00", Calc.parsePrice("CHF 89.00"), 89);

// comma as the decimal point — the one that was broken
eq("120,00 € is a hundred and twenty", Calc.parsePrice("120,00 €"), 120);
eq("89,5 kr", Calc.parsePrice("89,5 kr"), 89.5);
eq("29,99 zł", Calc.parsePrice("29,99 zł"), 29.99);

// comma as a thousands separator
eq("$1,299", Calc.parsePrice("$1,299"), 1299);
eq("$1,299.00", Calc.parsePrice("$1,299.00"), 1299);
eq("12,345,678", Calc.parsePrice("12,345,678"), 12345678);

// both marks: the last one is the decimal point
eq("1.299,00 €", Calc.parsePrice("1.299,00 €"), 1299);
eq("1,299.50", Calc.parsePrice("1,299.50"), 1299.5);

// nothing to read
eq("empty", Calc.parsePrice(""), null);
eq("null", Calc.parsePrice(null), null);
eq("no digits", Calc.parsePrice("Sold out"), null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
