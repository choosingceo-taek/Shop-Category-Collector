/* Draw the panel in each candidate palette, so the choice is made by looking
   rather than by reading hex codes. Generation, not report.

   Everything in the panel is driven by the tokens on :root, so a variant is
   an override sheet and nothing else — which is also the measure of whether
   the restyle is safe: if a variant needs new rules, the palette is not a
   palette.

   Run: cd tests && NODE_PATH=/opt/node22/lib/node_modules xvfb-run -a node palette-probe.js
*/
"use strict";
const { chromium } = require("playwright");
const EXT = "/home/user/Fabric-Scanner";

const VARIANTS = {
  "a-now": "",

  /* Softer, achromatic. The ground steps off pure grey without taking a hue —
     v1.98.0 removed the warm greige because a tool whose job is judging
     colour in garment photographs must not put its own colour beside them,
     and PRODUCTS is a wall of those photographs. So: lighter hairlines, a
     black that is not pure black, real corner radius, and the rust flag
     replaced by the dashboard's orange. */
  "b-soft": `
    --bg:#f7f7f7; --card:#fff; --ink:#151515; --ink2:#2a2a2a; --muted:#6f6f6f;
    --line:#ececec; --line2:#dedede; --hard:#1a1a1a; --wash:#f7f7f7;
    --accent:#ff5c35; --cta:#1a1a1a; --cta-hi:#000;
    --r:10px; --r-s:8px;`,

  /* The dashboard's own tokens — the sheet the team already chose for the
     file that leaves the building. Warm paper, generous radius. */
  "c-dash": `
    --bg:#f4f4f0; --card:#fff; --ink:#151713; --ink2:#232620; --muted:#6f746c;
    --line:#e4e5de; --line2:#dcded6; --hard:#151713; --wash:#f8f8f5;
    --accent:#ff5c35; --cta:#151713; --cta-hi:#000;
    --r:14px; --r-s:10px;`,
};

const lists = [{
  id: "l0", name: "My references", createdAt: 1,
  entries: [
    { brand: "ATHLETA", label: "All New Arrivals", url: "https://athleta.gap.com/browse/new/all-new-arrivals" },
    { brand: "GYMSHARK", label: "Everyday Womens", url: "https://www.gymshark.com/collections/everyday/womens" },
    { brand: "VUORI", label: "New Arrivals", url: "https://vuoriclothing.com/collections/womens-new" },
    { brand: "ALO YOGA", label: "New In", url: "https://www.aloyoga.com/collections/new-arrivals" },
  ],
}, { id: "l1", name: "FABRIC", createdAt: 2, entries: [] }];

(async () => {
  const ctx = await chromium.launchPersistentContext("/tmp/pw-palette", {
    executablePath: "/opt/pw-browsers/chromium", headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-sandbox"],
  });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker");
  const id = sw.url().split("/")[2];
  const p = await ctx.newPage();
  await p.setViewportSize({ width: 350, height: 620 });
  await p.goto(`chrome-extension://${id}/sidepanel.html`);
  await p.waitForTimeout(1200);
  await p.evaluate(l => new Promise(r => chrome.storage.local.set({ wpb_lists: l }, r)), lists);

  for (const [name, css] of Object.entries(VARIANTS)) {
    await p.reload();
    await p.waitForTimeout(1300);
    await p.evaluate(c => {
      const old = document.getElementById("variant");
      if (old) old.remove();
      if (!c) return;
      const s = document.createElement("style");
      s.id = "variant";
      s.textContent = ":root{" + c + "}";
      document.head.appendChild(s);
    }, css);
    await p.waitForTimeout(4200);
    await p.screenshot({ path: `palette-${name}.png` });
    console.log("drew palette-" + name + ".png");
  }
  await ctx.close();
})().catch(e => { console.log("HARNESS " + e.message); process.exit(1); });
