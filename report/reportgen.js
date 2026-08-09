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
      return `<rect x="${bx + 1}" y="${by}" width="${Math.max(1, bw - 3)}" height="${h}" rx="4" fill="${SERIES[0]}"/>
        <text x="${bx + bw / 2}" y="${H - padB + 13}" text-anchor="middle" font-size="10" fill="${MUTED}">$${Math.round(x.lo)}</text>`;
    }).join("");
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="가격 분포">
      ${gridLines}${cols}
      <line x1="${padL}" y1="${H - padB}" x2="${W - 8}" y2="${H - padB}" stroke="#c3c2b7" stroke-width="1"/></svg>`;
  }

  function statTile(label, value, sub) {
    return `<div class="tile"><div class="tl">${esc(label)}</div><div class="tv">${esc(value)}</div>${
      sub ? `<div class="ts">${esc(sub)}</div>` : ""}</div>`;
  }

  /* items: catalog rows (raw fields). images: { [product_url]: dataUri }.
     meta: { title, subtitle, period, scope, generatedAt } */
  function build(items, images, meta) {
    meta = meta || {}; images = images || {};
    const agg = Calc.aggregate(items);
    const norm = (items || []).map(Calc.normItem);
    const title = meta.title || "마켓 리서치 리포트";
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
          <span class="pn">${esc(p.name || "(이름 없음)")}</span>
          ${p.price != null ? `<span class="pp${sale ? " sale" : ""}">${money(p.price)}${
            sale ? ` <s>${money(p.priceWas)}</s>` : ""}</span>` : ""}
          ${p.fibers.length ? `<span class="pf">${esc(p.fibers.map(f => (f.pct != null ? f.pct + "% " : "") + f.fiber).join(", "))}</span>` : ""}
        </figcaption></figure>`;
    }).join("");

    // Data-sheet table: every collected field, compact, for close analysis.
    const table = `<table class="tb"><thead><tr>
        <th></th><th>브랜드</th><th>상품명</th><th>카테고리</th><th>현재가</th><th>정가</th>
        <th>원단</th><th>색상</th><th>사이즈</th></tr></thead><tbody>` +
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
    if (agg.brandShare.length) scopeBits.push(`브랜드 ${agg.brandShare.length}`);
    if (agg.categoryShare.length) scopeBits.push(`카테고리 ${agg.categoryShare.length}`);

    // Templates change PRESENTATION only — the figures above are identical in
    // all three, so two teams reading different layouts never see different
    // numbers. standard = stats+charts+grid, lookbook = images lead,
    // data = full table for close analysis.
    const tmpl = meta.template || "standard";
    const summary = `<h2>요약</h2>
<div class="tiles">
  ${statTile("수집 상품", agg.count.toLocaleString() + "개")}
  ${statTile("평균가", money(agg.avgPrice), agg.medianPrice != null ? "중앙값 " + money(agg.medianPrice) : "")}
  ${statTile("가격대", agg.minPrice != null ? money(agg.minPrice) + " – " + money(agg.maxPrice) : "—")}
  ${statTile("세일 중", agg.onSalePct + "%", agg.avgDiscountPct != null ? "평균 " + Math.round(agg.avgDiscountPct) + "% 인하" : "")}
  ${statTile("원단 확인", agg.compositionKnownPct + "%", "조성 수집된 비율")}
  ${statTile("색상 종류", agg.distinctColors + "종")}
</div>`;
    const charts = `<h2>가격 분포</h2>
${histogram(agg.priceHistogram) || `<p class="sub">가격 정보가 없습니다.</p>`}
<div class="two">
  <div><h2>원단 (상품 중 사용 비율)</h2>
    ${fibers.length ? barsH(fibers, { alt: "원단별 사용 비율", labelW: 140 }) : `<p class="sub">조성 정보가 없습니다.</p>`}</div>
  <div><h2>색상 빈도</h2>
    ${colors.length ? barsH(colors, { alt: "색상 빈도", labelW: 140 }) : `<p class="sub">색상 정보가 없습니다.</p>`}</div>
</div>
<div class="two">
  <div><h2>브랜드</h2>${brands.length ? barsH(brands, { alt: "브랜드별 상품 수", labelW: 140 }) : ""}</div>
  <div><h2>카테고리</h2>${cats.length ? barsH(cats, { alt: "카테고리별 상품 수", labelW: 140 }) : ""}</div>
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
          <span class="pn">${esc(p.name || "(이름 없음)")}</span>
          ${p.price != null ? `<span class="pp${p.onSale ? " sale" : ""}">${money(p.price)}${
            p.onSale ? ` <s>${money(p.priceWas)}</s>` : ""}</span>` : ""}
          ${p.fibers.length ? `<span class="pf">${esc(p.fibers.map(f => (f.pct != null ? f.pct + "% " : "") + f.fiber).join(", "))}</span>` : ""}
        </figcaption></figure>`;
    });
    const raws = items || [];
    const DOW = ["일", "월", "화", "수", "목", "금", "토"];
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
        const b = raws[i].brand || "기타";
        if (!byBrand.has(b)) byBrand.set(b, []);
        byBrand.get(b).push(i);
      });
      const groups = [...byBrand.entries()].sort((a, b) => b[1].length - a[1].length)
        .map(([brand, ii]) => `<div class="bsub">${esc(brand)} <span>${ii.length}</span></div>
          <div class="grid">${ii.map(i => cardArr[i]).join("")}</div>`).join("");
      return `<div class="day"><div class="dh"><b>${k ? esc(dayLabel(k)) : "수집일 미상"}</b>
        <span>${idxs.length}개</span></div>${groups}</div>`;
    }).join("");

    // BY BRAND: brand (biggest first) → category → cards, with anchor chips.
    const byBrandAll = new Map();
    raws.forEach((r, i) => {
      const b = r.brand || "기타";
      if (!byBrandAll.has(b)) byBrandAll.set(b, []);
      byBrandAll.get(b).push(i);
    });
    const brandOrder = [...byBrandAll.entries()].sort((a, b) => b[1].length - a[1].length);
    const brandChips = brandOrder.map(([b, ii], n) =>
      `<a class="bchip" href="#b${n}">${esc(b)} <span>${ii.length}</span></a>`).join("");
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
      return `<div class="bsec" id="b${n}">
        <div class="bhero"><h3>${esc(b)}</h3><span>상품 ${ii.length}개 · 카테고리 ${byCat.size}개</span></div>
        ${inner}</div>`;
    }).join("");

    const secHead = (kicker, titleText) => `<div class="edhead">
      <div><span class="kicker">${esc(kicker)}</span><h2 class="big">${esc(titleText)}</h2></div>
      <span class="weektag">${esc(when)}</span></div>`;

    const pulse = `
<div class="shell">
  <aside class="rail">
    <div class="logo"><i>M</i><span>MARKET<br>LENS</span></div>
    <nav>
      <button class="nv on" data-s="new">01 &nbsp;New In</button>
      <button class="nv" data-s="brand">02 &nbsp;By Brand</button>
      <button class="nv" data-s="lab">03 &nbsp;LAB</button>
    </nav>
    <div class="railfoot">WEEKLY EDIT · ${esc(when)}</div>
  </aside>
  <div class="content">
    <section data-sec="new">
      ${secHead(`${agg.count.toLocaleString()} new arrivals · 처음 수집된 날짜 기준`, "New In")}
      ${newIn || `<p class="sub">상품이 없습니다.</p>`}
    </section>
    <section data-sec="brand">
      ${secHead(`${brandOrder.length} brand profiles`, "By Brand")}
      <div class="bchips">${brandChips}</div>
      ${brandSecs}
    </section>
    <section data-sec="lab">
      ${secHead("result analysis · 모든 수치는 수집 데이터에서 계산", "LAB")}
      ${summary}${charts}
    </section>
    <footer>
      이 파일은 생성 시점의 정보를 그대로 담고 있습니다. 이미지와 수치가 파일 안에 저장되어
      있어 인터넷 연결이나 원본 쇼핑몰 없이도 언제든 동일하게 열립니다.<br>
      생성: ${esc(when)}${meta.source ? " · 출처: " + esc(meta.source) : ""}${
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
  // brand anchor chips need the brand section visible first
  document.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest(".bchip");
    if (a) show("brand");
  });
  show("new");
})();
</script>`;

    const bodyByTemplate = {
      standard: pulse,
      lookbook: `<div class="lbgrid">${plates}</div>` + summary +
        `<div class="two"><div><h2>원단</h2>${fibers.length ? barsH(fibers, { labelW: 140 }) : ""}</div>` +
        `<div><h2>색상</h2>${colors.length ? barsH(colors, { labelW: 140 }) : ""}</div></div>`,
      data: summary + `<h2>상품 상세 (${agg.count.toLocaleString()})</h2>${table}` + charts,
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
  .two { display:grid; grid-template-columns:1fr 1fr; gap:26px; }
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
  .rail { background:#101010; color:#f2f1ec; padding:22px 16px; position:sticky; top:0;
    height:100vh; display:flex; flex-direction:column; }
  .logo { display:flex; gap:9px; align-items:center; margin-bottom:26px; }
  .logo i { font-style:normal; width:30px; height:30px; border-radius:50%; background:#f2f1ec;
    color:#101010; display:flex; align-items:center; justify-content:center; font-weight:800; }
  .logo span { font-size:11.5px; font-weight:800; letter-spacing:.14em; line-height:1.3; }
  .rail nav { display:flex; flex-direction:column; gap:2px; }
  .nv { text-align:left; border:0; background:none; color:#8f8e88; padding:9px 10px;
    border-radius:8px; font-size:12.5px; font-weight:600; letter-spacing:.02em; cursor:pointer; }
  .nv.on { background:#2a2a2a; color:#fff; }
  .railfoot { margin-top:auto; font-size:9.5px; letter-spacing:.14em; color:#7c7b75;
    text-transform:uppercase; }
  .content { padding:34px 40px 70px; background:${SURF}; min-width:0; }
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
  .bchips { display:flex; flex-wrap:wrap; gap:7px; margin-bottom:8px; }
  .bchip { border:1px solid ${GRID}; border-radius:999px; padding:5px 12px; font-size:12px;
    color:${INK}; text-decoration:none; background:#fff; }
  .bchip span { color:${MUTED}; }
  .bsec { margin-top:26px; }
  .bhero { border-bottom:2px solid ${INK}; padding-bottom:9px; margin-bottom:4px; }
  .bhero h3 { font-size:23px; margin:0 0 2px; letter-spacing:-.02em; }
  .bhero span { color:${MUTED}; font-size:12px; }
  @media (max-width:760px) { .shell { grid-template-columns:1fr; }
    .rail { position:static; height:auto; flex-direction:row; align-items:center; gap:10px; }
    .rail nav { flex-direction:row; } .railfoot { display:none; } .content { padding:20px 16px 50px; } }
  @media print { body { background:#fff; } .sheet { box-shadow:none; max-width:none; }
    .p, .lb, .tb tr, .day, .bsec { break-inside:avoid; }
    .rail { display:none; } .shell { display:block; }
    [data-sec] { display:block !important; } }
</style></head>
<body>${isPulse ? body : `<div class="sheet">
<header>
  <h1>${esc(title)}</h1>
  ${meta.subtitle ? `<div class="sub">${esc(meta.subtitle)}</div>` : ""}
  <div class="meta">${esc(when)} 기준 · 상품 ${agg.count.toLocaleString()}개${
    scopeBits.length ? " · " + esc(scopeBits.join(" · ")) : ""}</div>
</header>

${body}

<footer>
  이 파일은 생성 시점의 정보를 그대로 담고 있습니다. 이미지와 수치가 파일 안에 저장되어
  있어 인터넷 연결이나 원본 쇼핑몰 없이도 언제든 동일하게 열립니다.<br>
  생성: ${esc(when)}${meta.source ? " · 출처: " + esc(meta.source) : ""}
</footer>
</div>`}</body></html>`;
  }

  const API = { build, barsH, histogram, swatchFor };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  root.ReportGen = API;
})(typeof self !== "undefined" ? self : this);
