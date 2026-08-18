/* Two things a screenshot showed and no assertion did.

   1. The panel had been squeezed one size at a time — 8.5px marks, 9.5px
      brand names, 10.5px notes — until it read as fine print beside a browser
      at full size. So there is a floor now, measured on real computed styles
      of things actually on screen, and the rows a designer reads are held
      well above it.

   2. The lists were chips floating over a summary line over the sites, and
      nothing in that stack said the sites BELONG to the lit chip. They are
      browser tabs now (user request, pointing at Chrome's own strip): the open
      one carries the card's white, its bottom edge is missing, and what is
      under it is simply what is inside it. That is a structural claim, so it
      is measured structurally — same background, no line between — rather than
      by looking for a class name.

   Run: NODE_PATH=/opt/node22/lib/node_modules xvfb-run -a node panelread-e2e.js */
const { chromium } = require("playwright");
const EXT = require("path").resolve(__dirname, "..");
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log("  ok  " + n); } else { fail++; console.log("FAIL  " + n + (x ? "\n      " + x : "")); } };

const ent = (b, l, h) => ({ brand: b, label: l, url: `https://${h}/c/${l.toLowerCase().replace(/\W+/g, "-")}` });
const ENTRIES = [
  ent("ALO YOGA", "new arrivals", "aloyoga.com"),
  ent("LULULEMON", "Women New Styles", "shop.lululemon.com"),
  ent("VUORI", "womens new", "vuoriclothing.com"),
  ent("Aritzia", "New Arrivals", "www.aritzia.com"),
  ent("Aritzia", "Sweatshirts & Hoodies", "www.aritzia.com"),
];

