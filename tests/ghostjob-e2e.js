/* A scan that is not running must not look like one — and must not block ▶.

   Reported with a screenshot: the panel sits on "Starting…" with the gauge
   filling, ▶ greyed out, and pressing STOP changes nothing.

   Two records make that screen, and both could get stuck:

     · the JOB — one address being scanned. It writes the "Starting…" line, the
       gauge, and it disables ▶. The queue was given a heartbeat in v3.37.0 for
       exactly this reason and the job was left trusting its own flag, so a job
       that stopped writing held the screen for ever.
     · and a job left behind by an earlier run made bootQueue step aside from
       the NEXT run — correctly, since two scans in one tab would fight — so ▶
       wrote a queue and nothing started. STOP could not help: STOP is what had
       failed to close the job in the first place (its branch read a field that
       moved to IndexedDB in v1.82.0).

   Run: NODE_PATH=/opt/node22/lib/node_modules xvfb-run -a node ghostjob-e2e.js */
"use strict";
const { chromium } = require("playwright");
const path = require("path");
const { execSync } = require("child_process");
const EXT = path.resolve(__dirname, "..");

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log("  ok  " + n); } else { fail++; console.log("FAIL  " + n + (x ? "\n      " + x : "")); } };

const LISTS = [{ id: "G", name: "ACTIVE", createdAt: 1, entries: [
  { brand: "ALO YOGA", label: "new arrivals", scannable: true, url: "https://www.aloyoga.com/collections/new" },
] }];

const ui = p => p.evaluate(() => ({
  live: (document.querySelector("#livetext").textContent || "").trim(),
  gauge: document.querySelector("#live").classList.contains("on"),
  run: !!document.querySelector("#runlist").disabled,
  hold: !!document.querySelector("#jpause").disabled,
  stop: !!document.querySelector("#jreset").disabled,
}));

(async () => {
  execSync("rm -rf /tmp/pw-ghost");
  const ctx = await chromium.launchPersistentContext("/tmp/pw-ghost", {
    executablePath: "/opt/pw-browsers/chromium", headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-sandbox"] });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker");
  const id = sw.url().split("/")[2];
  const p = await ctx.newPage();
  await p.setViewportSize({ width: 400, height: 900 });
  const errs = []; p.on("pageerror", e => errs.push(e.message));

  /* The screen in the report: a job that says it is starting and stopped
     writing five minutes ago. */
  await p.goto(`chrome-extension://${id}/sidepanel.html`);
  await p.waitForTimeout(1000);
  await p.evaluate(ls => new Promise(r => chrome.storage.local.set({
    wpb_autoupdate: false, wpb_lists: ls,
    wpb_job: { active: true, paused: false, status: "Starting…", phase: "list",
      items: [], tabId: 999, at: Date.now() - 5 * 60 * 1000 },
    wpb_queue: { active: true, idx: 0, rowCount: 0, tabId: 999, listId: "G",
      name: "ACTIVE", list: [{ url: "https://www.aloyoga.com/collections/new" }],
      startedAt: Date.now() - 6 * 60 * 1000, at: Date.now() - 5 * 60 * 1000 },
  }, r)), LISTS);
  await p.reload();
  await p.waitForTimeout(1500);

  const stale = await ui(p);
  console.log("    " + JSON.stringify(stale));
  ok("a scan that stopped writing five minutes ago is not shown as running",
    stale.live === "" && !stale.gauge, JSON.stringify(stale));
  ok("…and ▶ is awake again, so a new run is one press away",
    stale.run === false, JSON.stringify(stale));

  /* A job that IS writing must still hold the screen — the heartbeat must not
     throw away a real scan. */
  await p.evaluate(() => new Promise(r => chrome.storage.local.set({
    wpb_job: { active: true, paused: false, status: "Starting…", phase: "list",
      items: [], tabId: 999, at: Date.now() },
  }, r)));
  await p.waitForTimeout(600);
  const fresh = await ui(p);
  ok("a scan that is writing still shows as running",
    fresh.live === "Starting…" && fresh.gauge, JSON.stringify(fresh));
  ok("…with ▶ asleep and hold and stop awake",
    fresh.run === true && fresh.hold === false && fresh.stop === false, JSON.stringify(fresh));

  /* And a held run is not a stalled one, however long it is held. */
  await p.evaluate(() => new Promise(r => chrome.storage.local.set({
    wpb_job: { active: true, paused: true, status: "Paused (resumable)", phase: "list",
      items: [], tabId: 999, at: Date.now() - 30 * 60 * 1000 },
  }, r)));
  await p.waitForTimeout(600);
  const held = await ui(p);
  ok("a run held on purpose stays held, however long",
    held.live === "Paused (resumable)", JSON.stringify(held));

  ok("no page errors", errs.length === 0, errs.join(" | "));
  console.log(`\n${pass} passed, ${fail} failed`);
  await ctx.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log("HARNESS ERROR: " + (e && e.message || e)); process.exit(1); });
