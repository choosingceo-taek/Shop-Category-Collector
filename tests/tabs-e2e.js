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

  /* ---- 4. the grab button carries no count ---- */
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
