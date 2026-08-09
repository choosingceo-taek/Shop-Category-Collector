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
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="${esc(opts.alt || "trend")}">
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
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="New arrivals per period">
      ${bars}<line x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}" stroke="${GRID}"/></svg>`;
  }

  /* Week-over-week board: what moved since the previous run.
     Shows the two periods being compared by name, so nobody has to guess
     whether "this week" means the calendar week or the last one with data. */
  function changeBoard(c, label) {
    if (!c.ok) {
      return `<div class="notice">${c.current
        ? `Only <b>${esc(c.current.label)}</b> has data so far (${c.current.count} products). ` +
          `Scan once more next week and the <b>change</b> appears here.`
        : "No period to compare yet. Run one scan and this period gets recorded."}</div>`;
    }
    const rows = c.rows.map(r => {
      const col = r.delta > 0 ? UP : r.delta < 0 ? DOWN : MUTED;
      const arrow = r.delta > 0 ? "▲" : r.delta < 0 ? "▼" : "–";
      const badge = r.isNew ? '<em class="new">NEW</em>'
        : r.isGone ? '<em class="new gone">GONE</em>' : "";
      return `<div class="mv">
        <span class="mk">${esc(r.key)}${badge}</span>
        <span class="mb">${r.before}% → ${r.after}% <span class="cn">(${r.countBefore}→${r.countAfter})</span></span>
        <span class="md" style="color:${col}">${arrow} ${Math.abs(r.delta)}p</span></div>`;
    }).join("") || `<div class="none">No clear movement between these two periods.</div>`;
    return `<div class="cmp"><b>${esc(c.previous.label)}</b> (${c.previous.count})
      <span class="ar">→</span> <b>${esc(c.current.label)}</b> (${c.current.count})
      · by ${esc(label)}</div>${rows}`;
  }

  /* Keywords worth watching, with the reason spelled out next to each one.
     Everything here is counted, never inferred — the charter's zero-hallucination
     rule applies to this screen as much as to the spreadsheet. */
  function emergingBoard(e) {
    if (!e.ok || !e.rows.length) {
      return `<div class="none">No repeated signal worth flagging yet — it appears as weekly scans build up.</div>`;
    }
    return `<div class="sugs">` + e.rows.map(r => `<div class="sug">
      <div class="sk">${esc(r.key)}<em class="tag ${r.kind}">${r.kind === "new" ? "NEW" : "RISING"}</em></div>
      <div class="sr">${esc(r.reason)} · ${r.count} this period · ${r.share}% share</div>
      <div class="sp">${r.path.map(v => `${v}%`).join(" → ")}</div>
    </div>`).join("") + `</div>`;
  }

  /* The plain ledger — one line per week, newest first. This is the "한눈에"
     view: how much came in, how it moved, and what led that week. */
  function ledgerTable(rows) {
    const withData = rows.filter(r => r.count);
    if (!withData.length) return `<div class="none">No periods recorded.</div>`;
    return `<table class="lg2"><thead><tr>
        <th>Period</th><th class="num">New</th><th class="num">Change</th><th>Most seen</th>
      </tr></thead><tbody>` +
      withData.slice().reverse().map(r => `<tr>
        <td class="pd">${esc(r.label)}${r.stored ? '<em class="arch" title="Products were cleaned up; only the weekly record remains">RECORD</em>' : ""}</td>
        <td class="num">${r.count}</td>
        <td class="num" style="color:${r.delta == null ? MUTED : r.delta > 0 ? UP : r.delta < 0 ? DOWN : MUTED}">${
          r.delta == null ? "—" : (r.delta > 0 ? "+" : "") + r.delta}</td>
        <td class="tp">${r.top.map(t => `${esc(t.key)} <span class="cn">${t.share}%</span>`).join(" · ") || "—"}</td>
      </tr>`).join("") + `</tbody></table>`;
  }

  /* Price and discount pressure — a different question from the share charts:
     not "what is in the assortment" but "what does it cost and how hard is it
     being marked down". Periods with no prices say so instead of showing 0. */
  function priceBoard(rows, unit) {
    const withData = rows.filter(r => r.priced);
    if (withData.length < 1) {
      return `<div class="none">No period has price data.</div>`;
    }
    const last = withData[withData.length - 1], prev = withData[withData.length - 2];
    const delta = (a, b) => (a == null || b == null) ? null : Math.round((a - b) * 10) / 10;
    const dMed = prev ? delta(last.median, prev.median) : null;
    const dSale = prev ? delta(last.salePct, prev.salePct) : null;
    const arrow = v => v == null ? "" :
      `<span style="color:${v > 0 ? UP : v < 0 ? DOWN : MUTED}">${v > 0 ? "▲" : v < 0 ? "▼" : "–"} ${Math.abs(v)}</span>`;

    const table = withData.slice().reverse().slice(0, 8).map(r => `<tr>
      <td class="pd">${esc(r.label)}</td>
      <td class="num">${r.priced}</td>
      <td class="num">${r.median != null ? "$" + r.median : "—"}</td>
      <td class="num">${r.avg != null ? "$" + r.avg : "—"}</td>
      <td class="num">${r.min != null ? `$${r.min}–$${r.max}` : "—"}</td>
      <td class="num">${r.salePct != null ? r.salePct + "%" : "—"}</td>
      <td class="num">${r.avgDiscount != null ? "-" + r.avgDiscount + "%" : "—"}</td>
    </tr>`).join("");

    return `<div class="tiles">
        <div class="tile"><div class="tl">Median price, latest ${unit}</div>
          <div class="tv">${last.median != null ? "$" + last.median : "—"}</div>
          <div class="ts">${esc(last.label)}${dMed != null ? ` · vs previous ${arrow(dMed)}` : ""}</div></div>
        <div class="tile"><div class="tl">On sale</div>
          <div class="tv">${last.salePct != null ? last.salePct + "%" : "—"}</div>
          <div class="ts">${dSale != null ? `vs previous ${arrow(dSale)}p` : last.priced + " with prices"}</div></div>
        <div class="tile"><div class="tl">Average markdown</div>
          <div class="tv">${last.avgDiscount != null ? "-" + last.avgDiscount + "%" : "—"}</div>
          <div class="ts">of the discounted items</div></div>
      </div>
      <table class="lg2" style="margin-top:12px"><thead><tr>
        <th>Period</th><th class="num">Priced</th><th class="num">Median</th><th class="num">Average</th>
        <th class="num">Range</th><th class="num">On sale</th><th class="num">Markdown</th>
      </tr></thead><tbody>${table}</tbody></table>`;
  }

  /* Plain frequency ranking — "what am I seeing, most to least".

     This is the flat question the share charts skip past. Bars are drawn
     relative to the top row so the shape of the tail is visible; the count and
     the share are both printed because a share alone hides how thin a sample
     is. Counts are products, not word mentions. */
  function rankedList(r) {
    if (!r.rows.length) {
      return `<div class="none">Nothing recorded ${r.total ? "above the sample floor" : "yet"}.</div>`;
    }
    const max = r.rows[0].count || 1;
    return `<div class="rank">` + r.rows.map((x, i) => `<div class="rk">
      <span class="ri">${i + 1}</span>
      <span class="rn">${esc(x.key)}</span>
      <span class="rb"><i style="width:${Math.max(2, (x.count / max) * 100).toFixed(1)}%"></i></span>
      <span class="rc">${x.count}<em>${x.share}%</em></span>
    </div>`).join("") + `</div>`;
  }

  // Rising / falling table with the change in percentage points.
  function moverList(rows, dir) {
    if (!rows.length) return `<div class="none">None</div>`;
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
        ? `Only ${clipped} hand-picked products here.<br>Trends are computed from scans only — build a list and press ▶ Scan all.`
        : "Nothing collected yet.<br>Once scans start, change over time builds up here."}</div>`;
      return;
    }

    const s = T.series(items, Object.assign({ dim, top: 6 }, base));
    const m = T.movers(items, Object.assign({ dim, top: 6, minCount: opts.minCount || 3 }, base));
    const c = T.latestChange(items, Object.assign({ dim, top: 10, minCount: 2 }, base));
    const e = T.emerging(items, Object.assign({ dim, top: 8, window: 3, minCount: 2 }, base));
    const led = T.ledger(items, Object.assign({ dim, top: 4 }, base));
    const rk = T.ranked(items, Object.assign({ dim, top: 20, minCount: 2 }, base));
    const label = (T.DIMS[dim] || {}).label || dim;
    const unit = granularity === "week" ? "week" : "month";

    el.innerHTML = `
      ${opts.tierChips || ""}
      <div class="labhead">
        <div class="tiles">
          <div class="tile"><div class="tl">Products</div><div class="tv">${o.total.toLocaleString()}</div>
            <div class="ts">${o.archived ? `+ ${o.archived.toLocaleString()} in weekly records` : `${o.brands} brands · ${o.sites} sites`}</div></div>
          <div class="tile"><div class="tl">${unit}s recorded</div><div class="tv">${o.periodsWithData}</div>
            <div class="ts">of ${o.periods} in the last ${months} months</div></div>
          <div class="tile"><div class="tl">New, latest ${unit}</div>
            <div class="tv">${o.latest ? o.latest.count : "—"}</div>
            <div class="ts">${o.latest ? esc(o.latest.label) : ""}${
              o.deltaVsPrev != null ? ` · vs previous ${unit} ${o.deltaVsPrev >= 0 ? "+" : ""}${o.deltaVsPrev}` : ""}</div></div>
          <div class="tile"><div class="tl">${esc(label)} to watch</div>
            <div class="tv">${e.ok ? e.rows.length : 0}</div>
            <div class="ts">new or consecutively rising</div></div>
        </div>
      </div>

      <h3>Latest change by ${unit} <span class="sub">vs the previous recorded period</span></h3>
      ${changeBoard(c, label)}

      <h3>${esc(label)} to watch now <span class="sub">reason always shown</span></h3>
      ${emergingBoard(e)}

      <h3>Most seen ${esc(label)} <span class="sub">whole window, by frequency</span></h3>
      ${rankedList(rk)}

      <h3>New arrivals per period</h3>
      ${volumeChart(s.labels, s.counts)}

      <h3>${esc(label)} share over time <span class="sub">% of each period\u2019s new arrivals</span></h3>
      ${lineChart(s, { alt: label + " share over time" })}

      <div class="movers">
        <div><h3>Rising over the window</h3>${moverList(m.risers || [], "up")}</div>
        <div><h3>Falling over the window</h3>${moverList(m.fallers || [], "down")}</div>
      </div>

      <h3>Price &amp; markdown pressure <span class="sub">where the season stands</span></h3>
      ${priceBoard(T.priceByPeriod(items, base), unit)}

      <h3>Record by ${unit} <span class="sub">at a glance</span></h3>
      ${ledgerTable(led)}

      <p class="foot">
        <b>Latest change</b> compares the last two periods that actually have data, so skipping a
        ${unit} never reads as everything disappearing. <b>Rising / falling over the window</b> is the
        share difference between the first and second half (in percentage points) — halves rather than
        single periods, so one odd ${unit} isn\u2019t mistaken for a trend — and anything with fewer than
        ${opts.minCount || 3} samples is left out. Every figure is computed directly from the products
        collected; nothing is estimated or fetched from an outside service.${
        o.archived ? ` Periods marked RECORD are ones whose products were cleaned up, leaving only the weekly totals.` : ""}${
        clipped ? ` ${clipped} hand-picked products are excluded here because that sample is biased (they remain in the product list and in Excel).` : ""}</p>`;
  }

  root.LabView = { render, lineChart, volumeChart, changeBoard, emergingBoard, ledgerTable, priceBoard, rankedList };
})(typeof self !== "undefined" ? self : this);
