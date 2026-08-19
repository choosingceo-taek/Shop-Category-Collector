/* A week is a week, not the days it was worked in.

   The team scans on Monday and again on Wednesday when a shop is added or one
   comes back. The feed used to split what came in by the day it happened to be
   collected, so the same brand appeared under two headings and one week of a
   season read as two half-weeks of work. The designer asked for the week
   itself — Monday to Sunday, named the way the record names it (2026-W34),
   with nothing counted twice.

   Nothing needs deduplicating by hand: a product is one row keyed by its
   address, so a second pass over the same page updates that row rather than
   adding another, and `addedAt` stays the first sighting — which is what puts
   it in one week and no other. This checks that it really behaves that way.

   Run: NODE_PATH=/opt/node22/lib/node_modules xvfb-run -a node weekbucket-e2e.js */
"use strict";
const { chromium } = require("playwright");
const path = require("path");
const EXT = path.resolve(__dirname, "..");

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log("  ok  " + n); } else { fail++; console.log("FAIL  " + n + (x ? "\n      " + x : "")); } };

const DAY = 86400000;
// the week that has finished, so every hour of it is in the past
const monday = (() => {
  const d = new Date(Date.now() - 7 * DAY);
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return day.getTime() - ((day.getDay() + 6) % 7) * DAY;
})();
const prevMonday = monday - 7 * DAY;

const mk = (n, when, brand) => ({
  url: `https://x.example.com/p/${n}`, product_url: `https://x.example.com/p/${n}`,
  brand, category: "New In", name: `${brand} ${n}`, price: "$50", image_url: "",
  colorways: "Black", fabric_composition: "100% Cotton", pos: n,
  addedAt: when, listIds: ["l0"],
});
/* One week, three sittings: Monday, Wednesday, Sunday — and one product from
   the week before, which must NOT join them. */
const items = [
  mk(1, monday + 9 * 3600e3, "ALO"),
  mk(2, monday + 9 * 3600e3, "ALO"),
  mk(3, monday + 2 * DAY + 10 * 3600e3, "COS"),
  mk(4, monday + 2 * DAY + 10 * 3600e3, "ALO"),
  mk(5, monday + 6 * DAY + 20 * 3600e3, "COS"),
  mk(6, prevMonday + DAY, "ALO"),
];
const THIS_WEEK = 5;

(async () => {
  const ctx = await chromium.launchPersistentContext("/tmp/pw-weekbucket", {
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
  await p.evaluate(rows => CatalogStore.putScan({ meta: { scanId: "wb" }, items: rows }), items);
  // putScan stamps its own dates, so the sittings are written in afterwards
  await p.evaluate(rows => new Promise(async res => {
    const db = await CatalogStore.open();
    const t = db.transaction("products", "readwrite");
    const P = t.objectStore("products");
    const q = P.getAll();
    q.onsuccess = () => q.result.forEach(r => {
      const src = rows.find(x => x.product_url === r.product_url);
      if (src) { r.addedAt = src.addedAt; P.put(r); }
    });
    t.oncomplete = res; t.onerror = res;
  }), items);
  await p.reload();
  await p.waitForTimeout(2600);

  await p.click('.tab[data-view="new"]');
  await p.waitForTimeout(1200);

  /* No picker anywhere — it was taken off the header (asked for) and nothing
     replaced it. The feed runs down every week it has, each pile introduced by
     the days it covers, so both weeks are on the screen at once. */
  const wk = await p.evaluate(() => ({
    picker: document.querySelectorAll("#wkstrip, #wknow, .weekchips").length,
    heads: [...document.querySelectorAll("#v-new .wkhead")].map(e => (e.textContent || "").trim()),
  }));
  ok("there is no week picker", wk.picker === 0, JSON.stringify(wk));
  ok("…and both weeks are on the screen, one heading each",
    wk.heads.length === 2, JSON.stringify(wk.heads));
  ok("…named by the days they cover, not by a W-number",
    wk.heads.every(t => /^[A-Z][a-z]{2} \d{1,2} – [A-Z][a-z]{2} \d{1,2}$/.test(t)),
    JSON.stringify(wk.heads));

  const view = await p.evaluate(() => {
    const el = document.querySelector("#v-new");
    return {
      days: el.querySelectorAll(".dayhead").length,
      brandHeads: [...el.querySelectorAll(".brandsec")].map(e => (e.textContent || "").trim()),
      cards: [...el.querySelectorAll(".grid .c")].map(c =>
        ((c.textContent || "").match(/(ALO|COS) \d/) || [""])[0]),
      // the cards under the FIRST week heading — everything up to the next one
      firstWeek: (() => {
        const out = [];
        let on = false;
        for (const n of el.children) {
          if (n.classList.contains("wkhead")) { if (on) break; on = true; continue; }
          if (!on) continue;
          n.querySelectorAll(".c").forEach(c =>
            out.push(((c.textContent || "").match(/(ALO|COS) \d/) || [""])[0]));
        }
        return out;
      })(),
      kicker: (el.querySelector(".kicker") || {}).textContent || "",
    };
  });
  ok("no day headings inside the week", view.days === 0, `${view.days} day headings`);
  ok("Monday's and Wednesday's and Sunday's work are one pile",
    view.firstWeek.length === THIS_WEEK,
    `${view.firstWeek.length} cards under the newest week, expected ${THIS_WEEK}`);
  ok("…and last week's product is under its own heading, not in it",
    !view.firstWeek.includes("ALO 6") && view.cards.includes("ALO 6"),
    JSON.stringify(view.firstWeek) + " | all: " + JSON.stringify(view.cards));
  ok("one brand, one heading inside a week — no matter which day it was collected",
    view.brandHeads.length === 3, JSON.stringify(view.brandHeads));
  ok("the date is not repeated above the title", !view.kicker.trim(), view.kicker);

  /* Scanning the same page again inside the same week adds nothing: same
     address, same row, first sighting kept. */
  await p.evaluate(rows => CatalogStore.putScan({ meta: { scanId: "wb2" },
    items: rows.map(r => Object.assign({}, r, { price: "$45" })) }), items);
  await p.reload();
  await p.waitForTimeout(2400);
  await p.click('.tab[data-view="new"]');
  await p.waitForTimeout(1200);
  const again = await p.evaluate(() => ({
    cards: document.querySelectorAll("#v-new .grid .c").length,
    heads: document.querySelectorAll("#v-new .wkhead").length,
  }));
  ok("a second pass over the same page does not duplicate anything",
    again.cards === THIS_WEEK + 1, `${again.cards} cards, expected ${THIS_WEEK + 1}`);
  ok("…and does not open a new week",
    again.heads === 2, String(again.heads));

  ok("no page errors", errs.length === 0, errs.join(" | "));
  console.log(`\n${pass} passed, ${fail} failed`);
  await ctx.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log("HARNESS ERROR: " + (e && e.message || e)); process.exit(1); });
