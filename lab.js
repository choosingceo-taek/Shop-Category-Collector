/* LAB — how the market moved, drawn from what we actually collected.

   The catalog records when each product was first seen, so bucketing by that
   date gives a timeline of new arrivals: what brands really put out, month by
   month. That is a stronger trend signal for a designer than search volume,
   and it needs no external service — the numbers are ours.

   Charts are inline SVG (no library, works offline). Colour follows the
   validated categorical order, assigned per series in fixed order and never
   cycled; a legend is always present for 2+ series so identity is never
   colour-alone. */
(function (root) {
  "use strict";
  const T = root.TrendCalc;

  const SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300"];
  const INK = "#111", INK2 = "#454545", MUTED = "#8c8c8c", GRID = "#e5e3df";
  const UP = "#0ca30c", DOWN = "#d03b3b";

  const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  /* Multi-line chart: share (%) of each period's new arrivals, over time.
     One measure, one axis — never a second scale. */
  function lineChart(data, opts) {
    opts = opts || {};
    const W = 660, H = 210, padL = 34, padR = 12, padT = 10, padB = 26;
    const labels = data.labels || [], rows = data.series || [];
    if (!labels.length || !rows.length) return "";
    const max = Math.max(10, ...rows.map(r => Math.max(...r.values)));
    const x = i => padL + (labels.length < 2 ? 0 : (W - padL - padR) * (i / (labels.length - 1)));
    const y = v => padT + (H - padT - padB) * (1 - v / max);

    const grid = [0, .5, 1].map(f => {
      const yy = padT + (H - padT - padB) * (1 - f);
      return `<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" stroke="${GRID}"/>` +
        `<text x="${padL - 6}" y="${yy + 4}" text-anchor="end" font-size="10" fill="${MUTED}">${Math.round(max * f)}%</text>`;
    }).join("");
    const xlab = labels.map((l, i) =>
      `<text x="${x(i)}" y="${H - 8}" text-anchor="middle" font-size="10" fill="${MUTED}">${esc(l)}</text>`).join("");
    const lines = rows.map((r, si) => {
      const col = SERIES[si % SERIES.length];
      const d = r.values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
      const dots = r.values.map((v, i) =>
        `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3" fill="${col}" stroke="#fff" stroke-width="1.5"/>`).join("");
      // direct-label the final point (≤4 series stay readable)
      const last = r.values.length - 1;
      const tag = rows.length <= 4
        ? `<text x="${x(last) - 4}" y="${y(r.values[last]) - 8}" text-anchor="end" font-size="10" font-weight="600" fill="${col}">${esc(r.key)}</text>`
        : "";
      return `<path d="${d}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round"/>${dots}${tag}`;
    }).join("");
    const legend = rows.map((r, si) =>
      `<span class="lg"><i style="background:${SERIES[si % SERIES.length]}"></i>${esc(r.key)}</span>`).join("");
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="${esc(opts.alt || "추이")}">
      ${grid}${xlab}${lines}</svg><div class="legend">${legend}</div>`;
  }

  // Volume of new arrivals per period — context for every share figure above.
  function volumeChart(labels, counts) {
    const W = 660, H = 84, padL = 34, padR = 12, padT = 6, padB = 20;
    if (!labels.length) return "";
    const max = Math.max(1, ...counts);
    const bw = (W - padL - padR) / labels.length;
    const bars = counts.map((c, i) => {
      const h = Math.max(1, (H - padT - padB) * (c / max));
      const cx = padL + i * bw + bw / 2;
      // label above the bar, or inside it when the bar reaches the top
      const inside = (H - padB - h) < padT + 12;
      const ty = inside ? (H - padB - h) + 12 : (H - padB - h) - 4;
      return `<rect x="${padL + i * bw + 2}" y="${H - padB - h}" width="${Math.max(1, bw - 4)}" height="${h}" rx="3" fill="${SERIES[0]}" opacity=".85"/>` +
        `<text x="${cx}" y="${ty}" text-anchor="middle" font-size="9.5" fill="${inside ? "#fff" : MUTED}">${c || ""}</text>`;
    }).join("");
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="기간별 신규 상품 수">
      ${bars}<line x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}" stroke="${GRID}"/></svg>`;
  }

  // Rising / falling table with the change in percentage points.
  function moverList(rows, dir) {
    if (!rows.length) return `<div class="none">해당 없음</div>`;
    const col = dir === "up" ? UP : DOWN;
    const arrow = dir === "up" ? "▲" : "▼";
    return rows.map(r => `<div class="mv">
      <span class="mk">${esc(r.key)}${r.isNew ? '<em class="new">NEW</em>' : ""}</span>
      <span class="mb">${r.before}% → ${r.after}%</span>
      <span class="md" style="color:${col}">${arrow} ${Math.abs(r.delta)}p</span>
    </div>`).join("");
  }

  /* Render the whole LAB view into `el`. Needs nothing but the collected rows. */
  function render(el, all, opts) {
    opts = opts || {};
    const months = opts.months || 6;
    const granularity = opts.granularity || "month";
    const dim = opts.dim || "fabric";
    // Hand-clipped products are a curated sample — including them would bend
    // every share figure toward whatever caught someone's eye. Trends read from
    // scans only; the clips stay in PRODUCTS and in the Excel.
    const items = (all || []).filter(i => i && i.source !== "clip");
    const clipped = (all || []).length - items.length;
    const o = T.overview(items, { months, granularity });

    if (!o.total) {
      el.innerHTML = `<div class="labempty">${clipped
        ? `손으로 담은 상품 ${clipped}개만 있습니다.<br>추이는 스캔한 상품으로만 계산합니다 — 리스트를 만들어 ▶ Run all 하세요.`
        : "아직 수집된 상품이 없습니다.<br>스캔을 시작하면 이곳에 시간에 따른 변화가 쌓입니다."}</div>`;
      return;
    }

    const s = T.series(items, { dim, months, granularity, top: 6 });
    const m = T.movers(items, { dim, months, granularity, top: 6, minCount: opts.minCount || 3 });
    const label = (T.DIMS[dim] || {}).label || dim;

    const notEnough = !o.comparable ? `<div class="notice">
      아직 <b>한 기간</b>의 데이터만 있습니다. 변화 비교는 두 기간 이상 쌓이면 자동으로 표시됩니다.
    </div>` : "";

    el.innerHTML = `
      <div class="labhead">
        <div class="tiles">
          <div class="tile"><div class="tl">수집 상품</div><div class="tv">${o.total.toLocaleString()}</div></div>
          <div class="tile"><div class="tl">기간</div><div class="tv">${months}개월</div>
            <div class="ts">${o.periodsWithData}/${o.periods} 구간에 데이터</div></div>
          <div class="tile"><div class="tl">최근 구간</div>
            <div class="tv">${o.latest ? o.latest.count : "—"}</div>
            <div class="ts">${o.latest ? o.latest.label : ""}${
              o.deltaVsPrev != null ? ` · ${o.deltaVsPrev >= 0 ? "+" : ""}${o.deltaVsPrev}` : ""}</div></div>
        </div>
      </div>
      ${notEnough}
      <h3>기간별 신규 상품 수</h3>
      ${volumeChart(s.labels, s.counts)}
      <h3>${esc(label)} 점유율 추이 <span class="sub">각 기간 신규 상품 중 비율</span></h3>
      ${lineChart(s, { alt: label + " 추이" })}
      <div class="movers">
        <div><h3>상승</h3>${moverList(m.risers || [], "up")}</div>
        <div><h3>하락</h3>${moverList(m.fallers || [], "down")}</div>
      </div>
      <p class="foot">전반기와 후반기의 점유율 차이(퍼센트포인트)입니다. 한 구간의 우연한 변동을
        트렌드로 오인하지 않도록 기간을 반으로 나눠 비교하며, 표본이 ${opts.minCount || 3}건 미만인
        항목은 제외합니다. 모든 수치는 수집된 상품에서 직접 계산합니다.${
        clipped ? ` 손으로 담은 상품 ${clipped}개는 표본이 한쪽으로 치우치므로 이 통계에서 제외했습니다(상품 목록과 Excel에는 포함).` : ""}</p>`;
  }

  root.LabView = { render, lineChart, volumeChart };
})(typeof self !== "undefined" ? self : this);
