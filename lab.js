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
    const nums = rows.flatMap(r => r.values).filter(v => v != null);
    if (!nums.length) return "";
    const max = Math.max(10, ...nums);
    const x = i => padL + (labels.length < 2 ? 0 : (W - padL - padR) * (i / (labels.length - 1)));
    const y = v => padT + (H - padT - padB) * (1 - v / max);

    const grid = [0, .5, 1].map(f => {
      const yy = padT + (H - padT - padB) * (1 - f);
      return `<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" stroke="${GRID}"/>` +
        `<text x="${padL - 6}" y="${yy + 4}" text-anchor="end" font-size="10" fill="${MUTED}">${Math.round(max * f)}%</text>`;
    }).join("");
    // 26 weekly labels will not fit — thin them out, always keeping the last one
    const step = Math.ceil(labels.length / 13);
    const xlab = labels.map((l, i) => ((labels.length - 1 - i) % step === 0
      ? `<text x="${x(i)}" y="${H - 8}" text-anchor="middle" font-size="10" fill="${MUTED}">${esc(l)}</text>`
      : "")).join("");
    const lines = rows.map((r, si) => {
      const col = SERIES[si % SERIES.length];
      /* A period with nothing collected is a hole in the record, not a zero, so
         the line BREAKS there instead of diving to the axis. Drawing 0% for a
         week nobody scanned would invent a collapse that never happened. */
      let d = "", pen = false;
      r.values.forEach((v, i) => {
        if (v == null) { pen = false; return; }
        d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)} `;
        pen = true;
      });
      const dots = r.values.map((v, i) => (v == null ? ""
        : `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3" fill="${col}" stroke="#fff" stroke-width="1.5"/>`)).join("");
      // direct-label the last point that exists (≤4 series stay readable)
      let last = r.values.length - 1;
      while (last >= 0 && r.values[last] == null) last--;
      const tag = (rows.length <= 4 && last >= 0)
        ? `<text x="${x(last) - 4}" y="${y(r.values[last]) - 8}" text-anchor="end" font-size="10" font-weight="600" fill="${col}">${esc(r.key)}</text>`
        : "";
      return `<path d="${d.trim()}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round"/>${dots}${tag}`;
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

  /* Week-over-week board: what moved since the previous run.
     Shows the two periods being compared by name, so nobody has to guess
     whether "this week" means the calendar week or the last one with data. */
  function changeBoard(c, label) {
    if (!c.ok) {
      return `<div class="notice">${c.current
        ? `<b>${esc(c.current.label)}</b> 구간의 데이터만 있습니다 (${c.current.count}개). ` +
          `다음 주에 한 번 더 스캔하면 이곳에 <b>변화량</b>이 표시됩니다.`
        : "아직 비교할 구간이 없습니다. 스캔을 한 번 돌리면 이번 구간이 기록됩니다."}</div>`;
    }
    const rows = c.rows.map(r => {
      const col = r.delta > 0 ? UP : r.delta < 0 ? DOWN : MUTED;
      const arrow = r.delta > 0 ? "▲" : r.delta < 0 ? "▼" : "–";
      const badge = r.isNew ? '<em class="new">NEW</em>'
        : r.isGone ? '<em class="new gone">사라짐</em>' : "";
      return `<div class="mv">
        <span class="mk">${esc(r.key)}${badge}</span>
        <span class="mb">${r.before}% → ${r.after}% <span class="cn">(${r.countBefore}→${r.countAfter}개)</span></span>
        <span class="md" style="color:${col}">${arrow} ${Math.abs(r.delta)}p</span></div>`;
    }).join("") || `<div class="none">두 구간 사이에 뚜렷한 변화가 없습니다.</div>`;
    return `<div class="cmp"><b>${esc(c.previous.label)}</b> (${c.previous.count}개)
      <span class="ar">→</span> <b>${esc(c.current.label)}</b> (${c.current.count}개)
      · ${esc(label)} 기준</div>${rows}`;
  }

  /* Keywords worth watching, with the reason spelled out next to each one.
     Everything here is counted, never inferred — the charter's zero-hallucination
     rule applies to this screen as much as to the spreadsheet. */
  function emergingBoard(e) {
    if (!e.ok || !e.rows.length) {
      return `<div class="none">아직 제안할 만큼 반복된 신호가 없습니다. 주마다 스캔이 쌓이면 나타납니다.</div>`;
    }
    return `<div class="sugs">` + e.rows.map(r => `<div class="sug">
      <div class="sk">${esc(r.key)}<em class="tag ${r.kind}">${r.kind === "new" ? "신규" : "상승"}</em></div>
      <div class="sr">${esc(r.reason)} · 이번 구간 ${r.count}개 · 점유율 ${r.share}%</div>
      <div class="sp">${r.path.map(v => `${v}%`).join(" → ")}</div>
    </div>`).join("") + `</div>`;
  }

  /* The plain ledger — one line per week, newest first. This is the "한눈에"
     view: how much came in, how it moved, and what led that week. */
  function ledgerTable(rows) {
    const withData = rows.filter(r => r.count);
    if (!withData.length) return `<div class="none">기록된 구간이 없습니다.</div>`;
    return `<table class="lg2"><thead><tr>
        <th>구간</th><th class="num">신규</th><th class="num">증감</th><th>많이 보인 항목</th>
      </tr></thead><tbody>` +
      withData.slice().reverse().map(r => `<tr>
        <td class="pd">${esc(r.label)}${r.stored ? '<em class="arch" title="상품은 정리되었고 주간 기록만 남아 있습니다">기록</em>' : ""}</td>
        <td class="num">${r.count}</td>
        <td class="num" style="color:${r.delta == null ? MUTED : r.delta > 0 ? UP : r.delta < 0 ? DOWN : MUTED}">${
          r.delta == null ? "—" : (r.delta > 0 ? "+" : "") + r.delta}</td>
        <td class="tp">${r.top.map(t => `${esc(t.key)} <span class="cn">${t.share}%</span>`).join(" · ") || "—"}</td>
      </tr>`).join("") + `</tbody></table>`;
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
    // Weeks whose products are gone still count, through their stored snapshot.
    const snapshots = opts.snapshots || [];
    const base = { months, granularity, snapshots };
    const o = T.overview(items, base);

    if (!o.total && !o.archived) {
      el.innerHTML = `<div class="labempty">${clipped
        ? `손으로 담은 상품 ${clipped}개만 있습니다.<br>추이는 스캔한 상품으로만 계산합니다 — 리스트를 만들어 ▶ Run all 하세요.`
        : "아직 수집된 상품이 없습니다.<br>스캔을 시작하면 이곳에 시간에 따른 변화가 쌓입니다."}</div>`;
      return;
    }

    const s = T.series(items, Object.assign({ dim, top: 6 }, base));
    const m = T.movers(items, Object.assign({ dim, top: 6, minCount: opts.minCount || 3 }, base));
    const c = T.latestChange(items, Object.assign({ dim, top: 10, minCount: 2 }, base));
    const e = T.emerging(items, Object.assign({ dim, top: 8, window: 3, minCount: 2 }, base));
    const led = T.ledger(items, Object.assign({ dim, top: 4 }, base));
    const label = (T.DIMS[dim] || {}).label || dim;
    const unit = granularity === "week" ? "주" : "달";

    el.innerHTML = `
      <div class="labhead">
        <div class="tiles">
          <div class="tile"><div class="tl">수집 상품</div><div class="tv">${o.total.toLocaleString()}</div>
            <div class="ts">${o.archived ? `+ 주간 기록 ${o.archived.toLocaleString()}` : `브랜드 ${o.brands} · 사이트 ${o.sites}`}</div></div>
          <div class="tile"><div class="tl">기록된 ${unit}</div><div class="tv">${o.periodsWithData}</div>
            <div class="ts">최근 ${months}개월 중 ${o.periods}${unit}</div></div>
          <div class="tile"><div class="tl">최근 ${unit} 신규</div>
            <div class="tv">${o.latest ? o.latest.count : "—"}</div>
            <div class="ts">${o.latest ? esc(o.latest.label) : ""}${
              o.deltaVsPrev != null ? ` · 지난 ${unit} 대비 ${o.deltaVsPrev >= 0 ? "+" : ""}${o.deltaVsPrev}` : ""}</div></div>
          <div class="tile"><div class="tl">주목 ${esc(label)}</div>
            <div class="tv">${e.ok ? e.rows.length : 0}</div>
            <div class="ts">신규·연속 상승 항목</div></div>
        </div>
      </div>

      <h3>${unit}차별 최근 변화 <span class="sub">직전 기록 구간 대비</span></h3>
      ${changeBoard(c, label)}

      <h3>지금 주목할 ${esc(label)} <span class="sub">근거를 함께 표시</span></h3>
      ${emergingBoard(e)}

      <h3>구간별 신규 상품 수</h3>
      ${volumeChart(s.labels, s.counts)}

      <h3>${esc(label)} 점유율 추이 <span class="sub">각 구간 신규 상품 중 비율</span></h3>
      ${lineChart(s, { alt: label + " 추이" })}

      <div class="movers">
        <div><h3>기간 전체 상승</h3>${moverList(m.risers || [], "up")}</div>
        <div><h3>기간 전체 하락</h3>${moverList(m.fallers || [], "down")}</div>
      </div>

      <h3>${unit}차별 기록 <span class="sub">한눈에 보기</span></h3>
      ${ledgerTable(led)}

      <p class="foot">
        <b>${unit}차별 최근 변화</b>는 데이터가 있는 마지막 두 구간을 비교합니다(한 주를 건너뛰어도
        “전부 사라짐”으로 읽히지 않도록). <b>기간 전체 상승/하락</b>은 창의 전반기와 후반기 점유율
        차이(퍼센트포인트)로, 한 구간의 우연한 변동을 트렌드로 오인하지 않기 위한 것이며 표본이
        ${opts.minCount || 3}건 미만인 항목은 제외합니다. 모든 수치는 수집한 상품에서 직접 계산하며,
        추정하거나 외부 서비스에서 가져오지 않습니다.${
        o.archived ? ` “기록” 표시가 붙은 구간은 상품이 정리되어 주간 집계만 남은 구간입니다.` : ""}${
        clipped ? ` 손으로 담은 상품 ${clipped}개는 표본이 한쪽으로 치우치므로 이 통계에서 제외했습니다(상품 목록과 Excel에는 포함).` : ""}</p>`;
  }

  root.LabView = { render, lineChart, volumeChart, changeBoard, emergingBoard, ledgerTable };
})(typeof self !== "undefined" ? self : this);
