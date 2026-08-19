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


  /* A sparkline: the shape of one measure over the recent periods.

     Deliberately unlabelled and unscaled against the others — it answers
     "which way has this been going", and the exact figure is the column
     beside it. Each line is scaled to its own range so a 2%-to-4% climb is
     as legible as a 40%-to-80% one; that is the point of a sparkline, and the
     reason it never stands in for the axis-bearing chart further down. */
  /* A card-sized area chart. Same numbers as the sparkline, drawn with a fill
     because a card has room for a shape and a shape reads faster than a line
     at this size. Scaled to its own range, like every other small multiple
     here, so a keyword at 4% and one at 40% are both legible; the exact value
     is on the card in figures. */
  function areaChart(values, opts) {
    opts = opts || {};
    const vals = (values || []).filter(v => v != null);
    if (vals.length < 2) return '<div class="noarea">one week only — no shape yet</div>';
    const W = 220, H = 46, pad = 3;
    const max = Math.max(...vals), min = Math.min(...vals);
    const span = max - min || 1;
    const x = i => pad + (W - pad * 2) * (i / (vals.length - 1));
    const y = v => pad + (H - pad * 2) * (1 - (v - min) / span);
    const line = vals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    const area = `${line} L${x(vals.length - 1).toFixed(1)},${H} L${x(0).toFixed(1)},${H} Z`;
    const col = opts.color || "#111";
    return `<svg class="area" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
      <path d="${area}" fill="${col}" fill-opacity=".07"></path>
      <path d="${line}" fill="none" stroke="${col}" stroke-width="1.4"
        stroke-linejoin="round" stroke-linecap="round"></path>
      <circle cx="${x(vals.length - 1).toFixed(1)}" cy="${y(vals[vals.length - 1]).toFixed(1)}"
        r="2.4" fill="${col}"></circle></svg>`;
  }

  /* The count, week by week — the same figure the card shows, drawn over the
     period. Bars rather than a line because it IS a count: a bar of nothing is
     honestly nothing, where a line would slope through it. A week with no
     products collected at all is a gap (null), not a zero, so a week nobody
     scanned does not read as a week the keyword vanished. */
  function weekBars(labels, counts, unit) {
    const vals = counts || [];
    if (!vals.some(v => v != null)) return "";
    const W = 220, H = 40, base = 30;              // 10px under the bars for the label
    const max = Math.max(1, ...vals.filter(v => v != null));
    const n = vals.length;
    const bw = W / n;
    const bars = vals.map((v, i) => {
      const x = i * bw;
      if (v == null) {
        return `<rect x="${(x + 1).toFixed(1)}" y="${base - 2}" width="${Math.max(1, bw - 2).toFixed(1)}" height="2" fill="#e6e6e6"></rect>`;
      }
      const h = Math.max(1, base * (v / max));
      const last = i === n - 1;
      return `<rect x="${(x + 1).toFixed(1)}" y="${(base - h).toFixed(1)}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${h.toFixed(1)}" fill="#111" fill-opacity="${last ? ".85" : ".28"}"></rect>`;
    }).join("");
    const first = labels && labels[0] ? labels[0] : "";
    const lastLab = labels && labels[n - 1] ? labels[n - 1] : "";
    return `<svg class="axbars" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"
      role="img" aria-label="items per ${unit || "week"}">${bars}
      <text x="0" y="${H - 1}" font-size="7" fill="#9a9a9a">${esc(first)}</text>
      <text x="${W}" y="${H - 1}" font-size="7" fill="#9a9a9a" text-anchor="end">${esc(lastLab)}</text>
    </svg>`;
  }

  function sparkline(values, dir) {
    const vals = (values || []).filter(v => v != null);
    if (vals.length < 2) return '<span class="nospark">—</span>';
    const W = 62, H = 18, pad = 2;
    const max = Math.max(...vals), min = Math.min(...vals);
    const span = max - min || 1;
    const x = i => pad + (W - pad * 2) * (i / (vals.length - 1));
    const y = v => pad + (H - pad * 2) * (1 - (v - min) / span);
    const col = dir === "up" ? UP : dir === "down" ? DOWN : MUTED;
    const d = vals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    const last = vals.length - 1;
    return `<svg class="spark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true">
      <path d="${d}" fill="none" stroke="${col}" stroke-width="1.6"
        stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="${x(last).toFixed(1)}" cy="${y(vals[last]).toFixed(1)}" r="2" fill="${col}"/>
    </svg>`;
  }

  /* The pulse table — the first thing the LAB says.

     One row per measure: what it is, how it moved since the last scan of this
     list, and the shape it has been tracing. Dense on purpose; a designer
     reads down the change column and stops at whatever is not flat. */
  /* What the line covers, for the row's tooltip. The change column answers
     "since the last scan"; the line answers "and before that" — so the
     tooltip states the window's own start and end rather than leaving the
     reader to infer a second number from a picture. */
  function sparkTitle(r, p) {
    const v = (r.spark || []).filter(x => x != null);
    if (v.length < 2) return "not enough periods yet";
    const labs = p.sparkLabels || [];
    const from = labs[labs.length - v.length] || "start", to = labs[labs.length - 1] || "now";
    const move = Math.round((v[v.length - 1] - v[0]) * 10) / 10;
    return `${from} → ${to}: ${v[0]}% → ${v[v.length - 1]}% (${move >= 0 ? "+" : ""}${move}p over ${v.length} ${p.unit}s)`;
  }

  function pulseTable(p) {
    if (!p.rows.length) {
      return `<div class="none">Nothing moved enough to report between these two ${p.unit}s.</div>`;
    }
    const rows = p.rows.map(r => {
      const chg = r.direction === "flat" ? `<span class="flat">STABLE</span>`
        : r.direction === "new" ? `<span class="up">NEW</span>`
        : r.direction === "gone" ? `<span class="down">GONE</span>`
        : `<span class="${r.direction}">${r.delta > 0 ? "+" : ""}${r.delta}p</span>`;
      return `<tr>
        <td class="pk">${esc(r.key)}</td>
        <td class="pc">${chg}</td>
        <td class="ps" title="${esc(sparkTitle(r, p))}">${sparkline(r.spark, r.direction)}</td>
        <td class="pn">${r.before}% → ${r.after}% <i>(${r.countBefore}→${r.countAfter})</i></td>
      </tr>`;
    }).join("");
    /* Say what STABLE means here. On a small week one garment is a large
       percentage, so a move the sample cannot resolve is reported as steady —
       and the reader is told the size of that band rather than left to guess
       why something with a visibly different number reads as unchanged. */
    const note = p.resolution
      ? `<p class="pnote">Moves under ${p.resolution}p read as STABLE — that is
         one product at this ${p.unit}'s size (${p.coverage.matchedProducts.before}
         → ${p.coverage.matchedProducts.after} on the shared shops).</p>`
      : "";
    return `<table class="pulse"><thead><tr>
      <th>${esc(p.label)}</th><th>Change</th><th>Trend</th><th>Share</th>
    </tr></thead><tbody>${rows}</tbody></table>${note}`;
  }

  /* Week against week, on the shops both weeks actually contain.

     A share is "out of this week's arrivals", which only compares to last week
     if both weeks read the same shops. Lists grow, categories get added, a
     scan fails — and then the number moves for a reason that has nothing to do
     with fashion. So the headline is the like-for-like reading, the coverage
     change is stated next to it rather than buried, and the raw reading is
     kept where it can be seen but not mistaken for the trend. */
  function compareBoard(w, label) {
    // `w` is a pulse() result: weekCompare plus a spark per row.
    if (!w || !w.ok) {
      return `<div class="notice">${w && w.periods
        ? `Only one ${w.unit} has products so far. Scan this list again next ${w.unit} ` +
          `and the ${w.unit}-on-${w.unit} comparison appears here.`
        : "Nothing to compare yet — scan this list once and this " +
          "week becomes the baseline."}</div>`;
    }
    const cov = w.coverage;
    const rowsOf = rows => rows.map(r => {
      const col = r.delta > 0 ? UP : r.delta < 0 ? DOWN : MUTED;
      const arrow = r.delta > 0 ? "▲" : r.delta < 0 ? "▼" : "–";
      const badge = r.isNew ? '<em class="new">NEW</em>'
        : r.isGone ? '<em class="new gone">GONE</em>' : "";
      return `<div class="mv">
        <span class="mk">${esc(r.key)}${badge}</span>
        <span class="mb">${r.before}% → ${r.after}% <span class="cn">(${r.countBefore}→${r.countAfter})</span></span>
        <span class="md" style="color:${col}">${arrow} ${Math.abs(r.delta)}p</span></div>`;
    }).join("");

    const head = `<div class="cmp"><b>${esc(w.previous.label)}</b> (${w.previous.count})
      <span class="ar">→</span> <b>${esc(w.current.label)}</b> (${w.current.count})
      · by ${esc(label)}</div>`;

    if (!cov.comparable) {
      return head + `<div class="notice">These two ${w.unit}s share no collection —
        ${w.previous.collections} in ${esc(w.previous.label)},
        ${w.current.collections} in ${esc(w.current.label)}, none in both. There is
        nothing to compare like for like; what changed is which shops were read.</div>`;
    }

    // The coverage line is always shown, including when nothing moved — the
    // absence of a caveat is itself information worth stating.
    const names = list => list.slice(0, 6).map(esc).join(", ") +
      (list.length > 6 ? ` +${list.length - 6} more` : "");
    const covLine = cov.stable
      ? `<div class="cov same">Same ${cov.common} collections in both ${w.unit}s —
         this is a clean comparison.</div>`
      : `<div class="cov">Compared on the <b>${cov.common} collections both ${w.unit}s contain</b>
         (${cov.matchedProducts.before} → ${cov.matchedProducts.after} products).` +
        (cov.added.length ? `<div class="covr"><b>+ new this ${w.unit}</b> ${names(cov.added)}</div>` : "") +
        (cov.dropped.length ? `<div class="covr"><b>− not read this ${w.unit}</b> ${names(cov.dropped)}</div>` : "") +
        `</div>`;

    const matched = pulseTable(w);
    // Only worth showing the raw reading when it can actually mislead.
    const raw = cov.stable ? "" : `<details class="rawcmp">
      <summary>Everything collected, including what changed underneath
        (${w.all.before} → ${w.all.after} products)</summary>
      ${rowsOf(w.all.rows) || `<div class="none">No movement.</div>`}
      <p class="rawnote">These figures move with the list as well as with the market.
        Use them for volume, not for trend.</p></details>`;

    return head + covLine + matched + raw;
  }

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

  /* Rising and falling over the WINDOW — the two halves of it compared,
     rather than this period against last. A single period is noisy; a
     designer wants "this is trending", not "one odd week".

     The calculation never left (trend.js movers, under test the whole time);
     what left was the thing that drew it. Two panels side by side because
     they are one reading: what the season is picking up and what it is
     putting down, and neither is legible without the other. */
  function moversBoard(m, unitLabel) {
    const row = r => `<div class="mv">
      <span class="mk">${esc(r.key)}${r.isNew ? '<em class="new">NEW</em>' : ""}</span>
      <span class="mb">${r.before}% → ${r.after}%</span>
      <span class="md" style="color:${r.delta > 0 ? UP : DOWN}">${
        r.delta > 0 ? "▲" : "▼"} ${Math.abs(r.delta)}p</span></div>`;
    const side = (title, rows, empty) => `<section class="sec"><h3>${esc(title)}
        <span class="sub">${esc(unitLabel || "")}</span></h3>${
      rows.length ? rows.map(row).join("") : `<div class="none">${esc(empty)}</div>`}</section>`;
    if (!m || (!(m.risers || []).length && !(m.fallers || []).length)) {
      return `<div class="none">Not enough periods yet to say what is rising — it appears once a second scan has been recorded.</div>`;
    }
    return `<div class="labcols">
      ${side("Rising over the window", m.risers || [], "nothing gaining ground")}
      ${side("Falling over the window", m.fallers || [], "nothing losing ground")}
    </div>`;
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

  /* NOT on the LAB any more (the designer asked for it off this page): what a
     season is made of and what it costs are two different questions, and the
     table for the second one sat between the axes and the record. The
     arithmetic stays in trend.js under test, and the exported dashboard still
     draws its own price distribution — this renderer is kept beside them so
     putting it back is wiring rather than rewriting, which is the lesson of
     v3.35.0.

     Price and discount pressure — a different question from the share charts:
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
      /* The analysis reads New In pages only, so "nothing here" has a third
         cause now — plenty was collected, but none of it from a page the
         designer named as new arrivals. Saying which one it is is the
         difference between a fixable state and a broken-looking screen. */
      /* The chips stay. A garment type with nothing inside the window would
         otherwise take its own way back off the screen. */
      el.innerHTML = `<div class="labctx">${opts.tierChips || ""}${opts.garmentChips || ""}</div>
        <div class="labempty">${opts.sourceEmpty
        ? esc(opts.sourceEmpty).replace(/\. /g, ".<br>")
        : clipped
          ? `Only ${clipped} hand-picked products here.<br>Trends are computed from scans only — build a list and press ▶ Scan all.`
          : "Nothing collected yet.<br>Once scans start, change over time builds up here."}</div>`;
      return;
    }

    const led = T.ledger(items, Object.assign({ dim, top: 4 }, base));
    const unit = granularity === "week" ? "week" : "month";

    /* ---- the fibre read of the window ---------------------------------------

       The four axis blocks answer "what is the season made of" in brands. This
       answers a different question and is why it is back: what the FIBRES are
       doing over the whole window — which one is most seen, which are rising,
       which are falling, and the shape each has traced.

       The axes count fabricfam, the cloth a shop names (satin, poplin,
       jersey). These count `fabric`, every fibre the compositions state, which
       is the measured half — a shop can call a thing what it likes and the
       percentages still say cotton. Both are true and they are not the same
       question, which is exactly why one did not replace the other.

       Nothing here is new arithmetic: every one of these was computed all
       along in trend.js and kept under test; only the wiring that drew them
       had been taken out. */
    const FIB = Object.assign({ dim: "fabric" }, base);
    const fibSeries = T.series(items, Object.assign({ top: 6 }, FIB));
    const fibBlocks = `
      <section class="sec"><h3>Fabric to watch now <span class="sub">reason always shown</span></h3>
      ${emergingBoard(T.emerging(items, Object.assign({ top: 5 }, FIB)))}</section>

      <section class="sec"><h3>Most seen fabric <span class="sub">whole window, by frequency</span></h3>
      ${rankedList(T.ranked(items, Object.assign({ top: 9 }, FIB)))}</section>

      <section class="sec"><h3>New arrivals per ${unit} <span class="sub">how much came in</span></h3>
      ${volumeChart(fibSeries.labels || [], fibSeries.counts || [])}</section>

      <section class="sec"><h3>Fabric share over time <span class="sub">% of each ${unit}'s new arrivals</span></h3>
      ${lineChart(fibSeries)}</section>

      ${moversBoard(T.movers(items, FIB), "by fibre, over the whole window")}`;

    /* ---- the four axes ------------------------------------------------------

       FABRIC / COLOR / FIT / DETAIL, one block each, always on screen. A
       designer asks four questions of a season and they are these four; a
       selector that shows one at a time means holding three in your head.

       Each row is counted in BRANDS, not products: "21 of the 32 shops that
       produced this week put out satin". One shop that drops sixty satin
       pieces counts once, which is the difference between a market moving and
       a label being busy — and the only one of those two worth developing
       against. The product count is still there, in smaller type, because
       volume is a real second fact.

       FABRIC carries the blend under the name (the shops' own percentages,
       modal not averaged), so the cloth and what it is made of are read in one
       line. */
    /* A colour card shows its colour. The names are the shelf's, so the ink is
       a label rather than a measurement — nothing is read off it. */
    const INK = (window.ReportCalc && window.ReportCalc.COLOUR_INK) || {};
    const AXES = [
      /* FABRIC counts the fifteen fibres the designer named, read from the
         compositions — the measured half. It used to count `fabricfam`, the
         cloth a shop NAMES in a title, and that put RIBBED, TERRY, RIB,
         HEATHER and JERSEY on the same row as COTTON and NYLON: two
         vocabularies in one axis, so nothing on it could be added up. The
         weave reading is not lost — it is what the DETAIL axis and the name
         keywords still read — but the fabric question is answered in fibres,
         the same fifteen the filter rail offers. */
      ["fabric", "Fabric"],
      ["color", "Colour"],
      ["fit", "Fit"],
      /* DETAIL is off this page (the designer asked). It is read from the
         words left over in a product name and the shop's own copy, and what
         reached the top ten was the copy's furniture — COLOR, COLORS, SHOW,
         ADD, AVAILABLE, PRESS, QUICK, ENTER, SHOP. A stoplist can keep taking
         words out of that axis one at a time, but a ranking whose top row is
         "COLOR 76 items" is not reporting a season. The reading still exists
         (`keyword` in trend.js, still under test) and the words themselves are
         in the product names, which is where they can be searched. */
    ];
    const blendMap = T.blends ? T.blends(items, { dim: "fabric" }) : {};

    /* One card per keyword: what it is, how many shops carry it, what it is
       made of, and the shape it has traced. The card is the unit because a
       designer compares keywords side by side rather than reading down a
       column — and because it leaves room for the search lane below, which a
       row never had. */
    const trendRows = opts.trends || [];
    const searchLane = (key) => {
      /* Google Trends, imported by hand from a CSV — there is no public API and
         a rank cannot be collected retroactively. No import, no lane: an empty
         chart here would be a claim that nobody searched for it. */
      const mine = T.trendsForKey ? T.trendsForKey(key, trendRows) : [];
      if (!mine.length) return "";
      const byTerm = new Map();
      mine.forEach(r => {
        if (!byTerm.has(r.term)) byTerm.set(r.term, []);
        byTerm.get(r.term).push(r);
      });
      // the term with the highest recent interest speaks for the keyword
      let best = null, bestVal = -1;
      byTerm.forEach((rows, term) => {
        const sorted = rows.slice().sort((a, b) => (a.week < b.week ? -1 : 1));
        const last = sorted[sorted.length - 1];
        if (last && last.value > bestVal) { bestVal = last.value; best = { term, sorted }; }
      });
      if (!best) return "";
      const vals = best.sorted.map(r => r.value);
      return `<div class="axgt" title="Google Trends interest for “${esc(best.term)}”, imported from a CSV. 0–100 relative to that term's own peak — not a rank and not a volume.">
        <span class="gtlab">SEARCH</span>
        <span class="gtq">${esc(best.term)}</span>
        <b class="gtv">${Math.round(bestVal)}</b>
        ${areaChart(vals, { color: "#8a3c17" })}</div>`;
    };

    /* One card: its place in the ranking, the keyword, how many items were
       actually found with it, and what that number did week by week.

       It used to lead with "2 /6 brands", which is the honest adoption unit
       (v3.0.0) but is not readable at a glance — the designer said so: two
       figures over a slash, and the one that matters (how much there IS of it)
       in small grey type underneath. So the face is the ranking and the count,
       both of them plain, and the brand reading is a hover away rather than
       gone: it is still what stops one busy label reading as a market. */
    const axisBlock = (d, title) => {
      const a = T.axisRows(items, Object.assign({ dim: d, top: 10 }, base));
      const roster = a.roster;
      const body = a.rows.length ? a.rows.map((r, i) => `<article class="axc">
          <div class="axch"><span class="axrank">${i + 1}</span><span class="axk">${
            d === "color" && INK[r.key] ? `<i class="sw" style="background:${INK[r.key]}"></i>` : ""
            }${esc(r.key)}</span>
            <span class="axd ${r.delta > 0 ? "up" : r.delta < 0 ? "down" : ""}"
              title="${r.delta == null ? "no earlier " + unit + " to compare with"
                : "against the " + a.shared + " shops that produced in both " + unit + "s"}">${
              r.delta == null ? "—" : r.delta > 0 ? "▲" + r.delta
                : r.delta < 0 ? "▼" + Math.abs(r.delta) : "0"}</span></div>
          <div class="axnum" title="${r.products} of the products collected this ${unit} have ${esc(r.key)}, across ${r.n} of the ${roster} shops that put anything out — a shop that dropped sixty of them counts as one shop, which is what tells a market apart from one busy label"><b>${r.products}</b><i>items</i></div>
          ${weekBars(a.labels, r.counts, unit)}
          ${d === "fabric" && blendMap[r.key]
            ? `<div class="axmeta" title="the blend these products state most often">${esc(blendMap[r.key])}</div>` : ""}
          ${searchLane(r.key)}
        </article>`).join("")
        : `<div class="none">nothing collected on this axis yet</div>`;

      /* What moved underneath. A brand that joined this week lifts every count
         on the page, so the change column already ignores it — but the fact
         has to be visible, not merely handled. */
      const cover = (a.joined.length || a.left.length) ? `<div class="axcov">${
        a.joined.length ? `+${a.joined.length} new this ${unit} (${esc(a.joined.slice(0, 3).join(", "))}${a.joined.length > 3 ? "…" : ""})` : ""}${
        a.joined.length && a.left.length ? " · " : ""}${
        a.left.length ? `−${a.left.length} not read this ${unit} (${esc(a.left.slice(0, 3).join(", "))}${a.left.length > 3 ? "…" : ""})` : ""}
        — the change column reads only the ${a.shared} shops in both</div>` : "";

      return `<section class="sec ax"><h3>${esc(title)}
        <span class="sub">top ${a.rows.length} by how many items carry it${
          roster ? `, across the ${roster} shops that produced this ${unit}` : ""} · the bars are that count, ${unit} by ${unit}</span></h3>
        <div class="axcards">${body}</div>${cover}</section>`;
    };

    /* One context band: who is being read (tier · garment type) and what that
       amounts to, on a single line. Three stacked bands — tier chips, type
       chips, source note — say one thing between them, and each of them was
       pushing the first answer further down the page.

       The counts follow it rather than lead it. The question this tool exists
       for is what fabric and what details are moving; how many products that
       came from is the footing under the answer, not the answer. */
    const ctxBand = `<div class="labctx">${opts.tierChips || ""}${opts.garmentChips || ""}${
      opts.sourceNote ? `<p class="srcnote">${esc(opts.sourceNote)}</p>` : ""}</div>`;

    /* What this page was computed over. It used to be a paragraph above the
       axes, which put grey prose between the reader and the first answer for
       the sake of a fact that is only needed once. It belongs with the rest of
       "what these figures are", at the foot — but it does have to be said:
       the analysis reads New In pages only, so it is a part of the catalogue,
       and a narrowed screen reads fewer weeks than a whole one. */
    const b = opts.basis || null;
    const basisNote = !b ? "" :
      ` These figures are read from the ${b.fresh.toLocaleString()} of ${b.pool.toLocaleString()}` +
      ` collected products that came from a New In page — the analysis uses those only, so each` +
      ` ${unit} is the same kind of sample.` +
      (b.garment
        ? ` Narrowed to ${esc(b.garment)}: ${b.narrowed.toLocaleString()} of them, and the frozen` +
          ` ${unit}ly records cover every garment type together, so they are left out while this is on.`
        : "");

    el.innerHTML = `
      ${ctxBand}
      ${AXES.map(a => axisBlock(a[0], a[1])).join("")}
      ${fibBlocks}

      <!-- The three tiles (Products · weeks recorded · New, latest week) and
           the Record-by-week table are off this page, as asked. Every one of
           them was a count of the collection rather than a fact about the
           season: how many rows there are, how many weeks have any, how many
           arrived last — and the table repeated the axes underneath it in
           percentages. What answers "what is the season made of" is above.
           The figures are all still computed (overview, ledger in trend.js,
           both under test) and the exported dashboard still draws its own. -->
      <p class="foot">
        Each card is ranked by how many collected items carry it, and the brand figure behind that
        (on hover) counts SHOPS, not products: one that puts out sixty of something counts once,
        so it answers whether the market moved rather than whether one label was busy.
        The change beside it is against the previous ${unit} that had products, so skipping a
        ${unit} never reads as everything disappearing. Every figure is computed directly from what
        was collected; nothing is estimated or fetched from an outside service.${
        basisNote}${
        o.archived ? ` Periods marked RECORD are ones whose products were cleaned up, leaving only the weekly totals.` : ""}${
        clipped ? ` ${clipped} hand-picked products are excluded here because that sample is biased (they remain in the product list and in Excel).` : ""}</p>`;
  }

  root.LabView = { render, lineChart, volumeChart, sparkline, pulseTable, changeBoard, moversBoard, compareBoard, emergingBoard, ledgerTable, priceBoard, rankedList };
})(typeof self !== "undefined" ? self : this);
