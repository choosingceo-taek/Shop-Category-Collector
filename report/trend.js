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

  const DIM_KEYS = Object.keys(DIMS);

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

  /* ---- weekly snapshots ---------------------------------------------------

     A snapshot is one week's numbers, frozen: how many products were newly seen
     and how often each keyword / fibre / colour / brand / category appeared.

     Why keep it when the products are already stored? Because the product rows
     are LIVE — a re-scan updates them, a cleanup deletes them, and a product
     whose page changes gets rewritten. The snapshot is the record of what we
     saw THAT WEEK, and it stays true afterwards. It is also tiny (a few KB a
     week, so a few hundred KB a year), which is what makes a multi-year view
     cheap: the chart reads ~100 rows instead of ~100,000 products.

     Rebuilding a week from live products always wins where the products still
     exist; the snapshot only fills in weeks that no longer have any. */

  // "2026-W32" — ISO week number of the Monday that starts the bucket.
  function weekId(start) {
    const d = new Date(start);
    const th = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 3);   // Thursday decides the year
    const jan1 = new Date(th.getFullYear(), 0, 1);
    const wk = Math.floor((th - jan1) / (7 * DAY)) + 1;
    return `${th.getFullYear()}-W${String(wk).padStart(2, "0")}`;
  }

  function countKeys(items, dim, topN) {
    const c = new Map();
    items.forEach(it => DIMS[dim].keysOf(it).forEach(k => { if (k) c.set(k, (c.get(k) || 0) + 1); }));
    const rows = [...c.entries()].sort((a, b) => b[1] - a[1]);
    const out = {};
    (topN ? rows.slice(0, topN) : rows).forEach(([k, v]) => { out[k] = v; });
    return out;
  }

  /* One snapshot record per week that has products. Deterministic: the same
     items always produce the same records, so re-running is a safe overwrite. */
  function weeklySnapshots(items, opts) {
    opts = Object.assign({}, opts || {}, { granularity: "week" });
    const topN = opts.topN || 200;
    return timeline(items, opts).filter(b => b.count).map(b => {
      const dims = {};
      DIM_KEYS.forEach(d => { dims[d] = countKeys(b.items, d, topN); });
      const uniq = f => new Set(b.items.map(f).filter(Boolean)).size;
      return {
        id: weekId(b.start), granularity: "week",
        start: b.start, end: b.end, label: b.label,
        products: b.count, brands: uniq(i => i.brand), sites: uniq(i => i.site || i.source),
        dims, builtAt: opts.now || Date.now(),
      };
    });
  }

  // A stored snapshot, reshaped to look exactly like a live bucket.
  function periodOfSnapshot(s, dim, label) {
    const counts = new Map(Object.entries((s.dims && s.dims[dim]) || {}));
    const shares = new Map();
    counts.forEach((v, k) => shares.set(k, s.products ? (v / s.products) * 100 : 0));
    return { label: label || s.label, start: s.start, count: s.products,
      counts, shares, fromSnapshot: true };
  }

  /* The bucket series every chart below runs on. Live products first; where a
     week has no products left, a stored snapshot stands in. Snapshots are
     weekly, so they are only consulted at week granularity. */
  function periodsFor(items, dim, opts) {
    const per = sharesByBucket(timeline(items, opts), dim);
    const snaps = (opts && opts.snapshots) || [];
    if (!snaps.length || (opts && opts.granularity) !== "week") return per;
    const byStart = new Map(snaps.map(s => [s.start, s]));
    return per.map(p => (p.count || !byStart.has(p.start))
      ? p : periodOfSnapshot(byStart.get(p.start), dim, p.label));
  }

  /* Series for charting: the top N keys by recent presence, each with a value
     per bucket. Ranking uses the LAST bucket that has data (what matters now),
     falling back to the overall total so an empty final period doesn't blank the
     chart. */
  function series(items, opts) {
    opts = opts || {};
    const dim = opts.dim || "fabric";
    const per = periodsFor(items, dim, opts);
    const totals = new Map();
    per.forEach(p => p.counts.forEach((v, k) => totals.set(k, (totals.get(k) || 0) + v)));
    const recent = [...per].reverse().find(p => p.counts.size) || { counts: new Map() };
    const rank = k => (recent.counts.get(k) || 0) * 1000 + (totals.get(k) || 0);
    const keys = [...totals.keys()].sort((a, b) => rank(b) - rank(a)).slice(0, opts.top || 6);
    return {
      dim, label: (DIMS[dim] || DIMS.fabric).label,
      labels: per.map(p => p.label),
      counts: per.map(p => p.count),
      // null, not 0, for a period with nothing collected — "we didn't look" is
      // not "it disappeared", and a 0 would draw a cliff that never happened
      series: keys.map(k => ({
        key: k,
        values: per.map(p => (p.count ? Math.round((p.shares.get(k) || 0) * 10) / 10 : null)),
        counts: per.map(p => (p.count ? (p.counts.get(k) || 0) : null)),
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
    // Halve the periods that HAVE data, not the calendar window. Scanning began
    // three weeks into a six-month window is normal; splitting the window would
    // put every key's "before" at 0% and report the whole assortment as new.
    const per = periodsFor(items, dim, opts).filter(p => p.count);
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

  /* Week-over-week: the two most recent periods that actually have data.

     `movers` above splits the whole window in half, which answers "what is
     trending this season". This answers the other question a weekly routine
     asks — "what changed since last time I ran the list" — and it deliberately
     compares the last two periods WITH data rather than the last two calendar
     periods, so skipping a week doesn't read as everything vanishing. */
  function latestChange(items, opts) {
    opts = opts || {};
    const dim = opts.dim || "keyword";
    const minCount = opts.minCount == null ? 2 : opts.minCount;
    const per = periodsFor(items, dim, opts).filter(p => p.count);
    if (per.length < 2) {
      return { dim, ok: false, periods: per.length,
        current: per[0] ? { label: per[0].label, count: per[0].count } : null, rows: [] };
    }
    const B = per[per.length - 1], A = per[per.length - 2];
    const keys = new Set([...A.counts.keys(), ...B.counts.keys()]);
    const rows = [];
    keys.forEach(k => {
      const ca = A.counts.get(k) || 0, cb = B.counts.get(k) || 0;
      if (ca + cb < minCount) return;
      const a = Math.round((A.shares.get(k) || 0) * 10) / 10;
      const b = Math.round((B.shares.get(k) || 0) * 10) / 10;
      rows.push({ key: k, before: a, after: b, delta: Math.round((b - a) * 10) / 10,
        countBefore: ca, countAfter: cb, isNew: !ca && !!cb, isGone: !!ca && !cb });
    });
    rows.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
    return {
      dim, ok: true,
      previous: { label: A.label, count: A.count },
      current: { label: B.label, count: B.count },
      rows: rows.slice(0, opts.top || 10),
      risers: rows.filter(r => r.delta > 0).slice(0, opts.top || 6),
      fallers: rows.filter(r => r.delta < 0).slice(0, opts.top || 6),
    };
  }

  /* Keywords worth a designer's attention right now — the "제안" layer.

     Two honest signals, both pure counting, both stated as the reason so nobody
     has to trust a black box:
       · 연속 상승 — share went up in every step of the last `window` periods
       · 신규 — absent from the earlier periods, present now with enough samples
     Anything below minCount in the latest period is dropped: one product is an
     accident, not a direction. */
  function emerging(items, opts) {
    opts = opts || {};
    const dim = opts.dim || "keyword";
    const win = opts.window || 3;
    const minCount = opts.minCount == null ? 2 : opts.minCount;
    const per = periodsFor(items, dim, opts).filter(p => p.count);
    if (per.length < 2) return { dim, ok: false, periods: per.length, rows: [] };

    const tail = per.slice(-win);
    const earlier = per.slice(0, -tail.length);
    const last = tail[tail.length - 1];
    const rows = [];
    last.counts.forEach((cnt, k) => {
      if (cnt < minCount) return;
      const path = tail.map(p => Math.round((p.shares.get(k) || 0) * 10) / 10);
      const seenBefore = earlier.some(p => p.counts.get(k)) ||
        tail.slice(0, -1).some(p => p.counts.get(k));
      const rising = path.length >= 2 && path.every((v, i) => i === 0 || v > path[i - 1]);
      if (!seenBefore) {
        rows.push({ key: k, kind: "new", reason: "이번 구간에 처음 등장",
          count: cnt, share: path[path.length - 1], path, lift: path[path.length - 1] });
      } else if (rising) {
        rows.push({ key: k, kind: "rising", reason: `${path.length}구간 연속 상승`,
          count: cnt, share: path[path.length - 1], path,
          lift: Math.round((path[path.length - 1] - path[0]) * 10) / 10 });
      }
    });
    // biggest movement first; a tie goes to the one backed by more products
    rows.sort((a, b) => (b.lift - a.lift) || (b.count - a.count));
    return { dim, ok: true, label: (DIMS[dim] || {}).label || dim,
      periods: per.length, current: { label: last.label, count: last.count },
      rows: rows.slice(0, opts.top || 8) };
  }

  /* One row per period: the week-by-week ledger, for the "한눈에" table.
     `top` names the leading keys of that period so a row is readable on its own. */
  function ledger(items, opts) {
    opts = opts || {};
    const dim = opts.dim || "keyword";
    const per = periodsFor(items, dim, opts);
    let prev = null;
    return per.map(p => {
      const top = [...p.counts.entries()].sort((a, b) => b[1] - a[1])
        .slice(0, opts.top || 4)
        .map(([k, v]) => ({ key: k, count: v, share: Math.round((p.shares.get(k) || 0) * 10) / 10 }));
      const row = { label: p.label, start: p.start, count: p.count, top,
        stored: !!p.fromSnapshot, delta: (p.count && prev != null) ? p.count - prev : null };
      if (p.count) prev = p.count;
      return row;
    });
  }

  // Headline numbers for the LAB header.
  function overview(items, opts) {
    opts = opts || {};
    const buckets = periodsFor(items, "brand", opts);
    const withDate = (items || []).filter(i => i && i.addedAt);
    const span = withDate.length
      ? { from: Math.min(...withDate.map(i => i.addedAt)), to: Math.max(...withDate.map(i => i.addedAt)) }
      : null;
    const nonEmpty = buckets.filter(b => b.count);
    const last = nonEmpty[nonEmpty.length - 1], prev = nonEmpty[nonEmpty.length - 2];
    // products the window can only see through a stored snapshot
    const archived = buckets.filter(b => b.fromSnapshot).reduce((n, b) => n + b.count, 0);
    const uniq = f => new Set(withDate.map(f).filter(Boolean)).size;
    return {
      total: withDate.length,
      archived,
      brands: uniq(i => i.brand),
      categories: uniq(i => i.category),
      sites: uniq(i => i.site || i.source),
      periods: buckets.length,
      periodsWithData: nonEmpty.length,
      span,
      latest: last ? { label: last.label, count: last.count } : null,
      deltaVsPrev: (last && prev) ? last.count - prev.count : null,
      // comparison needs at least two periods that actually have data
      comparable: nonEmpty.length >= 2,
    };
  }

  const API = { timeline, sharesByBucket, periodsFor, series, movers, latestChange,
    emerging, ledger, overview, weeklySnapshots, weekId, DIMS, bucketStart };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  root.TrendCalc = API;
})(typeof self !== "undefined" ? self : this);
