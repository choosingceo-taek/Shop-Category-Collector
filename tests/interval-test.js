/* The four intervals the LAB offers must each bucket the same products.

   Asked for: Monthly, Biweekly, Weekly, Daily. A control that offers a choice
   the arithmetic cannot bucket is a control that does nothing.

   The one with a trap is the FORTNIGHT. Pairing weeks off "now" would re-cut
   every bucket each time the page opened — the same product would fall in a
   different fortnight depending on the day you looked — so the pairing counts
   from a fixed Monday and the boundaries never move.

   Run: node tests/interval-test.js */
"use strict";
const path = require("path");
const T = require(path.resolve(__dirname, "..", "report", "trend.js"));

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log("  ok  " + n); } else { fail++; console.log("FAIL  " + n + (x ? "\n      " + x : "")); } };
const at = (y, m, d, h) => new Date(y, m - 1, d, h || 12).getTime();
const ymd = ts => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; };

ok("the page's four intervals are named by the maths, not the markup",
  T.GRANULARITIES.map(g => g.value).join(",") === "month,fortnight,week,day",
  JSON.stringify(T.GRANULARITIES));
ok("…and each one is spelled the way the screen says it",
  T.GRANULARITIES.map(g => g.label).join(",") === "Monthly,Biweekly,Weekly,Daily");

// ---- where each interval puts one Wednesday -------------------------------
const wed = at(2026, 8, 19);                 // Wednesday 19 Aug 2026
ok("a day starts at midnight that day", ymd(T.bucketStart(wed, "day")) === "2026-08-19");
ok("a week starts on its Monday", ymd(T.bucketStart(wed, "week")) === "2026-08-17");
ok("a month starts on the 1st", ymd(T.bucketStart(wed, "month")) === "2026-08-01");

// ---- the fortnight, which is the one that can drift -----------------------
const f = ts => ymd(T.bucketStart(ts, "fortnight"));
ok("a fortnight starts on a Monday", new Date(T.bucketStart(wed, "fortnight")).getDay() === 1,
  f(wed));
/* 2026-08-10 is 136 whole weeks after the anchor — even, so it opens a
   fortnight, and the Monday after it (08-17, week 137) belongs to the same
   one. Checked by hand rather than assumed; the first version of this test
   guessed 08-17 and was wrong about which Monday starts the pair. */
ok("…and it is the fortnight the anchor's pairing actually gives",
  f(wed) === "2026-08-10", f(wed));
ok("…every day of those two weeks lands in the SAME fortnight",
  new Set([at(2026,8,10), at(2026,8,16), at(2026,8,17), at(2026,8,19),
    at(2026,8,23)].map(f)).size === 1,
  JSON.stringify([at(2026,8,10), at(2026,8,23)].map(f)));
ok("…while the Monday after those two weeks opens a new one",
  f(at(2026, 8, 24)) === "2026-08-24", f(at(2026,8,24)));
ok("…and the boundary does not move with the year",
  f(at(2024, 1, 1)) === "2024-01-01" && f(at(2024, 1, 14)) === "2024-01-01",
  f(at(2024,1,1)) + " / " + f(at(2024,1,14)));
ok("…nor before the anchor", f(at(2023, 12, 25)) === "2023-12-18", f(at(2023,12,25)));

// ---- the timeline itself ---------------------------------------------------
const now = at(2026, 8, 19, 23);
const items = Array.from({ length: 40 }, (_, i) => ({
  addedAt: now - i * 3 * 864e5, brand: "B", name: "Linen Tee", fabric_composition: "100% Linen",
}));
const counts = {};
["month", "fortnight", "week", "day"].forEach(g => {
  const tl = T.timeline(items, { months: 3, granularity: g, now });
  const from = tl[0].start, to = tl[tl.length - 1].end;
  counts[g] = { buckets: tl.length, filed: tl.reduce((a, b) => a + b.count, 0),
    inWindow: items.filter(i => i.addedAt >= from && i.addedAt < to).length };
});
/* Not "every interval files the same number" — the windows genuinely differ,
   because each one starts where ITS buckets start (a month window opens on the
   1st, a day window on that day). What must hold is that nothing inside an
   interval's own window is dropped on the floor between its buckets. */
ok("nothing inside an interval's own window goes unfiled",
  Object.values(counts).every(c => c.filed === c.inWindow), JSON.stringify(counts));
ok("…and finer intervals make more buckets, in order",
  counts.month.buckets < counts.fortnight.buckets &&
  counts.fortnight.buckets < counts.week.buckets &&
  counts.week.buckets < counts.day.buckets, JSON.stringify(counts));
ok("a fortnight is about half the buckets of a week",
  Math.abs(counts.week.buckets - counts.fortnight.buckets * 2) <= 2, JSON.stringify(counts));
ok("no bucket overlaps the next", (() => {
  return ["month", "fortnight", "week", "day"].every(g => {
    const tl = T.timeline(items, { months: 3, granularity: g, now });
    return tl.every((b, i) => i === 0 || tl[i - 1].end === b.start);
  });
})());
ok("a year of days is not silently truncated",
  T.timeline(items, { months: 12, granularity: "day", now }).length > 360,
  String(T.timeline(items, { months: 12, granularity: "day", now }).length));

// ---- the word for one bucket ----------------------------------------------
ok("the axis calls a bucket what it is",
  ["month", "fortnight", "week", "day"].map(T.unitName).join(",") === "month,fortnight,week,day");
ok("…and an interval it does not know reads as a week", T.unitName("wat") === "week");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
