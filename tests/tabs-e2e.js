/* The panel's furniture, measured on screen rather than argued about.

   Three reports, all of them things a screenshot showed and no test did:

     1. With enough lists the ＋ printed ON TOP of a tab name. The whole head
        scrolled, so the button travelled with the strip and came to rest
        under the last tab. A browser pins its new-tab button for the same
        reason: it is the only way to make another one, so it can never be
        the thing that gets pushed away.
     2. "Filter sites" was a second box to type into on a 350px row, for a
        search on a list of a dozen folded brands.
     3. In PRODUCTS the search box and the BRAND / CATEGORY selects scrolled
        away with the first row of photographs — so what you were looking at
        stopped being readable exactly when the wall of images started.

   Run: cd tests && NODE_PATH=/opt/node22/lib/node_modules xvfb-run -a node tabs-e2e.js
*/
"use strict";
const { chromium } = require("playwright");
const EXT = "/home/user/Fabric-Scanner";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  cond ? pass++ : fail++;
  if (!cond) console.log(`  FAIL ${name}${extra ? "\n       " + extra : ""}`);
};

const lists = ["FABRIC", "ACTIVE", "SLEEP", "1", "2", "3", "4"].map((name, i) => ({
  id: "l" + i, name, createdAt: i + 1,
  entries: [{ brand: name, label: "New In", url: `https://www.example${i}.com/new` }],
}));

const products = Array.from({ length: 24 }, (_, i) => ({
  url: `https://www.example.com/p/${i}`,
  brand: "WEARETALA", category: "New In", name: "Item " + i,
  price: "$40", image_url: "", addedAt: Date.now(), listIds: ["l0"],
}));