(async () => {
  const ctx = await chromium.launchPersistentContext("/tmp/pw-panelread", {
    executablePath: "/opt/pw-browsers/chromium", headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-sandbox"] });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker");
  const id = sw.url().split("/")[2];

  const panel = await ctx.newPage();
  await panel.setViewportSize({ width: 350, height: 830 });
  const errs = []; panel.on("pageerror", e => errs.push(e.message));
  await panel.goto(`chrome-extension://${id}/sidepanel.html`);
  await panel.waitForTimeout(400);
  await panel.evaluate(es => new Promise(r => chrome.storage.local.set({ wpb_lists: [
    { id: "a", name: "FABRIC", createdAt: 1, entries: es },
    { id: "b", name: "ACTIVE", createdAt: 2, entries: es.slice(0, 1) },
    { id: "c", name: "GRAPHIC", createdAt: 3, entries: es.slice(0, 1) },
  ] }, r)), ENTRIES);
  await panel.reload();
  await panel.waitForTimeout(1500);

  // ---- the floor -------------------------------------------------------------
  const FLOOR = 10;
  const tiny = await panel.evaluate(min => {
    const out = [];
    document.querySelectorAll("body *").forEach(e => {
      if (e.offsetParent === null && getComputedStyle(e).position !== "fixed") return;
      const r = e.getBoundingClientRect();
      if (!r.width || !r.height) return;
      // only elements that draw text themselves
      const own = [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
      if (!own) return;
      const px = parseFloat(getComputedStyle(e).fontSize);
      if (px < min) out.push(`${e.tagName.toLowerCase()}${e.id ? "#" + e.id : ""}` +
        `${e.className && typeof e.className === "string" ? "." + e.className.trim().split(/\s+/)[0] : ""}` +
        ` ${px}px "${(e.textContent || "").trim().slice(0, 24)}"`);
    });
    return out;
  }, FLOOR);
  ok(`nothing on screen is set below ${FLOOR}px`, tiny.length === 0, tiny.join(" | "));

  const sizes = await panel.evaluate(() => {
    const px = s => { const e = document.querySelector(s); return e ? parseFloat(getComputedStyle(e).fontSize) : 0; };
    return { body: px("body"), row: px("#listbody .ent .lb"), brand: px("#listbody .ent .bn"),
      tab: px("#lchips button"), lab: px("#catalog .lbmain"), view: px(".tab"),
      /* The transport row is marks now, by request, so what has to be legible
         there is the mark. Its size is the measurement that replaces the word
         it used to carry; what the mark MEANS is held by tabs-e2e, which
         requires each one to actually put ink on its box. */
      run: (() => {
        const s = document.querySelector("#runlist svg");
        return s ? s.getBoundingClientRect().width : 0;
      })() };
  });
  ok("the addresses a designer reads are body size or larger",
    sizes.row >= 13, JSON.stringify(sizes));
  ok("the brand over each row is readable, not a watermark",
    sizes.brand >= 10, JSON.stringify(sizes));
  ok("the list tabs are readable at rest", sizes.tab >= 12, JSON.stringify(sizes));
  ok("the transport marks are big enough to read at a glance",
    sizes.run >= 22, JSON.stringify(sizes));
  ok("the way to the LAB is the largest thing on the panel",
    sizes.lab >= 16 && sizes.lab > sizes.view && sizes.lab > sizes.tab, JSON.stringify(sizes));

  // ---- the LAB band is centred ----------------------------------------------
  const lab = await panel.evaluate(() => {
    const b = document.querySelector("#catalog"), m = b.querySelector(".lbmain");
    const br = b.getBoundingClientRect(), mr = m.getBoundingClientRect();
    return { align: getComputedStyle(m).textAlign,
      leftGap: Math.round(mr.left - br.left), rightGap: Math.round(br.right - mr.right) };
  });
  ok("LAB is centred in its band", lab.align === "center", JSON.stringify(lab));

  // ---- the lists are tabs, and the sites are what is inside the open one -----
  const tabs = await panel.evaluate(() => {
    const on = document.querySelector("#lchips button.on");
    const off = document.querySelector("#lchips button:not(.on)");
    const card = document.querySelector(".fs.sites");
    const cs = getComputedStyle(on), os = getComputedStyle(off), card$ = getComputedStyle(card);
    return {
      openBg: cs.backgroundColor, cardBg: card$.backgroundColor, offBg: os.backgroundColor,
      // the open tab's bottom edge is painted in the card's own colour: no line
      openBottom: cs.borderBottomColor,
      strip: getComputedStyle(document.querySelector(".lhead")).borderBottomWidth,
      openSide: cs.borderTopColor, offSide: os.borderTopColor,
    };
  });
  ok("the open tab is the same surface as the panel under it",
    tabs.openBg === tabs.cardBg, JSON.stringify(tabs));
  ok("…with no line between the two", tabs.openBottom === tabs.cardBg, JSON.stringify(tabs));
  ok("…while the strip itself carries one", parseFloat(tabs.strip) >= 1, JSON.stringify(tabs));
  ok("the tabs that are not open are not that surface",
    tabs.offBg !== tabs.cardBg && tabs.offSide !== tabs.openSide, JSON.stringify(tabs));

  /* Switching really switches, and the sites under the strip follow. */
  await panel.click('#lchips button[data-id="b"]');
  await panel.waitForTimeout(500);
  ok("pressing a tab opens that list",
    (await panel.locator("#lchips button.on").innerText()).toLowerCase().includes("active"),
    await panel.locator("#lchips button.on").innerText());
  ok("…and what is under the strip is that list's addresses",
    await panel.locator("#listbody .ent").count() === 1,
    String(await panel.locator("#listbody .ent").count()));
  await panel.click('#lchips button[data-id="a"]');
  await panel.waitForTimeout(400);

  /* A browser keeps its new-tab button reachable however many tabs are open.
     Carried inside the strip, a fourth list pushed it off the right edge —
     and with it the only way to make another list. */
  await panel.evaluate(es => new Promise(r => chrome.storage.local.set({ wpb_lists:
    ["FABRIC", "ACTIVE", "GRAPHIC", "DENIM", "KNITWEAR", "OUTERWEAR"].map((n, i) =>
      ({ id: "x" + i, name: n, createdAt: i + 1, entries: es })) }, r)), ENTRIES);
  await panel.reload();
  await panel.waitForTimeout(1500);
  const plus = await panel.evaluate(() => {
    const b = document.querySelector("#newlist"), r = b.getBoundingClientRect();
    return { right: Math.round(r.right), vw: document.documentElement.clientWidth,
      w: Math.round(r.width), tabs: document.querySelectorAll("#lchips button").length };
  });
  ok("six lists do not push the new-list button off the panel",
    plus.tabs === 6 && plus.w > 0 && plus.right <= plus.vw, JSON.stringify(plus));
  /* Chrome side panels swallow window.prompt, so the panel asks with its own
     box — which is what has to be driven here. */
  ok("…and it still makes one", await (async () => {
    await panel.click("#newlist");
    await panel.waitForTimeout(400);
    if (await panel.locator("#ask").isHidden()) return false;
    await panel.fill("#askinput", "SATIN");
    await panel.click("#askok");
    await panel.waitForTimeout(900);
    const names = await panel.locator("#lchips button").allInnerTexts();
    return names.some(n => /satin/i.test(n));
  })(), JSON.stringify(await panel.locator("#lchips button").allInnerTexts()));

  ok("no page errors", errs.length === 0, errs.join(" | "));
  console.log(`\n${pass} passed, ${fail} failed`);
  await ctx.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log("HARNESS ERROR: " + (e && e.message || e)); process.exit(1); });
