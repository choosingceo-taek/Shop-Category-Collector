/* Generate the shapes; do not wait to be told.

   Every fault in this tool's history arrived the same way — a designer opened
   the spreadsheet, saw a wrong column, and reported it. But a shop is not a
   brand, it is a set of INDEPENDENT choices: how the photo is drawn × where
   the money sits × where the name lives × how the tile nests × what shape the
   product address is × what junk shares the tile. Because the choices are
   independent, the faults live in the COMBINATIONS — the colour-chip bug and
   the euro bug could never be found by testing brands, only by testing shapes.

   So this generates them. Each axis value once against a baseline, then a
   deterministic (never random) sweep of combinations. The real reader runs
   over each one: sites.js has no chrome.* dependency, so it is injected into
   a plain page and called exactly as a scan calls it.

   NOT-EMPTY IS NOT CORRECT. Every cell is compared to what the page actually
   says: the product photo (not a colour swatch, not a 1×1 placeholder), the
   product name (not screen-reader boilerplate, not a routing word off the
   URL), and the price written the way the shop wrote it.

   Adding a value to an axis IS the development plan: the table below says how
   often each value appears in the failures, and that is what to fix next.

   Exits non-zero on any failing shape, so it is the contract too — the
   generator and the check live in one file and cannot drift apart.

   Run: NODE_PATH=/opt/node22/lib/node_modules node matrix-probe.js  */
const { chromium } = require("playwright");
const path = require("path");
const REPO = path.resolve(__dirname, "..");

const SHOP = "https://shop.example/collections/new-in";
const PHOTO = "https://cdn.shop.example/img/airbrush-tank-800.jpg";
const CHIP = "https://cdn.shop.example/img/swatch-black.jpg";
const NAME = "Airbrush Ribbed Tank";
const HREF = {
  clean: "https://shop.example/products/airbrush-ribbed-tank",
  slugId: "https://shop.example/p/airbrush-ribbed-tank/PROD1.html",
  query: "https://shop.example/product.do?pid=901",
  amazon: "https://shop.example/dp/B0123456",
};

/* ---- the axes ------------------------------------------------------------ */
const AX = {
  image: ["img", "picture", "background", "lazy", "noscript", "chipFirst"],
  money: ["usd", "euroAfter", "krAfter", "chfBefore", "audBefore", "gluedToName"],
  name: ["tileText", "altOnly", "jsonld", "urlOnly", "srBoilerplate"],
  nest: ["flat", "innerAnchor", "wrappingAnchor"],
  href: ["clean", "slugId", "query", "amazon"],
  junk: ["none", "sizePicker", "addToBag", "saleBadge"],
};
const BASE = { image: "img", money: "usd", name: "tileText", nest: "flat", href: "clean", junk: "none" };

const PRICE_TEXT = {
  usd: "$89.00", euroAfter: "89,00 €", krAfter: "890 kr",
  chfBefore: "CHF 89.00", audBefore: "A$89.00", gluedToName: "$89.00",
};

/* ---- the generator -------------------------------------------------------
   One product tile, built from a combination. The name is deliberately made
   to END IN A NUMBER for the glued case, because "501", "Air Max 90" and
   "Tee 2.0" are ordinary product names and a shop puts no space between the
   name node and the price node. */