(async () => {
  const ctx = await chromium.launchPersistentContext("/tmp/pw-tabs", {
    executablePath: "/opt/pw-browsers/chromium", headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-sandbox"],
  });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker");
  const id = sw.url().split("/")[2];
  const p = await ctx.newPage();
  await p.setViewportSize({ width: 350, height: 800 });
  const errs = [];
  p.on("pageerror", e => errs.push(e.message));
  await p.goto(`chrome-extension://${id}/sidepanel.html`);
  await p.waitForTimeout(1200);
  await p.evaluate(l => new Promise(r => chrome.storage.local.set({ wpb_lists: l }, r)), lists);
  await p.evaluate(rows => CatalogStore.putScan({ meta: { scanId: "t1" }, items: rows }), products);
  await p.reload();
  await p.waitForTimeout(1800);

  /* ---- 1. the ＋ is beside the tabs, never on top of one ---- */
  const geo = await p.evaluate(() => {
    const strip = document.querySelector("#lchips");
    const add = document.querySelector("#newlist");
    const head = document.querySelector(".lhead");
    const r = e => { const b = e.getBoundingClientRect(); return { l: b.left, r: b.right, w: b.width, t: b.top }; };
    /* A tab inside a scroller keeps its full box even where the scroller
       clips it, so what matters is the part still on screen: the rect
       intersected with the strip's own frame. */
    const sb = strip.getBoundingClientRect();
    const tabs = [...strip.querySelectorAll("button[data-id]")].map(b => {
      const q = b.getBoundingClientRect();
      return { name: b.textContent.trim(), l: Math.max(q.left, sb.left), r: Math.min(q.right, sb.right) };
    }).filter(t => t.r > t.l);
    return {
      strip: r(strip), add: r(add), head: r(head), tabs,
      scrolls: strip.scrollWidth > strip.clientWidth + 1,
      headScrolls: head.scrollWidth > head.clientWidth + 1,
      vw: document.documentElement.clientWidth,
    };
  });
  ok("the tab strip has more tabs than fit", geo.scrolls,
    `strip does not overflow — the overlap case is not being exercised`);
  ok("＋ starts where the tabs end", geo.add.l >= geo.strip.r - 1,
    `＋ left ${geo.add.l.toFixed(1)} vs strip right ${geo.strip.r.toFixed(1)}`);
  ok("＋ is inside the panel", geo.add.r <= geo.vw + 1,
    `＋ right ${geo.add.r.toFixed(1)} vs panel ${geo.vw}`);
  const over = geo.tabs.filter(t => t.r > geo.add.l + 1 && t.l < geo.add.r - 1);
  ok("no tab is printed under the ＋", over.length === 0,
    over.map(t => `"${t.name}" ${t.l.toFixed(0)}–${t.r.toFixed(0)}`).join(", "));
  ok("the head itself does not scroll", !geo.headScrolls);

  /* the ＋ stays put when the strip is scrolled to its end */
  const after = await p.evaluate(() => {
    const strip = document.querySelector("#lchips");
    strip.scrollLeft = strip.scrollWidth;
    const a = document.querySelector("#newlist").getBoundingClientRect();
    const s = strip.getBoundingClientRect();
    const tabs = [...strip.querySelectorAll("button[data-id]")]
      .map(b => b.getBoundingClientRect())
      .filter(t => Math.min(t.right, s.right) > Math.max(t.left, s.left));
    return {
      al: a.left, ar: a.right, sr: s.right,
      over: tabs.filter(t => Math.min(t.right, s.right) > a.left + 1).length,
    };
  });
  ok("＋ does not move when the tabs are scrolled", after.al >= after.sr - 1,
    `＋ left ${after.al.toFixed(1)} vs strip right ${after.sr.toFixed(1)}`);
  ok("still nothing under it at the end of the strip", after.over === 0);

  /* ---- 2. no Filter sites box ---- */
  const filt = await p.evaluate(() => {
    const q = document.querySelector("#lq");
    const vis = q && q.getBoundingClientRect().height > 0;
    const anyPlaceholder = [...document.querySelectorAll("input")]
      .some(i => /filter sites/i.test(i.placeholder || "") && i.getBoundingClientRect().height > 0);
    return { vis: !!vis, anyPlaceholder, value: q ? q.value : null };
  });
  ok("the list filter is not drawn", !filt.vis);
  ok('nothing says "Filter sites"', !filt.anyPlaceholder);
  ok("the field is still there and empty, so the render can read it", filt.value === "");

  /* ---- 3. PRODUCTS keeps its search and its two selects in view ---- */
  await p.click('.tab[data-view="products"]').catch(() => {});
  await p.waitForTimeout(700);
  const before = await p.evaluate(() => {
    const f = document.querySelector("#v-products .filters").getBoundingClientRect();
    return { top: f.top, cards: document.querySelectorAll("#pgrid .pc").length };
  });
  ok("there are enough products to scroll past", before.cards >= 10, `${before.cards} cards`);
  const stuck = await p.evaluate(async () => {
    const v = document.querySelector("#v-products");
    v.scrollTop = 900;
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const f = document.querySelector("#v-products .filters").getBoundingClientRect();
    const vr = v.getBoundingClientRect();
    const box = document.querySelector("#psearch").getBoundingClientRect();
    const b = document.querySelector("#pbrand").getBoundingClientRect();
    const c = document.querySelector("#pcat").getBoundingClientRect();
    return {
      scrolled: v.scrollTop, ftop: f.top, vtop: vr.top,
      search: box.top >= vr.top && box.bottom <= vr.bottom,
      brand: b.top >= vr.top && b.bottom <= vr.bottom,
      cat: c.top >= vr.top && c.bottom <= vr.bottom,
      opaque: getComputedStyle(document.querySelector("#v-products .filters")).backgroundColor,
    };
  });
  ok("the view really scrolled", stuck.scrolled > 100, `scrollTop ${stuck.scrolled}`);
  ok("the filter block is pinned to the top of the view",
    Math.abs(stuck.ftop - stuck.vtop) < 2, `filters ${stuck.ftop.toFixed(1)} vs view ${stuck.vtop.toFixed(1)}`);
  ok("the search box is still on screen", stuck.search);
  ok("BRAND is still on screen", stuck.brand);
  ok("CATEGORY is still on screen", stuck.cat);
  ok("it is opaque, so photographs do not show through",
    stuck.opaque !== "rgba(0, 0, 0, 0)" && stuck.opaque !== "transparent", stuck.opaque);

  /* ---- 3b. PRODUCTS shows the list that is open in COLLECTOR --------------

     The scoping existed and had almost no way in: only a "View" button in the
     box a finished run leaves behind. So the product wall was the whole
     catalog, and someone looking at one research question saw every other one
     mixed into it. */
  const scope = await p.evaluate(() => {
    const b = document.querySelector("#scopebar");
    return {
      shown: !!b && !b.hidden,
      text: (document.querySelector("#scopetext").textContent || "").trim(),
      cards: document.querySelectorAll("#pgrid .pc").length,
    };
  });
  ok("the wall says which list it is showing", scope.shown && /FABRIC/.test(scope.text),
    scope.text);
  ok("…and that is the list the products belong to", scope.cards >= 10,
    `${scope.cards} cards`);

  // switching the list in COLLECTOR moves the wall with it
  await p.click('.tab[data-view="collector"]');
  await p.waitForTimeout(400);
  await p.evaluate(() => {
    const sel = document.querySelector("#listsel");
    sel.value = "l1";                              // ACTIVE — nothing collected
    sel.dispatchEvent(new Event("change"));
  });
  await p.click('.tab[data-view="products"]');
  await p.waitForTimeout(700);
  const moved = await p.evaluate(() => ({
    text: (document.querySelector("#scopetext").textContent || "").trim(),
    cards: document.querySelectorAll("#pgrid .pc").length,
  }));
  ok("choosing another list moves the wall to it", /ACTIVE/.test(moved.text), moved.text);
  ok("…and an empty list really is empty", moved.cards === 0, `${moved.cards} cards`);

  // and there is a way to see everything
  await p.click("#scopeclear");
  await p.waitForTimeout(600);
  const all = await p.evaluate(() => ({
    text: (document.querySelector("#scopetext").textContent || "").trim(),
    cards: document.querySelectorAll("#pgrid .pc").length,
  }));
  ok("one press steps out to every list", /All lists/i.test(all.text), all.text);
  ok("…which brings the other list's products back", all.cards >= 10, `${all.cards} cards`);
  await p.click("#scopeclear");
  await p.waitForTimeout(600);
  ok("and one press goes back to the open list",
    /ACTIVE/.test((await p.locator("#scopetext").innerText()).trim()),
    (await p.locator("#scopetext").innerText()).trim());

  /* ---- 4. the run bar is marks only, and every mark carries its weight ----

     A bare glyph has to say the whole thing, so the floor is measured rather
     than guessed: the transport marks cover 12.7–16.9% of their box and the
     download glyph that never painted its stem covered 9.4%. 12% sits
     between them (tests/glyph-probe.js). */
  await p.click('.tab[data-view="collector"]').catch(() => {});
  await p.waitForTimeout(400);
  const bar = await p.evaluate(async () => {
    const btns = [...document.querySelectorAll(".runrow .rbtn")];
    const ink = async svg => {
      const src = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="96" height="96">${svg.innerHTML}</svg>`;
      const img = new Image();
      img.src = "data:image/svg+xml;base64," + btoa(src);
      await img.decode();
      const c = document.createElement("canvas");
      c.width = c.height = 96;
      const g = c.getContext("2d");
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, 96, 96).data;
      let on = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 40) on++;
      return (on / 9216) * 100;
    };
    const out = [];
    for (const b of btns) {
      const svg = b.querySelector("svg");
      out.push({
        id: b.id,
        text: (b.textContent || "").replace(/\s+/g, ""),
        title: b.getAttribute("title") || "",
        label: b.getAttribute("aria-label") || "",
        h: b.getBoundingClientRect().height,
        marks: svg ? 1 : 0,
        ink: svg ? await ink(svg) : 0,
      });
    }
    return out;
  });
  ok("all four run controls are there", bar.length === 4, `${bar.length}`);
  bar.forEach(b => {
    ok(`${b.id}: no word on it`, b.text === "", JSON.stringify(b.text));
    ok(`${b.id}: has a mark`, b.marks === 1);
    ok(`${b.id}: keeps its name on hover`, b.title.length > 3, b.title);
    ok(`${b.id}: keeps its name for a screen reader`, b.label.length > 1, b.label);
    ok(`${b.id}: still a target you can hit`, b.h >= 44, `${b.h.toFixed(0)}px`);
    ok(`${b.id}: the mark actually paints`, b.ink >= 12, `${b.ink.toFixed(1)}% of its box`);
  });

  /* ---- 4b. one site can be scanned again on its own ----------------------

     ▶ walks the whole list, and a designer re-scans for a reason: one shop
     changed, one came back short, one was fixed. Re-walking twelve to see one
     of them is the afternoon. The row carries its own ↻ and hands the same
     machinery an array of one — the run still belongs to the LIST, so the rows
     land under the same listIds and nothing downstream knows the difference. */
  await p.click('.tab[data-view="collector"]');
  await p.waitForTimeout(500);
  await p.evaluate(() => {
    const sel = document.querySelector("#listsel");
    sel.value = "l0";
    sel.dispatchEvent(new Event("change"));
  });
  await p.waitForTimeout(600);

  const tools = await p.evaluate(() => {
    const rows = [...document.querySelectorAll("#listbody .ent")];
    return {
      rows: rows.length,
      withRerun: rows.filter(r => r.querySelector(".run")).length,
      order: rows[0] ? [...rows[0].querySelectorAll(".act")].map(b => b.textContent.trim()) : [],
      overflows: rows.some(r => r.scrollWidth > r.clientWidth + 1),
    };
  });
  ok("every site in the list carries a rerun", tools.rows > 0 && tools.withRerun === tools.rows,
    `${tools.withRerun} of ${tools.rows}`);
  ok("it leads the row's tools", tools.order[0] === "↻", tools.order.join(" "));
  ok("and the row still fits at panel width", !tools.overflows);

  /* What it actually sends. The tab and the message are stubbed because the
     fixture shops are not reachable from here — what is under test is that
     the run is given ONE entry and still belongs to the list. */
  await p.evaluate(() => {
    window.__sent = [];
    window.__opened = "";
    chrome.tabs.create = async o => { window.__opened = o.url; return { id: 4242 }; };
    chrome.tabs.sendMessage = (id, msg, cb) => { window.__sent.push(msg); if (cb) cb({ ok: true }); };
    chrome.permissions.request = (o, cb) => { if (cb) cb(true); };
  });
  await p.click("#listbody .ent .run");
  await p.waitForTimeout(3000);
  const sent = await p.evaluate(() => ({
    opened: window.__opened,
    msgs: window.__sent.map(m => ({ type: m.type, listId: m.listId, n: (m.list || []).length,
      urls: (m.list || []).map(e => e.url) })),
  }));
  const run = sent.msgs.find(m => m.type === "runList");
  ok("pressing it starts a run", !!run, JSON.stringify(sent.msgs));
  ok("…of exactly one site", run && run.n === 1, run && String(run.n));
  ok("…the one that was pressed", run && /example0\.com/.test(run.urls[0] || ""), run && run.urls[0]);
  ok("…opened at that site", /example0\.com/.test(sent.opened), sent.opened);
  ok("…and it still belongs to the list", run && run.listId === "l0", run && run.listId);

  /* Two runs share one queue, so the second one would scramble the first.
     A live run is one that has written something recently — every write on the
     path stamps `at`, which is what makes "running" a fact rather than a flag
     nobody ever clears. */
  await p.evaluate(() => new Promise(r =>
    chrome.storage.local.set({ wpb_queue: { active: true, idx: 0, listId: "l0",
      list: [{ brand: "FABRIC", label: "New In", url: "https://www.example0.com/new" }],
      at: Date.now() } }, r)));
  await p.evaluate(() => { window.__sent = []; });
  await p.click("#listbody .ent .run");
  await p.waitForTimeout(2500);
  const during = await p.evaluate(() => window.__sent.length);
  ok("it refuses while a scan is already running", during === 0, `${during} messages`);

  /* ---- 4b. a run that stopped writing is over, whatever the flag says ----

     `active` survives a closed tab, a quit browser and a shop that hangs, and
     the panel believed it on its own: ▶ stayed asleep, the progress line
     stayed up, and — because the index kept the position it died at — it read
     "20/11 ·", the twentieth of eleven sites, with no name after it. Four
     quiet minutes is the same reading the worker's watchdog takes. */
  const stale = await p.evaluate(async () => {
    await new Promise(r => chrome.storage.local.set({ wpb_queue: {
      active: true, idx: 19, listId: "l0",
      list: Array.from({ length: 11 }, (_, i) => ({ brand: "B" + i, label: "New In",
        url: `https://www.example${i}.com/new` })),
      at: Date.now() - 31 * 60 * 1000 } }, r));
    await new Promise(r => setTimeout(r, 1200));
    const q = document.querySelector("#qstate");
    return { hidden: q.hidden, text: (q.textContent || "").trim(),
      runDisabled: document.querySelector("#runlist").disabled };
  });
  ok("a run gone quiet for half an hour is not shown as running", stale.hidden,
    JSON.stringify(stale));
  ok("…and ▶ is awake again", stale.runDisabled === false, JSON.stringify(stale));
  ok("…so no impossible position is printed", !/20\s*\/\s*11/.test(stale.text),
    JSON.stringify(stale));

  /* The counter itself: past the end of the list there is no site to name. */
  const overrun = await p.evaluate(async () => {
    await new Promise(r => chrome.storage.local.set({ wpb_queue: {
      active: true, idx: 19, listId: "l0",
      list: Array.from({ length: 11 }, (_, i) => ({ brand: "B" + i, label: "New In",
        url: `https://www.example${i}.com/new` })),
      at: Date.now() } }, r));
    await new Promise(r => setTimeout(r, 1200));
    const q = document.querySelector("#qstate");
    return { hidden: q.hidden, text: (q.textContent || "").trim() };
  });
  ok("a live run past the end of its list says so in words", !overrun.hidden &&
    /finishing/i.test(overrun.text) && !/20\s*\/\s*11/.test(overrun.text),
    JSON.stringify(overrun));

  await p.evaluate(() => new Promise(r => chrome.storage.local.remove("wpb_queue", r)));
  await p.waitForTimeout(600);

  /* ---- 5. the grab button carries no count ---- */
  const fab = await p.evaluate(async () => {
    // A <script src> of the extension's own file — the page's CSP allows
    // 'self' and nothing else, so this is the only way to run it here.
    await new Promise(r => {
      const s = document.createElement("script");
      s.src = chrome.runtime.getURL("fab.js");
      s.onload = r; s.onerror = r;
      document.head.appendChild(s);
    });
    await new Promise(r => setTimeout(r, 600));
    const h = document.getElementById("wpb-fab-host");
    if (!h || !h.shadowRoot) return { mounted: false };
    const sr = h.shadowRoot;
    const badge = sr.getElementById("count");
    const btn = sr.getElementById("fab");
    /* The "+1" that flies off a chip lives on the button too, but it is only
       ever on screen for the moment after a grab. What must not be there is a
       figure standing on the button at rest. */
    const showing = [...(btn ? btn.querySelectorAll("*") : [])].filter(n => {
      const cs = getComputedStyle(n);
      return /\d/.test(n.textContent || "") &&
        cs.display !== "none" && cs.visibility !== "hidden" && parseFloat(cs.opacity) > 0.05;
    }).map(n => n.textContent.trim());
    return { mounted: true, badge: !!badge, showing };
  });
  ok("the grab button mounted", fab.mounted);
  ok("no count badge on it", fab.mounted && !fab.badge);
  ok("no number standing on it at rest", fab.mounted && !fab.showing.length,
    (fab.showing || []).join(", "));

  ok("no page errors", errs.length === 0, errs.join("\n       "));
  console.log(`\n${pass} passed, ${fail} failed`);
  await ctx.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log("HARNESS " + e.message); process.exit(1); });
