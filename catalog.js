/* Catalog tab — everything collected, in one place.

   This is the screen the vision is built around: instead of visiting each brand
   site to check products, the designer opens this and browses what the scans
   already gathered, filters down to the brand/category they care about, and
   drops the ones they want into a project folder. The report is then built from
   that project only.

   Reads the same IndexedDB the service worker writes on every scan (store.js),
   so there is no import step, no file passing, and no server. */
(function () {
  "use strict";
  const S = window.CatalogStore;
  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  let allItems = [];          // everything in the catalog
  let items = [];             // …narrowed to the list this screen is about
  let lists = [];             // saved scan lists, for the scope rail
  let scopeId = "";           // "" = the whole catalog
  const SCOPE_KEY = "wpb_labscope";
  let projects = [];
  let snapshots = [];         // frozen weekly numbers (survive product cleanup)
  let trends = [];            // search interest, imported from a Google Trends CSV
  let merged = 0;             // rows collapsed as the same product
  let tiers = {};             // brand (lowercased) -> "Tier 1" … from the imported sheet
  let curTier = "";           // tier filter shared by LAB / New In / By Brand
  const picked = new Set();   // product keys the user has selected

  const priceNum = v => { const m = String(v || "").replace(/,/g, "").match(/\d+(?:\.\d+)?/); return m ? parseFloat(m[0]) : null; };

  /* Freeze this week's numbers (and re-confirm earlier ones) every time the LAB
     is opened. Products are live — re-scanned, updated, eventually cleaned up —
     so the weekly aggregate is written down separately and never shrinks. That
     is what makes the long view possible: a year from now the charts still have
     every week, at a few KB each, whether or not the products are still here. */
  /* Each list keeps its own weekly record, under its own snapshot ids
     (`<listId>|2026-W32`), alongside the catalog-wide one. A list is one
     research question, so its history has to be its own — filing a list's
     numbers under the catalog's week would rewrite a record that describes a
     different population. */
  /* Frozen from the SAME population the analysis reads — New In pages only.

     A snapshot exists so a week's figures survive its products, so it has to
     describe the same thing the live weeks do. Freezing the whole catalog
     while the charts read only new arrivals would make the archived half of
     any window describe a back-catalogue and the recent half a season, which
     is the exact comparison this whole change exists to prevent.

     It is filed under its own id (`<list>|new`) rather than overwriting the
     older whole-catalog record: those are a different population, and a
     record must never be rewritten by one (v1.72). */
  // "ymn|new|2026-W33" for a list, "new|2026-W33" for the whole catalog —
  // no empty leading segment.
  const NEW_SNAP = id => (id ? id + "|new" : "new");
  async function rollup() {
    const scanned = items.filter(i => i && i.source !== "clip" && i.addedAt && isNewIn(i));
    if (!scanned.length) return;
    const oldest = Math.min(...scanned.map(i => i.addedAt));
    const months = Math.max(2, Math.ceil((Date.now() - oldest) / (30 * 864e5)) + 1);
    try {
      await S.putSnapshots(window.TrendCalc.weeklySnapshots(scanned,
        { months, listId: NEW_SNAP(scopeId) }));
      snapshots = await S.allSnapshots();
      applyScope();
    } catch (e) { /* snapshots are an optimisation — never block the view */ }
  }

  /* Narrow everything on this screen to one list.

     A product records which list(s) collected it (store.merge unions listIds,
     since two lists may legitimately watch the same category), so the scope is
     a filter on data we already hold — nothing needs re-scanning. Everything
     downstream reads `items`, so the charts, the arrivals feed, the brand rail
     and the product grid all narrow together. */
  const inScope = i => !scopeId || [].concat((i && i.listIds) || []).includes(scopeId);
  function applyScope() {
    items = allItems.filter(inScope);
    // Only this list's frozen weeks — the catalog-wide ones describe a
    // different population and would inflate every archived figure.
    labSnapshots = snapshots.filter(s => String((s && s.listId) || "") === NEW_SNAP(scopeId));
  }
  let labSnapshots = [];

  function renderScope() {
    const rail = $("#scoperail"), box = $("#scopechips");
    /* Brands, not products. A list is a research question, and its size as a
       question is how many shops it watches — a number the designer chose and
       can act on. The product count is a consequence of what the shops
       happened to publish that week: 387 against 431 says nothing about which
       list is the bigger job. The exact product count is still on the line
       beside these chips, where the rest of the totals are. */
    const brandsIn = rows => new Set(rows.map(i => String(i.brand || "").trim())
      .filter(Boolean)).size;
    const counts = new Map(lists.map(l =>
      [l.id, brandsIn(allItems.filter(i => [].concat(i.listIds || []).includes(l.id)))]));
    // With no list saved there is nothing to choose between — the rail would
    // be a control with one option, which is just noise.
    rail.hidden = lists.length < 1;
    /* Lists only. "All lists" pooled research questions that were never asked
       together — a week of FABRIC and a week of WMN averaged into one line —
       and it was the default, so that pooled screen is what most people saw.
       A list is one research question; this rail chooses which one.

       The name, and no figure: which list is open is what these chips answer,
       and how much is in it is what the page below is for. The tally is still
       a hover away, where it costs nothing. */
    box.innerHTML =
      lists.map(l => `<button data-id="${esc(l.id)}" class="${scopeId === l.id ? "on" : ""}" ` +
        `title="${counts.get(l.id) || 0} brands in ${esc(l.name)}">` +
        `<span class="dot" style="background:${listColor(l.name)}"></span>${esc(l.name)}</button>`).join("");
    box.querySelectorAll("button").forEach(b => b.addEventListener("click", () => {
      if (b.dataset.id === scopeId) return;
      scopeId = b.dataset.id;
      try { chrome.storage.local.set({ [SCOPE_KEY]: scopeId }); } catch (e) {}
      applyScope();
      curWeekStart = null; curBrand = "";
      renderScope(); fillFilters(); redrawAll();
      // this list's weeks are its own record — write them the first time it is opened
      rollup().then(redrawAll);
    }));
  }
  // same derivation the panel and the grab button use, so a list keeps its
  // colour wherever it appears
  const LIST_HUES = ["#C08552", "#7E9E7A", "#7C9CC4", "#9A85BE", "#C9A227", "#D98070"];
  function listColor(name) {
    const s = String(name || "").toLowerCase();
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return LIST_HUES[h % LIST_HUES.length];
  }

  function redrawAll() {
    render();
    if (!$("#v-lab").hidden) renderLab();
    if (!$("#v-new").hidden) renderNew();
    if (!$("#v-brands").hidden) renderBrands();
    paintStats();
    paintDataChip();
    paintCheck();
  }

  /* ---- what the catalog is holding ----------------------------------------

     Measured on this store: ~283 bytes per product against a ~150 GB quota, so
     disk is never the limit. What grows is the work on every LAB open — the
     whole table is read and repaired before anything is drawn — so the useful
     control is over the WORKING SET, not over disk.

     Pruning is safe because each week's numbers are frozen in a snapshot of a
     few KB: the trend survives its products. Nothing is ever pruned on a
     schedule; this is a tool a person points at a window they no longer need,
     and it reports exactly what it removed. */
  const MB = n => (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + " MB";
  const ymd = t => new Date(t).toISOString().slice(0, 10);

  async function paintDataChip() {
    const chip = $("#datachip");
    if (!chip) return;
    let u = null;
    try { u = await window.CatalogStore.usage(); } catch (e) { return; }
    /* The chip used to be the byte count, and that number was measured to
       never matter: ~283 bytes a product against a ~150 GB quota, so a year
       of a whole team is single-digit MB. Showing it invited the reasonable
       question "why am I being told this", and the honest answer is that the
       size was never the point — what is behind the chip is: BACK UP and
       MERGE, which is the only way one browser's catalog reaches another's,
       because this catalog lives in this browser alone.

       So the chip names the door instead of a measurement, and the size stays
       inside, on the line that is genuinely about storage. */
    chip.textContent = "Data";
    const span = u.oldest ? `${ymd(u.oldest)} → ${ymd(u.newest)}` : "nothing collected yet";
    chip.title = "Back up this catalog, merge in a teammate's, or free up space" +
      ` — ${u.products.toLocaleString()} products, ${MB(u.bytes || 0)}`;
    /* "Lives in this browser only" was true and still left the obvious worry
       unanswered — people assume clearing their history takes it. Measured in
       a real Chrome: Chrome's Delete browsing data, all time and every box,
       leaves this untouched (it only ever clears web origins; an extension's
       storage is a different origin type its dialog does not offer). What DOES
       take it is removing Market Lens, or loading its folder from a new path —
       an unpacked extension's identity IS its path, so a moved folder is a
       different extension with an empty catalog. Say both, and say when this
       was last backed up, because "never" is the state that costs a year. */
    const backedUp = await new Promise(r =>
      chrome.storage.local.get("wpb_lastbackup", o => r((o || {}).wpb_lastbackup || 0)));
    const backup = backedUp
      ? `Last backup ${ymd(backedUp)}.`
      : "Never backed up.";
    $("#datafacts").textContent =
      `${u.products.toLocaleString()} products · ${u.snapshots} frozen weeks · ${span} · ` +
      `${MB(u.bytes || 0)} of ${u.quota ? MB(u.quota) : "the browser's"} space. ` +
      "This catalog lives in THIS browser only — clearing your browsing data does " +
      "not touch it, but removing Market Lens or moving its folder does. " + backup;
  }

  /* ---- what the last scan thought of its own results ----------------------

     Every fault in this tool's history arrived the same way: the designer
     opened the LAB, saw something wrong — a shop split into drop names, sixty
     grey boxes, an empty fabric column — and reported it. The scan had
     already graded itself each time. The grade just went to `devsitecheck()`
     in the service worker console, which is not a place a designer goes, so
     the tool knowing was worth nothing.

     This is that grade, on the screen they open anyway. Clean scans render
     nothing at all, so it costs no height in the normal case, and the
     exceptions are the only thing it ever shows. */
  function healthWord(rec) {
    if (rec.why) return rec.why;                       // written at scan time
    // records from before this existed, and the worker's stall entries
    if (!rec.count) return `${rec.brand || rec.label || "This site"}: nothing was collected.`;
    return `${rec.brand || rec.label || "This site"}: ${rec.note || "needs a look"}.`;
  }

  /* One shop, one line \u2014 a brand is the unit a designer trusts or does not,
     and its categories are pages of the same answer. The worst page decides
     the mark, because a brand whose New In came back empty is not "mostly
     fine". */
  const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return ""; } };
  const WORST = { "\u274c": 0, "\u26a0\ufe0f": 1, "\u2705": 2 };
  function byShop(health) {
    const shops = new Map();
    Object.values(health).forEach(h => {
      if (!h || !h.mark) return;
      const key = (h.brand || "").trim() || hostOf(h.url) || h.label || "This site";
      const s = shops.get(key) || { name: key, pages: 0, count: 0, imaged: 0, fabric: 0,
        withSpec: false, mark: "\u2705", ts: 0, url: "", whys: [] };
      s.pages++;
      s.count += h.count || 0;
      s.imaged += h.imaged || 0;
      s.fabric += h.fabric || 0;
      s.withSpec = s.withSpec || !!h.withSpec;
      if (WORST[h.mark] < WORST[s.mark]) { s.mark = h.mark; s.url = h.url || s.url; }
      if (!s.url) s.url = h.url || "";
      if ((h.ts || 0) > s.ts) s.ts = h.ts || 0;
      const w = h.mark !== "\u2705" ? healthWord(h) : "";
      if (w && !s.whys.includes(w)) s.whys.push(w);
      shops.set(key, s);
    });
    return [...shops.values()].sort((a, b) =>
      (WORST[a.mark] - WORST[b.mark]) || (b.ts - a.ts) || a.name.localeCompare(b.name));
  }

  const shopLine = s => {
    const bits = [`${s.pages} page${s.pages === 1 ? "" : "s"}`, `${s.count} products`];
    if (s.count) bits.push(`${s.imaged} with a photo`);
    if (s.withSpec && s.count) bits.push(`${s.fabric} with fabric`);
    return bits.join(" \u00b7 ");
  };

  async function paintCheck() {
    const bar = $("#checkbar"), chip = $("#checkchip");
    if (!bar || !chip) return;
    let health = {};
    try {
      health = await new Promise(r =>
        chrome.storage.local.get("wpb_sitehealth", o => r((o || {}).wpb_sitehealth || {})));
    } catch (e) { return; }
    const shops = byShop(health);
    const bad = Object.values(health)
      .filter(h => h && h.mark && h.mark !== "\u2705")
      .sort((a, b) => (b.ts || 0) - (a.ts || 0))
      .slice(0, 30);
    const need = [...needOrigins];
    const seen = [...blockedBy].filter(Boolean);
    if (need.length) {
      /* Not a broken scan and not a broken address: Market Lens simply has no
         access to the host the pictures are on. Saying that is only half the
         job — the button beside it is the other half, and the click is what
         Chrome requires to grant it. */
      bad.unshift({ mark: "\u26a0\ufe0f", ts: Date.now(), url: "", grant: need,
        why: `The photos for ${need.length} site${need.length === 1 ? "" : "s"} are hosted ` +
             `somewhere Market Lens cannot reach (${need.map(o => o.replace(/^https?:\/\//, "")
               .replace(/\/\*$/, "")).slice(0, 3).join(", ")}). ` +
             `Nothing is wrong with the scan — this needs your permission.` });
    } else if (seen.length) {
      bad.unshift({ mark: "\u26a0\ufe0f", ts: Date.now(), url: "", copy: true,
        why: `Photos refused — ` + seen.slice(0, 4).map(h =>
          `${h} (${failWhy.get(h) || "refused"})`).join(" \u00b7 ") +
        `. The addresses were collected correctly; the shop will not serve them here.` });
    }
    /* The chip is present whenever anything has been scanned, and says which
       way the answer went. Nothing scanned yet means nothing to report, and
       then it stays out of the way entirely. */
    const rough = shops.filter(s => s.mark !== "\u2705").length;
    chip.hidden = !shops.length;
    chip.classList.toggle("warn", !!(rough || bad.length));
    $("#checkn").textContent = !shops.length ? "" :
      rough ? `${shops.length} sites \u00b7 ${rough} need a look`
            : `${shops.length} sites \u00b7 all clean`;
    // the list is a band of its own, so it exists only while it is open
    if (!shops.length) { bar.hidden = true; return; }
    bar.hidden = $("#checkbox").hidden;

    const when = shops[0] && shops[0].ts ? new Date(shops[0].ts).toLocaleString() : "";
    /* Both halves of the question, because "which brands give good
       information" is asked before a week's numbers are trusted, and a band
       that only listed failures could answer half of it. */
    const special = bad.filter(h => h.grant || h.copy);
    const groups = [
      ["Nothing came through", shops.filter(s => s.mark === "\u274c")],
      ["Partly", shops.filter(s => s.mark === "\u26a0\ufe0f")],
      ["Complete", shops.filter(s => s.mark === "\u2705")],
    ];
    $("#checkbox").innerHTML =
      `<span class="cwhen">What each site produced the last time it was scanned` +
      `${when ? " \u00b7 " + esc(when) : ""}. Everything that WAS collected is in the ` +
      `catalog and the spreadsheet \u2014 a site listed here did not cost you the rest. ` +
      `Sites you have not scanned yet are not here.</span>` +
      special.map(h => `<span class="cw"><b>${esc(h.mark)}</b> ${esc(healthWord(h))}` +
        (h.grant ? ` <button class="cgrant">Show these photos</button>` : "") +
        (h.copy ? ` <button class="ccopy">Copy this line</button>` : "") +
        `</span>`).join("") +
      groups.filter(([, list]) => list.length).map(([title, list]) =>
        `<span class="grp">${esc(title)} \u00b7 ${list.length}</span>` +
        list.map(s => `<span class="cw"><b>${esc(s.mark)}</b> ${esc(s.name)} ` +
          `<span class="num">${esc(shopLine(s))}</span>` +
          (s.whys.length ? ` \u2014 ${esc(s.whys.slice(0, 2).join(" "))}` : "") +
          (s.url ? ` <a href="${esc(s.url)}" target="_blank" rel="noreferrer">open \u2197</a>` : "") +
          `</span>`).join("")).join("");
    const gb = $("#checkbox").querySelector(".cgrant");
    if (gb) gb.addEventListener("click", () => grantImageHosts(need));
    /* One button, so the exact reason can be sent on without anyone
       retyping it or being asked to open a developer console. */
    const cb = $("#checkbox").querySelector(".ccopy");
    if (cb) cb.addEventListener("click", () => {
      const line = [...blockedBy].map(h => `${h}: ${failWhy.get(h) || "refused"}`).join("\n");
      navigator.clipboard.writeText(line).then(
        () => { cb.textContent = "Copied"; },
        () => { cb.textContent = line.slice(0, 60); });
    });
  }

  /* The grant has to happen inside the click — Chrome requires the gesture —
     so nothing is awaited before asking. Afterwards the failed addresses are
     forgotten and the views redrawn, which is what retries them. */
  function grantImageHosts(origins) {
    try {
      chrome.permissions.request({ origins }, granted => {
        void chrome.runtime.lastError;
        if (!granted) return;
        needOrigins.clear(); blockedBy.clear(); viaWorker.clear();
        redrawAll();
      });
    } catch (e) {}
  }

  function wireCheckBar() {
    const chip = $("#checkchip"), box = $("#checkbox"), bar = $("#checkbar");
    if (!chip) return;
    chip.addEventListener("click", () => {
      box.hidden = !box.hidden;
      bar.hidden = box.hidden;        // the band exists only while the list does
    });
  }

  function wireDataBox() {
    const box = $("#databox");
    $("#datachip").addEventListener("click", () => {
      box.hidden = !box.hidden;
      if (!box.hidden) paintDataChip();
    });

    /* Trimming the working set. Safe because every week's numbers are frozen
       separately — the trend outlives the products it was computed from. */
    $("#datatrim").addEventListener("click", async () => {
      const u = await window.CatalogStore.usage();
      const months = parseInt(window.prompt(
        "Keep products collected in the last how many months?\n\n" +
        `Now: ${u.products.toLocaleString()} products, ${MB(u.bytes || 0)}.\n` +
        "Older products are removed. The weekly trend keeps its numbers, " +
        "because each week is frozen separately.", "12"), 10);
      if (!isFinite(months) || months < 1) return;
      const res = await window.CatalogStore.pruneOlderThan(Date.now() - months * 30 * 864e5);
      window.alert(res.removed
        ? `${res.removed.toLocaleString()} removed · ${res.kept.toLocaleString()} kept.\nThe weekly trend is unchanged.`
        : "Nothing was older than that — nothing removed.");
      if (res.removed) await load();
      paintDataChip();
    });

    /* A catalog that can leave the machine it was collected on.

       Everyone runs this in their own Chrome, so there are as many catalogs as
       there are people: a history dies with a laptop, and no one can see the
       trend the team collected together. A file fixes both, because merging is
       already well defined — the product URL is the identity, the earliest
       first-seen wins, list membership is a union, and a frozen week is never
       replaced by a smaller one. */
    $("#dataout").addEventListener("click", async () => {
      const btn = $("#dataout"), was = btn.textContent;
      btn.disabled = true; btn.textContent = "Packing…";
      try {
        const data = await window.CatalogStore.exportAll();
        const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `marketlens_catalog_${ymd(Date.now())}_${data.products.length}items.json`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 8000);
        // so the box can say how long it has been, rather than only offering
        await new Promise(r => chrome.storage.local.set({ wpb_lastbackup: Date.now() }, r));
        paintDataChip();
      } finally { btn.disabled = false; btn.textContent = was; }
    });

    $("#datain").addEventListener("click", () => $("#datafile").click());
    $("#datafile").addEventListener("change", async e => {
      const file = e.target.files && e.target.files[0];
      e.target.value = "";
      if (!file) return;
      const btn = $("#datain"), was = btn.textContent;
      btn.disabled = true; btn.textContent = "Merging…";
      try {
        const res = await window.CatalogStore.importAll(JSON.parse(await file.text()));
        window.alert(`${res.added.toLocaleString()} new products · ` +
          `${res.updated.toLocaleString()} already here (merged) · ` +
          `${res.snapshots} weeks of history.\n` +
          "Products seen by both are one row, dated from whoever saw them first.");
        await load();
      } catch (err) {
        window.alert("Could not read that file: " + ((err && err.message) || err));
      } finally { btn.disabled = false; btn.textContent = was; paintDataChip(); }
    });

    /* Google Trends, by CSV. trends.google.com → compare the terms → the
       download arrow over "Interest over time". Reading the file rather than
       calling an endpoint is not a compromise: there is no public API, the
       internal one refuses a machine asking for thirty words a week, and a
       rank cannot be collected retroactively — a CSV is dated, accurate and
       allowed. Terms are matched to the axis keywords by whole word, so
       "satin dress" answers for SATIN. */
    $("#gtin").addEventListener("click", () => $("#gtfile").click());
    $("#gtfile").addEventListener("change", async e => {
      const file = e.target.files && e.target.files[0];
      e.target.value = "";
      if (!file) return;
      const btn = $("#gtin"), was = btn.textContent;
      btn.disabled = true; btn.textContent = "Reading…";
      try {
        const parsed = window.TrendCalc.parseTrendsCsv(await file.text());
        if (!parsed.rows.length) {
          window.alert("No weekly numbers in that file.\n\n" +
            "It should be the \"Interest over time\" CSV from trends.google.com — " +
            "a date column and one column per search term.");
        } else {
          await window.CatalogStore.putTrends(parsed.rows);
          trends = await window.CatalogStore.allTrends();
          window.alert(`${parsed.terms.length} search terms · ` +
            `${parsed.rows.length} weekly readings.\n\n` +
            parsed.terms.slice(0, 6).join(", ") +
            (parsed.terms.length > 6 ? "…" : "") +
            "\n\nA term shows on a keyword card when it contains that keyword.");
          redrawAll();
        }
      } catch (err) {
        window.alert("Could not read that file: " + ((err && err.message) || err));
      } finally { btn.disabled = false; btn.textContent = was; }
    });
  }

  /* The header tally is gone: the list chip beside it already names the scope
     and its size, and the product / brand / photo counts are on the tiles in
     the LAB, where they are being used for something.

     One figure has no other home and must never be quiet — how many rows were
     folded together as duplicates. A total that shrinks without saying why is
     how a designer stops believing the tool, so it is said whenever it
     happened and not at all otherwise. */
  function paintStats() {
    const el = $("#stats");
    if (!el) return;
    el.textContent = merged && !scopeId
      ? `${merged} duplicate${merged === 1 ? "" : "s"} merged` : "";
  }

  wireDataBox();
  wireCheckBar();

  async function load() {
    // one product, one row — see store.dedupe for what counts as the same product
    const raw = await S.allProducts();
    /* Tier comes from the imported brand sheet and is applied HERE, by brand
       name, rather than being stamped during a scan. That way importing the
       sheet once labels everything collected months ago — no re-scan. */
    try { trends = await window.CatalogStore.allTrends(); } catch (e) { trends = []; }
    try { lists = await window.ScanLists.load(); } catch (e) { lists = []; }
    try { tiers = window.ScanLists.tierMap(lists); } catch (e) { tiers = {}; }
    // repair rows the pre-fix scans stored with a placeholder "photo"
    raw.forEach(i => {
      if (!i) return;
      i.image_url = S.cleanImage(i.image_url);
      i.tier = tiers[String(i.brand || "").trim().toLowerCase()] || "";
    });
    const dd = S.dedupe(raw);
    allItems = dd.rows; merged = dd.merged;
    try {
      const o = await new Promise(r => chrome.storage.local.get(SCOPE_KEY, x => r(x || {})));
      scopeId = o[SCOPE_KEY] || "";
    } catch (e) { scopeId = ""; }
    /* A scope is always one of the lists. A deleted list leaves it pointing at
       nothing, and a first run has never chosen — both land on the first list,
       because there is no "everything" to fall back to any more. */
    if (!lists.some(l => l.id === scopeId)) scopeId = (lists[0] && lists[0].id) || "";
    projects = await S.allProjects();
    try { snapshots = await S.allSnapshots(); } catch (e) { snapshots = []; }
    applyScope();
    await rollup();
    applyScope();               // rollup may have refreshed the frozen weeks
    renderScope();
    fillFilters();
    fillProjects();
    render();
    if (!$("#v-lab").hidden) renderLab();
    if (!$("#v-new").hidden) renderNew();
    if (!$("#v-brands").hidden) renderBrands();
    paintStats();
    paintDataChip();
    // the scan's own verdict, on the first paint — a run that collected
    // nothing has no products to redraw, and that is exactly when it matters
    paintCheck();
  }

  function fillFilters() {
    const fill = (sel, values, label) => {
      const cur = sel.value;
      sel.innerHTML = `<option value="">${label}</option>` +
        [...values].sort((a, b) => a.localeCompare(b)).map(v => `<option>${esc(v)}</option>`).join("");
      sel.value = cur;
    };
    fill($("#brand"), new Set(items.map(i => i.brand).filter(Boolean)), "All brands");
    fill($("#cat"), new Set(items.map(i => i.category).filter(Boolean)), "All categories");
    fill($("#src"), new Set(items.map(i => i.site || i.source).filter(Boolean)), "All sites");
  }
  function fillProjects() {
    const sel = $("#proj"), cur = sel.value;
    sel.innerHTML = projects.length
      ? projects.map(p => `<option value="${esc(p.id)}">${esc(p.name)} (${(p.keys || []).length})</option>`).join("")
      : `<option value="">No projects</option>`;
    if (cur) sel.value = cur;
    // the same list also filters the catalog down to one project's contents
    const f = $("#projf"), curF = f.value;
    f.innerHTML = `<option value="">All products</option>` +
      projects.map(p => `<option value="${esc(p.id)}">📁 ${esc(p.name)} (${(p.keys || []).length})</option>`).join("");
    f.value = curF;
  }

  // Window for the period filter, on addedAt — the moment a product FIRST
  // entered the catalog. That is what "이번 주 신규" means to a designer: newly
  // seen this week, not merely re-scanned. Weeks start Monday.
  /* The shop's publish date is collected but never shown.

     Only Shopify states one, so it existed for a minority of shops and was
     blank everywhere else — a column that answers for some brands and not
     others invites exactly the comparison it cannot support. It is also not
     the date a designer reads it as: it is when the shop made the product
     visible in its store, so a re-published item carries a fresh date and a
     long-listed one carries a date from last year, which is why a "new in"
     grid was showing 2025.

     The value stays in the row (the shop said it; we do not delete facts),
     and everything on screen dates by first collection instead — one measure,
     the same for every shop. */

  /* The shop's own order.

     A category page is laid out, not listed: the first tile is the one the
     merchandiser put first, and reading that order is half of what a designer
     does on the page itself. It survives the scan (`pos`) but not the database
     — rows come back in whatever order the store hands them over — so it has
     to be sorted back in. Brand, then the page within that brand, then the
     shop's position on it, which is the same shape the Excel has always had.
     A row collected before positions were recorded sorts after the ones that
     have them rather than jumping to the front. */
  const bySitePos = (x, y) =>
    byBrand(x, y) ||
    String(x.category || "").localeCompare(String(y.category || "")) ||
    ((x.pos || 1e9) - (y.pos || 1e9)) ||
    ((y.addedAt || 0) - (x.addedAt || 0));

  const byBrand = (x, y) => {
    const a = String(x.brand || ""), b = String(y.brand || "");
    if (!a || !b) return (!a && !b) ? 0 : (a ? -1 : 1);
    return a.localeCompare(b);
  };

  function periodRange(v) {
    if (!v) return null;
    const now = new Date();
    if (/^\d+$/.test(v)) return { from: Date.now() - parseInt(v, 10) * 864e5, to: Infinity };
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dow = (d.getDay() + 6) % 7;                 // Mon=0
    const monday = new Date(d); monday.setDate(d.getDate() - dow);
    if (v === "thisweek") return { from: monday.getTime(), to: Infinity };
    if (v === "lastweek") {
      const prev = new Date(monday); prev.setDate(monday.getDate() - 7);
      return { from: prev.getTime(), to: monday.getTime() };
    }
    return null;
  }

  function visible() {
    const q = $("#q").value.trim().toLowerCase();
    const b = $("#brand").value, c = $("#cat").value, s = $("#src").value;
    const range = periodRange($("#period").value);
    const projId = $("#projf").value;
    const projKeys = projId
      ? new Set((projects.find(p => p.id === projId) || {}).keys || [])
      : null;
    let out = items.filter(i => {
      if (b && i.brand !== b) return false;
      if (c && i.category !== c) return false;
      if (s && (i.site || i.source) !== s) return false;
      if (projKeys && !projKeys.has(i.key)) return false;
      if (range) {
        // One measure of time: when this row was first collected. Every shop
        // is counted the same way, whether or not it publishes a date.
        const t = i.addedAt || 0;
        if (!(t >= range.from && t < range.to)) return false;
      }
      if (q) {
        const hay = [i.name, i.fabric_composition, i.colorways, i.brand, i.design].join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const sort = $("#sort").value;
    out.sort((x, y) =>
      sort === "site" ? bySitePos(x, y)
      : sort === "priceUp" ? (priceNum(x.price) ?? 1e12) - (priceNum(y.price) ?? 1e12)
      : sort === "priceDown" ? (priceNum(y.price) ?? -1) - (priceNum(x.price) ?? -1)
      : sort === "name" ? String(x.name).localeCompare(String(y.name))
      // newest upload first; rows with no upload date go last, never guessed at
      // no brand sinks to the bottom; written out rather than using a U+FFFF
      // sentinel, which makes the file invalid UTF-8 and blocks the extension
      : sort === "brand" ? (byBrand(x, y) || (y.addedAt || 0) - (x.addedAt || 0))
      : (y.addedAt || 0) - (x.addedAt || 0));
    return out;
  }

  /* The grid draws a page at a time.

     Measured on a year of one designer's scanning — 35 brands, ~55 products
     each, weekly — the catalog reaches ~27,000 rows, and building a card for
     every one of them was most of the time the LAB took to open (20 s at
     100,000). Nobody scrolls 27,000 cards either; the filters and the analysis
     tabs are how this data is actually read. Exports and reports still work on
     the whole filtered set, not on what happens to be drawn. */
  const GRID_PAGE = 300;
  let gridShown = GRID_PAGE;

  function render(keepShown) {
    const grid = $("#grid");
    /* The product wall is not a tab here any more — it lives in the side
       panel, beside the list it belongs to. The grid element stays because
       `visible()` is what the report and the workbook are built from, but
       there is no reason to lay out three hundred cards nobody can look at. */
    if (!grid || grid.closest("[hidden]") || (grid.offsetParent === null && document.body.contains(grid))) return;
    const rows = visible();
    if (!keepShown) gridShown = GRID_PAGE;
    if (!items.length) {
      grid.innerHTML = "";
      grid.insertAdjacentHTML("beforeend",
        '<div class="empty" style="grid-column:1/-1">The catalog is empty.<br>' +
        'Run <b>Scan all</b> once on a shop and everything collected lands here.</div>');
      return;
    }
    if (!rows.length) {
      grid.innerHTML = '<div class="empty" style="grid-column:1/-1">No products match these filters.</div>';
      return;
    }
    const slice = rows.slice(0, gridShown);
    grid.innerHTML = slice.map(i => {
      const onSale = i.price_was && i.price && priceNum(i.price_was) > priceNum(i.price);
      const img = i.image_url
        ? `<img class="thumb" src="${esc(i.image_url)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
        : `<div class="thumb"></div>`;
      const link = i.product_url ? `<a href="${esc(i.product_url)}" target="_blank" rel="noopener">` : "";
      return `<div class="c${picked.has(i.key) ? " sel" : ""}" data-k="${esc(i.key)}">
        <input class="pick" type="checkbox" ${picked.has(i.key) ? "checked" : ""} title="Select">
        ${link}${img}${link ? "</a>" : ""}
        <div class="body">
          ${i.brand ? `<div class="bd">${esc(i.brand)}</div>` : ""}
          <div class="nm">${link}${esc(i.name || "(untitled)")}${link ? "</a>" : ""}</div>
          ${i.price ? `<div class="pr${onSale ? " sale" : ""}">${esc(i.price)}${onSale ? `<s>${esc(i.price_was)}</s>` : ""}</div>` : ""}
          ${i.fabric_composition ? `<div class="fb">${esc(i.fabric_composition)}</div>` : ""}
        </div></div>`;
    }).join("") + (rows.length > slice.length
      ? `<div class="gridmore"><button id="gridmore">Show ${Math.min(GRID_PAGE, rows.length - slice.length)} more</button>` +
        `<span>${slice.length.toLocaleString()} of ${rows.length.toLocaleString()} shown · ` +
        `exports and reports use all ${rows.length.toLocaleString()}</span></div>`
      : "");
    const more = $("#gridmore");
    if (more) more.addEventListener("click", () => { gridShown += GRID_PAGE; render(true); });
    armImgFallback(grid);
    paintSel();
  }

  function paintSel() {
    $("#selbar").classList.toggle("on", picked.size > 0);
    $("#selcount").textContent = `${picked.size} selected`;
  }

  // ---- selection + projects ------------------------------------------------
  $("#grid").addEventListener("change", e => {
    const box = e.target.closest(".pick");
    if (!box) return;
    const card = e.target.closest(".c");
    const k = card.getAttribute("data-k");
    if (box.checked) picked.add(k); else picked.delete(k);
    card.classList.toggle("sel", box.checked);
    paintSel();
  });
  $("#selnone").addEventListener("click", () => {
    picked.clear(); render();
  });
  $("#newproj").addEventListener("click", async () => {
    const name = prompt("New project name", "26SS research");
    if (!name) return;
    const p = await S.saveProject({ name: name.trim(), keys: [] });
    projects = await S.allProjects();
    fillProjects();
    $("#proj").value = p.id;
  });
  $("#addproj").addEventListener("click", async () => {
    const id = $("#proj").value;
    if (!id) return alert("Create a project first.");
    const p = projects.find(x => x.id === id);
    if (!p) return;
    const before = (p.keys || []).length;
    p.keys = [...new Set([...(p.keys || []), ...picked])];
    await S.saveProject(p);
    projects = await S.allProjects();
    fillProjects();
    const added = p.keys.length - before;
    alert(`Added ${added} to "${p.name}". (${p.keys.length} total)`);
    picked.clear(); render();
  });

  // ---- report: one self-contained HTML file --------------------------------
  // Images are fetched through the service worker (it has the host access a
  // page fetch would be blocked by CORS for), downscaled to ~240px and embedded
  // as data URIs. That is what makes the file still work in a year: shops
  // delete products and rotate CDN paths, so a report that merely linked to
  // their images would quietly lose every picture.
  const THUMB_W = 240, THUMB_Q = 0.72;

  function fetchImage(url) {
    return new Promise(res => {
      if (!url) return res(null);
      try {
        chrome.runtime.sendMessage({ type: "fetchImage", url }, r => {
          void chrome.runtime.lastError;
          res(r && r.ok ? r : null);
        });
      } catch (e) { res(null); }
    });
  }
  function downscale(dataUrl) {
    return new Promise(res => {
      const img = new Image();
      img.onload = () => {
        try {
          const scale = Math.min(1, THUMB_W / img.width);
          const c = document.createElement("canvas");
          c.width = Math.round(img.width * scale);
          c.height = Math.round(img.height * scale);
          c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
          res(c.toDataURL("image/jpeg", THUMB_Q));
        } catch (e) { res(null); }
      };
      img.onerror = () => res(null);
      img.src = dataUrl;
    });
  }

  async function makeReport() {
    const rows = visible();
    if (!rows.length) return alert("No products to put in a report.");
    const btn = $("#report");
    const label = btn.textContent;
    btn.disabled = true;

    const images = {};
    let done = 0, ok = 0;
    for (const r of rows) {
      btn.textContent = `Embedding images… ${++done}/${rows.length}`;
      if (!r.image_url || !r.product_url) continue;
      const got = await fetchImage(r.image_url);
      if (!got) continue;
      const small = await downscale("data:image/" + (got.ext || "jpeg") + ";base64," + got.base64);
      if (small) { images[r.product_url] = small; ok++; }
    }

    btn.textContent = "Building the report…";
    /* The LAB section of the file is the LAB — rendered by the same function
       that draws the screen, into an element nobody sees.

       It used to be a second, older dashboard: KPI tiles, a price histogram
       and four bar charts. So the screen answered "how many brands carry
       satin, and is that rising" while the file it produced answered "what
       share of products is polyester", and a designer comparing the two found
       two different reports of one week. Same figures everywhere is a rule
       this project already holds for its three templates; the file and the
       workbench are the same case. */
    const labHtml = (() => {
      try {
        const box = document.createElement("div");
        window.LabView.render(box, rows.filter(i => i && i.source !== "clip" && isNewIn(i)), {
          months: parseInt($("#labmonths").value, 10) || 6,
          granularity: $("#labgran").value,
          dim: "fabricfam",
          snapshots: curGarment ? [] : labSnapshots,
          trends,
          // the chips are controls; a file has nothing to press
          tierChips: "", garmentChips: "", sourceNote: "",
          basis: { fresh: rows.filter(isNewIn).length, pool: rows.length,
            garment: curGarment, narrowed: rows.filter(i => isNewIn(i) && inGarment(i)).length },
        });
        return box.innerHTML;
      } catch (e) { return ""; }
    })();
    const b = $("#brand").value, c = $("#cat").value, s = $("#src").value;
    const scope = [b, c, s].filter(Boolean).join(" · ");
    // say plainly which slice this is, so the file still explains itself later
    const periodLabel = ({ "7": "last 7 days collected", "14": "last 14 days collected",
      "30": "last 30 days collected", thisweek: "this week collected",
      lastweek: "last week collected" })[$("#period").value] || "";
    const proj = projects.find(p => p.id === $("#projf").value);
    const today = new Date().toISOString().slice(0, 10);
    const html = window.ReportGen.build(rows, images, {
      title: proj ? proj.name : (scope ? `${scope} market research` : "Market research report"),
      subtitle: [periodLabel, proj ? scope : ""].filter(Boolean).join(" · ") || (scope ? "" : "Whole catalog"),
      scope, period: periodLabel, generatedAt: today,
      template: $("#tmpl").value, labHtml,
      source: [...new Set(rows.map(r => r.site || r.source).filter(Boolean))].join(", "),
    });

    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `research_${scope ? scope.replace(/[^\w가-힣]+/g, "_") + "_" : ""}${today}.html`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 8000);

    btn.disabled = false; btn.textContent = label;
    const mb = (blob.size / 1048576).toFixed(1);
    alert(`Report saved.\n${rows.length} products · ${ok} images embedded · ${mb} MB\n\n` +
      `Images and figures live inside the file, so it opens the same with no internet, even after the shop removes the products.`);
  }
  $("#report").addEventListener("click", makeReport);

  /* The LAB's own button. It presses the one above rather than calling the
     builder again — a second caller is a second thing to keep in step, and
     this is the same file either way. The progress the builder writes goes on
     the hidden button, so this one carries its own. */
  const labXlsxBtn = $("#labxlsx");
  if (labXlsxBtn) {
    labXlsxBtn.addEventListener("click", async () => {
      const em = labXlsxBtn.querySelector("em");
      const was = em ? em.textContent : "";
      labXlsxBtn.disabled = true;
      if (em) em.textContent = "Building…";
      try { await exportXlsx(); }
      finally {
        labXlsxBtn.disabled = false;
        if (em) em.textContent = was || "EXCEL";
      }
    });
  }

  const labHtmlBtn = $("#labhtml");
  if (labHtmlBtn) {
    labHtmlBtn.addEventListener("click", async () => {
      const em = labHtmlBtn.querySelector("em");
      const was = em ? em.textContent : "";
      labHtmlBtn.disabled = true;
      if (em) em.textContent = "Building…";
      try {
        const t = $("#tmpl");
        if (t) t.value = "standard";          // the dashboard, which is the LAB
        await makeReport();
      } finally {
        labHtmlBtn.disabled = false;
        if (em) em.textContent = was || "HTML";
      }
    });
  }

  // ---- Excel export ---------------------------------------------------------
  // The storyline ends in a spreadsheet, and a scan's own xlsx only ever covers
  // that one scan. This exports whatever the catalog is currently showing — many
  // brands and categories collected over weeks — through the same 12-column
  // builder the scans use, so the sourcing rules (real value / red "정보 확인")
  // and embedded thumbnails are identical.
  async function exportXlsx() {
    const rows = visible();
    if (!rows.length) return alert("Nothing to export.");
    const btn = $("#xlsx");
    const label = btn.textContent;
    btn.disabled = true;
    try {
      /* One tab per list. A list is one research question, and a single
         sheet with every list poured into it answers none of them — reading
         what FABRIC brought in would mean pulling WMN's rows back out by
         hand. Rows belonging to no list keep a tab of their own rather than
         disappearing; a row in two lists is on both, because it really was
         collected for both. */
      const groups = [];
      lists.forEach(l => {
        const mine = rows.filter(r => [].concat(r.listIds || []).includes(l.id));
        if (mine.length) groups.push({ name: l.name || "List", items: mine });
      });
      const unfiled = rows.filter(r => !lists.some(l =>
        [].concat(r.listIds || []).includes(l.id)));
      if (unfiled.length) groups.push({ name: "Unfiled", items: unfiled });

      const { bytes } = await window.WPBExcel.buildKnitWorkbook(rows, {
        ExcelJS: window.ExcelJS,
        groups,
        // the service worker holds the host access needed to read shop CDNs
        fetchImage: url => new Promise(res => {
          if (!url) return res(null);
          try {
            chrome.runtime.sendMessage({ type: "fetchImage", url }, r => {
              void chrome.runtime.lastError; res(r && r.ok ? r : null);
            });
          } catch (e) { res(null); }
        }),
        filters: {},
        onProgress: (i, total) => { btn.textContent = `Embedding images… ${i}/${total}`; },
      });
      const b = $("#brand").value, c = $("#cat").value;
      const proj = projects.find(p => p.id === $("#projf").value);
      const tag = (proj ? proj.name : [b, c].filter(Boolean).join("_")) || "catalog";
      const name = `${tag.replace(/[^\w가-힣]+/g, "_")}_${rows.length}items_${new Date().toISOString().slice(0, 10)}.xlsx`;
      const blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 8000);
      alert(`Exported to Excel.\n${rows.length} products · ${(blob.size / 1048576).toFixed(1)} MB\n\n` +
        (groups.length > 1
          ? `One tab per list: ${groups.map(g => `${g.name} (${g.items.length})`).join(" · ")}`
          : `One tab: ${(groups[0] && groups[0].name) || "Products"}`));
    } catch (e) {
      alert("Export failed: " + (e && e.message || e));
    } finally { btn.disabled = false; btn.textContent = label; }
  }
  $("#xlsx").addEventListener("click", exportXlsx);

  // the search box serves whichever product view is open
  ["q", "brand", "cat", "src", "sort", "period", "projf"].forEach(id =>
    $("#" + id).addEventListener("input", () => {
      render();
      if (id === "q") {
        if (!$("#v-new").hidden) renderNew();
        if (!$("#v-brands").hidden) renderBrands();
      }
    }));
  $("#reset").addEventListener("click", () => {
    ["q", "brand", "cat", "src", "period", "projf"].forEach(id => { $("#" + id).value = ""; });
    $("#sort").value = "site"; render();
  });

  // ---- scan lists tab -------------------------------------------------------
  // `lists` is the same array the scope rail reads, so editing a list here
  // updates the rail rather than leaving two copies to drift apart.
  const L = window.ScanLists;
  let curList = null;

  function tabTo(view) {
    document.querySelectorAll(".tab").forEach(b => b.classList.toggle("on", b.dataset.view === view));
    $("#v-lab").hidden = view !== "lab";
    $("#v-new").hidden = view !== "new";
    $("#v-brands").hidden = view !== "brands";
    // each browsing tab keeps its own rail picks
    if (view === "new" || view === "brands") facetView = view;
    // the rail belongs to the two browsing tabs, and goes with them
    $("#railwrap").hidden = !(view === "new" || view === "brands");
    $("#v-products").hidden = view !== "products";
    $("#v-lists").hidden = view !== "lists";
    /* The header follows the tab. 상품 = full filter row; 신상 피드/브랜드 =
       search only (the dropdowns and export buttons act on the PRODUCTS grid and
       would lie here); LAB / Scan lists = no row at all. */
    const filters = document.querySelector(".filters");
    filters.hidden = !(view === "products" || view === "new" || view === "brands");
    filters.classList.toggle("slim", view === "new" || view === "brands");
    $("#q").placeholder = view === "products"
      ? "Search name · fabric · colour" : "Search this view — name, fabric, colour, brand";
    if (view === "lists") renderLists();
    if (view === "lab") renderLab();
    if (view === "new") renderNew();
    if (view === "brands") renderBrands();
  }

  // LAB — change over time, computed from what we collected (no external service)
  /* ---- what the analysis is allowed to see --------------------------------

     A trend answers "what changed between one week and the next", and that
     only works if each week is the same KIND of sample. A shop's New In page
     is the shop telling us what it just released; a Tops page is its whole
     shelf, most of which has been there for months. Mixing them means the
     first scan of a shelf lands as one enormous week of arrivals and the
     fabric and fit figures underneath describe a back-catalogue, not a
     season.

     What counts as New is the designer's own label on the list entry — the
     name they typed on the Grab card, which is what the category column
     already carries. So it is their call, it needs no re-scan to apply, and
     it changes the moment they rename an entry.

     Only the analysis is narrowed. New In and By Brand keep showing
     everything the lists collected — browsing wants the whole assortment. */
  const NEW_LABEL = /(^|[^a-z])(new|just[ -]?(in|dropped|landed)|latest|arrivals?|release[ds]?|drop)([^a-z]|$)|신상|신제품|뉴인/i;
  const isNewIn = i => NEW_LABEL.test(String((i && i.category) || ""));

  /* ---- garment type, so the analysis can be split by what the clothes ARE ---

     "Price, keywords and fabric, broken down by category" cannot use the
     category column any more: since the analysis reads New In pages only,
     that column says "New in" on every row — it is the name of the page, not
     the name of the garment. The split has to be by garment type.

     Two sources, in this order:
       1. the shop's own product type (Shopify states it; kept on the row
          alongside the category the designer named),
       2. the product name, which every shop writes in the same closed
          vocabulary — a tank is called a tank everywhere.

     The shop's word goes through the same vocabulary rather than being used
     raw, because "T-Shirts" here and "Tees" there and "Tops" somewhere else
     are the same drawer, and a per-shop drawer would defeat the whole point
     of comparing across brands.

     Derived when the screen is drawn, never stored — so it applies to
     everything already collected, with no re-scan, and improves whenever this
     list does. */
  const GARMENTS = [
    ["Dresses",   /\b(dress|dresses|gown|gowns|frock|frocks)\b/i],
    ["Jumpsuits", /\b(jumpsuits?|rompers?|playsuits?|unitards?|catsuits?|overalls?|dungarees)\b/i],
    ["Skirts",    /\bskirts?\b/i],
    ["Swim",      /\b(swim\w*|bikinis?|one[- ]?pieces?|boardshorts?)\b/i],
    ["Outerwear", /\b(jackets?|coats?|blazers?|parkas?|puffers?|trench(es)?|anoraks?|windbreakers?|vests?|gilets?|shackets?)\b/i],
    ["Knitwear",  /\b(sweaters?|jumpers?|cardigans?|knits?|knitwear|pullovers?|cashmeres?)\b/i],
    ["Sweats",    /\b(hoodies?|hooded|sweatshirts?|crewnecks?|zip[- ]?ups?|quarter[- ]?zips?|half[- ]?zips?)\b/i],
    ["Bras",      /\b(bras?|bralettes?|bandeaus?)\b/i],
    ["Leggings",  /\b(leggings?|tights?)\b/i],
    ["Shorts",    /\bshorts?\b/i],
    ["Bottoms",   /\b(pants?|trousers?|jeans?|joggers?|sweatpants?|chinos?|cargos?|culottes?|flares?)\b/i],
    ["Tops",      /\b(tops?|tees?|t[- ]?shirts?|shirts?|blouses?|tanks?|camis(oles?)?|bodysuits?|crops?|polos?|turtlenecks?|henleys?)\b/i],
    ["Accessories", /\b(bags?|hats?|caps?|beanies?|socks?|belts?|scarves|scarfs?|gloves?|totes?)\b/i],
  ];
  const GARMENT_ORDER = GARMENTS.map(g => g[0]).concat(["Other"]);
  const matchGarment = s => {
    const t = String(s || "");
    if (!t.trim()) return "";
    for (const [name, re] of GARMENTS) if (re.test(t)) return name;
    return "";
  };
  const garmentOf = i =>
    matchGarment(i && i.product_type) || matchGarment(i && i.name) || "Other";

  let curGarment = "";        // "" = every garment type
  const inGarment = i => !curGarment || garmentOf(i) === curGarment;

  /* Same row of chips as the tier filter, counts and all, so a chip can never
     lead to an empty screen. Omitted when everything collected is one type —
     a filter with a single option is furniture. */
  function garmentChips(rows) {
    const counts = new Map();
    (rows || []).forEach(i => {
      const g = garmentOf(i);
      counts.set(g, (counts.get(g) || 0) + 1);
    });
    if (counts.size < 2 && !curGarment) return "";
    const list = GARMENT_ORDER.filter(g => counts.has(g));
    if (curGarment && !counts.has(curGarment)) list.push(curGarment);
    const all = [...counts.values()].reduce((a, b) => a + b, 0);
    return `<div class="catchips garmentchips">
      <button data-g="" class="${curGarment ? "" : "on"}">All types · ${all}</button>` +
      list.map(g => `<button data-g="${esc(g)}" class="${g === curGarment ? "on" : ""}">${
        esc(g)} · ${counts.get(g) || 0}</button>`).join("") + `</div>`;
  }
  function wireGarmentChips(el, rerender) {
    el.querySelectorAll(".garmentchips button").forEach(b =>
      b.addEventListener("click", () => { curGarment = b.dataset.g; rerender(); }));
  }

  /* Garment type is now one of the three controls that decide what the page is
     computed over, beside PERIOD and INTERVAL, rather than a band of chips
     between the reader and the first answer. The counts stay on the options —
     a choice that empties the screen should be visible before it is made. */
  function fillLabCat(rows) {
    const sel = $("#labcat");
    if (!sel) return;
    const counts = new Map();
    (rows || []).forEach(i => {
      const g = garmentOf(i);
      counts.set(g, (counts.get(g) || 0) + 1);
    });
    const list = GARMENT_ORDER.filter(g => counts.has(g));
    if (curGarment && !counts.has(curGarment)) list.push(curGarment);
    const all = [...counts.values()].reduce((a, b) => a + b, 0);
    sel.innerHTML = `<option value="">All types${all ? ` · ${all}` : ""}</option>` +
      list.map(g => `<option value="${esc(g)}">${esc(g)} · ${counts.get(g) || 0}</option>`).join("");
    sel.value = curGarment;
  }

  function renderLab() {
    const pool = items.filter(inTier);
    const fresh = pool.filter(isNewIn);
    const shown = fresh.filter(inGarment);
    fillLabCat(fresh);
    window.LabView.render($("#labbody"), shown, {
      tierChips: tierChips(),
      garmentChips: "",
      months: parseInt($("#labmonths").value, 10) || 6,
      granularity: $("#labgran").value,
      // the record table below the axes ranks the same cloth vocabulary the
      // FABRIC axis uses; there is no picker any more
      dim: "fabricfam",
      /* A frozen week is one number for the whole population — it cannot be
         split by garment type. Reading it while the screen says "Dresses"
         would put the whole assortment's figures under a garment's name, so
         a narrowed view reads products only and says so. */
      snapshots: curGarment ? [] : labSnapshots,
      // drawn on a card only when a term for that keyword was imported
      trends,
      /* The paragraph that used to stand between the reader and the first
         answer is gone. Both facts it carried are still said — at the foot of
         the page, with the rest of "what these figures are" — because a number
         computed from a quarter of what was collected must never look like a
         number about all of it, and a narrowed screen quietly reading fewer
         weeks would be worse than the paragraph ever was. */
      sourceNote: "",
      basis: { fresh: fresh.length, pool: pool.length, garment: curGarment,
        narrowed: shown.length },
      sourceEmpty: pool.length && !fresh.length
        ? "None of the collected products came from a page named as new arrivals. " +
          "The analysis compares like with like, so it needs those: name a list entry " +
          "New in (or New arrivals) on the Grab card and scan it."
        : "",
    });
    wireTierChips($("#labbody"), renderLab);
  }
  ["labmonths", "labgran"].forEach(id =>
    $("#" + id).addEventListener("change", renderLab));
  $("#labcat").addEventListener("change", e => { curGarment = e.target.value; renderLab(); });

  /* ---- NEW ARRIVALS / BY BRAND --------------------------------------------

     The same catalog rows, framed the way the team's weekly edit reads: a
     week's new arrivals as a browsable feed, and a brand rail with each
     brand's assortment. Nothing is fetched or computed beyond what the scans
     already hold — "new" here means first seen that week (addedAt), which is
     honest for every shop; a shop-stated launch date exists only on Shopify
     and is shown on the card when we have it. Clips are excluded, as in LAB:
     hand-picked items are not arrivals. */
  let curWeekStart = null, curBrand = "";

  const tierList = () => [...new Set(items.map(i => i.tier).filter(Boolean))].sort();
  const inTier = i => !curTier || i.tier === curTier;
  const scanned = () => items.filter(i => i && i.source !== "clip" && i.addedAt && inTier(i));

  /* ---- the filter rail ----------------------------------------------------

     Seven questions, in the order a designer asks them: what kind of garment,
     what cloth, what shape, how it sits, what was done to it, what colour,
     whose. Each is read off the rows themselves — nothing is stored, so it
     applies to everything already collected and improves whenever the
     vocabularies do.

     Several values inside a group are an OR; the groups are an AND. Counts
     beside each value are computed against the OTHER groups, so a value that
     is offered can never produce an empty screen.

     Nothing here touches what is collected — the charter allows attribute
     filters only after the scan, on the display side, because narrowing what
     goes INTO the catalogue is what destroys a distribution. */
  // one ink per shelf colour, defined once beside the shelf itself
  const COLOUR_INK = window.ReportCalc.COLOUR_INK;
  /* Four questions, in the order a designer asks them: who made it, what kind
     of garment, what it is made of, what colour it is. Silhouette, Fit and
     Detail are off the rail (the designer asked): they are read from words in
     a product name, so they run to hundreds of values — DETAIL alone offered
     1,172 — and a filter with a thousand answers is a list, not a filter. They
     are still counted on the LAB's own axes, which is where that reading
     belongs. */
  const FACETS = [
    ["brand", "Brand", i => [(i && i.brand) || ""].filter(Boolean)],
    ["category", "Category", i => [garmentOf(i)]],
    /* The fifteen fibres the designer named, read from the composition — not
       the cloth NAME the shop uses. fabricfam answers with the weave when the
       shop writes one into the title, so the rail was offering Bonded,
       Brushed, Heather and Waffle beside Cotton and Nylon: two vocabularies in
       one filter. The weave reading is still on the LAB's own FABRIC axis,
       where it belongs. */
    ["fabric", "Fabric", i => window.ReportCalc.fibreFamilies(i && i.fabric_composition)],
    // the twelve-colour shelf, not the shop's sales names — a rail of two
    // hundred colourways seen once each is not a filter
    ["color", "Colour", i => window.ReportCalc.colourFamilies(i && i.colorways)],
  ];
  const T = () => window.TrendCalc;
  /* One set of picks PER TAB, not one for the page.

     They were shared, so ticking three brands on New In silently narrowed
     Clothing as well — and the second screen looked like the whole catalogue
     with most of it missing. The two tabs ask different questions ("what
     arrived this week" and "what does this shop carry"), so they keep their
     own answers; switching back finds the screen as it was left. */
  const facetPick = { new: {}, brands: {} };  // view -> key -> Set of chosen values
  Object.keys(facetPick).forEach(v => FACETS.forEach(f => { facetPick[v][f[0]] = new Set(); }));
  let facetView = "new";                      // which tab's picks are in play
  const brandQ = { new: "", brands: "" };     // the Brand group's own search, per tab
  const railOpen = { category: true, fabric: true, brand: true };
  const RAIL_CUT = 8;                         // values shown before "show all"
  const railAll = {};                         // groups the user expanded

  const facetValues = (f, i) => (f[2](i) || []).filter(Boolean);
  const chosenIn = k => (facetPick[facetView] || facetPick.new)[k];
  const anyPicked = () => FACETS.some(f => chosenIn(f[0]).size);

  // does a row pass every group EXCEPT the one named (for that group's counts)
  function railMatch(i, except) {
    return FACETS.every(f => {
      const set = chosenIn(f[0]);
      if (!set.size || f[0] === except) return true;
      return facetValues(f, i).some(v => set.has(v));
    });
  }

  function renderRail(rows, skip) {
    const el = $("#rail");
    const groups = FACETS.filter(f => !(skip || []).includes(f[0])).map(f => {
      const [key, label] = f;
      const base = rows.filter(i => railMatch(i, key));
      const counts = new Map();
      base.forEach(i => facetValues(f, i).forEach(v =>
        counts.set(v, (counts.get(v) || 0) + 1)));
      // a value the user picked stays listed even when nothing carries it now,
      // otherwise the filter is on and invisible
      chosenIn(key).forEach(v => { if (!counts.has(v)) counts.set(v, 0); });
      return { key, label, counts };
    });

    el.innerHTML = groups.map(g => {
      const chosen = chosenIn(g.key);
      if (!g.counts.size && !chosen.size) return "";
      let list = [...g.counts.entries()].sort((a, b) =>
        b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
      if (g.key === "category") {
        // garment types read in their own order, not by how many came in
        const rank = n => { const x = GARMENT_ORDER.indexOf(n); return x < 0 ? 99 : x; };
        list.sort((a, b) => rank(a[0]) - rank(b[0]));
      }
      if (g.key === "brand" && brandQ[facetView]) {
        const q = brandQ[facetView].toLowerCase();
        list = list.filter(([v]) => String(v).toLowerCase().includes(q) || chosen.has(v));
      }
      const open = railOpen[g.key] || chosen.size > 0;
      const showAll = railAll[g.key] || list.length <= RAIL_CUT;
      const head = list.slice(0, showAll ? list.length : RAIL_CUT);
      /* No number beside each value. It was there so a value that leads
         nowhere is not offered — but that job is done by the list itself:
         these counts are faceted, so a value with nothing behind it is not
         listed at all. The figure was only ever restating that, once per row,
         down a rail of forty. */
      /* A colour is worth showing as a colour. The rail names twelve of them
         and the eye picks a swatch out of a list faster than it reads a word —
         which is why every shop's own colour filter is drawn this way. */
      const swatch = v => g.key === "color" && COLOUR_INK[v]
        ? `<i class="sw" style="background:${COLOUR_INK[v]}"></i>` : "";
      const row = ([v]) => `<label class="${chosen.has(v) ? "picked" : ""}">
        <input type="checkbox" data-k="${esc(g.key)}" data-v="${esc(v)}"${chosen.has(v) ? " checked" : ""}>
        ${swatch(v)}<span class="rv" title="${esc(v)}">${esc(v)}</span></label>`;
      /* Brands sit under their tier — that is how the team names them, and a
         flat alphabetical list of thirty-two is not readable. */
      let body;
      if (g.key === "brand") {
        const tiers = new Map();
        head.forEach(([v, n]) => {
          const t = (rows.find(i => i.brand === v) || {}).tier || "";
          if (!tiers.has(t)) tiers.set(t, []);
          tiers.get(t).push([v, n]);
        });
        const order = [...tiers.keys()].sort((a, b) => (a ? 0 : 1) - (b ? 0 : 1) || a.localeCompare(b));
        body = `<input type="search" class="rsearch" id="rbq" placeholder="Search brand" value="${esc(brandQ[facetView])}">` +
          order.map(t => (order.length > 1 || t
            ? `<div class="rtier">${esc(t || "Untiered")}</div>` : "") +
            tiers.get(t).map(row).join("")).join("");
      } else body = head.map(row).join("");
      const more = list.length > head.length
        ? `<button class="rmore" data-more="${esc(g.key)}">Show all ${list.length}</button>` : "";
      /* The name, then a chevron at the far end — the shape of a shop's own
         filter column. No figure beside the name: the values are counted
         against the other groups, so one with nothing behind it is never
         listed at all, and the number only ever restated that. What does
         appear is the way out of a group that IS narrowing the screen. */
      return `<details class="rgrp"${open ? " open" : ""} data-g="${esc(g.key)}">
        <summary>${esc(g.label)}${
          chosen.size ? `<span class="rn"><button class="rclear" data-clear="${esc(g.key)}">clear ${chosen.size}</button></span>`
            : ""}<span class="rcar">⌄</span></summary>
        <div class="rvals">${body}${more}</div></details>`;
    }).join("");
  }

  function wireRail(rerender) {
    const el = $("#rail");
    el.querySelectorAll("input[type=checkbox]").forEach(b =>
      b.addEventListener("change", () => {
        const set = chosenIn(b.dataset.k);
        if (b.checked) set.add(b.dataset.v); else set.delete(b.dataset.v);
        rerender();
      }));
    el.querySelectorAll("[data-clear]").forEach(b =>
      b.addEventListener("click", e => {
        e.preventDefault(); e.stopPropagation();
        chosenIn(b.dataset.clear).clear(); rerender();
      }));
    el.querySelectorAll("[data-more]").forEach(b =>
      b.addEventListener("click", () => { railAll[b.dataset.more] = true; rerender(); }));
    el.querySelectorAll("details").forEach(d =>
      d.addEventListener("toggle", () => { railOpen[d.dataset.g] = d.open; }));
    const q = el.querySelector("#rbq");
    if (q) {
      q.addEventListener("input", () => {
        brandQ[facetView] = q.value;
        railAll.brand = true;
        rerender();
        const again = $("#rail").querySelector("#rbq");
        if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
      });
    }
  }

  /* Nothing across the middle any more (the designer asked): choosing a value
     ticks its box on the rail and does nothing else.

     The rule that put a line here — v3.3.0, a screen that has been narrowed
     must say so, or a part reads as the whole — is kept by the rail itself. It
     stands beside the results rather than scrolling with them, every group
     that is narrowing anything carries "clear N", and the ticks ARE the state.
     A second copy of that answer in the feed was one more thing to keep in
     step with the first. */
  function railNote() { return ""; }
  function wireRailNote(el, rerender) {
    const b = el.querySelector("#railclear");
    if (b) b.addEventListener("click", () => {
      FACETS.forEach(f => chosenIn(f[0]).clear()); brandQ[facetView] = ""; rerender();
    });
  }

  /* One chip row, reused by every view that can be narrowed to a tier. Counts
     are shown so a chip can never lead to an empty screen, and the row is
     omitted entirely when no tier data has been imported. */
  function tierChips() {
    const list = tierList();
    if (!list.length) return "";
    // the tier, not how many are in it — counting is the LAB's job
    return `<div class="catchips tierchips">
      <button data-t="" class="${curTier ? "" : "on"}">All tiers</button>` +
      list.map(t => `<button data-t="${esc(t)}" class="${t === curTier ? "on" : ""}">${esc(t)}</button>`).join("") +
      `</div>`;
  }
  function wireTierChips(el, rerender) {
    el.querySelectorAll(".tierchips button").forEach(b =>
      b.addEventListener("click", () => { curTier = b.dataset.t; rerender(); }));
  }

  // the same haystack the 상품 grid searches, so one query means one thing
  const matchesQ = (i, q) => !q ||
    [i.name, i.fabric_composition, i.colorways, i.brand, i.design]
      .join(" ").toLowerCase().includes(q);
  const currentQ = () => $("#q").value.trim().toLowerCase();

  function weekBuckets() {
    const rows = scanned();
    if (!rows.length) return [];
    const oldest = Math.min(...rows.map(i => i.addedAt));
    const months = Math.max(2, Math.ceil((Date.now() - oldest) / (30 * 864e5)) + 1);
    return window.TrendCalc.timeline(rows, { months, granularity: "week" }).filter(b => b.count);
  }

  // simple browse card — same look as the product grid, no selection checkbox
  function feedCard(i) {
    const onSale = i.price_was && i.price && priceNum(i.price_was) > priceNum(i.price);
    const img = i.image_url
      ? `<img class="thumb" src="${esc(i.image_url)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
      : `<div class="thumb ph">NO IMAGE</div>`;
    const link = i.product_url ? `<a href="${esc(i.product_url)}" target="_blank" rel="noopener">` : "";
    return `<div class="c">
      ${link}${img}${link ? "</a>" : ""}
      <div class="body">
        ${i.brand ? `<div class="bd">${esc(i.brand)}</div>` : ""}
        <div class="nm">${link}${esc(i.name || "(untitled)")}${link ? "</a>" : ""}</div>
        ${i.price ? `<div class="pr${onSale ? " sale" : ""}">${esc(i.price)}${onSale ? `<s>${esc(i.price_was)}</s>` : ""}</div>` : ""}
        ${i.fabric_composition ? `<div class="fb">${esc(i.fabric_composition)}</div>` : ""}
        </div></div>`;
  }

  const EMPTY_FEED = `<div class="empty">Nothing scanned yet.<br>
    Build a list in the side panel and press <b>▶ Scan all</b> — the weekly feed fills in here.</div>`;

  /* A stored URL can still be a dead image — the shop deleted the product,
     rotated its CDN path, or refuses the request. The <img> then renders as a
     silent grey box that reads as "broken app".

     It says WHICH of the two happened, because they are fixed in different
     places and the card used to blame both on "NO IMAGE": nothing was
     collected (scan side) versus the shop would not serve what we collected
     (network side). Hovering shows the address that failed.
     (Attached in JS — MV3 CSP forbids inline onerror handlers.) */
  /* A refusal is usually not a dead address — it is who is asking.

     This page is chrome-extension://, and Nike, lululemon and adidas serve
     their product images only to their own site: no CORS header, or a Referer
     check. The browser drops the response and the card said IMAGE BLOCKED on
     a photo that exists and that the scan recorded correctly.

     The service worker is not subject to that. It holds host permissions for
     these shops — it is already how the spreadsheet embeds thumbnails — so a
     refused image is fetched there and handed back as bytes. One shared cache
     keyed by address, because a grid shows the same CDN host hundreds of
     times and a colourway repeats the same photo.

     Only failures take this path: an image the page can load itself never
     costs a message. What stays IMAGE BLOCKED after it is genuinely gone. */
  const viaWorker = new Map();                    // url -> Promise<dataURL|null>
  /* Hosts the worker could not reach because the extension does not hold them.

     Most shops serve photos from a subdomain of their own, which we already
     hold. Some do not — Aritzia's are on Adobe Scene7, and Cloudinary,
     Amplience and Contentful are just as common — and no list of ours will
     ever name them all. That is a permission, not a bug, and a permission has
     a fix a person can apply in one click. */
  const needOrigins = new Set();
  /* Why each host failed, in the shop's own words where there are any.

     Three fixes have been shipped for missing photos and the report came back
     the same each time. That is the real defect: the failure never said what
     it was, so every round was a guess. It now carries the reason — the HTTP
     status the shop answered with, or the network error, or the missing
     permission — and shows it on the card and in the band, where it can be
     read and sent on without anyone opening a console. */
  const failWhy = new Map();                      // host -> reason
  function workerImage(url) {
    if (viaWorker.has(url)) return viaWorker.get(url);
    const p = new Promise(res => {
      let done = false;
      const finish = v => { if (!done) { done = true; res(v); } };
      setTimeout(() => { failWhy.set(hostOfUrl(url), "no answer in 15s"); finish(null); }, 15000);
      try {
        chrome.runtime.sendMessage({ type: "fetchImage", url }, r => {
          void chrome.runtime.lastError;
          if (r && r.need) needOrigins.add(r.need);
          if (!r || !r.ok) failWhy.set(hostOfUrl(url),
            (r && r.need) ? "Market Lens has no access to this host"
              : (r && r.error) || "the request failed");
          finish(r && r.ok && r.base64
            ? `data:image/${r.ext === "jpg" ? "jpeg" : (r.ext || "png")};base64,${r.base64}` : null);
        });
      } catch (e) { finish(null); }
    });
    viaWorker.set(url, p);
    return p;
  }

  function armImgFallback(root) {
    root.querySelectorAll("img.thumb").forEach(img =>
      img.addEventListener("error", async () => {
        const src = img.getAttribute("src") || "";
        // already a fetched copy that failed to decode — nothing left to try
        if (!src || /^data:/.test(src)) return blocked(img, src);
        const data = await workerImage(src);
        if (data && img.isConnected) { img.src = data; return; }
        if (img.isConnected) blocked(img, src);
      }, { once: true }));
  }
  /* What the LAB can see and the scan could not.

     A photo that fails only when it is displayed is invisible at scan time —
     the address was collected, so the scan graded the page healthy. Counting
     them here is the other half of the tool watching itself: the shop's name
     goes into the same band as the scan's own verdict, instead of the
     designer counting grey boxes and telling us. */
  const hostOfUrl = u => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return "a shop"; } };
  const blockedBy = new Set();
  let blockedPaint = null;
  function blocked(img, src) {
    const host = hostOfUrl(src);
    const ph = document.createElement("div");
    ph.className = "thumb ph";
    /* The card names the host and the reason. "IMAGE BLOCKED" on its own sent
       the designer back to us three times with nothing to go on. */
    ph.innerHTML = `<b>${esc(host)}</b><span>${esc(failWhy.get(host) || "refused")}</span>`;
    ph.title = "the shop refused this address, and fetching it here failed too:\n" + src;
    blockedBy.add(host);               // the CDN that refused, which is the shop
    img.replaceWith(ph);
    clearTimeout(blockedPaint);              // one repaint for a whole grid
    blockedPaint = setTimeout(paintCheck, 600);
  }

  function renderNew() {
    const el = $("#v-new");
    const weeks = weekBuckets().slice().reverse();          // newest first
    if (!weeks.length) { el.innerHTML = EMPTY_FEED; return; }
    if (!weeks.some(w => w.start === curWeekStart)) curWeekStart = weeks[0].start;
    const wk = weeks.find(w => w.start === curWeekStart);

    /* The weeks, and nothing else — no tally on the chip. Counting what came
       in is the LAB's job and it does it properly, by brand; here the figure
       was decoration on a control whose whole meaning is "which week". */
    const span = (a, b) => {
      const f = t => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()}`; };
      return `${f(a)}-${f(b - 1)}`;
    };
    const chips = weeks.map(w => `<button data-w="${w.start}" class="${w.start === curWeekStart ? "on" : ""}">
      <b>${esc(window.TrendCalc.weekId(w.start))}</b>${
        w.start === curWeekStart ? `<i class="wkspan"> : ${esc(span(w.start, w.end))}</i>` : ""}</button>`).join("");

    // search first, so the brand chips' counts describe what is on screen
    const q = currentQ();
    const searched = wk.items.filter(i => matchesQ(i, q));
    // the rail is built from the searched week, so its counts describe what
    // is actually on offer here rather than the whole catalogue
    renderRail(searched);
    wireRail(renderNew);
    const wkItems = searched.filter(i => railMatch(i));

    /* No brand row across the middle any more. The rail on the left asks that
       question — with counts, a search box and tiers — and a second brand
       filter three inches away is two controls for one thing: they drift,
       and the screen stops saying which one is narrowing it. The only chips
       left over the feed are the weeks, which is what this tab is FOR. */
    const shownItems = wkItems;

    /* One week, one pile — brand (biggest first) → cards, and no day inside it.

       A week is worked in sittings: Monday's scan, another on Wednesday when a
       shop is added or one comes back. Split by the day it happened to be
       collected, the same brand appeared under two headings and the week read
       as two half-weeks of work rather than one week of a season. The week
       here is Monday to Sunday (bucketStart already starts weeks on Monday)
       and it is named the way the record names it — 2026-W34.

       Nothing is counted twice: a product is one row keyed by its address, so
       Wednesday's pass over Monday's page updates that row rather than adding
       another, and `addedAt` stays the first sighting — which is what puts it
       in this week and no other. The shop's own order survives inside each
       brand group. */
    const groups = new Map();
    shownItems.forEach(i => {
      const b = i.brand || "Other";
      if (!groups.has(b)) groups.set(b, []);
      groups.get(b).push(i);
    });
    const sections = [...groups.entries()].sort((a, b) => b[1].length - a[1].length)
      .map(([brand, ii]) =>
        `<div class="brandsec"><b>${esc(brand)}</b></div>
         <div class="grid">${ii.slice().sort(bySitePos).map(feedCard).join("")}</div>`).join("");

    /* One date on the screen. The same week was being said three times — a
       line above the title, a tag at the far right, and the chip itself — and
       the chip is the one that is also the control. The days it covers ride
       IN the open chip, written plainly rather than through the browser's
       locale, which had been printing Korean month names on an otherwise
       English screen. */
    el.innerHTML = `
      <div class="edhead"><div><h2>New In</h2></div></div>
      <div class="weekchips">${chips}</div>
      ${tierChips()}
      ${railNote()}
      ${sections || `<div class="none">${q ? `Nothing matches "${esc(q)}" in this week.`
        : anyPicked() ? "Nothing in this week matches the filters on the left."
        : "No products in this week."}</div>`}`;
    armImgFallback(el);
    wireRailNote(el, renderNew);
    wireTierChips(el, () => renderNew());
    el.querySelectorAll(".weekchips button").forEach(b =>
      b.addEventListener("click", () => { curWeekStart = +b.dataset.w; renderNew(); }));
  }

  function renderBrands() {
    const el = $("#v-brands");
    const all = scanned();
    if (!all.length) { el.innerHTML = EMPTY_FEED; return; }

    /* The Brand group is left off this tab's rail: the brand column beside the
       results IS the brand picker, and two of them would disagree. Everything
       else narrows the assortment, which is what makes "who is doing satin"
       answerable here — the brand column's counts follow the filter. */
    renderRail(all, ["brand"]);
    wireRail(renderBrands);
    const rows = all.filter(i => railMatch(i));
    if (!rows.length) {
      el.innerHTML = `${railNote()}
        <div class="none">No products match the filters on the left.</div>`;
      wireRailNote(el, renderBrands);
      return;
    }

    const byBrand = new Map();
    rows.forEach(i => {
      const b = i.brand || "Other";
      if (!byBrand.has(b)) byBrand.set(b, []);
      byBrand.get(b).push(i);
    });
    const brands = [...byBrand.keys()].sort((a, b) => byBrand.get(b).length - byBrand.get(a).length);
    if (!byBrand.has(curBrand)) curBrand = brands[0];

    const weeks = weekBuckets();
    const latest = weeks[weeks.length - 1];
    const newOf = b => latest ? latest.items.filter(i => (i.brand || "Other") === b).length : 0;

    /* The rail groups by tier when the sheet has been imported: the team think
       in tiers first ("what are the hero brands doing"), and a flat list of 40
       brands makes that question unanswerable. Untiered brands sit under a
       plain heading rather than being hidden. */
    const btn = b => `<button data-b="${esc(b)}" class="${b === curBrand ? "on" : ""}">
      <span>${esc(b)}</span></button>`;
    const railTiers = [...new Set(brands.map(b => (byBrand.get(b)[0] || {}).tier || ""))]
      .sort((a, b) => (a ? 0 : 1) - (b ? 0 : 1) || String(a).localeCompare(String(b)));
    const rail = railTiers.length > 1 || railTiers[0]
      ? railTiers.map(t => {
          const mine = brands.filter(b => ((byBrand.get(b)[0] || {}).tier || "") === t);
          if (!mine.length) return "";
          return `<div class="railgrp">${esc(t || "Untiered")}</div>` + mine.map(btn).join("");
        }).join("")
      : brands.map(btn).join("");

    const mine = byBrand.get(curBrand) || [];
    /* No category row here either — same reason as the brand row on New In.
       The rail asks what kind of garment it is, and it asks it once. */
    const q = currentQ();
    const shown = mine
      .filter(i => matchesQ(i, q))
      // in the shop's own order — the page a designer would have opened
      .slice().sort(bySitePos);
    const nw = newOf(curBrand);

    el.innerHTML = `
      <!-- No title here: the tab above says which screen this is, and the
           brand column below says what it is showing. -->
      ${tierChips()}
      ${railNote()}
      <div class="brandwrap">
        <div class="brail">${rail}</div>
        <div>
          <div class="bhero">
            <h2>${esc(curBrand)}${(mine[0] || {}).tier ? `<em class="tierbadge">${esc(mine[0].tier)}</em>` : ""}</h2>
            <div class="bmeta">${nw ? `<span class="bnew">New this week</span>` : ""}</div>
          </div>
          ${shown.length ? `<div class="grid">${shown.map(feedCard).join("")}</div>`
            : `<div class="none">${q ? `Nothing matches "${esc(q)}".` : "No products."}</div>`}
        </div>
      </div>`;
    armImgFallback(el);
    wireTierChips(el, () => { curBrand = ""; renderBrands(); });
    wireRailNote(el, renderBrands);
    el.querySelectorAll(".brail button").forEach(b =>
      b.addEventListener("click", () => { curBrand = b.dataset.b; renderBrands(); }));
  }
  document.querySelectorAll(".tab").forEach(b =>
    b.addEventListener("click", () => tabTo(b.dataset.view)));

  async function loadLists() {
    lists = await L.load();
    if (!lists.length) {
      lists = [{ id: "l" + Date.now(), name: "Weekly research", entries: [], createdAt: Date.now() }];
      await L.save(lists);
    }
    curList = lists.find(x => x.id === (curList && curList.id)) || lists[0];
    // a list renamed, added or deleted here changes what the scope rail offers
    if (!lists.some(l => l.id === scopeId)) {
      scopeId = (lists[0] && lists[0].id) || ""; applyScope();
    }
    renderScope();
  }
  function fillListSelect() {
    const sel = $("#listsel");
    sel.innerHTML = lists.map(l =>
      `<option value="${esc(l.id)}">${esc(l.name)} (${(l.entries || []).length})</option>`).join("");
    if (curList) sel.value = curList.id;
  }

  function renderLists() {
    fillListSelect();
    const rows = $("#urlrows");
    const entries = (curList && curList.entries) || [];
    if (!entries.length) {
      rows.innerHTML = '<div class="empty">No URLs in this list yet.<br>' +
        'Paste brand and category URLs below to add them.</div>';
    } else {
      rows.innerHTML = entries.map((e, i) => `<div class="ur" data-i="${i}">
        <span class="n">${i + 1}</span>
        <span class="bd">${esc(e.brand || "—")}</span>
        <span class="lb">${esc(e.label || "")}<small>${esc(e.url)}</small></span>
        <button class="x" title="Remove">✕</button></div>`).join("");
      rows.querySelectorAll(".x").forEach(b => b.addEventListener("click", async () => {
        const i = +b.closest(".ur").dataset.i;
        curList.entries.splice(i, 1);
        await L.save(lists); renderLists();
      }));
    }
    paintRunState();
  }

  // live progress of a list run, read from the queue the content script keeps
  async function paintRunState() {
    const box = $("#runstate");
    const q = await new Promise(res => {
      chrome.tabs.query({}, tabs => {
        let done = false;
        const finish = v => { if (!done) { done = true; res(v); } };
        setTimeout(() => finish(null), 600);
        chrome.storage.local.get("wpb_queue", o => finish(o && o.wpb_queue));
      });
    });
    const running = q && q.active;
    box.hidden = !running;
    $("#stoplist").hidden = !running;
    $("#runlist").disabled = !!running;
    if (running) {
      const cur = q.list[q.idx] || {};
      box.innerHTML = `<b>Scanning · ${q.idx + 1}/${q.list.length}</b> — ` +
        `${esc(cur.brand || "")} ${esc(cur.label || "")}<br>` +
        `<span style="color:var(--muted);font-size:12px">The scan runs in its own tab. You can close this window.</span>`;
      document.querySelectorAll(".ur").forEach((el, i) => el.classList.toggle("cur", i === q.idx));
    }
  }
  setInterval(() => { if (!$("#v-lists").hidden) paintRunState(); }, 2500);

  $("#listsel").addEventListener("change", e => {
    curList = lists.find(l => l.id === e.target.value) || curList;
    renderLists();
  });
  $("#newlist").addEventListener("click", async () => {
    const name = prompt("New list name", "Weekly research");
    if (!name) return;
    curList = { id: "l" + Date.now(), name: name.trim(), entries: [], createdAt: Date.now() };
    lists.push(curList); await L.save(lists); renderLists();
  });
  $("#dellist").addEventListener("click", async () => {
    if (!curList || lists.length < 2) return alert("This is your only list.");
    if (!confirm(`Delete the list "${curList.name}"?`)) return;
    lists = lists.filter(l => l.id !== curList.id);
    curList = lists[0]; await L.save(lists); renderLists();
  });
  $("#addbulk").addEventListener("click", async () => {
    const text = $("#bulk").value;
    const parsed = L.parseList(text);
    if (!parsed.length) return alert("No URLs found — check the format.");
    const m = L.mergeEntries(curList.entries || [], parsed);
    curList.entries = m.list;
    await L.save(lists);
    $("#bulk").value = "";
    renderLists();
    alert(`Added ${m.added}.` + (m.skipped ? ` (${m.skipped} already there, skipped)` : ""));
  });

  // Run the list: hand it to a tab's content script, which walks the URLs.
  $("#runlist").addEventListener("click", async () => {
    const entries = (curList && curList.entries) || [];
    if (!entries.length) return alert("This list is empty.");
    if (!confirm(`Scan all ${entries.length} URLs in "${curList.name}", one after another.\n` +
      `It takes a while and the scanning tab navigates on its own. Start?`)) return;
    // run it in a fresh tab so the user's current tab is left alone
    const tab = await chrome.tabs.create({ url: entries[0].url, active: true });
    const send = () => chrome.tabs.sendMessage(tab.id,
      { type: "runList", name: curList.name, list: entries, withSpec: true, filters: {} },
      r => {
        if (chrome.runtime.lastError || !r) return setTimeout(send, 900);   // content script not up yet
        paintRunState();
      });
    setTimeout(send, 1500);
  });
  $("#stoplist").addEventListener("click", async () => {
    await new Promise(res => chrome.storage.local.get("wpb_queue", o => {
      const q = o && o.wpb_queue; if (q) { q.active = false; chrome.storage.local.set({ wpb_queue: q }, res); }
      else res();
    }));
    paintRunState();
  });

  (async () => { await loadLists(); })();
  tabTo("lab");                 // LAB is the default view; hides the product filters
  /* A failure to open the catalog has to SAY so.

     The one that actually happens: the database version went up in a release
     and an older connection — the service worker still running the code from
     before the reload — holds the previous one, so the open is blocked. The
     page then shows "Loading…" for ever with an empty console, which reads as
     "I can't get into the LAB". Now it names the one step that fixes it. */
  load().catch(err => {
    const msg = (err && err.message) || String(err);
    const st = $("#stats");
    if (st) st.textContent = "Could not open the catalog";
    $("#labbody").innerHTML = `<div class="labempty"><b>The catalog did not open.</b><br>${
      esc(msg)}<br><br>Nothing collected has been lost — this is about opening the file, not its contents.</div>`;
    const grid = $("#grid");
    if (grid) grid.innerHTML = `<div class="empty" style="grid-column:1/-1">${esc(msg)}</div>`;
  });
})();