function tile(c, i) {
  const name = c.money === "gluedToName" ? "Style Number 1" : NAME;
  /* Unique per tile: identical addresses are one product and the reader
     rightly folds them, which would hide "found one of six". */
  const base = HREF[c.href];
  const href = base + (base.includes("?") ? "&" : "?") + "n=" + i;

  let img;
  switch (c.image) {
    case "img":        img = `<img src="${PHOTO}" alt="${name}" width="800" height="1067">`; break;
    case "picture":    img = `<picture><source srcset="${PHOTO} 800w, ${PHOTO}?w=400 400w" ` +
                             `sizes="50vw"><img src="${PHOTO}" alt="${name}" width="800" height="1067"></picture>`; break;
    case "background": img = `<div class="ph" style="background-image:url('${PHOTO}')" ` +
                             `role="img" aria-label="${name}"></div>`; break;
    case "lazy":       img = `<img src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==" ` +
                             `data-src="${PHOTO}" alt="${name}" width="800" height="1067">`; break;
    /* The real shape: with scripts on the browser paints the placeholder and
       leaves the <noscript> as text, so the only true address is in there.
       A tile with no image node at all is not a shape any shop ships. */
    case "noscript":   img = `<img src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==" ` +
                             `alt="${name}" width="800" height="1067">` +
                             `<noscript><img src="${PHOTO}" alt="${name}" width="800" height="1067"></noscript>`; break;
    case "chipFirst":  img = `<img src="${CHIP}" alt="Black" width="40" height="40">` +
                             `<img src="${PHOTO}" alt="${name}" width="800" height="1067">`; break;
  }

  const priceText = PRICE_TEXT[c.money];
  const nameNode = c.name === "altOnly" || c.name === "urlOnly" ? ""
    : c.name === "srBoilerplate"
      ? `<span class="sr-only">Activating this element will cause content on the page to be updated.</span>` +
        `<span class="t">${name}</span>`
      : `<span class="t">${name}</span>`;
  // glued: no whitespace at all between the name node and the price node
  const priceNode = `<span class="pr">${priceText}</span>`;
  const body = c.money === "gluedToName"
    ? `<div class="meta">${nameNode}${priceNode}</div>`
    : `<div class="meta">${nameNode} ${priceNode}</div>`;

  let junk = "";
  if (c.junk === "sizePicker") junk = `<select aria-label="Select Size"><option>Select Size</option><option>S</option></select>`;
  if (c.junk === "addToBag")   junk = `<button type="button">Add to bag</button>`;
  if (c.junk === "saleBadge")  junk = `<span class="badge">20% off</span>`;

  const inner = img + body + junk;
  if (c.nest === "wrappingAnchor") return `<li class="card"><a href="${href}">${inner}</a></li>`;
  if (c.nest === "innerAnchor")
    return `<li class="card">${img}<a href="${href}">${nameNode || name}</a>${priceNode}${junk}</li>`;
  return `<li class="card"><a href="${href}" class="lnk">${img}</a>${body}${junk}</li>`;
}

function page(c, n = 6) {
  const ld = c.name === "jsonld" ? `<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org", "@type": "ItemList",
    itemListElement: Array.from({ length: n }, (_, i) => ({
      "@type": "ListItem", position: i + 1,
      item: { "@type": "Product", name: NAME, url: HREF[c.href], image: PHOTO },
    })),
  })}</script>` : "";
  return `<!doctype html><meta charset="utf-8"><title>New In | Shop</title>${ld}
    <style>.card{display:block}.ph{width:800px;height:1067px}.sr-only{position:absolute;
      width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}</style>
    <h1>New In</h1><ul class="grid">${Array.from({ length: n }, (_, i) => tile(c, i)).join("")}</ul>`;
}

/* ---- the combinations ---------------------------------------------------- */
function combos() {
  const out = [], seen = new Set();
  const add = c => { const k = JSON.stringify(c); if (!seen.has(k)) { seen.add(k); out.push(c); } };
  add({ ...BASE });
  for (const ax of Object.keys(AX)) for (const v of AX[ax]) add({ ...BASE, [ax]: v });
  // deterministic sweep: every axis advanced at a different stride
  const keys = Object.keys(AX);
  for (let i = 0; i < 96; i++) {
    const c = {};
    keys.forEach((k, j) => { c[k] = AX[k][(i * (j + 2) + j) % AX[k].length]; });
    add(c);
  }
  return out;
}

