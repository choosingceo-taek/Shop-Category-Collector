/* Massimo Dutti product-API probe — the grid is served by Inditex's `itxrest`
   catalog API (store 34009527, brandId 3), not the page HTML. This script
   discovers the catalog id from the store config, then FETCHES a few candidate
   category-product endpoints and reports which one returns products and what
   fields each product carries. Verify, don't guess: the winning URL + field
   shape is exactly what the adapter will use.

   Paste the whole file into the DevTools Console ON the Massimo Dutti category
   page (so the fetches are same-origin and logged-in). It reads only; it
   changes nothing and submits nothing. Copy the entire output back. */
(async function () {
  const R = []; const log = (...a) => R.push(a.join(" "));
  const shortJson = v => { try { return JSON.stringify(v).slice(0, 500); } catch (e) { return String(v).slice(0, 500); } };

  log("=== MASSIMO DUTTI API PROBE ===");
  log("URL:", location.href);

  // category id: prefer -n<id> in the path, then ?celement=<id>
  const catId = (location.href.match(/-n(\d+)/) || [])[1]
    || (location.href.match(/[?&]celement=(\d+)/) || [])[1] || "";
  const store = "34009527";              // observed in the itxrest user/cart calls
  log("categoryId:", catId || "(not found)", "| store:", store);

  // find any product array anywhere in a JSON blob
  const findProducts = (o, p, d, out) => {
    if (out.hit || !o || typeof o !== "object" || d > 7) return;
    if (Array.isArray(o)) {
      if (o.length && o[0] && typeof o[0] === "object" &&
        (o[0].name || o[0].nameEn || o[0].detail || o[0].productUrl || o[0].seo)) {
        out.hit = { path: p, len: o.length, sample: o[0] }; return;
      }
      o.slice(0, 6).forEach((x, i) => findProducts(x, p + "[" + i + "]", d + 1, out));
    } else { for (const k in o) findProducts(o[k], p + "." + k, d + 1, out); }
  };

  // discover catalogId from the store-config endpoint that was seen working
  let catalogId = "";
  try {
    const cfg = await (await fetch("/itxrest/2/catalog/store?appId=1&brandId=3", { credentials: "include" })).json();
    const grab = (o, d) => {
      if (!o || typeof o !== "object" || d > 5 || catalogId) return;
      for (const k in o) {
        if (/^catalog(Id)?$/i.test(k) && /^\d+$/.test(String(o[k]))) { catalogId = String(o[k]); return; }
        if (typeof o[k] === "object") grab(o[k], d + 1);
      }
    };
    grab(cfg, 0);
    log("store config: OK | catalogId:", catalogId || "(not found — will try without)");
  } catch (e) { log("store config fetch failed:", e.message); }

  const withCat = catalogId ? [catalogId + "/"] : [];
  const versions = ["3", "2", "4", "1"];
  const cats = [...new Set([...withCat, ""])];        // try with and without catalogId segment
  const candidates = [];
  for (const v of versions) for (const c of cats)
    candidates.push(`/itxrest/${v}/catalog/store/${store}/${c}category/${catId}/product?languageId=-1&appId=1&showProducts=false`);

  let won = false;
  for (const u of candidates) {
    if (won) break;
    try {
      const r = await fetch(u, { credentials: "include", headers: { Accept: "application/json" } });
      log("TRY", r.status, u.slice(0, 140));
      if (!r.ok) continue;
      const j = await r.json();
      const out = {}; findProducts(j, "root", 0, out);
      if (out.hit) {
        won = true;
        log("  ✓ PRODUCTS @", out.hit.path, "| count:", out.hit.len);
        log("  item keys:", Object.keys(out.hit.sample).join(", "));
        log("  sample product:", shortJson(out.hit.sample));
        // dig for price + colors specifically
        const s = out.hit.sample;
        const detail = s.detail || s;
        if (detail) {
          log("  detail keys:", Object.keys(detail).join(", "));
          if (detail.colors && detail.colors[0]) log("  color[0] keys:", Object.keys(detail.colors[0]).join(", "), "|", shortJson(detail.colors[0]));
        }
      } else {
        log("  (200 but no product array — top keys:", Object.keys(j).join(", ").slice(0, 160), ")");
      }
    } catch (e) { log("  err:", e.message); }
  }
  if (!won) log("No candidate returned products — paste the Network tab URL of the call that loads the grid (filter: product).");

  log("=== END (copy everything above) ===");
  const text = R.join("\n");
  console.log(text);
  try { copy(text); console.log("(copied to clipboard)"); } catch (e) {}
  return text;
})();
