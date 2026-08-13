/* Market Lens side panel.

   The one job: while browsing Chrome, whenever a page is worth coming back to,
   add it to your own list of reference sites — and shape that list over time
   (rename, regroup, split into several lists). Everything else hangs off that.

   COLLECTOR  add the current page, curate the list, run the whole list
   PRODUCTS   what those scans collected, filter and export

   Adding works on ANY page, not just the shops with an adapter: a reference URL
   is worth keeping even when we can't scan it yet. Entries carry a SCAN/REF tag
   so the difference is visible, and "Run all" only walks the scannable ones. */
(function () {
  "use strict";
  const $ = s => document.querySelector(s);
  const JOB = "wpb_job";        // the scan job the content script drives
  const QUEUE = "wpb_queue";    // batch run over the list
  const L = window.ScanLists;

  let tab = null, read = null, job = null, queue = null;
  let lists = [], curList = null;
  let products = [], picked = new Set();
  let listFilter = "";          // when set, PRODUCTS shows only that list's results

  const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const load = k => new Promise(r => chrome.storage.local.get(k, o => r(o[k] || null)));
  const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return ""; } };

  /* Chrome side panels silently suppress window.confirm/prompt/alert — the call
     returns immediately (confirm as false), so anything gated behind one simply
     never ran. These render inside the panel instead. */
  function ask(text, initial) {           // initial === undefined -> confirm
    return new Promise(res => {
      const box = $("#ask"), input = $("#askinput");
      $("#asktext").textContent = text;
      const wantsText = initial !== undefined;
      input.hidden = !wantsText;
      if (wantsText) { input.value = initial || ""; }
      box.hidden = false;
      if (wantsText) setTimeout(() => { input.focus(); input.select(); }, 30);
      const done = v => {
        box.hidden = true;
        $("#askok").onclick = null; $("#askcancel").onclick = null; input.onkeydown = null;
        res(v);
      };
      $("#askok").onclick = () => done(wantsText ? (input.value.trim() || null) : true);
      $("#askcancel").onclick = () => done(wantsText ? null : false);
      input.onkeydown = e => {
        if (e.key === "Enter") { e.preventDefault(); $("#askok").onclick(); }
        if (e.key === "Escape") { e.preventDefault(); done(wantsText ? null : false); }
      };
    });
  }
  const confirmIn = text => ask(text);
  const promptIn = (text, initial) => ask(text, initial == null ? "" : initial);

  let toastT;
  function toast(msg) {
    const t = $("#toast"); t.textContent = msg; t.classList.add("on");
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("on"), 1800);
  }

  /* Can we scan this URL? SITES.active falls back to the generic adapter for
     anything unknown, so "generic" means we have no dedicated support.

     Crucially this is a URL-ONLY check, and some adapters cannot answer from a
     URL at all: Shopify is detected from markers inside the page, so every
     Shopify shop (Edikted included) looks unsupported here. Callers must treat
     a null as UNKNOWN, never as "not scannable" — writing scannable:false from
     this is what silently made Run all skip Edikted entirely. */
  function adapterFor(url) {
    try {
      const a = window.SITES && window.SITES.active(url);
      return (a && a.id !== "generic") ? a : null;
    } catch (e) { return null; }
  }

  /* Do we hold host access for this URL? This is what separates "the page
     hasn't answered yet" from "nothing can ever run here".

     A freshly reloaded extension has no content script in already-open tabs
     until they refresh, so askAdapter() comes back null on sites we fully
     support. Treating that null as "not scannable" is what stamped Gap,
     Lululemon and Edikted as Ref and made Run all walk 7 of 10 entries. */
  function hasHostAccess(url) {
    return new Promise(res => {
      let done = false;
      const finish = v => { if (!done) { done = true; res(v); } };
      setTimeout(() => finish(false), 600);
      try {
        const o = new URL(url).origin + "/*";
        chrome.permissions.contains({ origins: [o] }, ok => {
          void chrome.runtime.lastError; finish(!!ok);
        });
      } catch (e) { finish(false); }
    });
  }

  /* Naming rules live in lists.js so the on-page grab button and this panel
     file a page identically — two spellings of one shop become two Excel
     groups. */
  const brandFromHost = L.brandFromHost;
  const cleanLabel = L.cleanLabel;
  const brandOfRead = r => L.brandFor(r && r.ctx, r && r.adapter && r.adapter.label, r && r.host);

  // ---- current page ---------------------------------------------------------
  function askAdapter(tabId) {
    return new Promise(res => {
      let done = false;
      const finish = v => { if (!done) { done = true; res(v); } };
      setTimeout(() => finish(null), 800);
      try {
        chrome.tabs.sendMessage(tabId, { type: "context" }, r => {
          void chrome.runtime.lastError;
          finish(r && r.site ? r : null);
        });
      } catch (e) { finish(null); }
    });
  }

  async function observe() {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = t || null;
    const url = (tab && tab.url) || "";
    const internal = !url || /^(chrome|edge|about|devtools|chrome-extension):/i.test(url);
    read = internal ? { kind: "internal" }
      : { kind: "page", host: hostOf(url), url,
          ctx: await askAdapter(tab.id).catch(() => null),
          adapter: adapterFor(url),
          access: await hasHostAccess(url).catch(() => false) };
    paintNow();
  }

  /* The fallback add button, and nothing else.

     Grabbing a page is done on the page. This button exists only for the
     pages the grab button cannot reach, so it states its own condition
     instead of a separate status line narrating the tab. */
  function paintNow() {
    const add = $("#addbtn"), dot = $("#dot");
    // the lens IS the status light — toggle, never rewrite the class list
    dot.classList.toggle("busy", !!(job && job.active && !job.paused));
    const set = (label, on, why) => {
      add.textContent = label; add.disabled = !on;
      add.title = why || "Add the page you are on (the round button on the page does this too)";
    };
    if (!read) return set("＋ This page", false, "Reading the page…");
    if (read.kind === "internal") return set("＋ This page", false, "A browser page can't be collected");
    if (urlInList(read.url)) {
      const brand = brandOfRead(read);
      return set("✓ In list", false,
        `${brand} — already in ${curList ? curList.name : "this list"}`);
    }
    const brand = brandOfRead(read);
    const cat = cleanLabel((read.ctx && read.ctx.category) || (tab && tab.title || ""), brand, read.host)
      || L.labelFromUrl(read.url) || read.host;
    set("＋ This page", true, `Add as ${brand} · ${cat}`);
  }

  // ---- the list -------------------------------------------------------------
  async function loadLists() {
    lists = await L.load();
    if (!lists.length) {
      lists = [{ id: "l" + Date.now(), name: "My references", entries: [], createdAt: Date.now() }];
      await L.save(lists);
    }
    curList = lists.find(x => curList && x.id === curList.id) || lists[0];
    /* Both repairs mutate the same array, so they save ONCE, here. Saving
       inside each of them raced: the name repair serialised the list before
       the scannable repair had run, and its later write put every entry back
       to Ref — which is how a fixed list could arrive on screen still broken. */
    const renamed = repairNames();
    const rescanned = await repairScannable();
    if (renamed || rescanned) await L.save(lists);
    return rescanned;
  }

  /* Entries saved before v1.68 can carry a platform label as their brand
     ("Shopify store" — which then groups the list AND fills the Excel brand
     column) and a raw page title as their label. Re-derive both, the same way
     a fresh Add would. Runs on every load; already-clean entries don't move. */
  function repairNames() {
    let changed = 0;
    lists.forEach(l => (l.entries || []).forEach(e => {
      if (!/^https?:/i.test(e.url || "")) return;
      let brand = e.brand || "";
      if (!brand.trim() || L.PLATFORM_LABEL.test(brand.trim())) {
        brand = brandFromHost(hostOf(e.url));
      }
      // A row has to read as a category. An address never did — it is the
      // identity of the page, not what the designer is watching there.
      let label = cleanLabel(e.label, brand, hostOf(e.url)) || e.label || "";
      if (!label.trim() || L.looksLikeUrl(label)) label = L.labelFromUrl(e.url) || label;
      if (brand !== e.brand || label !== e.label) { e.brand = brand; e.label = label; changed++; }
    }));
    return changed;                 // the caller saves — see loadLists
  }

  /* Ask for the origins a set of URLs needs, in one prompt.

     Must be called straight from a click — Chrome only grants an optional
     permission during a user gesture. Returns the number of origins we hold
     afterwards; a refusal is not fatal, the entry stays in the list and we ask
     again when the run reaches it. */
  async function grantAccess(urls) {
    const want = [];
    for (const u of urls || []) {
      if (!/^https?:/i.test(u || "")) continue;
      let o = ""; try { o = new URL(u).origin + "/*"; } catch (e) { continue; }
      if (want.includes(o)) continue;
      if (!await hasHostAccess(u).catch(() => false)) want.push(o);
    }
    if (!want.length) return { needed: 0, granted: 0 };
    const okAll = await new Promise(res => {
      try { chrome.permissions.request({ origins: want }, g => { void chrome.runtime.lastError; res(!!g); }); }
      catch (e) { res(false); }
    });
    return { needed: want.length, granted: okAll ? want.length : 0 };
  }

  /* Repair every entry the old rules stamped as Ref.

     Ref is not a real category for a shop. Two separate rules used to create
     it: "the page hasn't answered yet" (true of every supported site whose tab
     predates an extension reload) and "we don't hold this origin's permission"
     — but permission is grantable on request, and since the service worker can
     now inject the engine into any permitted page, an http(s) URL is always
     scannable in principle. So no web address stays Ref: entries we can name
     an adapter for become Scan, the rest become Scan? (included in every run,
     access requested when it starts). Only a non-web address — a file:// or a
     chrome:// page, which cannot be added anyway — can still be Ref. */
  async function repairScannable() {
    /* Undefined is repaired too, not just false. "Scan?" is honest only while
       we genuinely cannot tell; once the origin is ours the answer is known,
       and leaving the hedge in place is what made an Abercrombie entry read
       Scan? on a site the manifest fully covers. */
    const stale = [];
    lists.forEach(l => (l.entries || []).forEach(e => { if (e.scannable !== true) stale.push(e); }));
    if (!stale.length) return 0;
    let fixed = 0;
    for (const e of stale) {
      if (!/^https?:/i.test(e.url || "")) continue;          // genuinely not a web page
      // Certain when we can name the adapter or we already hold the origin
      // (the engine goes in either way); otherwise unknown, which still runs.
      const was = e.scannable;
      if (adapterFor(e.url) || await hasHostAccess(e.url).catch(() => false)) e.scannable = true;
      else delete e.scannable;
      if (e.scannable !== was) fixed++;      // report only what actually moved
    }
    return fixed;                   // the caller saves — see loadLists
  }
  function urlInList(url) {
    if (!url || !curList) return false;
    const k = L.normUrl(url);
    return (curList.entries || []).some(e => L.normUrl(e.url) === k);
  }

  async function addCurrentPage() {
    if (!tab || !tab.url || !read || read.kind === "internal") return;
    const a = read.ctx, ad = read.adapter;
    const brand = brandOfRead(read);
    const entry = {
      brand,
      label: cleanLabel((a && a.category) || (tab.title || ""), brand, read.host)
        || L.labelFromUrl(tab.url) || read.host,
      url: tab.url,
    };
    /* Everything the user adds is meant to be scanned — that is the whole
       point of adding it — so a web address is never filed as Reference. If we
       don't hold this origin yet, ask for it now: this call is inside the
       click, which is the gesture Chrome requires, and the service worker
       injects the engine into any page we're allowed to touch. A refusal still
       leaves the entry as Scan? rather than Ref, and the run asks again. */
    if (a || ad || read.access) entry.scannable = true;
    else {
      const g = await grantAccess([tab.url]).catch(() => ({ granted: 0 }));
      if (g.granted) {
        entry.scannable = true; read.access = true;
        // Put the engine in straight away rather than waiting for a refresh:
        // the grab button is how this site gets collected from now on, and a
        // button that only appears after an unexplained F5 reads as broken.
        try { chrome.runtime.sendMessage({ type: "ensureEngine", tabId: tab.id },
          () => void chrome.runtime.lastError); } catch (e) {}
      } else delete entry.scannable;
    }
    const m = L.mergeEntries(curList.entries || [], [entry]);
    if (!m.added) return toast("Already in this list");
    curList.entries = m.list;
    await L.save(lists);
    renderList(); paintNow();
    toast(`Added — ${entry.brand} · ${entry.label}`);
  }

  /* A colour per brand, derived from its name — no storage, no lookup table,
     and the same brand keeps the same mark in every list. The palette is the
     warm pastel set the panel already lives in, so a long list reads as
     organised rather than decorated. */
  const BRAND_HUES = ["#d2691e", "#9fc9a2", "#9fbbe0", "#c0a8dd", "#c08532", "#dfa88f", "#a8bfa0", "#d59a9a"];
  function brandColor(name) {
    const s = String(name || "").toLowerCase();
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return BRAND_HUES[h % BRAND_HUES.length];
  }
  const folded = new Set();          // brands the user collapsed, this session
  let listQuery = "";

  function renderList() {
    const body = $("#listbody");
    const entries = (curList && curList.entries) || [];
    const running = !!(queue && queue.active);
    const scannableCount = entries.filter(e => e.scannable !== false).length;
    $("#runlist").dataset.empty = scannableCount ? "0" : "1";
    $("#runlist").dataset.n = scannableCount === entries.length ? "" : String(scannableCount);
    paintLive();     // the one run button reads list count + job + queue state

    // The filter only earns its space once the list is long enough to scroll.
    $("#lsearch").hidden = entries.length < 7;
    if (entries.length < 7) { listQuery = ""; $("#lq").value = ""; }

    if (!entries.length) {
      body.innerHTML = '<div class="lempty">No sites in this list yet.<br>' +
        'Open a brand\'s category page and press <b>＋ Add this page</b>,<br>' +
        'or bring a whole list in with <b>⬆ Import list</b>.</div>';
      return;
    }
    const qIdx = e => running ? queue.list.findIndex(x => L.normUrl(x.url) === L.normUrl(e.url)) : -1;
    const q = listQuery.trim().toLowerCase();
    const hit = e => !q || [e.brand, e.label, e.url].some(v => String(v || "").toLowerCase().includes(q));
    const groups = new Map();
    entries.forEach((e, i) => {
      if (!hit(e)) return;
      const b = e.brand || hostOf(e.url) || "Other";
      if (!groups.has(b)) groups.set(b, []);
      groups.get(b).push({ e, i });
    });
    if (!groups.size) {
      body.innerHTML = `<div class="lempty">Nothing matches “${esc(listQuery)}”.</div>`;
      return;
    }
    const shown = [...groups.values()].reduce((n, r) => n + r.length, 0);
    const sum = q ? `${shown} of ${entries.length} · ${groups.size} brands`
      : `${entries.length} sites · ${groups.size} brands`;

    body.innerHTML = `<div class="lsum">${esc(sum)}</div>` +
      [...groups.entries()].map(([brand, rows]) => {
        // searching temporarily opens every group — a hidden match is a bug
        const fold = !q && folded.has(brand);
        return `<div class="grp${fold ? " fold" : ""}" data-b="${esc(brand)}">
      <button class="gname" type="button">
        <span class="gdot" style="background:${brandColor(brand)}"></span>
        <span class="gnm">${esc(brand)}</span>
        <span class="gn">${rows.length}</span>
        <span class="gcar">▾</span>
      </button>
      <div class="gbody">${rows.map(({ e, i }) => {
        const qi = qIdx(e);
        const cls = running ? (qi > -1 && qi < queue.idx ? " done" : qi === queue.idx ? " cur" : "") : "";
        // Brand and category are the reading matter (user request); the address
        // is identity only, so it lives in the tooltip and the ↗ button.
        return `<div class="ent${cls}" data-i="${i}" title="${esc(e.url)}">
          <div class="txt">
            <div class="lb">${esc(e.label || hostOf(e.url) || e.url)}</div>
          </div>
          ${e.scannable === false ? '<span class="tag">Ref</span>'
            : e.scannable ? '<span class="tag on">Scan</span>'
            : '<span class="tag q" title="Only the page itself can tell — included in the run">Scan?</span>'}
          <button class="act go" title="Open">↗</button>
          <button class="act ren" title="Rename">✎</button>
          <button class="act del" title="Remove">✕</button>
        </div>`;
      }).join("")}</div></div>`;
      }).join("");

    body.querySelectorAll(".grp .gname").forEach(el => el.addEventListener("click", () => {
      const b = el.parentElement.dataset.b;
      if (folded.has(b)) folded.delete(b); else folded.add(b);
      el.parentElement.classList.toggle("fold");
    }));
    $("#lfold").textContent = groups.size && [...groups.keys()].every(b => folded.has(b))
      ? "Expand" : "Collapse";

    body.querySelectorAll(".ent").forEach(el => {
      const i = +el.dataset.i;
      el.querySelector(".go").addEventListener("click", () =>
        chrome.tabs.create({ url: curList.entries[i].url }));
      el.querySelector(".del").addEventListener("click", async () => {
        curList.entries.splice(i, 1); await L.save(lists); renderList(); paintNow();
      });
      el.querySelector(".ren").addEventListener("click", async () => {
        const e = curList.entries[i];
        const label = await promptIn("Category name", e.label || "");
        if (label == null) return;
        const brand = await promptIn("Brand / group", e.brand || "");
        if (brand == null) return;
        e.label = label.trim(); e.brand = brand.trim();
        await L.save(lists); renderList();
      });
    });
  }

  function fillListSelect() {
    const sel = $("#listsel");
    sel.innerHTML = lists.map(l =>
      `<option value="${esc(l.id)}">${esc(l.name)} · ${(l.entries || []).length}</option>`).join("");
    if (curList) sel.value = curList.id;
    // The chips are the visible control; the select stays as the value holder
    // so everything that reads #listsel keeps working.
    const chips = $("#lchips");
    chips.innerHTML = lists.map(l =>
      `<button type="button" data-id="${esc(l.id)}"${curList && l.id === curList.id ? ' class="on"' : ""}>` +
      `${l.schedule && l.schedule.on ? "⏱ " : ""}${esc(l.name)}` +
      `<span class="n">${(l.entries || []).length}</span></button>`).join("") +
      `<button type="button" class="add" id="newlist" title="Start another list">＋ New</button>`;
    chips.querySelectorAll("button[data-id]").forEach(b => b.addEventListener("click", () => {
      if (curList && b.dataset.id === curList.id) return;
      sel.value = b.dataset.id;
      sel.dispatchEvent(new Event("change"));
    }));
    chips.querySelector("#newlist").addEventListener("click", newList);
  }

  // Products this list collected. Rows carry the list ids that produced them,
  // so a list is a real unit of work end to end: curate it, scan it, export it.
  const productsOfList = id =>
    id ? products.filter(p => [].concat(p.listIds || []).includes(id)) : [];

  function paintListResult() {
    const box = $("#listresult");
    const rows = productsOfList(curList && curList.id);
    box.hidden = !rows.length;
    if (!rows.length) return;
    const brands = new Set(rows.map(r => r.brand).filter(Boolean));
    $("#resulttext").innerHTML =
      `<b>${rows.length.toLocaleString()}</b> products collected by this list` +
      (brands.size ? ` · ${brands.size} brands` : "");
  }

  // Excel of exactly this list's results, through the same 12-column builder.
  async function exportRows(rows, filename, btn) {
    if (!rows.length) return toast("Nothing to export");
    const label = btn.textContent; btn.disabled = true;
    try {
      const { bytes } = await window.WPBExcel.buildKnitWorkbook(rows, {
        ExcelJS: window.ExcelJS,
        fetchImage: url => new Promise(res => {
          if (!url) return res(null);
          try { chrome.runtime.sendMessage({ type: "fetchImage", url }, r => {
            void chrome.runtime.lastError; res(r && r.ok ? r : null); }); } catch (e) { res(null); }
        }),
        filters: {},
        onProgress: (i, total) => { btn.textContent = `${i}/${total}`; },
      });
      let b64 = "";
      for (let i = 0; i < bytes.length; i += 0x8000)
        b64 += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      chrome.runtime.sendMessage({
        type: "downloadFile", filename, b64: btoa(b64),
        mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }, r => toast(r && r.ok ? `Saved ${rows.length} rows to Excel` : "Export failed"));
    } catch (e) { toast("Export failed"); }
    finally { btn.disabled = false; btn.textContent = label; }
  }

  /* Which tab is doing the work.

     A list run pins itself to one tab (queue.tabId) so the user can browse
     elsewhere without disturbing it; a single scan runs in whatever tab the FAB
     was pressed in. Controls have to reach that tab, not the one currently in
     front of the panel. */
  function engineTab() {
    if (queue && queue.active && queue.tabId != null) return queue.tabId;
    return tab && tab.id;
  }
  function sendEngine(type, cb) {
    const id = engineTab();
    if (id == null) return cb && cb(null);
    try {
      chrome.tabs.sendMessage(id, { type }, r => {
        void chrome.runtime.lastError; cb && cb(r || null);
      });
    } catch (e) { cb && cb(null); }
  }

  function paintQueue() {
    const box = $("#qstate");
    const running = !!(queue && queue.active);
    box.hidden = !running;
    if (running) {
      const cur = queue.list[queue.idx] || {};
      box.innerHTML = `<b>${queue.idx + 1}/${queue.list.length}</b> ${esc(cur.brand || "")} · ${esc(cur.label || "")}`;
    }
    renderList();
    paintLive();          // the controls depend on BOTH the job and the queue
  }
  function paintLive() {
    const on = !!(job && job.active);
    $("#live").classList.toggle("on", on);
    // clear it when the run ends — a leftover "저장됨…" line with a progress bar
    // reads as "still working" long after the scan is done
    $("#livetext").textContent = on ? (job.status || "Working…") : "";
    $("#dot").classList.toggle("busy", on && !job.paused);
    /* Run · hold · stop. The controls never move or vanish — a control that
       disappears makes the user hunt for it mid-run — so state shows as
       enabled/disabled, and pause names what pressing it will do. */
    const running = !!(queue && queue.active);
    const busy = on || running;
    const paused = !!(job && job.paused);
    const btn = $("#runlist");
    btn.disabled = busy || btn.dataset.empty === "1";
    $("#runlabel").textContent = busy ? "Scanning…"
      : (btn.dataset.n ? `Scan all (${btn.dataset.n})` : "Scan all");
    /* Pause and resume are one button in two states, so it shows the state it
       will move to — icon and word together, since two grey squares said
       nothing about which control did what. */
    const hold = $("#jpause");
    hold.disabled = !on;
    hold.classList.toggle("held", paused);
    hold.title = paused ? "Resume the run where it stopped" : "Hold the run — it keeps its place";
    hold.setAttribute("aria-label", paused ? "Resume" : "Pause");
    $("#pauselabel").textContent = paused ? "Resume" : "Pause";
    $("#pauseicon").innerHTML = paused
      ? '<path d="M8 5.5v13l11-6.5z"/>'                      // ▶ resume
      : '<path d="M9 5.5h3v13H9zM14 5.5h3v13h-3z"/>';        // ⏸ hold
    $("#jreset").disabled = !busy;
  }

  // ---- products -------------------------------------------------------------
  async function refreshProducts() {
    // one product, one card — the same collapse the LAB does (store.dedupe)
    try {
      const raw = await window.CatalogStore.allProducts();
      raw.forEach(i => { if (i) i.image_url = window.CatalogStore.cleanImage(i.image_url); });
      products = window.CatalogStore.dedupe(raw).rows;
    } catch (e) { products = []; }
    const fill = (sel, values) => {
      const cur = sel.value;
      sel.innerHTML = '<option value="">All</option>' +
        [...values].sort((a, b) => a.localeCompare(b)).map(v => `<option>${esc(v)}</option>`).join("");
      sel.value = cur;
    };
    fill($("#pbrand"), new Set(products.map(p => p.brand).filter(Boolean)));
    fill($("#pcat"), new Set(products.map(p => p.category).filter(Boolean)));
    renderProducts();
    paintListResult();
  }
  const priceN = v => { const m = String(v || "").replace(/,/g, "").match(/\d+(?:\.\d+)?/); return m ? parseFloat(m[0]) : null; };
  function visibleProducts() {
    const q = $("#psearch").value.trim().toLowerCase();
    const b = $("#pbrand").value, c = $("#pcat").value;
    return products.filter(p => {
      if (listFilter && ![].concat(p.listIds || []).includes(listFilter)) return false;
      if (b && p.brand !== b) return false;
      if (c && p.category !== c) return false;
      if (q && ![p.name, p.brand, p.fabric_composition, p.colorways].join(" ").toLowerCase().includes(q)) return false;
      return true;
    }).sort((x, y) => (y.addedAt || 0) - (x.addedAt || 0));
  }
  function renderProducts() {
    const scoped = listFilter && lists.find(l => l.id === listFilter);
    $("#scopebar").hidden = !scoped;
    if (scoped) $("#scopetext").textContent = "List · " + scoped.name;
    const rows = visibleProducts(), grid = $("#pgrid");
    if (!products.length) {
      grid.innerHTML = '<div class="pempty">Nothing collected yet.<br>Add sites in COLLECTOR, then press ▶ Scan all.</div>';
    } else if (!rows.length) {
      grid.innerHTML = '<div class="pempty">No products match these filters.</div>';
    } else {
      grid.innerHTML = rows.slice(0, 400).map(p => {
        const sale = p.price_was && priceN(p.price_was) > priceN(p.price);
        const img = p.image_url ? `<img src="${esc(p.image_url)}" alt="" loading="lazy">` : '<div class="ph"></div>';
        return `<figure class="pc${picked.has(p.key) ? " sel" : ""}" data-k="${esc(p.key)}">
          ${img}<input class="ck" type="checkbox" ${picked.has(p.key) ? "checked" : ""}>
          <figcaption>
            ${p.brand ? `<span class="b">${esc(p.brand)}</span>` : ""}
            <span class="n">${esc(p.name || "")}</span>
            ${p.price ? `<span class="p">${esc(p.price)}${sale ? `<s>${esc(p.price_was)}</s>` : ""}</span>` : ""}
          </figcaption></figure>`;
      }).join("");
    }
    $("#selcount").textContent = "Selected " + picked.size;
  }

  // ---- wiring ---------------------------------------------------------------
  document.querySelectorAll(".tab").forEach(b => b.addEventListener("click", () => {
    const v = b.dataset.view;
    document.querySelectorAll(".tab").forEach(x => x.classList.toggle("on", x === b));
    $("#v-collector").classList.toggle("on", v === "collector");
    $("#v-products").classList.toggle("on", v === "products");
    $("#selbar").classList.toggle("on", v === "products");
    if (v === "products") refreshProducts();
  }));

  /* Bring the on-page grab button back (or send it away).

     Hiding it used to be permanent in practice: the page removed the button
     and nothing anywhere offered it back, so the main way to collect a page
     disappeared for good. The flag lives in storage and the button on every
     open tab reacts to it, so this reaches the page you are looking at
     without a refresh. */
  const FAB_HIDDEN = "wpb_fab_hidden";
  function paintFabToggle(hidden) {
    const b = $("#fabtoggle");
    b.classList.toggle("off", !!hidden);
    b.textContent = hidden ? "◎" : "◉";
    b.title = hidden
      ? "Grab button is hidden on pages — click to show it again"
      : "Grab button is showing on pages — click to hide it";
  }
  chrome.storage.local.get(FAB_HIDDEN, o => paintFabToggle(!!(o || {})[FAB_HIDDEN]));
  $("#fabtoggle").addEventListener("click", () => {
    chrome.storage.local.get(FAB_HIDDEN, o => {
      const next = !((o || {})[FAB_HIDDEN]);
      chrome.storage.local.set({ [FAB_HIDDEN]: next }, () => {
        paintFabToggle(next);
        toast(next ? "Grab button hidden on pages" : "Grab button back on pages");
      });
    });
  });

  /* ---- the list's own appointment ----------------------------------------

     A list is one research question and the LAB reads it week over week, so a
     week nobody remembered to scan is a hole in the trend rather than a quiet
     week. The clock in the tool row opens this; the worker keeps the time
     (chrome.alarms), and both sides ask ScanLists.nextRun what "next" means so
     the panel can never promise a minute the alarm will not honour. */
  let schedDays = [];
  function paintDays() {
    $("#scheddays").innerHTML = L.DAY_NAMES.map((n, i) =>
      `<button type="button" data-d="${i}"${schedDays.includes(i) ? ' class="on"' : ""} title="${n}">${n[0]}</button>`).join("");
  }
  function paintSchedNext() {
    const on = !!(curList && curList.schedule && curList.schedule.on);
    const at = L.nextRun({ on: true, time: $("#schedtime").value, days: schedDays }, Date.now());
    $("#schedsave").textContent = on ? "Turn off" : "Turn on";
    $("#schednext").textContent = !at
      ? "Pick a time."
      : (on ? "Next scan " : "Would scan ") +
        new Date(at).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" }) +
        " · Chrome must be open; a missed one runs soon after it opens.";
  }
  function openSchedule() {
    const sc = (curList && curList.schedule) || {};
    $("#schedtime").value = sc.time || "09:00";
    schedDays = [].concat(sc.days || []);
    paintDays(); paintSchedNext();
  }
  $("#schedtoggle").addEventListener("click", () => {
    const box = $("#schedbox"), open = box.hidden;
    box.hidden = !open;
    $("#schedtoggle").setAttribute("aria-expanded", String(open));
    if (open) openSchedule();
  });
  $("#scheddays").addEventListener("click", e => {
    const b = e.target.closest("button[data-d]"); if (!b) return;
    const d = +b.dataset.d;
    schedDays = schedDays.includes(d) ? schedDays.filter(x => x !== d) : schedDays.concat(d);
    paintDays(); paintSchedNext();
  });
  $("#schedtime").addEventListener("change", paintSchedNext);
  $("#schedsave").addEventListener("click", async () => {
    if (!curList) return;
    const on = !(curList.schedule && curList.schedule.on);
    curList.schedule = on
      ? { on: true, time: $("#schedtime").value, days: schedDays.slice() }
      : Object.assign({}, curList.schedule, { on: false });
    await L.save(lists);
    fillListSelect(); paintSchedNext();
    toast(on ? `Scanning automatically — ${L.scheduleLabel(curList.schedule)}` : "Automatic scan off");
  });

  /* ---- getting the new version -------------------------------------------

     Chrome never updates an extension you loaded from a folder yourself — the
     files on disk ARE the extension. So "download it again" is not a fallback,
     it is the update path, and it belongs in one obvious place instead of a
     link somebody has to find in a chat message.

     Three steps, each with the button that performs it: fetch the zip, replace
     the folder, reload. Step 3 can be opened from here — an extension may open
     chrome://extensions itself (checked, not assumed). */
  const ZIP_URL = "https://github.com/choosingceo-taek/Shop-Category-Collector/archive/refs/heads/claude/main-session-cudnkx.zip";
  const running = chrome.runtime.getManifest().version;
  $("#verchip").textContent = "v" + running;
  $("#verchip").addEventListener("click", () => {
    const box = $("#updbox");
    box.hidden = !box.hidden;
    if (!box.hidden) { refreshUpdBox(); paintAuto(); paintReload(false); }
  });

  function refreshUpdBox() {
    const foot = $("#ufoot");
    foot.textContent = `You are running v${running}. Checking…`;
    chrome.storage.local.get("wpb_filesready", o => {
      const ready = (o || {}).wpb_filesready;
      if (ready && ready.onDisk) {
        foot.textContent = `v${ready.onDisk} is already in your folder — step 3 is all that is left.`;
        return;
      }
      chrome.runtime.sendMessage({ type: "updateStatus" }, r => {
        void chrome.runtime.lastError;
        foot.textContent = !r || !r.ok
          ? `You are running v${running}. Could not reach GitHub to check for a newer one.`
          : r.newer
            ? `v${r.latest} is available — you are running v${running}.`
            : `v${running} is the latest. Downloading again is harmless.`;
      });
    });
  }

  $("#udl").addEventListener("click", () => {
    const btn = $("#udl"), was = btn.textContent;
    btn.disabled = true; btn.textContent = "Downloading…";
    /* Through the downloads API rather than a link, so it lands with a name
       the designer will recognise in the folder rather than the branch name
       GitHub would have given it. */
    chrome.runtime.sendMessage({ type: "downloadUrl", url: ZIP_URL, filename: "market-lens.zip" }, r => {
      void chrome.runtime.lastError;
      btn.disabled = false; btn.textContent = was;
      if (r && r.ok) { $("#udlnote").textContent = "saved as market-lens.zip in Downloads"; toast("Downloading market-lens.zip"); }
      else { chrome.tabs.create({ url: ZIP_URL }); $("#udlnote").textContent = "opened the download in a tab"; }
    });
  });

  /* ---- the one click ------------------------------------------------------

     The browser can do the two steps a person kept losing: it downloads the
     zip, unzips it and writes the files into the extension's own folder. That
     needs the folder once — showDirectoryPicker, whose grant persists — and
     after that every update is this button.

     The reload is not automated on purpose: chrome.runtime.reload() was
     measured on an unpacked extension and does not reliably bring it back.
     One click beats a disappeared extension. */
  const I = window.LensInstaller;
  let extDir = null;

  async function knownFolder(ask) {
    if (!extDir) extDir = await I.loadFolder();
    return (await I.folderReady(extDir, ask)) ? extDir : null;
  }

  function setBar(done, total) {
    const bar = $("#ubar"), fill = $("#ubarfill");
    bar.hidden = false;
    fill.style.width = Math.round((done / Math.max(1, total)) * 100) + "%";
  }

  async function paintAuto() {
    const dir = await knownFolder(false);
    $("#uauto").textContent = dir ? "⚡ Update now" : "📂 Choose my Market Lens folder";
    $("#uautonote").textContent = dir
      ? `writes straight into ${dir.name} — then press ↻`
      : "one time only: point at the folder Chrome loaded, and updates become one click";
  }

  $("#uauto").addEventListener("click", async () => {
    const btn = $("#uauto"), was = btn.textContent;
    try {
      let dir = await knownFolder(true);
      if (!dir) {
        // the picker needs the click, so it runs first and nothing else does
        dir = await window.showDirectoryPicker({ mode: "readwrite", id: "mlens-ext" });
        /* Check it before remembering it. The folder above the right one holds
           a valid extension after a write, and the folder Chrome actually
           loaded is then stale — which is what "File path cannot be resolved"
           is, and it costs the catalog, since an unpacked extension's identity
           is its path. */
        const here = await I.isExtensionFolder(dir);
        if (!here.ok) {
          $("#uautonote").textContent = here.name
            ? `That folder holds "${here.name}". Pick the Market Lens folder itself.`
            : "That folder has no manifest.json in it. Pick the folder Chrome loaded — " +
              "the one that CONTAINS manifest.json, not the folder above it.";
          return;
        }
        await I.saveFolder(dir);
        extDir = dir;
        await paintAuto();
        toast(`Folder remembered (${dir.name}) — press Update now`);
        return;
      }
      /* Reading the zip's BYTES needs access to github.com — a plain download
         does not, but we have to unzip it. Asked for inside the click, the way
         every other origin here is, and never held when it is not being used. */
      const GH = { origins: ["https://github.com/*", "https://codeload.github.com/*"] };
      const allowed = await new Promise(r => chrome.permissions.contains(GH, v => { void chrome.runtime.lastError; r(!!v); }))
        || await new Promise(r => chrome.permissions.request(GH, v => { void chrome.runtime.lastError; r(!!v); }));
      if (!allowed) throw new Error("access to github.com was declined");
      btn.disabled = true; btn.textContent = "Downloading…";
      const res = await fetch(ZIP_URL + "?t=" + Date.now(), { cache: "no-store" });
      if (!res.ok) throw new Error("download failed (" + res.status + ")");
      const buf = await res.arrayBuffer();
      btn.textContent = "Installing…";
      const out = await I.install(dir, buf, (d, t) => setBar(d, t));
      $("#uautonote").textContent =
        `v${out.version} written into ${dir.name} · ${out.written} files.`;
      toast(`v${out.version} is in your folder`);
      await paintReload(true);
      refreshUpdBox();
    } catch (e) {
      const m = (e && e.message) || String(e);
      if (/abort/i.test(m)) { /* the picker was dismissed — say nothing */ }
      else $("#uautonote").textContent = "Could not finish: " + m + " — try the manual steps below.";
    } finally {
      btn.disabled = false;
      if (btn.textContent === "Downloading…" || btn.textContent === "Installing…") btn.textContent = was;
      $("#ubar").hidden = true;
      paintAuto();
    }
  });

  /* ---- the last step, offered only while it is known to work --------------

     chrome.runtime.reload() is what turns this into one click. Measured in a
     test browser it never came back — but that browser loads extensions from
     the command line, which is not how a desktop Chrome registers one, so the
     measurement cannot decide it here. The extension settles it in the only
     place that counts, this browser: it leaves a note before reloading, clears
     the note if it comes back, and if the note is still sitting there the next
     time the panel opens, it stops offering the button and says why. Nobody
     loses their extension twice to find out. */
  const RELOAD_TRY = "wpb_reloadtry", RELOAD_OK = "wpb_reloadok";

  async function reloadVerdict() {
    return await new Promise(r => chrome.storage.local.get([RELOAD_TRY, RELOAD_OK], o => r(o || {})));
  }

  async function paintReload(filesJustWritten) {
    const v = await reloadVerdict();
    const stale = v[RELOAD_TRY] && Date.now() - (v[RELOAD_TRY].at || 0) > 30000;
    if (stale) {
      // it went away and a person had to bring it back — never offer that again
      await new Promise(r => chrome.storage.local.set({ [RELOAD_OK]: false }, r));
      await new Promise(r => chrome.storage.local.remove(RELOAD_TRY, r));
    }
    const allowed = (stale ? false : v[RELOAD_OK]) !== false;
    const btn = $("#ureload");
    btn.hidden = !(allowed && filesJustWritten);
    if (!allowed && filesJustWritten) {
      $("#uautonote").textContent += " This browser does not come back from an " +
        "automatic reload, so press ↻ on chrome://extensions.";
    } else if (allowed && filesJustWritten) {
      $("#uautonote").textContent += " One step left — and this can do it.";
    }
  }

  $("#ureload").addEventListener("click", () => {
    /* Open chrome://extensions FIRST. If the reload does come back, the tab is
       harmless; if it does not, the person is already looking at the page where
       one click brings it back, instead of at an extension that vanished. */
    chrome.tabs.create({ url: "chrome://extensions" }, () => void chrome.runtime.lastError);
    $("#uautonote").textContent = "Reloading… if Market Lens does not come back by itself, " +
      "press ↻ on the page that just opened.";
    chrome.runtime.sendMessage({ type: "reloadSelf" }, () => void chrome.runtime.lastError);
  });

  $("#uext").addEventListener("click", () => {
    chrome.tabs.create({ url: "chrome://extensions" }, () => {
      if (chrome.runtime.lastError) toast("Open chrome://extensions yourself — Chrome blocked the shortcut");
    });
  });

  $("#addbtn").addEventListener("click", addCurrentPage);
  $("#catalog").addEventListener("click", () =>
    chrome.tabs.create({ url: chrome.runtime.getURL("catalog.html") }));

  $("#listsel").addEventListener("change", e => {
    curList = lists.find(l => l.id === e.target.value) || curList;
    listQuery = ""; $("#lq").value = "";
    fillListSelect(); renderList(); paintNow(); paintListResult();
  });
  // Bound to the chip rail, which is rebuilt whenever the lists change.
  async function newList() {
    const name = await promptIn("New list name", "My references");
    if (!name) return;
    curList = { id: "l" + Date.now(), name: name.trim(), entries: [], createdAt: Date.now() };
    lists.push(curList); await L.save(lists); fillListSelect(); renderList(); paintNow();
  }
  $("#renlist").addEventListener("click", async () => {
    if (!curList) return;
    const name = await promptIn("List name", curList.name);
    if (!name) return;
    curList.name = name.trim(); await L.save(lists); fillListSelect();
  });
  $("#dellist").addEventListener("click", async () => {
    if (!curList || lists.length < 2) return toast("This is your only list");
    if (!await confirmIn(`Delete the list "${curList.name}"? The sites in it go with it.`)) return;
    lists = lists.filter(l => l.id !== curList.id);
    curList = lists[0]; await L.save(lists); fillListSelect(); renderList(); paintNow();
  });
  $("#lq").addEventListener("input", e => { listQuery = e.target.value; renderList(); });
  $("#lfold").addEventListener("click", () => {
    const brands = [...new Set(((curList && curList.entries) || [])
      .map(e => e.brand || hostOf(e.url) || "Other"))];
    const allFolded = brands.length && brands.every(b => folded.has(b));
    folded.clear();
    if (!allFolded) brands.forEach(b => folded.add(b));
    renderList();
  });
  $("#addbulk").addEventListener("click", async () => {
    const parsed = L.parseList($("#bulk").value)
      // adapterFor can't see platform-detected shops from a URL, so a miss is
      // "unknown" (undefined) rather than false — the page itself decides later
      .map(e => Object.assign(e, adapterFor(e.url) ? { scannable: true } : {}));
    if (!parsed.length) return toast("No URLs found");
    const m = L.mergeEntries(curList.entries || [], parsed);
    curList.entries = m.list;
    await L.save(lists); $("#bulk").value = "";
    fillListSelect(); renderList(); paintNow();
    toast(`${m.added} added` + (m.updated ? ` · ${m.updated} updated` : "") +
      (m.skipped ? ` · ${m.skipped} unchanged` : ""));
  });

  /* ---- export the list to a file -------------------------------------------

     The other half of Import. Take the list out, add a brand's category in
     Excel or Notepad, bring it back — the collector updates rather than
     duplicating, because the URL is the identity and brand/category are
     editable text. Both formats are written in exactly the shape the importer
     reads (lists.js toText / toGrid). */
  function saveFile(filename, blob, mime) {
    const reader = new FileReader();
    reader.onload = () => {
      const b64 = String(reader.result || "").split(",")[1] || "";
      try {
        chrome.runtime.sendMessage({ type: "downloadFile", filename, b64, mime }, r => {
          void chrome.runtime.lastError;
          if (r && r.ok) return toast(`Saved ${filename}`);
          // the worker path can be refused; the anchor still works here
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url; a.download = filename;
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 5000);
          toast(`Saved ${filename}`);
        });
      } catch (e) { toast("Save failed"); }
    };
    reader.readAsDataURL(blob);
  }
  const listTag = () =>
    ((curList && curList.name) || "list").replace(/[^\w가-힣]+/g, "_").slice(0, 40);

  $("#explisttxt").addEventListener("click", () => {
    const entries = (curList && curList.entries) || [];
    if (!entries.length) return toast("This list is empty");
    saveFile(`${listTag()}_list.txt`,
      new Blob([L.toText(entries)], { type: "text/plain;charset=utf-8" }),
      "text/plain");
  });

  $("#explistxlsx").addEventListener("click", async () => {
    const entries = (curList && curList.entries) || [];
    if (!entries.length) return toast("This list is empty");
    const btn = $("#explistxlsx");
    btn.disabled = true;
    try {
      const wb = new window.ExcelJS.Workbook();
      const ws = wb.addWorksheet("List", { views: [{ state: "frozen", ySplit: 1 }] });
      const grid = L.toGrid(entries);
      ws.columns = grid[0].map((h, i) => ({ header: h, width: [18, 26, 70][i] || 20 }));
      ws.getRow(1).eachCell(c => {
        c.font = { bold: true, color: { argb: "FFFFFFFF" } };
        c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2A2A2A" } };
      });
      grid.slice(1).forEach(r => ws.addRow(r));
      const bytes = await wb.xlsx.writeBuffer();
      saveFile(`${listTag()}_list.xlsx`,
        new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    } catch (e) {
      toast("Excel export failed: " + (e && e.message || e));
    } finally { btn.disabled = false; }
  });

  // ---- import a list from a file -------------------------------------------
  // Designers keep these lists in Excel as often as in a text file, so accept
  // both. Spreadsheets are read with the ExcelJS already bundled for export.
  async function gridFromFile(file) {
    const name = (file.name || "").toLowerCase();
    if (/\.(xlsx|xlsm)$/.test(name)) {
      const wb = new window.ExcelJS.Workbook();
      await wb.xlsx.load(await file.arrayBuffer());
      const grid = [];
      (wb.worksheets || []).forEach(ws => {
        ws.eachRow({ includeEmpty: false }, row => {
          const vals = Array.isArray(row.values) ? row.values.slice(1) : [];
          grid.push(vals);
        });
      });
      return L.parseGrid(grid);
    }
    const text = await file.text();
    if (/\.(csv|tsv)$/.test(name)) return L.parseGrid(L.parseCsv(text));
    // .txt — try the written format first, fall back to a delimited grid
    const asText = L.parseList(text);
    return asText.length ? asText : L.parseGrid(L.parseCsv(text));
  }

  $("#importbtn").addEventListener("click", () => $("#importfile").click());
  // Pasting sits beside Import and Add, but its box only opens when asked —
  // a four-line textarea permanently between the button and the list would
  // push the sites themselves off the screen.
  $("#pastetoggle").addEventListener("click", () => {
    const box = $("#bulkbox"), open = box.hidden;
    box.hidden = !open;
    $("#pastetoggle").setAttribute("aria-expanded", String(open));
    if (open) $("#bulk").focus();
  });
  $("#importfile").addEventListener("change", async e => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";                       // allow re-importing the same file
    if (!file) return;
    let parsed;
    try { parsed = await gridFromFile(file); }
    catch (err) { return toast("Could not read that file"); }
    if (!parsed || !parsed.length) return toast("No URLs found");
    parsed = parsed.map(en => Object.assign(en, adapterFor(en.url) ? { scannable: true } : {}));
    const m = L.mergeEntries(curList.entries || [], parsed);
    curList.entries = m.list;
    await L.save(lists);
    fillListSelect(); renderList(); paintNow(); paintListResult();
    toast(`${m.added} added` + (m.updated ? ` · ${m.updated} updated` : "") +
      (m.skipped ? ` · ${m.skipped} unchanged` : ""));
  });

  // Hold / resume. The scan keeps its place, so resuming never re-scrapes.
  $("#jpause").addEventListener("click", () => {
    if (job && job.paused) return sendEngine("resume", () => toast("Resumed"));
    sendEngine("pause", () => toast("On hold — press again to resume"));
  });

  /* Stop. One button, and the question is asked at the moment it matters with
     the safe answer — keep what was collected — as the default action. */
  $("#jreset").addEventListener("click", async () => {
    const running = !!(queue && queue.active);
    const rows = (queue && (queue.rows || []).length) || 0;
    const ok = await confirmIn(running && rows
      ? `Stop the run?\nThe ${rows} products collected so far will be saved to Excel.`
      : "Stop the scan?\nProducts already in the catalog are kept.");
    if (!ok) return;
    const clearStorage = () => chrome.storage.local.get(QUEUE, o => {
      const q = o && o[QUEUE];
      if (q) { q.active = false; q.rows = []; chrome.storage.local.set({ [QUEUE]: q }); }
    });
    if (running && rows) {
      return sendEngine("queueStop", r => {
        if (!r) { clearStorage(); return toast("Stopped (tab was gone — nothing saved)"); }
        toast("Stopping — saving what was collected to Excel");
      });
    }
    clearStorage();
    sendEngine("reset", () => toast("Stopped"));
  });

  $("#runlist").addEventListener("click", async () => {
    const entries = ((curList && curList.entries) || []).filter(e => e.scannable !== false);
    if (!entries.length) return toast("No scannable sites in this list");
    if (!await confirmIn(`Scan ${entries.length} sites one after another. Start?`)) return;
    // Ask for every origin the run will visit, in one prompt, while we still
    // have the click. Without the permission the worker cannot inject the
    // engine into a site the manifest doesn't cover, and that URL collects
    // nothing. Declining is allowed — the run just skips what it can't reach.
    await grantAccess(entries.map(e => e.url)).catch(() => {});
    // Foreground on purpose: Chrome throttles timers and fetches in hidden tabs
    // (down to roughly once a minute after a few minutes), which stalls a run.
    const t = await chrome.tabs.create({ url: entries[0].url, active: true });
    // The content script only exists once the page has loaded, so retry — but a
    // bounded number of times: if the site never answers (blocked, offline, or a
    // page the extension isn't injected into) the run must say so instead of
    // retrying invisibly forever.
    let tries = 0;
    // No maxItems sent: the engine's own default applies — the first page,
    // capped at the slice one research pass actually reads (user request:
    // always the first page, no count to choose).
    const send = () => chrome.tabs.sendMessage(t.id,
      { type: "runList", listId: curList.id, name: curList.name, list: entries,
        withSpec: true, filters: {} },
      r => {
        if (chrome.runtime.lastError || !r) {
          // No engine in that page: on a site the manifest doesn't cover there
          // never will be one on its own, so ask the worker to inject it.
          if (tries === 3) chrome.runtime.sendMessage({ type: "ensureEngine", tabId: t.id },
            () => void chrome.runtime.lastError);
          if (++tries < 14) return setTimeout(send, 900);
          return toast(`Could not start on ${hostOf(entries[0].url)} — open that page and allow access, then try again`);
        }
        toast("Scan started");
      });
    setTimeout(send, 1500);
  });
  $("#listxlsx").addEventListener("click", () => {
    const rows = productsOfList(curList && curList.id);
    const tag = (curList.name || "list").replace(/[^\w가-힣]+/g, "_");
    exportRows(rows, `${tag}_${rows.length}items_${new Date().toISOString().slice(0, 10)}.xlsx`, $("#listxlsx"));
  });
  // jump to PRODUCTS showing only this list's results
  $("#listview").addEventListener("click", () => {
    listFilter = curList && curList.id;
    document.querySelector('.tab[data-view="products"]').click();
  });

  $("#pgrid").addEventListener("change", e => {
    const ck = e.target.closest(".ck"); if (!ck) return;
    const card = e.target.closest(".pc"), k = card.getAttribute("data-k");
    if (ck.checked) picked.add(k); else picked.delete(k);
    card.classList.toggle("sel", ck.checked);
    $("#selcount").textContent = "Selected " + picked.size;
  });
  ["psearch", "pbrand", "pcat"].forEach(id => $("#" + id).addEventListener("input", renderProducts));
  $("#selall").addEventListener("click", () => {
    const rows = visibleProducts();
    const allOn = rows.length && rows.every(p => picked.has(p.key));
    rows.forEach(p => allOn ? picked.delete(p.key) : picked.add(p.key));
    renderProducts();
  });
  $("#selreset").addEventListener("click", () => { picked.clear(); renderProducts(); });
  $("#scopeclear").addEventListener("click", () => { listFilter = ""; renderProducts(); });
  $("#selexport").addEventListener("click", async () => {
    const rows = products.filter(p => picked.has(p.key));
    if (!rows.length) return toast("Nothing selected");
    const btn = $("#selexport"); btn.disabled = true;
    try {
      const { bytes } = await window.WPBExcel.buildKnitWorkbook(rows, {
        ExcelJS: window.ExcelJS,
        fetchImage: url => new Promise(res => {
          if (!url) return res(null);
          try { chrome.runtime.sendMessage({ type: "fetchImage", url }, r => {
            void chrome.runtime.lastError; res(r && r.ok ? r : null); }); } catch (e) { res(null); }
        }),
        filters: {},
        onProgress: (i, total) => { $("#selcount").textContent = `Images ${i}/${total}`; },
      });
      let b64 = "";
      for (let i = 0; i < bytes.length; i += 0x8000)
        b64 += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      chrome.runtime.sendMessage({
        type: "downloadFile",
        filename: `selection_${rows.length}items_${new Date().toISOString().slice(0, 10)}.xlsx`,
        b64: btoa(b64),
        mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }, r => toast(r && r.ok ? `Saved ${rows.length} rows to Excel` : "Export failed"));
    } catch (e) { toast("Export failed"); }
    finally { btn.disabled = false; $("#selcount").textContent = "Selected " + picked.size; }
  });

  chrome.tabs.onActivated.addListener(observe);
  chrome.tabs.onUpdated.addListener((id, info) => {
    if (tab && id === tab.id && (info.status === "complete" || info.url)) observe();
  });
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== "local") return;
    if (ch[JOB]) {
      const was = job; job = ch[JOB].newValue || null; paintLive();
      if (was && was.active && (!job || !job.active)) refreshProducts();
    }
    if (ch[QUEUE]) { queue = ch[QUEUE].newValue || null; paintQueue(); }
    if (ch[L.KEY]) {
      lists = ch[L.KEY].newValue || lists;
      curList = lists.find(x => curList && x.id === curList.id) || lists[0];
      fillListSelect(); renderList(); paintNow();
    }
  });

  (async () => {
    job = await load(JOB);
    queue = await load(QUEUE);
    const repaired = await loadLists();
    fillListSelect(); renderList(); paintLive(); paintQueue(); paintNow();
    // say it out loud — a count that changes on its own is exactly what makes
    // someone stop trusting the number
    if (repaired) toast(`${repaired} site${repaired > 1 ? "s" : ""} restored to the run`);
    refreshProducts();
    observe();
    /* Update notices, in the order that matters. If the new files are ALREADY
       in the folder — update.bat has run — that is the only thing worth
       saying, because one click finishes it. Otherwise fall back to "a newer
       version exists", which is a longer road. */
    try {
      chrome.storage.local.get("wpb_filesready", o => {
        const ready = (o || {}).wpb_filesready;
        if (ready && ready.onDisk) {
          $("#rdver").textContent = ready.onDisk;
          $("#upready").hidden = false;
          return;
        }
        chrome.runtime.sendMessage({ type: "updateStatus" }, r => {
          void chrome.runtime.lastError;
          if (!r || !r.newer) return;
          $("#upver").textContent = "v" + r.latest;
          $("#upcur").textContent = "v" + r.current;
          $("#upnote").hidden = false;
          $("#upget").onclick = () => chrome.tabs.create({ url: r.zip });
        });
      });
      // ask the worker to look at the folder right now, so opening the panel
      // is the fast path rather than waiting for the five-minute check
      chrome.runtime.sendMessage({ type: "checkFiles" }, () => void chrome.runtime.lastError);
    } catch (e) {}
  })();
})();
