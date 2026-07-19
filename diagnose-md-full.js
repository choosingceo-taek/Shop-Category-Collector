/* Massimo Dutti — full data-source probe. Answers three things so the adapter
   can be fixed without guessing:
     1) how to discover store/catalog ids (the detail fetch is failing = these
        were not found)
     2) the category endpoint that returns the WHOLE category (the DOM grid only
        renders ~half, so we want the API list of all ~102 products)
     3) the product `description` text (Key Design Details = the "Features…" part)

   Paste into the DevTools Console ON a Massimo Dutti category page (e.g.
   /us/women/t-shirts-n1444). Reads only. Copy ALL output back. */
(async function () {
  const R = []; const log = (...a) => R.push(a.join(" "));
  const j = (v, n) => { try { return JSON.stringify(v).slice(0, n || 300); } catch (e) { return String(v).slice(0, n || 300); } };
  const jget = async (u) => { try { const r = await fetch(u, { credentials: "include", headers: { Accept: "application/json" } }); return { status: r.status, ok: r.ok, text: r.ok ? await r.text() : "" }; } catch (e) { return { status: 0, ok: false, err: e.message }; } };

  log("=== MASSIMO DUTTI FULL PROBE ===");
  log("page:", location.href);

  // ---- 1) store / catalog discovery -------------------------------------
  const scFrom = s => { const m = String(s || "").match(/catalog\/store\/(\d+)\/(\d+)\//); return m ? m[1] + "/" + m[2] : ""; };
  // a) resource timing (any itxrest catalog call)
  let perfHits = [];
  try { perfHits = (performance.getEntriesByType("resource") || []).map(e => e.name).filter(n => /itxrest/i.test(n)); } catch (e) {}
  log("[1a] itxrest URLs in perf timing:", perfHits.length, "| first store/catalog:", scFrom(perfHits.map(scFrom).find(Boolean) ? perfHits.find(n => scFrom(n)) : "") || "(none)");
  // b) page HTML regex
  let htmlSC = "";
  try { htmlSC = scFrom(document.documentElement.innerHTML); } catch (e) {}
  log("[1b] catalog/store/X/Y in page HTML:", htmlSC || "(none)");
  // b2) separate storeId / catalogId tokens in inline scripts
  let tokStore = "", tokCat = "";
  try {
    const html = document.documentElement.innerHTML;
    tokStore = (html.match(/["']?(?:storeId|store_id|physicalStoreId)["']?\s*[:=]\s*["']?(\d{4,})/i) || [])[1] || "";
    tokCat = (html.match(/["']?catalog(?:Id)?["']?\s*[:=]\s*["']?(\d{4,})/i) || [])[1] || "";
  } catch (e) {}
  log("[1b2] inline tokens: storeId=", tokStore || "(none)", "| catalogId=", tokCat || "(none)");
  // c) store-config endpoint — dump shape so we can extract reliably
  for (const v of ["3", "2", "1"]) {
    const r = await jget(`/itxrest/${v}/catalog/store?languageId=-1&appId=1&brandId=3`);
    log(`[1c] store-config v${v}: status=${r.status}`);
    if (r.ok) {
      log("     self-ref store/catalog:", scFrom(r.text) || "(none)");
      let cfg; try { cfg = JSON.parse(r.text); } catch (e) {}
      if (cfg) {
        log("     top keys:", Object.keys(cfg).join(", ").slice(0, 200));
        log("     id=", j(cfg.id, 40), "| storeId=", j(cfg.storeId, 40), "| catalogId=", j(cfg.catalogId, 40), "| catalog=", j(cfg.catalog, 80));
        // recursive: first numeric-valued key matching store/catalog
        const found = {};
        (function dig(o, p, d) { if (!o || typeof o !== "object" || d > 4) return; for (const k in o) { if (/^(id|storeId|catalogId|catalog)$/i.test(k) && /^\d{4,}$/.test(String(o[k])) && !found[k]) found[k] = p + "." + k + "=" + o[k]; if (typeof o[k] === "object") dig(o[k], p + "." + k, d + 1); } })(cfg, "root", 0);
        log("     numeric id-ish keys:", Object.values(found).join(" | ") || "(none)");
      }
      break;
    }
  }

  // choose a store/catalog to test with: prefer discovered, fall back to the
  // known US pair (from the productsArray URL you captured earlier)
  const SC = htmlSC || (perfHits.map(scFrom).find(Boolean)) || (tokStore && tokCat ? tokStore + "/" + tokCat : "") || "34009527/30359506";
  log("=> using store/catalog:", SC, "(for the tests below)");

  // ---- 2) category endpoint (whole category list) -----------------------
  const catN = (location.href.match(/-n(\d+)/) || [])[1] || "";
  const celement = (location.href.match(/[?&]celement=(\d+)/) || [])[1] || "";
  log("[2] category ids from URL: -n", catN || "(none)", "| celement=", celement || "(none)");
  // collect pelement ids present in the DOM grid (how many the page rendered)
  const domIds = [...new Set([...document.querySelectorAll('a[href*="pelement="]')]
    .map(a => (a.getAttribute("href").match(/pelement=(\d+)/) || [])[1]).filter(Boolean))];
  log("[2] pelement ids in DOM grid right now:", domIds.length);

  for (const cid of [catN, celement].filter(Boolean)) {
    for (const sp of ["false", "true"]) {
      const u = `/itxrest/3/catalog/store/${SC}/category/${cid}/product?languageId=-1&appId=1&showProducts=${sp}`;
      const r = await jget(u);
      log(`[2] category ${cid} showProducts=${sp}: status=${r.status}`);
      if (r.ok) {
        let d; try { d = JSON.parse(r.text); } catch (e) {}
        if (d) {
          log("     top keys:", Object.keys(d).join(", ").slice(0, 200));
          // find the biggest array of product-ish things or ids
          const arrays = [];
          (function dig(o, p, depth) { if (!o || typeof o !== "object" || depth > 5) return; if (Array.isArray(o)) { arrays.push([p, o.length, o[0]]); return; } for (const k in o) dig(o[k], p + "." + k, depth + 1); })(d, "root", 0);
          arrays.sort((a, b) => b[1] - a[1]).slice(0, 4).forEach(a => log("     array", a[0], "len=", a[1], "sample=", j(a[2], 160)));
        }
      }
    }
  }

  // ---- 3) product description (Key Design Details) ----------------------
  if (domIds.length) {
    const r = await jget(`/itxrest/3/catalog/store/${SC}/productsArray?languageId=-1&appId=1&productIds=${domIds[0]}`);
    log("[3] productsArray single-id status:", r.status);
    if (r.ok) {
      let d; try { d = JSON.parse(r.text); } catch (e) {}
      const p = d && d.products && d.products[0];
      const bd = p && p.bundleProductSummaries && p.bundleProductSummaries[0] && p.bundleProductSummaries[0].detail;
      if (bd) {
        log("     description:", j(bd.description, 400));
        log("     longDescription:", j(bd.longDescription, 400));
      } else log("     (no bundleProductSummaries detail — product keys:", p ? Object.keys(p).join(",").slice(0, 160) : "none", ")");
    }
  }

  log("=== END (copy everything) ===");
  const text = R.join("\n");
  console.log(text);
  try { copy(text); console.log("(copied)"); } catch (e) {}
  return text;
})();