/* ---- what the page actually said ----------------------------------------- */
function check(c, rows) {
  const bad = [];
  if (!rows.length) return ["no products at all"];
  if (rows.__n < 6) bad.push(`only ${rows.__n} of 6 tiles read`);
  const r = rows[0];

  // NAME
  const wantName = c.money === "gluedToName" ? "Style Number 1" : NAME;
  const got = String(r.name || "").trim();
  if (c.name === "urlOnly") {
    // no text anywhere: the slug is the shop's own wording, a routing word is not
    if (/^(prod1|product\.do|dp|p)$/i.test(got)) bad.push(`name from routing/file word: "${got}"`);
  } else if (!got) bad.push("no name");
  else if (/activating this element/i.test(got)) bad.push(`name is screen-reader text: "${got}"`);
  else if (/^select size$/i.test(got)) bad.push(`name is a control: "${got}"`);
  else if (!got.toLowerCase().includes(wantName.toLowerCase().split(" ")[0]))
    bad.push(`name not the product's: "${got}" (wanted ~"${wantName}")`);

  // PRICE — exactly the characters the shop wrote
  const price = String(r.price || "").trim();
  const want = PRICE_TEXT[c.money];
  if (!price) bad.push(`no price (page said "${want}")`);
  else if (price.replace(/\s/g, "") !== want.replace(/\s/g, ""))
    bad.push(`price "${price}" but page said "${want}"`);

  // IMAGE — the product photo, not the swatch and not the placeholder
  const img = String(r.image_url || "").trim();
  if (!img) bad.push("no image");
  else if (/^data:/.test(img)) bad.push("image is the 1x1 placeholder");
  else if (img.includes("swatch")) bad.push(`image is the colour chip: ${img}`);
  else if (!img.startsWith("https://")) bad.push(`image not absolute: ${img}`);

  // URL
  const u = String(r.product_url || "");
  if (!u.startsWith("https://")) bad.push(`product url not absolute: ${u}`);

  return bad;
}

(async () => {
  const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const p = await b.newPage();
  const list = combos();
  const fails = [];
  const byValue = {};

  for (const c of list) {
    await p.setContent(page(c), { waitUntil: "domcontentloaded" });
    await p.addScriptTag({ path: path.join(REPO, "sites.js") });
    const res = await p.evaluate(u => {
      const a = window.SITES.active(u);
      try {
        const all = a.scrapeList(document, u) || [];
        const out = all.slice(0, 2); out.__n = all.length; return { rows: out, n: all.length };
      }
      catch (e) { return { rows: [{ __err: String(e && e.message || e) }], n: 0 }; }
    }, SHOP);
    const list2 = res && res.rows ? res.rows : [res];
    if (list2[0]) list2.__n = res.n;
    const bad = list2[0] && list2[0].__err ? ["threw: " + list2[0].__err] : check(c, list2);
    if (bad.length) {
      fails.push({ c, bad });
      Object.entries(c).forEach(([k, v]) => {
        const key = `${k}=${v}`; byValue[key] = (byValue[key] || 0) + 1;
      });
    }
  }

  console.log(`${list.length} shapes · ${list.length - fails.length} clean · ${fails.length} failing\n`);
  if (fails.length) {
    console.log("which axis value shows up in failures (this is the work list):");
    Object.entries(byValue).sort((a, x) => x[1] - a[1]).slice(0, 12)
      .forEach(([k, n]) => console.log(`  ${String(n).padStart(3)}  ${k}`));
    console.log("\nfirst failures:");
    fails.slice(0, 10).forEach(f =>
      console.log("  " + Object.entries(f.c).map(([k, v]) => `${k}:${v}`).join(" ") +
        "\n      " + f.bad.join(" | ")));
  }
  await b.close();
  /* This is the contract as well as the explorer. One file, so the generator
     that finds a defect and the check that keeps it fixed cannot drift apart. */
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.log("ERROR " + (e && e.message || e)); process.exit(1); });
