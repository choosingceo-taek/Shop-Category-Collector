/* How much ink does a mark actually put on the page?

   The download glyph was written as a line down and back up the same x, so
   its stem enclosed no area and never painted — invisible in the markup,
   obvious once measured. This rasterises each candidate and reports the share
   of its 24×24 box that is covered, which is the number a bare-mark control
   lives or dies by.

   Run: cd tests && NODE_PATH=/opt/node22/lib/node_modules xvfb-run -a node glyph-probe.js
*/
"use strict";
const { chromium } = require("playwright");

const GLYPHS = {
  "play (scan all)": '<path d="M8 5.5v13l11-6.5z"/>',
  "pause": '<path d="M9 5.5h3v13H9zM14 5.5h3v13h-3z"/>',
  "stop": '<rect x="7" y="7" width="10" height="10" rx="2"/>',
  "excel OLD (zero-width stem)": '<path d="M12 3v10.2l3.6-3.6 1.4 1.4L12 16 7 11l1.4-1.4 3.6 3.6V3zM5 18h14v2H5z"/>',
  "excel NEW (sheet + arrow)": '<path d="M7 2.6h6.2L18 7.4v4.1h-2V8.4h-3.6V4.6H7v14.8h3.1v2H7a2 2 0 0 1-2-2V4.6a2 2 0 0 1 2-2z"/><path d="M15.9 12.9h2.2v4.4l1.9-1.9 1.5 1.5-4.5 4.5-4.5-4.5 1.5-1.5 1.9 1.9z"/>',
};

(async () => {
  const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
  const p = await b.newPage();
  await p.goto("about:blank");
  for (const [name, inner] of Object.entries(GLYPHS)) {
    const pct = await p.evaluate(async src => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="96" height="96">${src}</svg>`;
      const img = new Image();
      img.src = "data:image/svg+xml;base64," + btoa(svg);
      await img.decode();
      const c = document.createElement("canvas");
      c.width = c.height = 96;
      const g = c.getContext("2d");
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, 96, 96).data;
      let on = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 40) on++;
      return (on / (96 * 96)) * 100;
    }, inner);
    console.log(`${name.padEnd(30)} ${pct.toFixed(1)}% of the box`);
  }
  await b.close();
})().catch(e => { console.log("HARNESS " + e.message); process.exit(1); });
