/* Report generator — turns a set of collected products into ONE self-contained
   HTML file.

   The archival requirement drives the whole design: this file must still show
   the same information a year from now. So it references NOTHING external —
   images are embedded as data URIs (downscaled to ~240px, ≈14KB each, so 100
   products land around 1.4MB), styles are inline, charts are inline SVG.
   The only script is a ten-line inline tab switcher with no dependencies;
   without it (print, ancient viewers) every section simply shows stacked, so
   nothing is ever unreachable. Shops delete products and rotate CDN paths; a
   report that linked to them would quietly lose its pictures. This one cannot.

   The default template reads like the team's weekly edit, not like a printout:
   a side rail with three sections — 01 New In (day-by-day, brands within each
   day), 02 By Brand (each brand's assortment, categories within), 03 LAB (the
   quantitative read). Same figures in every template, per the charter.

   Light-mode only, on purpose: it is a document that gets shared, opened on
   someone else's machine and printed, so it should look the same everywhere
   rather than follow the reader's OS theme.

   Numbers come from report.js (pure calculation, no LLM), and every figure
   shown is something the scan actually recorded. */
(function (root) {
  "use strict";
  const Calc = (typeof require !== "undefined" && typeof module !== "undefined")
    ? require("./report.js") : root.ReportCalc;

  // validated categorical palette (light surface)
  const SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];
  const INK = "#0b0b0b", INK2 = "#52514e", MUTED = "#898781", GRID = "#e1e0d9", SURF = "#fcfcfb";

  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = n => n == null ? "—" : "$" + (Math.round(n * 100) / 100).toFixed(2);

  // Named colours -> a swatch. Only well-known names get a swatch; anything we
  // can't map stays label-only rather than being guessed at.
  const SWATCH = {
    black: "#111", white: "#fff", cream: "#f0e7d8", ecru: "#e8dfd0", ivory: "#f5efe3",
    navy: "#1c2a4a", blue: "#2a78d6", "light blue": "#9ec5f4", red: "#c62828", pink: "#e87ba4",
    green: "#2e7d32", olive: "#6b7043", khaki: "#b3a380", beige: "#d9c9ae", brown: "#5d4433",
    tan: "#c39d72", grey: "#8a8a8a", gray: "#8a8a8a", charcoal: "#3a3a3a", silver: "#c8c8c8",
    yellow: "#eda100", orange: "#eb6834", purple: "#5b4a9e", lilac: "#b6a5da", burgundy: "#6d1f2d",
    camel: "#c19a6b", stone: "#cfc6b8", sand: "#ddceb4", mint: "#a8d5c2", teal: "#1b7f79",
  };
  function swatchFor(name) {
    const n = String(name || "").toLowerCase();
    if (SWATCH[n]) return SWATCH[n];
    for (const k in SWATCH) if (n.includes(k)) return SWATCH[k];
    return null;
  }

  // ---- chart primitives (inline SVG, no script) ----------------------------
  // Ranked horizontal bars: the right form for named categories with long
  // labels (fibres, colours, brands) — a vertical axis would clip them.
  function barsH(rows, opts) {
    opts = opts || {};
    const max = Math.max(1, ...rows.map(r => r.value));
    const W = 640, rowH = 26, padL = opts.labelW || 150, padR = 54;
    const H = rows.length * rowH + 6;
    const body = rows.map((r, i) => {
      const y = i * rowH + 4;
      const w = Math.max(2, Math.round((W - padL - padR) * (r.value / max)));
      const fill = r.color || opts.color || SERIES[0];
      const stroke = r.color ? ' stroke="rgba(11,11,11,.18)" stroke-width="1"' : "";
      return `<g>
        <text x="${padL - 9}" y="${y + 13}" text-anchor="end" font-size="12" fill="${INK2}">${esc(r.key)}</text>
        <rect x="${padL}" y="${y + 3}" width="${w}" height="14" rx="4" fill="${fill}"${stroke}/>
        <text x="${padL + w + 7}" y="${y + 14}" font-size="11.5" fill="${MUTED}">${esc(r.label != null ? r.label : r.value)}</text>
      </g>`;
    }).join("");
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="${esc(opts.alt || "")}">${body}</svg>`;
  }

  // Price histogram: magnitude over ordered numeric bins -> vertical columns.
  function histogram(hist) {
    const b = hist.buckets || [];
    if (!b.length) return "";
    const W = 640, H = 168, padB = 30, padL = 34, padT = 8;
    const max = Math.max(1, ...b.map(x => x.count));
    const bw = (W - padL - 8) / b.length;
    const gridLines = [0, .5, 1].map(f => {
      const y = padT + (H - padB - padT) * (1 - f);
      return `<line x1="${padL}" y1="${y}" x2="${W - 8}" y2="${y}" stroke="${GRID}" stroke-width="1"/>
        <text x="${padL - 6}" y="${y + 4}" text-anchor="end" font-size="10.5" fill="${MUTED}">${Math.round(max * f)}</text>`;
    }).join("");
    const cols = b.map((x, i) => {
      const h = Math.max(1, Math.round((H - padB - padT) * (x.count / max)));
      const bx = padL + i * bw, by = H - padB - h;
      // 2px gap between adjacent fills so bars read as separate marks
      return `<rect class="hbar" x="${bx + 1}" y="${by}" width="${Math.max(1, bw - 3)}" height="${h}" rx="4" fill="${SERIES[0]}"/>
        <text x="${bx + bw / 2}" y="${H - padB + 13}" text-anchor="middle" font-size="10" fill="${MUTED}">$${Math.round(x.lo)}</text>`;
    }).join("");
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="Price distribution">
      ${gridLines}${cols}
      <line x1="${padL}" y1="${H - padB}" x2="${W - 8}" y2="${H - padB}" stroke="#c3c2b7" stroke-width="1"/></svg>`;
  }

  function statTile(label, value, sub) {
    return `<div class="tile"><div class="tl">${esc(label)}</div><div class="tv">${esc(value)}</div>${
      sub ? `<div class="ts">${esc(sub)}</div>` : ""}</div>`;
  }

  /* ---- KPI cards, dashboard-style -----------------------------------------
     A headline number is easier to trust when its shape sits next to it, so
     each card carries a thumbnail chart of the same measure. Tinted grounds
     separate the cards at a glance without adding rules; the tint is
     decoration, and every figure still comes from the scan. */
  function sparkBars(values, color) {
    if (!values.length) return "";
    const W = 120, H = 34, max = Math.max(1, ...values);
    const bw = W / values.length;
    return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">` +
      values.map((v, i) => {
        const h = Math.max(1.5, (H - 2) * (v / max));
        return `<rect x="${(i * bw + bw * 0.16).toFixed(1)}" y="${(H - h).toFixed(1)}" width="${(bw * 0.68).toFixed(1)}" height="${h.toFixed(1)}" rx="1.2" fill="${color}"/>`;
      }).join("") + `</svg>`;
  }
  function sparkLine(values, color) {
    const pts = values.filter(v => v != null);
    if (pts.length < 2) return "";
    const W = 120, H = 34, max = Math.max(...pts), min = Math.min(...pts);
    const span = max - min || 1;
    const d = values.map((v, i) => {
      const x = (W * i) / (values.length - 1);
      const y = 3 + (H - 6) * (1 - (v - min) / span);
      return `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
    return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
      <path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }
  function kpi(tint, label, value, sub, chart) {
    return `<div class="kpi ${tint}">
      <div class="kl">${esc(label)}</div>
      <div class="krow"><div class="kv">${esc(value)}</div>${chart || ""}</div>
      ${sub ? `<div class="ks">${esc(sub)}</div>` : ""}</div>`;
  }

  /* items: catalog rows (raw fields). images: { [product_url]: dataUri }.
     meta: { title, subtitle, period, scope, generatedAt } */
  /* ---- dashboard pieces ----------------------------------------------------
     The layout a designer asked for (their own Material Intelligence sheet):
     a filter rail, a hero, a row of KPI tiles, ranking panels, a fibre donut,
     three decision signals and a product wall. Every figure below comes from
     the same Calc.aggregate the other templates read, so no two layouts can
     ever show different numbers — the rule that has held since v3.8.0. */

  // Ranking rows: name, a track that carries its own share, and the count.
  function rankRows(rows, unit) {
    if (!rows || !rows.length) return `<p class="sub">Nothing collected for this.</p>`;
    const max = Math.max(...rows.map(r => r.value)) || 1;
    return `<div class="rank">` + rows.map(r => `<div class="rrow">
      <span class="rk">${esc(r.key)}</span>
      <span class="rt"><i style="width:${Math.max(2, Math.round(r.value / max * 100))}%${
        r.color ? `;background:${r.color}` : ""}"></i></span>
      <span class="rv">${esc(String(r.label != null ? r.label : r.value))}${
        unit ? `<em>${esc(unit)}</em>` : ""}</span></div>`).join("") + `</div>`;
  }

  /* A donut, drawn as stroked arcs on one circle — no library, no script, and
     it survives being printed. The hole carries the total it is made of. */
  function donut(rows, total, note) {
    if (!rows || !rows.length) return `<p class="sub">No composition collected.</p>`;
    const sum = rows.reduce((a, r) => a + r.value, 0) || 1;
    const R = 54, C = 2 * Math.PI * R;
    let at = 0;
    const arcs = rows.map(r => {
      const frac = r.value / sum;
      const seg = `<circle class="dseg" r="${R}" cx="70" cy="70" fill="none"
        stroke="${r.color}" stroke-width="26"
        stroke-dasharray="${(frac * C).toFixed(2)} ${(C - frac * C).toFixed(2)}"
        stroke-dashoffset="${(-at * C).toFixed(2)}"><title>${esc(r.key)}</title></circle>`;
      at += frac;
      return seg;
    }).join("");
    return `<div class="donutwrap">
      <div class="donut"><svg viewBox="0 0 140 140" role="img" aria-label="Fibre mix">
        <g transform="rotate(-90 70 70)">${arcs}</g></svg>
        <div class="dhole"><b>${esc(String(total))}</b><span>${esc(note || "")}</span></div></div>
      <p class="dnote">Ring segments are proportional to each fibre's share of products; the
        figure beside each name is that share.</p>
      <ul class="dlegend">${rows.map(r => `<li><i style="background:${r.color}"></i>
        <span>${esc(r.key)}</span><b>${esc(String(r.label != null ? r.label : Math.round(r.value / sum * 100) + "%"))}</b></li>`).join("")}</ul>
    </div>`;
  }

  // One KPI tile. The first on the row is filled, the way the reference sets it.
  function dtile(label, value, sub, lead) {
    return `<div class="dt${lead ? " lead" : ""}">
      <span class="dtl">${esc(label)}</span>
      <b class="dtv">${esc(String(value))}</b>
      ${sub ? `<span class="dts">${esc(sub)}</span>` : ""}</div>`;
  }

  /* A "signal" states a fact the data already carries and names the count
     behind it. Nothing here is inferred — the zero-hallucination rule applies
     to a dashboard exactly as it applies to a spreadsheet cell. */
  function signal(n, kicker, term, line, tone) {
    return `<div class="sig ${tone}"><span class="sk">${esc(n)} · ${esc(kicker)}</span>
      <b>${esc(term)}</b><span class="sl">${esc(line)}</span></div>`;
  }

  function build(items, images, meta) {
    meta = meta || {}; images = images || {};
    const agg = Calc.aggregate(items);
    const norm = (items || []).map(Calc.normItem);
    const title = meta.title || "Market research report";
    const when = meta.generatedAt || new Date().toISOString().slice(0, 10);

    const fibers = agg.fiberPresence.slice(0, 10)
      .map((r, i) => ({ key: r.key, value: r.pct, label: r.pct + "%", color: SERIES[i % SERIES.length] }));
    const colors = agg.colorFreq.slice(0, 12).map(r => ({
      key: r.key, value: r.value, label: String(r.value),
      color: swatchFor(r.key) || SERIES[2],
    }));
    const brands = agg.brandShare.slice(0, 10).map(r => ({
      key: r.key, value: r.value, label: String(r.value), color: SERIES[0],
    }));
    const cats = agg.categoryShare.slice(0, 10).map(r => ({
      key: r.key, value: r.value, label: String(r.value), color: SERIES[2],
    }));

    const cards = norm.map(p => {
      const img = images[p.product_url] || "";
      const sale = p.onSale;
      return `<figure class="p">
        ${img ? `<img src="${img}" alt="">` : `<div class="ph"></div>`}
        <figcaption>
          ${p.brand ? `<span class="pb">${esc(p.brand)}</span>` : ""}
          <span class="pn">${esc(p.name || "(untitled)")}</span>
          ${p.price != null ? `<span class="pp${sale ? " sale" : ""}">${money(p.price)}${
            sale ? ` <s>${money(p.priceWas)}</s>` : ""}</span>` : ""}
          ${p.fibers.length ? `<span class="pf">${esc(p.fibers.map(f => (f.pct != null ? f.pct + "% " : "") + f.fiber).join(", "))}</span>` : ""}
        </figcaption></figure>`;
    }).join("");

    // Data-sheet table: every collected field, compact, for close analysis.
    const table = `<table class="tb"><thead><tr>
        <th></th><th>Brand</th><th>Product</th><th>Category</th><th>Price</th><th>Was</th>
        <th>Fabric</th><th>Colours</th><th>Sizes</th></tr></thead><tbody>` +
      norm.map(p => {
        const img = images[p.product_url] || "";
        const raw = (items || []).find(x => (x.product_url || "") === p.product_url) || {};
        return `<tr>
          <td>${img ? `<img class="tt" src="${img}" alt="">` : ""}</td>
          <td>${esc(p.brand)}</td>
          <td class="tn">${esc(p.name)}</td>
          <td>${esc(p.category)}</td>
          <td class="num${p.onSale ? " sale" : ""}">${p.price != null ? money(p.price) : "—"}</td>
          <td class="num">${p.priceWas != null ? money(p.priceWas) : "—"}</td>
          <td>${esc(p.fibers.map(f => (f.pct != null ? f.pct + "% " : "") + f.fiber).join(", "))}</td>
          <td>${esc(p.colors.join(", "))}</td>
          <td>${esc(raw.size_range || "")}</td></tr>`;
      }).join("") + `</tbody></table>`;

    // Lookbook: images lead, numbers recede — the visual read a design team wants.
    const plates = norm.map(p => {
      const img = images[p.product_url] || "";
      return `<figure class="lb">
        ${img ? `<img src="${img}" alt="">` : `<div class="ph"></div>`}
        <figcaption>
          <b>${esc(p.name || "")}</b>
          <span>${esc([p.brand, p.price != null ? money(p.price) : ""].filter(Boolean).join(" · "))}</span>
          ${p.fibers.length ? `<span class="lf">${esc(p.fibers.map(f => (f.pct != null ? f.pct + "% " : "") + f.fiber).join(", "))}</span>` : ""}
        </figcaption></figure>`;
    }).join("");

    const scopeBits = [];
    if (meta.period) scopeBits.push(meta.period);
    if (meta.scope) scopeBits.push(meta.scope);
    if (agg.brandShare.length) scopeBits.push(`${agg.brandShare.length} brands`);
    if (agg.categoryShare.length) scopeBits.push(`${agg.categoryShare.length} categories`);

    // Templates change PRESENTATION only — the figures above are identical in
    // all three, so two teams reading different layouts never see different
    // numbers. standard = stats+charts+grid, lookbook = images lead,
    // data = full table for close analysis.
    const tmpl = meta.template || "standard";
    const summary = `<h2>Summary</h2>
<div class="tiles">
  ${statTile("Products", agg.count.toLocaleString())}
  ${statTile("Average price", money(agg.avgPrice), agg.medianPrice != null ? "median " + money(agg.medianPrice) : "")}
  ${statTile("Price range", agg.minPrice != null ? money(agg.minPrice) + " – " + money(agg.maxPrice) : "—")}
  ${statTile("On sale", agg.onSalePct + "%", agg.avgDiscountPct != null ? Math.round(agg.avgDiscountPct) + "% average markdown" : "")}
  ${statTile("Fabric known", agg.compositionKnownPct + "%", "composition collected")}
  ${statTile("Distinct colours", String(agg.distinctColors))}
</div>`;

    // arrivals per collection day — the shape behind the headline count
    const dayCounts = (() => {
      const m = new Map();
      (items || []).forEach(r => {
        if (!r || !r.addedAt) return;
        const d = new Date(r.addedAt);
        m.set(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(), 0);
      });
      (items || []).forEach(r => {
        if (!r || !r.addedAt) return;
        const d = new Date(r.addedAt);
        const k = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
        m.set(k, m.get(k) + 1);
      });
      return [...m.entries()].sort((a, b) => a[0] - b[0]).map(e => e[1]).slice(-14);
    })();
    const kpis = `<div class="kpis">
      ${kpi("k1", "Products", agg.count.toLocaleString(),
        dayCounts.length > 1 ? `${dayCounts.length} collection days` : "",
        sparkBars(dayCounts, SERIES[0]))}
      ${kpi("k2", "Brands · Categories", `${agg.brandShare.length} · ${agg.categoryShare.length}`,
        agg.brandShare.length ? `most: ${agg.brandShare[0].key}` : "",
        sparkBars(agg.brandShare.slice(0, 8).map(b => b.value), SERIES[6]))}
      ${kpi("k3", "Median price", agg.medianPrice != null ? money(agg.medianPrice) : "—",
        agg.minPrice != null ? `${money(agg.minPrice)} – ${money(agg.maxPrice)}` : "",
        sparkLine((agg.priceHistogram.buckets || []).map(b => b.count), SERIES[7]))}
      ${kpi("k4", "On sale", agg.onSalePct + "%",
        agg.avgDiscountPct != null ? `${Math.round(agg.avgDiscountPct)}% average markdown` : "nothing discounted",
        sparkBars([agg.onSalePct, 100 - agg.onSalePct], SERIES[1]))}
    </div>`;

    const card = (title, inner) => `<section class="card"><h3>${esc(title)}</h3>${inner}</section>`;
    const charts = kpis +
      card("Price distribution", histogram(agg.priceHistogram) || `<p class="sub">No price data.</p>`) +
      `<div class="two">
        ${card("Fabric (share of products using it)", fibers.length ? barsH(fibers, { alt: "Fabric usage", labelW: 140 }) : `<p class="sub">No composition data.</p>`)}
        ${card("Colour frequency", colors.length ? barsH(colors, { alt: "Colour frequency", labelW: 140 }) : `<p class="sub">No colour data.</p>`)}
      </div>
      <div class="two">
        ${card("Brands", brands.length ? barsH(brands, { alt: "Products per brand", labelW: 140 }) : `<p class="sub">No brand data.</p>`)}
        ${card("Categories", cats.length ? barsH(cats, { alt: "Products per category", labelW: 140 }) : `<p class="sub">No category data.</p>`)}
      </div>`;

    /* ---- the pulse layout (default) ---------------------------------------
       One card per product, pre-rendered once and reused by index in both the
       New In and By Brand sections, so the two views can never disagree. */
    const cardArr = norm.map((p, i) => {
      const img = images[p.product_url] || "";
      return `<figure class="p">
        ${img ? `<img src="${img}" alt="">` : `<div class="ph"></div>`}
        <figcaption>
          ${p.brand ? `<span class="pb">${esc(p.brand)}</span>` : ""}
          <span class="pn">${esc(p.name || "(untitled)")}</span>
          ${p.price != null ? `<span class="pp${p.onSale ? " sale" : ""}">${money(p.price)}${
            p.onSale ? ` <s>${money(p.priceWas)}</s>` : ""}</span>` : ""}
          ${p.fibers.length ? `<span class="pf">${esc(p.fibers.map(f => (f.pct != null ? f.pct + "% " : "") + f.fiber).join(", "))}</span>` : ""}
        </figcaption></figure>`;
    });
    const raws = items || [];
    const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const dayKey = ts => { const d = new Date(ts); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
    const dayLabel = ts => { const d = new Date(ts); return `${d.getMonth() + 1}/${d.getDate()} (${DOW[d.getDay()]})`; };

    // NEW IN: day (newest first) → brand (biggest first) → cards. "New" is the
    // day the product was FIRST collected — the one measure every shop shares.
    const byDay = new Map();
    raws.forEach((r, i) => {
      const k = r.addedAt ? dayKey(r.addedAt) : 0;
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(i);
    });
    const newIn = [...byDay.entries()].sort((a, b) => b[0] - a[0]).map(([k, idxs]) => {
      const byBrand = new Map();
      idxs.forEach(i => {
        const b = raws[i].brand || "Other";
        if (!byBrand.has(b)) byBrand.set(b, []);
        byBrand.get(b).push(i);
      });
      // data-brand lets the chip row filter without re-rendering anything
      const groups = [...byBrand.entries()].sort((a, b) => b[1].length - a[1].length)
        .map(([brand, ii]) => `<div class="bgrp" data-brand="${esc(brand)}" data-tier="${esc((raws[ii[0]] || {}).tier || "")}">
          <div class="bsub">${esc(brand)} <span>${ii.length}</span></div>
          <div class="grid">${ii.map(i => cardArr[i]).join("")}</div></div>`).join("");
      return `<div class="day"><div class="dh"><b>${k ? esc(dayLabel(k)) : "Date unknown"}</b>
        <span class="dcount" data-all="${idxs.length}">${idxs.length}</span></div>${groups}</div>`;
    }).join("");

    // brand chips over the whole feed — counts included so no chip can lead to
    // an empty screen, and the filter narrows the view only
    const feedBrands = (() => {
      const m = new Map();
      raws.forEach(r => { const b = (r && r.brand) || "Other"; m.set(b, (m.get(b) || 0) + 1); });
      return [...m.entries()].sort((a, b) => b[1] - a[1]);
    })();
    const feedChips = feedBrands.length > 1
      ? `<div class="fchips"><button class="fch on" data-b="">All <span>${raws.length}</span></button>` +
        feedBrands.map(([b, n]) => `<button class="fch" data-b="${esc(b)}">${esc(b)} <span>${n}</span></button>`).join("") +
        `</div>`
      : "";
    // tier chips filter the same feed, one level up from brands
    const feedTiers = (() => {
      const m = new Map();
      raws.forEach(r => { const t = (r && r.tier) || ""; if (t) m.set(t, (m.get(t) || 0) + 1); });
      return [...m.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    })();
    const tierChips = feedTiers.length
      ? `<div class="fchips tchips"><button class="fch tch on" data-t="">All tiers <span>${raws.length}</span></button>` +
        feedTiers.map(([t, n]) => `<button class="fch tch" data-t="${esc(t)}">${esc(t)} <span>${n}</span></button>`).join("") +
        `</div>`
      : "";

    // BY BRAND: brand (biggest first) → category → cards, with anchor chips.
    const byBrandAll = new Map();
    raws.forEach((r, i) => {
      const b = r.brand || "Other";
      if (!byBrandAll.has(b)) byBrandAll.set(b, []);
      byBrandAll.get(b).push(i);
    });
    /* Tier ordering when the brand sheet has been imported: the team ask
       "what are the hero brands doing" before "what is brand #37 doing", and a
       flat list of forty names cannot answer that. Untiered brands keep their
       own group rather than disappearing. */
    const tierOfBrand = b => (raws[(byBrandAll.get(b) || [])[0]] || {}).tier || "";
    const brandOrder = [...byBrandAll.entries()].sort((a, b) => b[1].length - a[1].length);
    const tiersPresent = [...new Set(brandOrder.map(([b]) => tierOfBrand(b)))]
      .sort((a, b) => (a ? 0 : 1) - (b ? 0 : 1) || String(a).localeCompare(String(b)));
    const hasTiers = tiersPresent.some(Boolean);
    const brandChips = hasTiers
      ? tiersPresent.map(t => {
          const mine = brandOrder.filter(([b]) => tierOfBrand(b) === t);
          if (!mine.length) return "";
          return `<div class="tiergrp"><span class="tlabel">${esc(t || "Untiered")}</span>` +
            mine.map(([b, ii]) => `<a class="bchip" href="#b${brandOrder.findIndex(x => x[0] === b)}">${esc(b)} <span>${ii.length}</span></a>`).join("") +
            `</div>`;
        }).join("")
      : brandOrder.map(([b, ii], n) => `<a class="bchip" href="#b${n}">${esc(b)} <span>${ii.length}</span></a>`).join("");
    const brandSecs = brandOrder.map(([b, ii], n) => {
      const byCat = new Map();
      ii.forEach(i => {
        const c = raws[i].category || "";
        if (!byCat.has(c)) byCat.set(c, []);
        byCat.get(c).push(i);
      });
      const inner = [...byCat.entries()].sort((a, b) => b[1].length - a[1].length)
        .map(([cat, jj]) => `${cat ? `<div class="bsub">${esc(cat)} <span>${jj.length}</span></div>` : ""}
          <div class="grid">${jj.map(i => cardArr[i]).join("")}</div>`).join("");
      const tier = tierOfBrand(b);
      return `<div class="bsec" id="b${n}">
        <div class="bhero"><h3>${esc(b)}${tier ? `<em class="tierbadge">${esc(tier)}</em>` : ""}</h3>
          <span>${ii.length} products · ${byCat.size} categories</span></div>
        ${inner}</div>`;
    }).join("");

    const secHead = (kicker, titleText) => `<div class="edhead">
      <div><span class="kicker">${esc(kicker)}</span><h2 class="big">${esc(titleText)}</h2></div>
      <span class="weektag">${esc(when)}</span></div>`;

    /* The shell the designer asked for: a top bar that names what this is, a
       row of section pills, a filter rail down the left, and the work in the
       middle. The three sections that already existed keep their contents —
       what changed is that they now sit inside a dashboard rather than under a
       numbered rail. */
    const fibTop = agg.fiberPresence.slice(0, 8).map((r, i2) => ({
      key: r.key, value: r.pct, label: r.pct + "%", color: SERIES[i2 % SERIES.length] }));
    const catRows = agg.categoryShare.slice(0, 8).map(r => ({ key: r.key, value: r.value, label: r.value }));
    const brandRows = agg.brandShare.slice(0, 8).map(r => ({ key: r.key, value: r.value, label: r.value }));
    const colRows = agg.colorFreq.slice(0, 8).map(r => ({
      key: r.key, value: r.value, label: r.value, color: swatchFor(r.key) || SERIES[2] }));
    const withFabric = norm.filter(p => p.fibers.length).length;

    const heroChips = [
      `${agg.count.toLocaleString()} products`,
      `${agg.brandShare.length} brands`,
      `${agg.categoryShare.length} categories`,
      agg.medianPrice != null ? `median ${money(agg.medianPrice)}` : "",
    ].filter(Boolean).map(t => `<span class="hchip">${esc(t)}</span>`).join("");

    const sel = (id, label, rows) => `<div class="fgrp"><label for="${id}">${esc(label)}</label>
      <select id="${id}"><option value="">All ${esc(label.toLowerCase())}</option>${
        rows.map(r => `<option value="${esc(r.key)}">${esc(r.key)} (${r.value})</option>`).join("")}</select></div>`;

    const pulse = `
<header class="topbar">
  <div class="topline">
    <div class="brand"><div class="bmark">ML</div>
      <div><b>${esc(title)}</b><span>${esc([meta.scope, meta.period].filter(Boolean).join(" · ") || "Market Lens")}</span></div></div>
    <div class="tsearch"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 3a7 7 0 1 1-4.2 12.6l-2.1 2.1-1.4-1.4 2.1-2.1A7 7 0 0 1 10 3m0 2a5 5 0 1 0 0 10 5 5 0 0 0 0-10"/></svg>
      <input id="q" type="search" placeholder="Search products, brands, categories or fabrics…"></div>
    <span class="tstamp">${esc(when)}</span>
  </div>
  <nav class="pills">
    <button class="nv on" data-s="over">Overview</button>
    <button class="nv" data-s="new">New In</button>
    <button class="nv" data-s="brand">By Brand</button>
    <button class="nv" data-s="lab">LAB</button>
  </nav>
</header>
<div class="shell">
  <aside class="rail">
    <div class="rhead"><b>FILTERS</b><button id="fclear" type="button">Clear all</button></div>
    ${sel("fbrand", "Brand", agg.brandShare)}
    ${sel("fcat", "Category", agg.categoryShare)}
    ${sel("ffab", "Fabric", agg.fiberPresence.map(r => ({ key: r.key, value: r.count != null ? r.count : r.pct })))}
    <div class="rnote"><b>${agg.count.toLocaleString()} source rows</b>
      <span>${esc(meta.source || "collected by Market Lens")}</span>
      <span>${withFabric} of ${agg.count} carry a composition read from the shop's own page. Nothing here is inferred.</span></div>
  </aside>
  <div class="content">
    <section data-sec="over">
      <div class="hero">
        <span class="heyebrow">EXECUTIVE OVERVIEW</span>
        <h1>${esc(meta.scope || "This week")},<br>decoded.</h1>
        <p>A single view of the fabric, colour, brand and price decisions in the assortment collected for this list.</p>
        <div class="hchips">${heroChips}</div>
      </div>
      <div class="dtiles">
        ${dtile("Total products", agg.count.toLocaleString(), "unique product URLs", true)}
        ${dtile("Brands", String(agg.brandShare.length), agg.brandShare.length ? "most: " + agg.brandShare[0].key : "")}
        ${dtile("Categories", String(agg.categoryShare.length), "as filed by the list")}
        ${dtile("Median price", agg.medianPrice != null ? money(agg.medianPrice) : "—",
          agg.minPrice != null ? money(agg.minPrice) + " – " + money(agg.maxPrice) : "")}
        ${dtile("On sale", agg.onSalePct + "%", agg.avgDiscountPct != null ? Math.round(agg.avgDiscountPct) + "% average markdown" : "nothing discounted")}
        ${dtile("Fabric known", agg.compositionKnownPct + "%", withFabric + " of " + agg.count + " styles")}
        ${dtile("Distinct colours", String(agg.distinctColors), "across the assortment")}
      </div>

      <div class="shead"><h2>Assortment architecture</h2>
        <p>Every figure is counted from the products collected — no estimates, no sampling.</p></div>

      <div class="pgrid">
        <section class="panel"><div class="ptitle"><b>Fabric ranking</b><span>share of products using each fibre</span></div>
          ${rankRows(fibTop)}</section>
        <section class="panel"><div class="ptitle"><b>Category ranking</b><span>styles per category</span></div>
          ${rankRows(catRows)}</section>
      </div>
      <div class="pgrid">
        <section class="panel"><div class="ptitle"><b>Price distribution</b><span>current selling price</span></div>
          ${histogram(agg.priceHistogram) || `<p class="sub">No price data.</p>`}</section>
        <section class="panel"><div class="ptitle"><b>Fibre family mix</b><span>primary fibre across valid compositions</span></div>
          ${donut(fibTop, withFabric, "with fabric")}</section>
      </div>
      <div class="pgrid">
        <section class="panel"><div class="ptitle"><b>Brand ranking</b><span>styles per brand</span></div>
          ${rankRows(brandRows)}</section>
        <section class="panel"><div class="ptitle"><b>Colour frequency</b><span>colourways named by the shops</span></div>
          ${rankRows(colRows)}</section>
      </div>

      <section class="panel wide"><div class="ptitle"><b>Decision signals</b><span>stated from the figures above, nothing inferred</span></div>
        <div class="sigs">
          ${agg.fiberPresence.length ? signal("01", "Fabric anchor", agg.fiberPresence[0].key,
            `${agg.fiberPresence[0].pct}% of products with a composition use it.`, "a") : ""}
          ${agg.categoryShare.length ? signal("02", "Assortment weight", agg.categoryShare[0].key,
            `${agg.categoryShare[0].value} of ${agg.count} products sit in this category.`, "b") : ""}
          ${agg.brandShare.length ? signal("03", "Largest drop", agg.brandShare[0].key,
            `${agg.brandShare[0].value} products, the widest footprint in this list.`, "c") : ""}
        </div></section>

      <div class="shead"><h2>Representative products</h2>
        <p>The assortment as collected, in the order the shops showed it.</p></div>
      <div class="grid wall">${cardArr.slice(0, 24).join("")}</div>
    </section>

    <section data-sec="new">
      ${secHead(`${agg.count.toLocaleString()} new arrivals · by first collected date`, "New In")}
      ${tierChips}
      ${feedChips}
      ${newIn || `<p class="sub">No products.</p>`}
    </section>
    <section data-sec="brand">
      ${secHead(`${brandOrder.length} brand profiles`, "By Brand")}
      <div class="bchips">${brandChips}</div>
      ${brandSecs}
    </section>
    <section data-sec="lab">
      ${secHead("result analysis · every figure computed from collected data", "LAB")}
      ${meta.labHtml || charts}
    </section>
    <footer>
      This file holds the information exactly as it was when generated. Images and figures
      are stored inside it, so it opens the same with no internet and after the original shop
      is gone.<br>
      Generated ${esc(when)}${meta.source ? " · source: " + esc(meta.source) : ""}${
        meta.subtitle ? " · " + esc(meta.subtitle) : ""}
    </footer>
  </div>
</div>
<script>
(function () {
  var nav = document.querySelectorAll(".nv"), secs = document.querySelectorAll("[data-sec]");
  function show(id) {
    for (var i = 0; i < nav.length; i++) nav[i].classList.toggle("on", nav[i].dataset.s === id);
    for (var j = 0; j < secs.length; j++) secs[j].style.display = secs[j].dataset.sec === id ? "" : "none";
  }
  for (var i = 0; i < nav.length; i++) nav[i].addEventListener("click", function () { show(this.dataset.s); });

  // brand filter for New In: hide the groups of other brands, and hide a day
  // once nothing is left in it, so the date headers never lie about the count
  var bChips = document.querySelectorAll(".fch:not(.tch)");
  var tChips = document.querySelectorAll(".fch.tch");
  var curB = "", curT = "";
  function applyFilter() {
    for (var i = 0; i < bChips.length; i++) bChips[i].classList.toggle("on", bChips[i].dataset.b === curB);
    for (var j = 0; j < tChips.length; j++) tChips[j].classList.toggle("on", tChips[j].dataset.t === curT);
    var days = document.querySelectorAll("[data-sec='new'] .day");
    for (var d = 0; d < days.length; d++) {
      var grps = days[d].querySelectorAll(".bgrp"), shown = 0, n = 0;
      for (var g = 0; g < grps.length; g++) {
        var keep = (!curB || grps[g].dataset.brand === curB) &&
                   (!curT || grps[g].dataset.tier === curT);
        grps[g].style.display = keep ? "" : "none";
        if (keep) { shown++; n += grps[g].querySelectorAll(".p").length; }
      }
      days[d].style.display = shown ? "" : "none";
      var c = days[d].querySelector(".dcount");
      if (c) c.textContent = String((curB || curT) ? n : c.dataset.all);
    }
    // a brand chip that no longer belongs to the chosen tier would be a dead end
    for (var q = 0; q < bChips.length; q++) {
      var bn = bChips[q].dataset.b;
      var any = !bn || !curT || document.querySelector("[data-sec='new'] .bgrp[data-brand='" + bn.replace(/'/g, "\\'") + "'][data-tier='" + curT + "']");
      bChips[q].style.display = any ? "" : "none";
    }
  }
  for (var k = 0; k < bChips.length; k++)
    bChips[k].addEventListener("click", function () { curB = this.dataset.b; applyFilter(); });
  for (var t2 = 0; t2 < tChips.length; t2++)
    tChips[t2].addEventListener("click", function () { curT = this.dataset.t; curB = ""; applyFilter(); });
  // brand anchor chips need the brand section visible first
  document.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest(".bchip");
    if (a) show("brand");
  });
  /* The rail filters narrow the product wall and the two feeds together —
     one filter, every view, the same rule the LAB scope follows. */
  var q = document.getElementById("q");
  var fs = { brand: document.getElementById("fbrand"), cat: document.getElementById("fcat"),
             fab: document.getElementById("ffab") };
  function railFilter() {
    var b = fs.brand ? fs.brand.value : "", c = fs.cat ? fs.cat.value : "",
        f = fs.fab ? fs.fab.value : "", t = q ? q.value.trim().toLowerCase() : "";
    var cards = document.querySelectorAll(".p");
    for (var i = 0; i < cards.length; i++) {
      var el = cards[i], txt = (el.textContent || "").toLowerCase();
      var keep = (!b || txt.indexOf(b.toLowerCase()) >= 0) &&
                 (!c || txt.indexOf(c.toLowerCase()) >= 0) &&
                 (!f || txt.indexOf(f.toLowerCase()) >= 0) &&
                 (!t || txt.indexOf(t) >= 0);
      el.style.display = keep ? "" : "none";
    }
  }
  ["brand", "cat", "fab"].forEach(function (k) {
    if (fs[k]) fs[k].addEventListener("change", railFilter);
  });
  if (q) q.addEventListener("input", railFilter);
  var fc = document.getElementById("fclear");
  if (fc) fc.addEventListener("click", function () {
    ["brand", "cat", "fab"].forEach(function (k) { if (fs[k]) fs[k].value = ""; });
    if (q) q.value = ""; railFilter();
  });
  show("over");
})();
</script>`;

    const bodyByTemplate = {
      standard: pulse,
      lookbook: `<div class="lbgrid">${plates}</div>` + summary +
        `<div class="two"><div><h2>Fabric</h2>${fibers.length ? barsH(fibers, { labelW: 140 }) : ""}</div>` +
        `<div><h2>Colours</h2>${colors.length ? barsH(colors, { labelW: 140 }) : ""}</div></div>`,
      data: summary + `<h2>Product detail (${agg.count.toLocaleString()})</h2>${table}` + charts,
    };
    const body = bodyByTemplate[tmpl] || bodyByTemplate.standard;
    const isPulse = body === pulse;

    return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — ${esc(when)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin:0; background:#f4f3f0; color:${INK};
    font:14px/1.6 system-ui,-apple-system,"Segoe UI","Apple SD Gothic Neo",sans-serif; }
  .sheet { max-width:960px; margin:0 auto; background:${SURF}; padding:38px 40px 56px;
    box-shadow:0 1px 3px rgba(0,0,0,.07); }
  header { border-bottom:2px solid ${INK}; padding-bottom:14px; margin-bottom:24px; }
  h1 { font-size:25px; margin:0 0 5px; letter-spacing:-.02em; }
  .sub { color:${INK2}; font-size:13px; }
  .meta { color:${MUTED}; font-size:12px; margin-top:7px; }
  h2 { font-size:15px; margin:32px 0 12px; padding-bottom:6px; border-bottom:1px solid ${GRID};
    letter-spacing:-.01em; }
  .tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(132px,1fr)); gap:11px; margin-top:6px; }
  .tile { border:1px solid ${GRID}; border-radius:10px; padding:12px 13px; background:#fff; }
  .tl { font-size:11.5px; color:${MUTED}; }
  .tv { font-size:21px; font-weight:650; letter-spacing:-.02em; margin-top:2px; }
  .ts { font-size:11px; color:${MUTED}; margin-top:1px; }
  .two { display:grid; grid-template-columns:1fr 1fr; gap:14px; margin-bottom:14px; }
  @media (max-width:760px) { .two { grid-template-columns:1fr; } .sheet { padding:22px 18px 40px; } }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(132px,1fr)); gap:13px; }
  .p { margin:0; }
  .p img, .p .ph { width:100%; aspect-ratio:3/4; object-fit:cover; border-radius:8px;
    background:${GRID}; display:block; }
  .p figcaption { display:flex; flex-direction:column; gap:1px; margin-top:6px; }
  .pb { font-size:10px; color:${MUTED}; text-transform:uppercase; letter-spacing:.04em; }
  .pn { font-size:11.5px; line-height:1.35; overflow:hidden; display:-webkit-box;
    -webkit-line-clamp:2; -webkit-box-orient:vertical; }
  .pp { font-size:11.5px; font-weight:600; }
  .pp.sale { color:#d03b3b; } .pp s { color:${MUTED}; font-weight:400; }
  .pf { font-size:10.5px; color:${INK2}; }
  footer { margin-top:40px; padding-top:14px; border-top:1px solid ${GRID};
    color:${MUTED}; font-size:11.5px; }
  /* lookbook — images lead, text recedes */
  .lbgrid { display:grid; grid-template-columns:repeat(auto-fill,minmax(215px,1fr)); gap:20px; margin-bottom:8px; }
  .lb { margin:0; }
  .lb img, .lb .ph { width:100%; aspect-ratio:3/4; object-fit:cover; border-radius:3px;
    background:${GRID}; display:block; }
  .lb figcaption { display:flex; flex-direction:column; gap:2px; margin-top:9px; }
  .lb figcaption b { font-size:12.5px; font-weight:600; line-height:1.35; }
  .lb figcaption span { font-size:11.5px; color:${INK2}; }
  .lb .lf { font-size:11px; color:${MUTED}; }
  /* data sheet — everything collected, compact */
  .tb { width:100%; border-collapse:collapse; font-size:11.5px; }
  .tb th { text-align:left; font-weight:600; color:${INK2}; border-bottom:1.5px solid ${INK};
    padding:7px 8px; white-space:nowrap; }
  .tb td { border-bottom:1px solid ${GRID}; padding:7px 8px; vertical-align:top; }
  .tb tr:nth-child(even) td { background:#faf9f6; }
  .tb .tn { min-width:180px; }
  .tb .num { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
  .tb .num.sale { color:#d03b3b; font-weight:600; }
  .tb img.tt { width:40px; height:53px; object-fit:cover; border-radius:4px; display:block; }
  /* pulse — side rail + three sections, the weekly-edit read */
  .shell { display:grid; grid-template-columns:176px 1fr; min-height:100vh; }
  .rail { background:#eef3f1; color:#20302b; padding:22px 15px; position:sticky; top:0;
    height:100vh; display:flex; flex-direction:column; border-right:1px solid #dfe7e4; }
  .logo { display:flex; gap:9px; align-items:center; margin-bottom:26px; }
  .logo i { font-style:normal; width:30px; height:30px; border-radius:50%; background:#1f8c73;
    color:#fff; display:flex; align-items:center; justify-content:center; font-weight:800; }
  .logo span { font-size:11.5px; font-weight:800; letter-spacing:.14em; line-height:1.3; }
  .rail nav { display:flex; flex-direction:column; gap:2px; }
  .nv { text-align:left; border:0; background:none; color:#5c6b66; padding:10px 12px;
    border-radius:11px; font-size:12.5px; font-weight:600; letter-spacing:.02em; cursor:pointer; }
  .nv:hover { background:rgba(255,255,255,.65); }
  .nv.on { background:#fff; color:#12201c; box-shadow:0 1px 3px rgba(20,40,35,.10); }
  .railfoot { margin-top:auto; font-size:9.5px; letter-spacing:.14em; color:#77877f;
    text-transform:uppercase; }
  .content { padding:30px 34px 70px; background:#f7f7f4; min-width:0; }

  /* KPI cards — headline number beside the shape of the same measure */
  .kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); gap:14px;
    margin:4px 0 18px; }
  .kpi { border-radius:16px; padding:14px 16px 13px; border:1px solid rgba(20,20,20,.05); }
  .kpi.k1 { background:#e3f2ee; } .kpi.k2 { background:#e8ecfb; }
  .kpi.k3 { background:#fbe9ef; } .kpi.k4 { background:#fdf0dd; }
  .kl { font-size:11.5px; color:${INK2}; font-weight:600; }
  .krow { display:flex; align-items:flex-end; justify-content:space-between; gap:10px; margin-top:6px; }
  .kv { font-size:26px; font-weight:700; letter-spacing:-.03em; line-height:1; }
  .ks { font-size:11px; color:${MUTED}; margin-top:6px; }
  .spark { width:110px; height:34px; flex:none; opacity:.95; }

  /* every chart block is a card floating on the page ground */
  .card { background:#fff; border:1px solid ${GRID}; border-radius:16px; padding:16px 18px 18px;
    margin-bottom:14px; box-shadow:0 1px 2px rgba(20,20,20,.04); }
  .card h3 { font-size:13px; margin:0 0 12px; font-weight:650; letter-spacing:-.01em; }
  .two > .card { margin-bottom:0; }
  .edhead { display:flex; align-items:flex-end; justify-content:space-between; gap:14px;
    margin:2px 0 18px; flex-wrap:wrap; }
  .kicker { display:block; font-size:10px; text-transform:uppercase; letter-spacing:.16em;
    color:${MUTED}; margin-bottom:7px; }
  h2.big { font-size:34px; font-weight:750; letter-spacing:-.03em; margin:0; line-height:1;
    border:0; padding:0; }
  .weektag { font-size:10px; letter-spacing:.12em; border:1px solid ${INK};
    padding:4px 9px; white-space:nowrap; align-self:center; }
  .day { margin-bottom:8px; }
  .dh { display:flex; align-items:baseline; gap:10px; border-bottom:2px solid ${INK};
    padding:22px 0 7px; margin-bottom:4px; }
  .dh b { font-size:16px; letter-spacing:-.01em; }
  .dh span { color:${MUTED}; font-size:12px; }
  .bsub { display:flex; align-items:baseline; gap:7px; margin:16px 0 9px;
    font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:.06em; }
  .bsub span { color:${MUTED}; font-weight:400; }
  .fchips { display:flex; flex-wrap:wrap; gap:7px; margin:2px 0 4px; }
  .fch { border:1px solid ${GRID}; background:#fff; border-radius:999px; padding:6px 13px;
    font-size:12px; color:${INK}; cursor:pointer; }
  .fch span { color:${MUTED}; margin-left:3px; }
  .fch.on { background:${INK}; color:#fff; border-color:${INK}; }
  .fch.on span { color:rgba(255,255,255,.7); }
  .tchips { margin-bottom:10px; }
  .fch.tch.on { background:#1f8c73; border-color:#1f8c73; }
  .tiergrp { display:flex; flex-wrap:wrap; gap:7px; align-items:center; margin-bottom:8px; }
  .tiergrp .tlabel { font-size:9.5px; letter-spacing:.12em; text-transform:uppercase;
    color:${MUTED}; margin-right:2px; }
  .bhero h3 .tierbadge { font-style:normal; font-size:10px; letter-spacing:.1em;
    text-transform:uppercase; vertical-align:middle; margin-left:10px; padding:3px 9px;
    border:1px solid ${GRID}; border-radius:999px; color:${MUTED}; }
  .bchips { display:flex; flex-wrap:wrap; gap:7px; margin-bottom:8px; }
  .bchip { border:1px solid ${GRID}; border-radius:999px; padding:5px 12px; font-size:12px;
    color:${INK}; text-decoration:none; background:#fff; }
  .bchip span { color:${MUTED}; }
  .bsec { margin-top:26px; }
  .bhero { border-bottom:2px solid ${INK}; padding-bottom:9px; margin-bottom:4px; }
  .bhero h3 { font-size:23px; margin:0 0 2px; letter-spacing:-.02em; }
  .bhero span { color:${MUTED}; font-size:12px; }
  @media (max-width:760px) { .shell { grid-template-columns:1fr; }
    .rail { position:static; height:auto; flex-direction:row; align-items:center; gap:10px;
      border-right:0; border-bottom:1px solid #dfe7e4; }
    .rail nav { flex-direction:row; } .railfoot { display:none; } .content { padding:20px 16px 50px; } }
  /* ---- the LAB, as it is on the workbench ---------------------------------
     The markup in this section is produced by the same function that draws the
     screen, so the figures cannot drift apart. Only the typesetting lives
     here, in the sheet's own editorial idiom: rules instead of shadows,
     squared corners, uppercase micro-labels. */
  [data-sec="lab"] .sec { border:1px solid ${GRID}; padding:12px 14px 13px; margin-bottom:11px; background:#fff; }
  [data-sec="lab"] .sec h3 { font:700 10px/1 Helvetica,Arial,sans-serif; letter-spacing:.14em;
    text-transform:uppercase; color:${MUTED}; padding-bottom:8px; border-bottom:1px solid ${INK};
    margin:0 0 12px; }
  [data-sec="lab"] .sec h3 .sub { font-weight:400; letter-spacing:.02em; text-transform:none;
    font-size:10.5px; color:${MUTED}; margin-left:7px; display:inline; }
  .axcards { display:grid; grid-template-columns:repeat(auto-fill,minmax(210px,1fr)); gap:12px; }
  .axc { border:1px solid ${GRID}; padding:10px 11px 8px; display:flex; flex-direction:column;
    gap:2px; min-width:0; }
  .axch { display:flex; align-items:baseline; gap:8px; }
  .axk { font:700 10px/1.2 Helvetica,Arial,sans-serif; letter-spacing:.11em; text-transform:uppercase;
    flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .axd { font:650 10.5px/1 Helvetica,Arial,sans-serif; color:${MUTED}; font-variant-numeric:tabular-nums; }
  .axd.up { color:#1b7f4d; } .axd.down { color:#8a3c17; }
  .axnum { display:flex; align-items:baseline; gap:5px; margin-top:3px; }
  .axnum b { font:650 26px/1 Helvetica,Arial,sans-serif; letter-spacing:-.03em;
    font-variant-numeric:tabular-nums; }
  .axnum i { font-style:normal; font-size:10.5px; color:${MUTED}; }
  .axmeta { font-size:10.5px; color:${MUTED}; line-height:1.45; min-height:15px; }
  .axc svg.area { display:block; width:100%; height:46px; margin-top:6px; }
  .axc .noarea { font-size:10px; color:${MUTED}; margin-top:10px; height:46px; }
  .axgt { border-top:1px solid ${GRID}; margin-top:auto; padding-top:6px; }
  .axgt .gtlab { font:700 8.5px/1 Helvetica,Arial,sans-serif; letter-spacing:.14em; color:#8a3c17; }
  .axgt .gtq { font-size:10px; color:${MUTED}; margin-left:6px; }
  .axgt .gtv { font:650 11px/1 Helvetica,Arial,sans-serif; float:right; color:#8a3c17; }
  .axgt svg.area { height:26px; margin-top:2px; }
  .axcov { font-size:10.5px; color:${MUTED}; line-height:1.5; margin-top:10px; }
  [data-sec="lab"] .tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr));
    gap:11px; margin:0 0 11px; }
  [data-sec="lab"] .tile { border:1px solid ${GRID}; background:#fff; padding:10px 12px; }
  [data-sec="lab"] .tile .tl { font:700 9px/1 Helvetica,Arial,sans-serif; letter-spacing:.13em;
    text-transform:uppercase; color:${MUTED}; }
  [data-sec="lab"] .tile .tv { font:650 26px/1.1 Helvetica,Arial,sans-serif; margin:5px 0 3px;
    letter-spacing:-.03em; }
  [data-sec="lab"] .tile .ts { font-size:10.5px; color:${MUTED}; }
  table.lg2 { width:100%; border-collapse:collapse; font-size:12px; }
  table.lg2 th { text-align:left; font:700 9px/1 Helvetica,Arial,sans-serif; letter-spacing:.12em;
    text-transform:uppercase; color:${MUTED}; padding:0 8px 7px 0; border-bottom:1px solid ${INK}; }
  table.lg2 td { padding:7px 8px 7px 0; border-bottom:1px solid ${GRID}; vertical-align:top; }
  table.lg2 .num, table.lg2 td.num { text-align:right; font-variant-numeric:tabular-nums; }
  [data-sec="lab"] .foot { font-size:10.5px; color:${MUTED}; line-height:1.6; margin-top:12px; }
  [data-sec="lab"] .none, [data-sec="lab"] .labempty { color:${MUTED}; font-size:12px; padding:14px 0; }
  [data-sec="lab"] .pk, [data-sec="lab"] .pn { color:${MUTED}; font-size:10.5px; }
  [data-sec="lab"] .up { color:#1b7f4d; } [data-sec="lab"] .down { color:#8a3c17; }
  @media print { body { background:#fff; } .sheet { box-shadow:none; max-width:none; }
    .axc, .sec { break-inside:avoid; }
    .p, .lb, .tb tr, .day, .bsec, .card, .kpi { break-inside:avoid; }
    .rail { display:none; } .shell { display:block; }
    [data-sec] { display:block !important; } }

  /* ---- the dashboard the designer asked for ------------------------------
     Their own Material Intelligence sheet: warm paper, one hot accent, soft
     cards on a light ground. It departs from the panel's stark black-on-white
     deliberately and by request — this file is the thing that gets sent on,
     and they chose how it should look. */
  :root { --dbg:#f4f4f0; --dsurf:#fff; --dsurf2:#f8f8f5; --dink:#151713; --dmut:#6f746c;
    --dline:#e4e5de; --dacc:#ff5c35; --dacc2:#ffc247; --dacc3:#84a98c;
    --dsoft:#fff0e9; --dshadow:0 14px 34px rgba(21,23,19,.07); --drad:18px; }
  body { background:var(--dbg); color:var(--dink); }
  .topbar { position:sticky; top:0; z-index:20; background:var(--dbg);
    border-bottom:1px solid var(--dline); padding:14px 26px 0; }
  .topline { display:flex; align-items:center; gap:18px; }
  .brand { display:flex; align-items:center; gap:12px; flex:none; }
  .bmark { width:38px; height:38px; border-radius:12px; background:var(--dink); color:#fff;
    display:flex; align-items:center; justify-content:center; font:700 13px/1 Helvetica,Arial,sans-serif;
    letter-spacing:.04em; }
  .brand b { display:block; font-size:15px; }
  .brand span { display:block; font-size:11.5px; color:var(--dmut); }
  .tsearch { flex:1; min-width:0; position:relative; display:flex; align-items:center; }
  .tsearch svg { position:absolute; left:14px; width:16px; height:16px; fill:var(--dmut); }
  .tsearch input { width:100%; padding:11px 14px 11px 38px; border-radius:12px;
    border:1px solid var(--dline); background:var(--dsurf); font-size:13.5px; color:var(--dink); }
  .tstamp { flex:none; font-size:11.5px; color:var(--dmut); }
  .pills { display:flex; gap:6px; padding:12px 0 10px; flex-wrap:wrap; }
  .pills .nv { border:0; background:none; color:var(--dmut); font:600 13px/1 inherit;
    padding:9px 16px; border-radius:999px; cursor:pointer; }
  .pills .nv:hover { color:var(--dink); }
  .pills .nv.on { background:var(--dink); color:#fff; }

  .shell { display:grid; grid-template-columns:244px 1fr; gap:22px; padding:22px 26px 60px;
    align-items:start; min-height:0; }
  .rail { position:sticky; top:112px; background:var(--dsurf); border:1px solid var(--dline);
    border-radius:var(--drad); box-shadow:var(--dshadow); padding:18px; height:auto;
    display:block; color:var(--dink); }
  .rhead { display:flex; align-items:center; justify-content:space-between; margin-bottom:14px; }
  .rhead b { font:700 11.5px/1 Helvetica,Arial,sans-serif; letter-spacing:.12em; }
  .rhead button { border:0; background:none; color:var(--dacc); font:600 11.5px/1 inherit; cursor:pointer; }
  .fgrp { margin-bottom:12px; }
  .fgrp label { display:block; font-size:11.5px; color:var(--dmut); margin-bottom:5px; }
  .fgrp select { width:100%; padding:9px 10px; border-radius:10px; border:1px solid var(--dline);
    background:var(--dsurf); font-size:13px; color:var(--dink); }
  .rnote { margin-top:16px; padding:12px; border-radius:12px; background:var(--dsurf2);
    font-size:11.5px; line-height:1.55; color:var(--dmut); }
  .rnote b { display:block; color:var(--dink); margin-bottom:3px; }
  .rnote span { display:block; margin-top:6px; }
  .content { padding:0; }

  .hero { position:relative; overflow:hidden; border-radius:var(--drad); padding:34px 36px 30px;
    color:#fff; background:linear-gradient(120deg,#1b1d19 0%,#2b241f 46%,#7a3a22 100%); }
  .heyebrow { font:700 11.5px/1 Helvetica,Arial,sans-serif; letter-spacing:.22em; opacity:.72; }
  .hero h1 { margin:14px 0 10px; font-size:46px; line-height:1.02; letter-spacing:-.02em; color:#fff; }
  .hero p { margin:0; max-width:60ch; font-size:13.5px; color:rgba(255,255,255,.78); }
  .hchips { display:flex; flex-wrap:wrap; gap:8px; margin-top:18px; }
  .hchip { padding:7px 13px; border-radius:999px; font-size:11.5px;
    background:rgba(255,255,255,.12); color:rgba(255,255,255,.9); }

  .dtiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(148px,1fr)); gap:12px; margin:14px 0 26px; }
  .dt { background:var(--dsurf); border:1px solid var(--dline); border-radius:14px; padding:14px 15px;
    box-shadow:var(--dshadow); }
  .dt.lead { background:var(--dacc); border-color:var(--dacc); color:#fff; }
  .dtl { display:block; font:700 10.5px/1.3 Helvetica,Arial,sans-serif; letter-spacing:.11em;
    text-transform:uppercase; color:var(--dmut); }
  .dt.lead .dtl { color:rgba(255,255,255,.86); }
  .dtv { display:block; font-size:30px; line-height:1.1; margin:9px 0 5px; letter-spacing:-.02em; }
  .dts { display:block; font-size:11px; color:var(--dmut); }
  .dt.lead .dts { color:rgba(255,255,255,.85); }

  .shead { margin:26px 0 12px; }
  .shead h2 { margin:0; font-size:22px; letter-spacing:-.01em; }
  .shead p { margin:5px 0 0; font-size:12.5px; color:var(--dmut); }

  .pgrid { display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-bottom:16px;
    align-items:start; }
  .panel { background:var(--dsurf); border:1px solid var(--dline); border-radius:var(--drad);
    box-shadow:var(--dshadow); padding:18px 20px 20px; }
  .panel.wide { grid-column:1/-1; }
  .ptitle { margin-bottom:14px; }
  .ptitle b { display:block; font-size:15px; }
  .ptitle span { display:block; font-size:11.5px; color:var(--dmut); margin-top:3px; }

  .rank { display:flex; flex-direction:column; gap:9px; }
  .rrow { display:grid; grid-template-columns:minmax(90px,168px) 1fr auto; gap:12px; align-items:center; }
  .rk { font-size:12.5px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .rt { height:9px; border-radius:999px; background:var(--dsurf2); overflow:hidden; }
  .rt i { display:block; height:100%; border-radius:999px; background:var(--dacc); }
  .rv { font-size:11.5px; color:var(--dmut); font-variant-numeric:tabular-nums; }
  .rv em { font-style:normal; }

  .donutwrap { display:flex; align-items:center; gap:20px; flex-wrap:wrap; }
  .donut { position:relative; width:140px; height:140px; flex:none; }
  .donut svg { width:140px; height:140px; }
  .dhole { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center;
    justify-content:center; text-align:center; }
  .dhole b { font-size:24px; line-height:1; }
  .dhole span { font-size:10px; color:var(--dmut); margin-top:3px; }
  .dlegend { list-style:none; margin:0; padding:0; flex:1; min-width:150px;
    display:flex; flex-direction:column; gap:6px; }
  .dlegend li { display:flex; align-items:center; gap:8px; font-size:12px; }
  .dlegend i { width:9px; height:9px; border-radius:3px; flex:none; }
  .dlegend span { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .dlegend b { color:var(--dmut); font-weight:600; font-variant-numeric:tabular-nums; }
  .dnote { flex-basis:100%; margin:12px 0 0; font-size:11px; color:var(--dmut); line-height:1.5; }
  /* the histogram is shared with the other templates; only its colour is this
     sheet's, so the bars stop being the one blue thing on a warm page */
  .panel .hbar { fill:var(--dacc); }

  .sigs { display:grid; grid-template-columns:repeat(auto-fit,minmax(210px,1fr)); gap:12px; }
  .sig { border-radius:14px; padding:16px 17px; }
  .sig.a { background:var(--dsoft); } .sig.b { background:#eef4ef; } .sig.c { background:#fff6e2; }
  .sk { display:block; font:700 10.5px/1 Helvetica,Arial,sans-serif; letter-spacing:.08em;
    color:var(--dacc); text-transform:uppercase; }
  .sig b { display:block; font-size:19px; margin:9px 0 7px; letter-spacing:-.01em; }
  .sl { display:block; font-size:12px; color:var(--dmut); line-height:1.5; }

  .grid.wall { display:grid; grid-template-columns:repeat(auto-fill,minmax(190px,1fr)); gap:14px; }
  .content .p { background:var(--dsurf); border:1px solid var(--dline); border-radius:14px;
    overflow:hidden; box-shadow:var(--dshadow); }
  .content .p img, .content .p .ph { border-radius:0; }
  .content footer { margin-top:34px; padding-top:18px; border-top:1px solid var(--dline);
    font-size:11.5px; color:var(--dmut); line-height:1.6; }

  @media (max-width:980px) {
    .shell { grid-template-columns:1fr; }
    .rail { position:static; }
    .pgrid { grid-template-columns:1fr; }
    .hero h1 { font-size:34px; }
  }
  @media print {
    .topbar, .rail { display:none; }
    .shell { display:block; padding:0; }
    .panel, .dt { box-shadow:none; }
    [data-sec] { display:block !important; }
  }
</style></head>
<body>${isPulse ? body : `<div class="sheet">
<header>
  <h1>${esc(title)}</h1>
  ${meta.subtitle ? `<div class="sub">${esc(meta.subtitle)}</div>` : ""}
  <div class="meta">as of ${esc(when)} · ${agg.count.toLocaleString()} products${
    scopeBits.length ? " · " + esc(scopeBits.join(" · ")) : ""}</div>
</header>

${body}

<footer>
  This file holds the information exactly as it was when generated. Images and figures
  are stored inside it, so it opens the same with no internet and after the original shop
  is gone.<br>
  Generated ${esc(when)}${meta.source ? " · source: " + esc(meta.source) : ""}
</footer>
</div>`}</body></html>`;
  }

  const API = { build, barsH, histogram, swatchFor };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  root.ReportGen = API;
})(typeof self !== "undefined" ? self : this);
