/* Trend calculations — how the assortment CHANGED over time.

   The catalog records when each product was first seen (addedAt), so bucketing
   by that date gives a timeline of NEW ARRIVALS: what brands actually put out
   each week or month. That is the honest trend signal for a designer — better
   than search volume, because it is what shipped, not what people typed.

   Everything here is plain arithmetic over collected rows (charter: 정량 레포트는
   순수 계산으로). Pure and side-effect-free so the Node suite can drive it. */
(function (root) {
  "use strict";
  const Calc = (typeof require !== "undefined" && typeof module !== "undefined")
    ? require("./report.js") : root.ReportCalc;

  const DAY = 864e5;

  // ---- time buckets --------------------------------------------------------
  // Monday-start weeks; months are calendar months. `now` is injectable so the
  // tests are deterministic.
  function bucketStart(ts, granularity) {
    const d = new Date(ts);
    if (granularity === "month") return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const dow = (day.getDay() + 6) % 7;                 // Mon = 0
    return day.getTime() - dow * DAY;
  }
  function nextBucket(ts, granularity) {
    const d = new Date(ts);
    return granularity === "month"
      ? new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime()
      : ts + 7 * DAY;
  }
  function labelOf(ts, granularity) {
    const d = new Date(ts);
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    return granularity === "month"
      ? `${String(d.getFullYear()).slice(2)}.${mm}`
      : `${mm}/${String(d.getDate()).padStart(2, "0")}`;
  }

  /* Group products into consecutive time buckets by first-seen date.
     opts: { months = 6, granularity = 'month'|'week', now = Date.now() }
     Empty periods are kept so a gap reads as a gap rather than being closed up. */
  function timeline(items, opts) {
    opts = opts || {};
    const granularity = opts.granularity || "month";
    const months = opts.months || 6;
    const now = opts.now || Date.now();
    const rows = (items || []).filter(i => i && i.addedAt);
    const from = (() => {
      const d = new Date(now);
      return granularity === "month"
        ? new Date(d.getFullYear(), d.getMonth() - (months - 1), 1).getTime()
        : bucketStart(now - (months * 30 * DAY), "week");
    })();

    const buckets = [];
    for (let t = from; t <= now; t = nextBucket(t, granularity)) {
      buckets.push({ start: t, end: nextBucket(t, granularity),
        label: labelOf(t, granularity), items: [] });
      if (buckets.length > 200) break;                  // guard
    }
    rows.forEach(i => {
      const b = buckets.find(x => i.addedAt >= x.start && i.addedAt < x.end);
      if (b) b.items.push(i);
    });
    return buckets.map(b => Object.assign(b, { count: b.items.length }));
  }

  // ---- what to measure in each bucket --------------------------------------
  // Each dimension answers "share of that period's new arrivals", so periods of
  // different size stay comparable — a big drop week can't fake a rising fibre.
  const DIMS = {
    fabric: {
      label: "원단",
      keysOf: it => [...new Set(Calc.parseFibers(it.fabric_composition).map(f => f.fiber))],
    },
    color: {
      label: "색상",
      keysOf: it => [...new Set(Calc.parseColors(it.colorways).map(titleCase))],
    },
    keyword: {
      label: "키워드",
      keysOf: it => Calc.normItem(it).keywords,
    },
    brand: { label: "브랜드", keysOf: it => (it.brand ? [it.brand] : []) },
    category: { label: "카테고리", keysOf: it => (it.category ? [it.category] : []) },
  };
  function titleCase(s) {
    return String(s || "").replace(/\s+/g, " ").trim().replace(/\b\w/g, c => c.toUpperCase());
  }

  // Per-bucket share (%) for every key in a dimension.
  function sharesByBucket(buckets, dim) {
    const d = DIMS[dim] || DIMS.fabric;
    return buckets.map(b => {
      const counts = new Map();
      b.items.forEach(it => d.keysOf(it).forEach(k => {
        if (k) counts.set(k, (counts.get(k) || 0) + 1);
      }));
      const shares = new Map();
      counts.forEach((v, k) => shares.set(k, b.count ? (v / b.count) * 100 : 0));
      return { label: b.label, start: b.start, count: b.count, counts, shares };
    });
  }

  /* Series for charting: the top N keys by recent presence, each with a value
     per bucket. Ranking uses the LAST bucket that has data (what matters now),
     falling back to the overall total so an empty final period doesn't blank the
     chart. */
  function series(items, opts) {
    opts = opts || {};
    const dim = opts.dim || "fabric";
    const buckets = timeline(items, opts);
    const per = sharesByBucket(buckets, dim);
    const totals = new Map();
    per.forEach(p => p.counts.forEach((v, k) => totals.set(k, (totals.get(k) || 0) + v)));
    const recent = [...per].reverse().find(p => p.counts.size) || { counts: new Map() };
    const rank = k => (recent.counts.get(k) || 0) * 1000 + (totals.get(k) || 0);
    const keys = [...totals.keys()].sort((a, b) => rank(b) - rank(a)).slice(0, opts.top || 6);
    return {
      dim, label: (DIMS[dim] || DIMS.fabric).label,
      labels: per.map(p => p.label),
      counts: per.map(p => p.count),
      series: keys.map(k => ({
        key: k,
        values: per.map(p => Math.round((p.shares.get(k) || 0) * 10) / 10),
        counts: per.map(p => p.counts.get(k) || 0),
      })),
    };
  }

  /* Risers and fallers: change in share between the two halves of the window.
     Halves rather than last-vs-previous bucket, because a single period is noisy
     — a designer wants "this is trending", not "one odd week". Keys below
     minCount total occurrences are ignored so a single product can't top the
     chart. */
  function movers(items, opts) {
    opts = opts || {};
    const dim = opts.dim || "fabric";
    const minCount = opts.minCount == null ? 3 : opts.minCount;
    const buckets = timeline(items, opts);
    const per = sharesByBucket(buckets, dim);
    if (per.length < 2) return { dim, risers: [], fallers: [] };
    const mid = Math.ceil(per.length / 2);
    const half = arr => {
      const counts = new Map();
      let n = 0;
      arr.forEach(p => { n += p.count; p.counts.forEach((v, k) => counts.set(k, (counts.get(k) || 0) + v)); });
      const shares = new Map();
      counts.forEach((v, k) => shares.set(k, n ? (v / n) * 100 : 0));
      return { counts, shares, n };
    };
    const A = half(per.slice(0, mid)), B = half(per.slice(mid));
    const keys = new Set([...A.counts.keys(), ...B.counts.keys()]);
    const rows = [];
    keys.forEach(k => {
      const total = (A.counts.get(k) || 0) + (B.counts.get(k) || 0);
      if (total < minCount) return;
      const a = Math.round((A.shares.get(k) || 0) * 10) / 10;
      const b = Math.round((B.shares.get(k) || 0) * 10) / 10;
      rows.push({ key: k, before: a, after: b, delta: Math.round((b - a) * 10) / 10,
        countBefore: A.counts.get(k) || 0, countAfter: B.counts.get(k) || 0,
        isNew: !A.counts.get(k) && !!B.counts.get(k) });
    });
    const risers = rows.filter(r => r.delta > 0).sort((x, y) => y.delta - x.delta).slice(0, opts.top || 8);
    const fallers = rows.filter(r => r.delta < 0).sort((x, y) => x.delta - y.delta).slice(0, opts.top || 8);
    return { dim, label: (DIMS[dim] || DIMS.fabric).label,
      periodA: { n: A.n }, periodB: { n: B.n }, risers, fallers };
  }

  // Headline numbers for the LAB header.
  function overview(items, opts) {
    opts = opts || {};
    const buckets = timeline(items, opts);
    const withDate = (items || []).filter(i => i && i.addedAt);
    const span = withDate.length
      ? { from: Math.min(...withDate.map(i => i.addedAt)), to: Math.max(...withDate.map(i => i.addedAt)) }
      : null;
    const nonEmpty = buckets.filter(b => b.count);
    const last = nonEmpty[nonEmpty.length - 1], prev = nonEmpty[nonEmpty.length - 2];
    return {
      total: withDate.length,
      periods: buckets.length,
      periodsWithData: nonEmpty.length,
      span,
      latest: last ? { label: last.label, count: last.count } : null,
      deltaVsPrev: (last && prev) ? last.count - prev.count : null,
      // comparison needs at least two periods that actually have data
      comparable: nonEmpty.length >= 2,
    };
  }

  const API = { timeline, sharesByBucket, series, movers, overview, DIMS, bucketStart };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  root.TrendCalc = API;
})(typeof self !== "undefined" ? self : this);
