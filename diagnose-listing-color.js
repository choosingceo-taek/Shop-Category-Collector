/* LISTING colour-swatch diagnostic — paste this into the DevTools Console while
   on a Cotton On CATEGORY page (the grid, NOT a single product). Unlike the PDP
   fetch (which has no JavaScript, so colour swatches are missing), the category
   page you're looking at is fully rendered, so its tiles' colour swatches ARE in
   the DOM. This reports how those swatches are marked up so the colour count +
   names can be pulled straight from the listing.

   Reads only; changes nothing. Copy the whole output back. */
(function () {
  const R = []; const log = (...a) => R.push(a.join(" "));
  const cap = (s, n) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, n || 120);

  log("=== LISTING COLOUR-SWATCH DIAGNOSTIC ===");
  log("URL:", location.href);

  // 1) product tiles: a link to a .html product page, take its base pid
  const prodLinks = [...document.querySelectorAll('a[href*=".html"]')]
    .filter(a => /\/AU\/.+\/\d{4,}-[A-Za-z0-9]+\.html/i.test(a.href));
  log("\n[product .html links on page]:", prodLinks.length);
  if (!prodLinks.length) { log("No product links — open a category grid."); console.log(R.join("\n")); return; }

  // pick the first product and inspect everything sharing its base pid
  const first = prodLinks[0].href;
  const base = (first.match(/\/(\d{4,})-[A-Za-z0-9]+\.html/i) || [])[1] || "";
  log("first product:", cap(first, 90));
  log("base pid:", base);

  const share = [...document.querySelectorAll('a[href*="' + base + '-"]')];
  const codes = new Set();
  const rows = [];
  share.forEach(a => {
    const m = (a.getAttribute("href") || "").match(new RegExp("/" + base + "-([A-Za-z0-9]+)\\.html", "i"));
    const code = m ? m[1] : "(no .html pid)";
    codes.add(code);
    const img = a.querySelector("img");
    rows.push(`  code=${code} | aria="${cap(a.getAttribute("aria-label"), 32)}" | title="${cap(a.getAttribute("title"), 32)}" | img-alt="${cap(img && img.getAttribute("alt"), 44)}"`);
  });
  log(`\n[links sharing base ${base}]: ${share.length}, distinct colour codes: ${codes.size}`);
  rows.slice(0, 16).forEach(r => log(r));

  // 2) the tile container: what does one product's tile look like?
  const tile = prodLinks[0].closest('[class*="tile" i], [class*="product" i], li, article') || prodLinks[0].parentElement;
  log("\n[tile container tag/class]:", tile ? `<${tile.tagName.toLowerCase()} class="${cap(tile.className, 50)}">` : "(none)");
  if (tile) {
    // swatch-ish descendants inside the tile
    const sw = [...tile.querySelectorAll('[class*="swatch" i], [class*="colour" i], [class*="color" i], button, a[href*="color="]')].slice(0, 12);
    log("[swatch-ish elements in tile]:", tile.querySelectorAll('[class*="swatch" i],[class*="colour" i],[class*="color" i]').length);
    sw.forEach(e => log(`  <${e.tagName.toLowerCase()} class="${cap(e.className, 36)}"> aria="${cap(e.getAttribute("aria-label"), 30)}" title="${cap(e.getAttribute("title"), 24)}" text="${cap(e.children.length ? "" : e.textContent, 24)}"`));
    // any "+N" more-colours badge?
    const more = [...tile.querySelectorAll("*")].map(e => e.children.length ? "" : (e.textContent || "")).find(t => /\+\s*\d+|\d+\s*colou?rs?/i.test(t));
    log("[+N / 'N colours' badge in tile]:", more ? cap(more, 30) : "(none)");
  }

  log("\n=== END (copy everything above) ===");
  const text = R.join("\n");
  console.log(text);
  try { copy(text); console.log("(copied to clipboard)"); } catch (e) {}
})();
