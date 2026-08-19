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
  /* Four intervals, because the question changes with the season's tempo: a
     month for "what is this quarter made of", a fortnight for the drop cycle
     most of these shops actually run on, a week for the scanning routine, a
     day when something is moving fast enough to watch daily.

     A FORTNIGHT has to land on the same Mondays whatever today is. Pairing
     weeks off "now" would re-cut every bucket each time the page opened, and
     two screens on two days would disagree about which fortnight a product
     fell in. So the pairing counts from a fixed Monday (1 Jan 2024) and keeps
     the even one — the same fortnight for everybody, for ever. */
  const FORTNIGHT_ANCHOR = new Date(2024, 0, 1).getTime();   // a Monday, local
  const backDays = (ts, n) => {
    const d = new Date(ts);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - n).getTime();
  };
  function bucketStart(ts, granularity) {
    const d = new Date(ts);
    if (granularity === "month") return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    if (granularity === "day") return day.getTime();
    const dow = (day.getDay() + 6) % 7;                 // Mon = 0
    const week = day.getTime() - dow * DAY;
    if (granularity !== "fortnight") return week;
    // whole weeks between this Monday and the anchor; odd means we are in the
    // second half of a fortnight, so step back to its first Monday
    const weeks = Math.round((week - FORTNIGHT_ANCHOR) / (7 * DAY));
    return weeks % 2 === 0 ? week : backDays(week, 7);
  }
  function nextBucket(ts, granularity) {
    const d = new Date(ts);
    if (granularity === "month") return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
    // calendar arithmetic rather than milliseconds, so an hour lost or gained
    // to daylight saving cannot slide a boundary onto the wrong date
    if (granularity === "day") return backDays(ts, -1);
    if (granularity === "fortnight") return backDays(ts, -14);
    return ts + 7 * DAY;
  }
  function labelOf(ts, granularity) {
    const d = new Date(ts);
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    return granularity === "month"
      ? `${String(d.getFullYear()).slice(2)}.${mm}`
      : `${mm}/${String(d.getDate()).padStart(2, "0")}`;
  }
  // what one bucket IS, for the axis and for prose. Every interval that is not
  // a calendar month is counted in days, so the word follows the choice.
  const UNIT_NAME = { month: "month", fortnight: "fortnight", week: "week", day: "day" };
  const unitName = g => UNIT_NAME[g] || "week";
  /* The intervals themselves, named here rather than in the markup: the page
     offering a choice the maths cannot bucket is a control that does nothing,
     and that is worse than not offering it. */
  const GRANULARITIES = [
    { value: "month", label: "Monthly" },
    { value: "fortnight", label: "Biweekly" },
    { value: "week", label: "Weekly" },
    { value: "day", label: "Daily" },
  ];

  /* Group products into consecutive time buckets by first-seen date.
     opts: { months = 6, granularity = 'month'|'fortnight'|'week'|'day', now }
     Empty periods are kept so a gap reads as a gap rather than being closed up. */
  function timeline(items, opts) {
    opts = opts || {};
    const granularity = opts.granularity || "month";
    const months = opts.months || 6;
    const now = opts.now || Date.now();
    const rows = (items || []).filter(i => i && i.addedAt);
    const from = (() => {
      const d = new Date(now);
      // the window's first bucket has to start where THIS interval's buckets
      // start — cutting a fortnight or a day window on week boundaries would
      // put the first period half outside the window it claims to show
      return granularity === "month"
        ? new Date(d.getFullYear(), d.getMonth() - (months - 1), 1).getTime()
        : bucketStart(now - (months * 30 * DAY), granularity);
    })();

    const buckets = [];
    for (let t = from; t <= now; t = nextBucket(t, granularity)) {
      buckets.push({ start: t, end: nextBucket(t, granularity),
        label: labelOf(t, granularity), items: [] });
      // a backstop against a runaway loop, not a display limit: a year of days
      // is 365 buckets and has to fit, or the longest window would silently
      // show three quarters of itself
      if (buckets.length > 400) break;
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
      label: "Fabric",
      /* On the fifteen-fibre shelf. Counted as the shops write them, one
         fibre arrives as "Polyester", "Recycled Polyester" and "Poly Ester"
         and lands in three rows that each look small. */
      keysOf: it => Calc.fibreFamilies(it.fabric_composition),
    },
    color: {
      label: "Colour",
      /* On the twelve-colour shelf — the set a shop's own colour filter
         offers. A colourway is a sales name ("Deep Sea Navy"), so counting it
         as written gives a list of names seen once each and no colour at all. */
      keysOf: it => Calc.colourFamilies(it.colorways),
    },
    /* The three things a product NAME states, kept apart on purpose — a
       season where linen doubles and a season where ruching doubles are
       different findings, and one merged ranking hides both. */
    material: {
      label: "Material in name",
      keysOf: it => Calc.normItem(it).nameKinds.material.map(titleCase),
    },
    weave: {
      label: "Weave / structure",
      keysOf: it => Calc.normItem(it).nameKinds.weave.map(titleCase),
    },
    /* How the garment sits, kept out of the detail bucket — a season that goes
       oversized and a season that goes ruched are different findings. */
    fit: {
      label: "Fit",
      keysOf: it => Calc.normItem(it).nameKinds.fit.map(titleCase),
    },
    keyword: {
      label: "Design detail",
      keysOf: it => Calc.normItem(it).nameKinds.detail.map(titleCase),
    },
    /* The shape of the item — "midi dress" — which is neither the category
       (Dresses) nor the fit (how it sits). Read from the name and the shop's
       own product type, so it applies to everything already collected. */
    silhouette: {
      label: "Silhouette",
      keysOf: it => {
        const s = Calc.silhouetteOf([it && it.name, it && it.product_type].filter(Boolean).join(" "));
        return s ? [titleCase(s)] : [];
      },
    },
    /* The cloth, named the way a designer names it: the weave when the shop
       states one (satin, poplin, jersey), otherwise the fibre that the
       composition says the garment is mostly made of. Kept separate from the
       `fabric` axis above — that one counts every fibre in the blend and is
       what the stored weekly records have always held. */
    fabricfam: {
      label: "Fabric",
      keysOf: it => {
        const nk = Calc.normItem(it).nameKinds;
        if (nk.weave.length) return nk.weave.map(titleCase);
        // the fibre the composition says it is mostly made of, on the shelf
        const main = Calc.mainFibre(it.fabric_composition);
        if (main) return [main];
        return nk.material.length ? [titleCase(nk.material[0])] : [];
      },
    },
    brand: { label: "Brand", keysOf: it => (it.brand ? [it.brand] : []) },
    category: { label: "Category", keysOf: it => (it.category ? [it.category] : []) },
    // attached at display time from the imported brand sheet (lists.tierMap)
    tier: { label: "Tier", keysOf: it => (it.tier ? [it.tier] : []) },
  };
  function titleCase(s) {
    return String(s || "").replace(/\s+/g, " ").trim().replace(/\b\w/g, c => c.toUpperCase());
  }

  const DIM_KEYS = Object.keys(DIMS);

  // Per-bucket share (%) for every key in a dimension.
  /* ---- what a number counts ------------------------------------------------

     Two honest units, and they answer different questions.

     PRODUCTS — "of everything that arrived this week, how much of it was
     linen". Sensitive to volume: one shop that drops sixty linen pieces moves
     the figure as much as twenty shops adopting linen.

     BRANDS — "of the shops we watched this week, how many put out any linen at
     all". One shop counts once however much it makes, so the figure answers
     the question a designer actually proposes on: is the market moving, or is
     one label busy. It is also what makes timing readable — the same keyword
     climbing from four brands to twenty is a wave; sixty products from one
     brand is a drop. */
  const brandOf = it => String((it && it.brand) || "").trim();
  const rosterOf = items => new Set((items || []).map(brandOf).filter(Boolean)).size;

  function tallyIn(items, d, unit) {
    const counts = new Map();
    if (unit === "brands") {
      const seen = new Map();                    // key -> Set(brand)
      (items || []).forEach(it => {
        const b = brandOf(it);
        if (!b) return;
        d.keysOf(it).forEach(k => {
          if (!k) return;
          if (!seen.has(k)) seen.set(k, new Set());
          seen.get(k).add(b);
        });
      });
      seen.forEach((set, k) => counts.set(k, set.size));
      return counts;
    }
    (items || []).forEach(it => d.keysOf(it).forEach(k => {
      if (k) counts.set(k, (counts.get(k) || 0) + 1);
    }));
    return counts;
  }

  function sharesByBucket(buckets, dim, unit) {
    const d = DIMS[dim] || DIMS.fabric;
    return buckets.map(b => {
      const counts = tallyIn(b.items, d, unit);
      /* The denominator has to match the numerator. Brand counts are out of
         the brands that produced anything that week, product counts out of the
         products. Mixing them would put a brand count over a product total and
         read as a collapse. */
      const brands = rosterOf(b.items);
      const base = unit === "brands" ? brands : b.count;
      const shares = new Map();
      counts.forEach((v, k) => shares.set(k, base ? (v / base) * 100 : 0));
      return { label: b.label, start: b.start, count: b.count, brands,
        base, unit: unit === "brands" ? "brands" : "products", counts, shares };
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

  /* ---- what was actually looked at ----------------------------------------

     Every share in here is "out of that week's new arrivals", which is only
     comparable between two weeks if the two weeks looked at the same shops.
     They often did not: a list grows as the designer finds brands, a category
     gets added, a shop blocks a scan, a URL is retired. Then "Cotton went from
     30% to 45%" can be entirely the new brands, and "that colour collapsed"
     can be one shop we simply did not read this week.

     So a week records its ROSTER — the brand·category collections that
     actually produced products — and any two weeks are compared on the
     collections they share. This is the same-store-sales rule: measure the
     shops open in both periods, and report the ones that opened or closed
     separately rather than letting them move the number silently. */
  const collectionKey = it =>
    String((it && it.brand) || "").trim() + " · " + String((it && it.category) || "").trim();
  const collectionsOf = items =>
    [...new Set((items || []).map(collectionKey).filter(k => k.trim() !== "·"))].sort();

  // Counts and shares for one set of items, in one dimension.
  function tallyOf(items, dim, unit) {
    const d = DIMS[dim] || DIMS.fabric;
    const counts = tallyIn(items, d, unit);
    const n = (items || []).length;
    const brands = rosterOf(items);
    const base = unit === "brands" ? brands : n;
    const shares = new Map();
    counts.forEach((v, k) => shares.set(k, base ? (v / base) * 100 : 0));
    return { count: n, brands, base, counts, shares };
  }

  function rowsBetween(A, B, minCount, top) {
    const rows = [];
    new Set([...A.counts.keys(), ...B.counts.keys()]).forEach(k => {
      const ca = A.counts.get(k) || 0, cb = B.counts.get(k) || 0;
      if (ca + cb < minCount) return;
      const a = Math.round((A.shares.get(k) || 0) * 10) / 10;
      const b = Math.round((B.shares.get(k) || 0) * 10) / 10;
      rows.push({ key: k, before: a, after: b, delta: Math.round((b - a) * 10) / 10,
        countBefore: ca, countAfter: cb, isNew: !ca && !!cb, isGone: !!ca && !cb });
    });
    rows.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
    return top ? rows.slice(0, top) : rows;
  }

  /* Compare the two most recent periods that have data, on a like-for-like
     basis — and say plainly how much of the list moved underneath.

     Returns both readings, never one dressed as the other:
       matched   only the collections present in BOTH periods. The trend.
       all       everything collected in each period. The volume.
     plus `coverage`, which names what was added and what went unread. When the
     two readings disagree, the difference IS the coverage change, and that is
     the thing worth knowing before quoting a number to the team. */
  function weekCompare(items, opts) {
    opts = Object.assign({ granularity: "week" }, opts || {});
    const dim = opts.dim || "fabric";
    const minCount = opts.minCount == null ? 2 : opts.minCount;
    const unit = unitName(opts.granularity);
    const buckets = timeline(items, opts).filter(b => b.count);
    if (buckets.length < 2) {
      return { ok: false, dim, unit, periods: buckets.length,
        reason: buckets.length ? "only one period has products" : "nothing collected yet" };
    }
    const A = buckets[buckets.length - 2], B = buckets[buckets.length - 1];
    const rosterA = new Set(collectionsOf(A.items));
    const rosterB = new Set(collectionsOf(B.items));
    const common = [...rosterA].filter(k => rosterB.has(k));
    const commonSet = new Set(common);
    const added = [...rosterB].filter(k => !rosterA.has(k)).sort();
    const dropped = [...rosterA].filter(k => !rosterB.has(k)).sort();

    const inCommon = it => commonSet.has(collectionKey(it));
    // `unit` here is already the TIME unit (week/month) — this is the counting one
    const countUnit = (opts && opts.unit) || "products";
    const mA = tallyOf(A.items.filter(inCommon), dim, countUnit);
    const mB = tallyOf(B.items.filter(inCommon), dim, countUnit);
    const aA = tallyOf(A.items, dim, countUnit);
    const aB = tallyOf(B.items, dim, countUnit);

    return {
      ok: true, dim, unit,
      previous: { label: A.label, start: A.start, count: aA.count, collections: rosterA.size },
      current: { label: B.label, start: B.start, count: aB.count, collections: rosterB.size },
      coverage: {
        common: common.length, added, dropped,
        // Nothing changed underneath, so the two readings are the same number.
        stable: !added.length && !dropped.length,
        // Too little overlap to call it a comparison at all.
        comparable: common.length > 0,
        matchedProducts: { before: mA.count, after: mB.count },
      },
      matched: {
        rows: rowsBetween(mA, mB, minCount, opts.top || 10),
        before: mA.count, after: mB.count,
      },
      all: {
        rows: rowsBetween(aA, aB, minCount, opts.top || 10),
        before: aA.count, after: aB.count,
      },
    };
  }

  /* The pulse: one line per measure, what it did this period, and its shape.

     A designer scanning her list every week wants one table, not eight
     charts: which fabrics/colours/silhouettes are up, which are down, which
     are holding, and what each has been doing lately. So each row carries

       change     the like-for-like move against the previous period, in
                  percentage points — the honest number, computed only on the
                  collections both periods contain (see weekCompare)
       spark      the share across the recent periods that HAVE data, so the
                  shape is visible at a glance. It is the raw share history:
                  a sparkline is a trajectory, not a figure to quote, and
                  mixing bases inside one line would be worse than either.
       direction  up / down / flat / new / gone. Flat is stated rather than
                  shown as a tiny wobble, because "it held" is an answer.

     Rows come from the matched comparison, so a measure that appears only in
     a brand added this week is not presented as a rise; it shows up in the
     coverage line instead, which is where it belongs. */
  function pulse(items, opts) {
    opts = Object.assign({ granularity: "week" }, opts || {});
    const dim = opts.dim || "fabric";
    const spark = opts.spark || 8;
    const cmp = weekCompare(items, opts);
    /* What counts as "it moved" depends on how much was collected.

       A fixed percentage band lies at both ends: on a 20-product week a
       single garment is a 5-point swing, and calling that a rise would put
       noise at the top of the table; on a 600-product week a 2-point move is
       a dozen garments and reporting it as steady would hide a real shift.
       So the band is the larger of a floor and ONE PRODUCT's worth of share
       in the smaller of the two periods — a move the data cannot resolve is
       reported as steady, which is what it is. */
    const matched = (cmp.ok && cmp.coverage.matchedProducts) || { before: 0, after: 0 };
    const smallest = Math.max(1, Math.min(matched.before || 0, matched.after || 0) || 1);
    const flat = Math.max(opts.flat == null ? 1.5 : opts.flat, 100 / smallest);
    const tail = periodsFor(items, dim, opts).filter(p => p.count).slice(-spark);
    const rows = (cmp.ok ? cmp.matched.rows : []).map(r => ({
      key: r.key, before: r.before, after: r.after, delta: r.delta,
      countBefore: r.countBefore, countAfter: r.countAfter,
      isNew: r.isNew, isGone: r.isGone,
      direction: r.isNew ? "new" : r.isGone ? "gone"
        : Math.abs(r.delta) < flat ? "flat" : (r.delta > 0 ? "up" : "down"),
      spark: tail.map(p => Math.round((p.shares.get(r.key) || 0) * 10) / 10),
    }));
    return {
      ok: cmp.ok, dim, unit: cmp.unit, reason: cmp.reason, periods: cmp.periods,
      label: (DIMS[dim] || DIMS.fabric).label,
      previous: cmp.previous, current: cmp.current, coverage: cmp.coverage,
      all: cmp.all, rows, sparkLabels: tail.map(p => p.label),
      // stated, not hidden: the reader can see why something reads STABLE
      resolution: Math.round(flat * 10) / 10,
    };
  }

  function countKeys(items, dim, topN, unit) {
    const c = tallyIn(items, DIMS[dim], unit);
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
    /* A list is one research question, so its weeks are its own record: the id
       carries the list, and the whole-catalog record keeps the bare week id it
       has always had. Without this, scoping the LAB to a list would file that
       list's numbers under the catalog's week and quietly rewrite history. */
    const listId = opts.listId || "";
    return timeline(items, opts).filter(b => b.count).map(b => {
      const dims = {};
      const bdims = {};
      DIM_KEYS.forEach(d => {
        dims[d] = countKeys(b.items, d, topN);
        // the same week counted by brands — a few hundred bytes more, and the
        // only way a cleaned-up week can still answer "how many shops"
        bdims[d] = countKeys(b.items, d, topN, "brands");
      });
      const uniq = f => new Set(b.items.map(f).filter(Boolean)).size;
      return {
        id: (listId ? listId + "|" : "") + weekId(b.start), listId,
        granularity: "week",
        start: b.start, end: b.end, label: b.label,
        products: b.count, brands: uniq(i => i.brand), sites: uniq(i => i.site || i.source),
        /* What this week actually looked at. Kept so a week stays comparable
           after its products are cleaned up — without it, an old week's share
           can only ever be read on a basis nobody can check. Capped, because a
           snapshot is meant to stay a few KB. */
        collections: collectionsOf(b.items).slice(0, 400),
        dims, bdims, builtAt: opts.now || Date.now(),
      };
    });
  }

  // A stored snapshot, reshaped to look exactly like a live bucket.
  function periodOfSnapshot(s, dim, label, unit) {
    /* A frozen week answers in the unit it recorded. Records written before
       brand counts existed hold product counts only — reading those as brands
       would put a product number over a brand roster, so such a week is
       reported as having nothing rather than as a collapse. */
    const src = unit === "brands"
      ? ((s.bdims && s.bdims[dim]) || null)
      : ((s.dims && s.dims[dim]) || {});
    /* A week frozen before the shelves existed holds the shops' own words
       ("Deep Sea Navy", "Recycled Polyester"). Read through the same shelf the
       live weeks are counted on, or one chart runs two vocabularies at once
       and the old weeks look like a collapse. Same rule as the brand and
       category repairs: fix it on the way in as well as on the way out, so a
       record already written comes right by being opened. */
    const counts = new Map();
    Object.entries(src || {}).forEach(([k, v]) => {
      const shelf = dim === "color" ? Calc.colourFamily(k)
        : (dim === "fabric" || dim === "fabricfam") ? (Calc.fibreFamily(k) || k)
        : k;
      const key = shelf || k;
      /* Products add up; brands do not. A shop that put out both a "Navy" and
         a "Deep Sea Navy" is one shop, and adding the two would report more
         brands than the roster holds — so the larger of the two stands, which
         is the most that can be true. */
      counts.set(key, unit === "brands"
        ? Math.max(counts.get(key) || 0, v)
        : (counts.get(key) || 0) + v);
    });
    const base = unit === "brands" ? (src ? (s.brands || 0) : 0) : s.products;
    const shares = new Map();
    counts.forEach((v, k) => shares.set(k, base ? (v / base) * 100 : 0));
    return { label: label || s.label, start: s.start,
      count: unit === "brands" ? (src ? s.products : 0) : s.products,
      brands: s.brands || 0, base, counts, shares, fromSnapshot: true };
  }

  /* The bucket series every chart below runs on. Live products first; where a
     week has no products left, a stored snapshot stands in. Snapshots are
     weekly, so they are only consulted at week granularity. */
  function periodsFor(items, dim, opts) {
    const unit = (opts && opts.unit) || "products";
    const per = sharesByBucket(timeline(items, opts), dim, unit);
    const snaps = (opts && opts.snapshots) || [];
    if (!snaps.length || (opts && opts.granularity) !== "week") return per;
    const byStart = new Map(snaps.map(s => [s.start, s]));
    return per.map(p => (p.count || !byStart.has(p.start))
      ? p : periodOfSnapshot(byStart.get(p.start), dim, p.label, unit));
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
      unit: (opts.unit === "brands" ? "brands" : "products"),
      labels: per.map(p => p.label),
      counts: per.map(p => p.count),
      // how many shops produced anything in each period — the denominator a
      // brand-counted share is read against ("21 of 32")
      brands: per.map(p => p.brands || 0),
      bases: per.map(p => p.base || 0),
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
        rows.push({ key: k, kind: "new", reason: "first seen this period",
          count: cnt, share: path[path.length - 1], path, lift: path[path.length - 1] });
      } else if (rising) {
        rows.push({ key: k, kind: "rising", reason: `up ${path.length} periods running`,
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

  /* Price and discount pressure, period by period.

     A separate read from the share charts and worth its own section: what the
     assortment COSTS and how hard it is being marked down is the clearest
     read on where a brand's season is. Sale share climbing week over week
     means end-of-season or overstock long before the products change.

     Median, not just mean, because one $400 coat drags an average of $40 tees.
     A period with no priced rows reports null rather than 0 — "we collected no
     prices" is not "everything is free". */
  function priceByPeriod(items, opts) {
    opts = opts || {};
    const num = v => {
      const m = String(v == null ? "" : v).replace(/,/g, "").match(/\d+(?:\.\d+)?/);
      return m ? parseFloat(m[0]) : null;
    };
    const median = arr => {
      if (!arr.length) return null;
      const s = arr.slice().sort((a, b) => a - b), h = s.length >> 1;
      return s.length % 2 ? s[h] : Math.round(((s[h - 1] + s[h]) / 2) * 100) / 100;
    };
    // buckets carry their items, so this reads the live timeline (not snapshots,
    // which store counts only — a snapshot period reports nulls, honestly)
    return timeline(items, opts).map(b => {
      const priced = [], sale = [];
      b.items.forEach(it => {
        const p = num(it.price), was = num(it.price_was);
        if (p != null) priced.push(p);
        if (p != null && was != null && was > p) sale.push(Math.round(((was - p) / was) * 100));
      });
      return {
        label: b.label, start: b.start, count: b.count,
        priced: priced.length,
        avg: priced.length ? Math.round((priced.reduce((s, v) => s + v, 0) / priced.length) * 100) / 100 : null,
        median: median(priced),
        min: priced.length ? Math.min(...priced) : null,
        max: priced.length ? Math.max(...priced) : null,
        salePct: priced.length ? Math.round((sale.length / priced.length) * 1000) / 10 : null,
        avgDiscount: sale.length ? Math.round(sale.reduce((s, v) => s + v, 0) / sale.length) : null,
      };
    });
  }

  /* Plain frequency ranking over the whole window.

     The share charts answer "is this rising"; this answers the flatter question
     a designer asks first — "what am I actually seeing, most to least". Counts
     are products, not mentions: a name repeating a word does not vote twice
     (keysOf de-duplicates per item), so the ranking cannot be inflated by
     wordy titles. */
  /* What a fabric key is actually made of, in the shops' own numbers.

     The axis key is a name ("Satin", "Viscose"); the line under it is the
     composition the products behind that name most often carried, so a
     designer reads the cloth AND the blend without opening anything. Modal
     rather than averaged: an average of two different blends is a blend
     nobody makes. */
  function blends(items, opts) {
    opts = opts || {};
    const d = DIMS[opts.dim || "fabricfam"] || DIMS.fabricfam;
    const per = new Map();                     // key -> Map(blend -> n)
    (items || []).forEach(it => {
      const fib = Calc.parseFibers(it.fabric_composition);
      if (!fib.length) return;
      const blend = fib.slice().sort((a, b) => (b.pct || 0) - (a.pct || 0))
        .slice(0, 3)
        .map(f => `${f.fiber.toLowerCase()}${f.pct != null ? " " + f.pct : ""}`)
        .join(" · ");
      d.keysOf(it).forEach(k => {
        if (!k) return;
        if (!per.has(k)) per.set(k, new Map());
        const m = per.get(k);
        m.set(blend, (m.get(blend) || 0) + 1);
      });
    });
    const out = {};
    per.forEach((m, k) => {
      out[k] = [...m.entries()].sort((a, b) => b[1] - a[1])[0][0];
    });
    return out;
  }

  /* ---- Google Trends, brought in by hand ----------------------------------

     What a designer downloads from trends.google.com is "Interest over time":
     a couple of preamble lines, a header whose first cell is the time unit,
     then one row per week. The columns are the terms, written as
     "satin dress: (United States)".

     Read exactly what the file says and nothing more. The numbers are Google's
     0–100 interest index, NOT a rank and not a volume, so they are stored as
     they came and labelled as what they are. A week the file does not mention
     has no row — the line breaks there rather than dropping to zero, which is
     the same rule the scan data follows. */
  function parseTrendsCsv(text) {
    const lines = String(text || "").split(/\r?\n/);
    const cells = l => {
      const out = []; let cur = "", q = false;
      for (let i = 0; i < l.length; i++) {
        const c = l[i];
        if (c === '"') { if (q && l[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
        else if (c === "," && !q) { out.push(cur); cur = ""; }
        else cur += c;
      }
      out.push(cur);
      return out.map(x => x.trim());
    };
    const isDate = s => /^\d{4}-\d{2}(-\d{2})?$/.test(s);
    let head = -1;
    for (let i = 0; i < lines.length; i++) {
      const c = cells(lines[i]);
      if (c.length >= 2 && /^(week|day|month|time|주|일|월)\b/i.test(c[0]) && c[1]) { head = i; break; }
    }
    if (head < 0) {
      // some exports have no header row at all — find the first dated line
      for (let i = 0; i < lines.length; i++) {
        const c = cells(lines[i]);
        if (c.length >= 2 && isDate(c[0])) { head = i - 1; break; }
      }
    }
    if (head < -1) return { terms: [], rows: [] };
    const header = head >= 0 ? cells(lines[head]) : [];
    const terms = header.slice(1).map(h =>
      h.replace(/:\s*\([^)]*\)\s*$/, "").replace(/^"|"$/g, "").trim()).filter(Boolean);
    const rows = [];
    for (let i = head + 1; i < lines.length; i++) {
      const c = cells(lines[i]);
      if (!c.length || !isDate(c[0])) continue;
      terms.forEach((term, j) => {
        const raw = c[j + 1];
        if (raw == null || raw === "") return;
        // Trends writes "<1" for a value below one per cent of the peak
        const v = /^<\s*1$/.test(raw) ? 0.5 : parseFloat(raw);
        if (!isFinite(v)) return;
        rows.push({ term, week: weekId(new Date(c[0] + "T00:00:00").getTime()), value: v });
      });
    }
    return { terms, rows };
  }

  /* Which imported term belongs to an axis key. The designer types the query
     the way people search ("satin dress"), and the axis key is one word
     ("Satin"), so a term counts for a key when it CONTAINS that key as a whole
     word. One key can gather several terms; the strongest is shown. */
  function trendsForKey(key, rows) {
    const k = String(key || "").toLowerCase().trim();
    if (!k) return [];
    const re = new RegExp("(^|[^a-z])" + k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "([^a-z]|$)", "i");
    return (rows || []).filter(r => re.test(String(r.term || "")));
  }

  /* ---- one axis, as the LAB draws it --------------------------------------

     Rows counted in BRANDS ("21 of the 32 shops that produced this week"),
     with the change measured LIKE FOR LIKE: only the shops present in both
     weeks. Without that rule the number rises whenever the designer adds a
     brand to the list, and "satin +4" turns out to mean "we started watching
     four more shops" — the same-store-sales rule this file already applies to
     the week comparison, applied where the eye actually lands.

     The headline count is still every shop that produced this week, because
     that is a fact about this week; only the CHANGE is restricted. What moved
     in and out of the roster is returned alongside, so the screen can say it
     rather than bury it. */
  function axisRows(items, opts) {
    opts = opts || {};
    const d = DIMS[opts.dim] || DIMS.fabricfam;
    const per = timeline(items, opts).map(b => {
      const brands = new Set((b.items || []).map(brandOf).filter(Boolean));
      const byKey = new Map();
      const nKey = new Map();
      (b.items || []).forEach(it => {
        const br = brandOf(it);
        d.keysOf(it).forEach(k => {
          if (!k) return;
          nKey.set(k, (nKey.get(k) || 0) + 1);
          if (!br) return;
          if (!byKey.has(k)) byKey.set(k, new Set());
          byKey.get(k).add(br);
        });
      });
      return { label: b.label, start: b.start, count: b.count, brands, byKey, nKey };
    });
    const withData = per.filter(p => p.count);
    const last = withData[withData.length - 1] || null;
    const prev = withData[withData.length - 2] || null;
    if (!last) return { dim: opts.dim, label: d.label, rows: [], roster: 0, shared: 0,
      joined: [], left: [], labels: per.map(p => p.label) };

    const shared = prev ? new Set([...last.brands].filter(b => prev.brands.has(b))) : new Set();
    const inShared = (p, k) => {
      const set = p && p.byKey.get(k);
      return set ? [...set].filter(b => shared.has(b)).length : 0;
    };
    const rows = [...last.byKey.keys()].map(k => ({
      key: k,
      n: last.byKey.get(k).size,
      products: last.nKey.get(k) || 0,
      // null when there is no earlier week to compare with, or no shop in common
      delta: (prev && shared.size) ? inShared(last, k) - inShared(prev, k) : null,
      spark: per.map(p => (p.count
        ? Math.round(((p.byKey.get(k) ? p.byKey.get(k).size : 0) / (p.brands.size || 1)) * 1000) / 10
        : null)),
      /* How many items carried it in each period — the count itself, not a
         share. A share moves when the week's total moves, which is the wrong
         shape to put beside "16 products"; this is the figure on the card,
         drawn over the weeks. Null for a period with nothing collected, so a
         week nobody scanned reads as a gap and not as a collapse. */
      counts: per.map(p => (p.count ? (p.nKey.get(k) || 0) : null)),
    })).sort((a, b) => b.products - a.products || b.n - a.n)
      .slice(0, opts.top || 10);

    return {
      dim: opts.dim, label: d.label, rows,
      roster: last.brands.size,
      shared: shared.size,
      joined: prev ? [...last.brands].filter(b => !prev.brands.has(b)).sort() : [],
      left: prev ? [...prev.brands].filter(b => !last.brands.has(b)).sort() : [],
      labels: per.map(p => p.label),
    };
  }

  function ranked(items, opts) {
    opts = opts || {};
    const dim = opts.dim || "keyword";
    const per = periodsFor(items, dim, opts).filter(p => p.count);
    const total = per.reduce((n, p) => n + p.count, 0);
    const counts = new Map();
    per.forEach(p => p.counts.forEach((v, k) => counts.set(k, (counts.get(k) || 0) + v)));
    const rows = [...counts.entries()]
      .filter(([, v]) => v >= (opts.minCount == null ? 2 : opts.minCount))
      .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
      .slice(0, opts.top || 20)
      .map(([key, count]) => ({ key, count, share: total ? Math.round((count / total) * 1000) / 10 : 0 }));
    return { dim, label: (DIMS[dim] || {}).label || dim, total, rows };
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

  const API = { timeline, sharesByBucket, periodsFor, series, movers, latestChange, blends, axisRows,
    parseTrendsCsv, trendsForKey,
    emerging, ledger, ranked, priceByPeriod, overview, weeklySnapshots, weekId,
    weekCompare, pulse, collectionsOf, collectionKey,
    DIMS, bucketStart, unitName, GRANULARITIES };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  root.TrendCalc = API;
})(typeof self !== "undefined" ? self : this);
