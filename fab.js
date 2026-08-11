/* The grab button — collecting URLs happens on the page, not in the panel.

   A designer finds the categories worth watching while browsing, one tab at a
   time. Asking them to look away to a side panel to file each one breaks that
   rhythm, so the act of collecting sits where the browsing is: a small round
   button in the bottom-right corner. Press it and the page is already named —
   brand and category read from the shop itself, both editable right there —
   and the lists appear as coloured chips. Tapping a chip drops the page in.
   That is the whole interaction: see something, grab it, keep browsing.

   The panel keeps what it is good at: holding several lists and organising
   what has been grabbed. Running a scan lives there too.

   Rendered in a Shadow DOM so no site's CSS can reach it. */
(function () {
  "use strict";
  if (window.__wpbFabInjected) return;
  window.__wpbFabInjected = true;

  const JOB = "wpb_job";
  const LAST = "wpb_lastlist";           // the list a grab defaults to
  const HIDDEN = "wpb_fab_hidden";       // user tucked the button away
  const L = () => self.ScanLists || null;
  const engine = () => self.WPB_ENGINE || null;

  /* Colours carry meaning: a list keeps the same colour everywhere, derived
     from its name, so the chip you reach for is recognisable by shape and
     colour before you have read it. The palette is the warm set the panel
     uses — clay, sage, sky, plum, amber, blush. */
  const HUES = ["#C08552", "#7E9E7A", "#7C9CC4", "#9A85BE", "#C9A227", "#D98070"];
  const hueOf = name => {
    const s = String(name || "").toLowerCase();
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return HUES[h % HUES.length];
  };

  const host = document.createElement("div");
  host.id = "wpb-fab-host";
  const sh = host.attachShadow({ mode: "open" });
  sh.innerHTML = `
<style>
  :host { all: initial; }
  * { box-sizing: border-box; }
  #wrap {
    position: fixed; right: 18px; bottom: 18px; z-index: 2147483647;
    font: 13px/1.45 -apple-system, system-ui, "Segoe UI", sans-serif;
    display: flex; flex-direction: column; align-items: flex-end; gap: 10px;
    color: #1D1B18;
  }
  button { all: unset; box-sizing: border-box; cursor: pointer;
    display: inline-flex; align-items: center; justify-content: center; }

  /* ---------- the button ---------- */
  #fab {
    position: relative; width: 52px; height: 52px; border-radius: 50%;
    background: #1D1B18; color: #F7F4EE;
    box-shadow: 0 6px 22px rgba(29,27,24,.32), 0 1px 3px rgba(29,27,24,.2);
    transition: transform .18s cubic-bezier(.2,.9,.3,1.2), box-shadow .18s ease;
  }
  #fab:hover { transform: translateY(-2px) scale(1.04); }
  #fab:active { transform: scale(.94); }
  #fab svg { width: 24px; height: 24px; display: block; }
  #fab.saved { background: #4E7C59; }
  /* a scan is running elsewhere — the button says so without taking over */
  #fab.busy { background: #C08552; }
  #fab.busy::after {
    content: ""; position: absolute; inset: -4px; border-radius: 50%;
    border: 2px solid rgba(192,133,82,.45); border-top-color: transparent;
    animation: spin 1s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  #count {
    position: absolute; top: -3px; right: -3px; min-width: 20px; height: 20px;
    padding: 0 5px; border-radius: 999px; background: #D9634A; color: #fff;
    font-size: 11px; font-weight: 700; display: none;
    align-items: center; justify-content: center;
    box-shadow: 0 0 0 2px rgba(255,255,255,.9);
  }
  #count.on { display: inline-flex; }

  /* the "+1" that flies off the chip you tapped */
  #pop {
    position: absolute; right: 26px; bottom: 52px; pointer-events: none;
    font-weight: 800; font-size: 15px; color: #4E7C59; opacity: 0;
  }
  #pop.go { animation: rise .8s ease-out; }
  @keyframes rise {
    0% { opacity: 0; transform: translateY(6px) scale(.8); }
    25% { opacity: 1; transform: translateY(-4px) scale(1.05); }
    100% { opacity: 0; transform: translateY(-34px) scale(1); }
  }

  /* ---------- the card ---------- */
  #card {
    width: 306px; max-width: calc(100vw - 36px);
    background: #F7F4EE; border-radius: 22px;
    box-shadow: 0 20px 50px rgba(29,27,24,.26), 0 2px 8px rgba(29,27,24,.12);
    overflow: hidden;
    transform-origin: 100% 100%;
    transform: scale(.9) translateY(10px); opacity: 0;
    visibility: hidden; pointer-events: none;
    transition: transform .2s cubic-bezier(.2,.9,.3,1.15), opacity .15s ease, visibility 0s .2s;
  }
  #card.show { transform: none; opacity: 1; visibility: visible; pointer-events: auto;
    transition: transform .2s cubic-bezier(.2,.9,.3,1.15), opacity .15s ease; }

  .top { display: flex; align-items: center; justify-content: space-between;
    padding: 15px 16px 9px; }
  .top .ttl { font-size: 12px; font-weight: 700; letter-spacing: .09em;
    text-transform: uppercase; color: #8A857C; }
  #x { width: 26px; height: 26px; border-radius: 50%; color: #8A857C;
    background: rgba(29,27,24,.06); font-size: 14px; }
  #x:hover { background: rgba(29,27,24,.12); }

  /* what will be filed — the two fields Excel groups by, editable in place */
  .fields { padding: 0 16px 4px; }
  .fld { display: block; margin-bottom: 8px; }
  .fld span { display: block; font-size: 10.5px; letter-spacing: .07em;
    text-transform: uppercase; color: #A8A29A; margin: 0 0 4px 12px; }
  .fld input {
    all: unset; box-sizing: border-box; display: block; width: 100%;
    padding: 11px 13px; border-radius: 13px; background: #fff;
    font: 600 13.5px/1.3 inherit; color: #1D1B18;
    box-shadow: inset 0 0 0 1px rgba(29,27,24,.09);
  }
  .fld input:focus { box-shadow: inset 0 0 0 2px #1D1B18; }
  .fld input::placeholder { color: #C4BFB6; font-weight: 500; }

  /* the lists, as chips you drop the page into */
  .into { padding: 8px 16px 4px; font-size: 10.5px; letter-spacing: .07em;
    text-transform: uppercase; color: #A8A29A; }
  #chips { display: flex; flex-wrap: wrap; gap: 7px; padding: 0 16px 14px;
    max-height: 168px; overflow-y: auto; }
  .chip {
    display: inline-flex; align-items: center; gap: 7px;
    padding: 9px 13px; border-radius: 999px; background: #fff;
    box-shadow: inset 0 0 0 1px rgba(29,27,24,.1);
    font-size: 12.5px; font-weight: 600; color: #1D1B18;
    transition: transform .14s ease, box-shadow .14s ease, background .14s ease;
  }
  .chip .dot { width: 9px; height: 9px; border-radius: 50%; flex: 0 0 auto; }
  .chip .n { font-size: 11px; font-weight: 700; color: #A8A29A; }
  .chip:hover { transform: translateY(-1px); box-shadow: inset 0 0 0 1px rgba(29,27,24,.28); }
  .chip:active { transform: scale(.96); }
  .chip.hit { background: #1D1B18; color: #F7F4EE; box-shadow: none; }
  .chip.hit .n { color: rgba(247,244,238,.7); }
  .chip.has { background: #EDE8DE; }
  .chip.new { color: #8A857C; box-shadow: inset 0 0 0 1px rgba(29,27,24,.1); font-weight: 600; }

  /* state line — already in a list, or the last thing that happened */
  #msg { padding: 0 16px 15px; font-size: 12px; color: #8A857C; display: none; }
  #msg.on { display: block; }
  #msg b { color: #1D1B18; }

  .foot { border-top: 1px solid rgba(29,27,24,.08); padding: 10px 16px;
    display: flex; align-items: center; justify-content: space-between;
    background: rgba(29,27,24,.02); }
  .foot button { font-size: 11.5px; color: #8A857C; }
  .foot button:hover { color: #1D1B18; }
  #run { font-weight: 700; color: #1D1B18; }
  #run[disabled] { opacity: .35; cursor: default; }
</style>
<div id="wrap">
  <div id="card">
    <div class="top"><div class="ttl">Grab this page</div><button id="x" title="Close">✕</button></div>
    <div class="fields">
      <label class="fld"><span>Brand</span><input id="fbrand" placeholder="Brand" autocomplete="off"></label>
      <label class="fld"><span>Category</span><input id="flabel" placeholder="Category" autocomplete="off"></label>
    </div>
    <div class="into">Into which list</div>
    <div id="chips"></div>
    <div id="msg"></div>
    <div class="foot">
      <button id="run">▶ Scan this page</button>
      <button id="hide" title="Hide the button on this site">Hide button</button>
    </div>
  </div>
  <button id="fab" title="Grab this page">
    <span id="pop">+1</span>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"
         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="6.4"></circle>
      <path d="M15.8 15.8 21 21"></path>
      <path d="M11 8.2v5.6M8.2 11h5.6"></path>
    </svg>
    <span id="count"></span>
  </button>
</div>`;

  const $ = s => sh.querySelector(s);
  const esc = s => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  let lists = [], lastId = "", job = null, open = false, dirty = false;

  const alive = () => { try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; } };
  const get = keys => new Promise(r => {
    if (!alive()) return r({});
    try { chrome.storage.local.get(keys, o => r(chrome.runtime.lastError ? {} : (o || {}))); }
    catch (e) { r({}); }
  });
  const set = obj => new Promise(r => {
    if (!alive()) return r();
    try { chrome.storage.local.set(obj, () => r()); } catch (e) { r(); }
  });

  // What this page is, according to the shop itself. Falls back to the domain
  // and the page title — never to a guess dressed up as a fact.
  function readPage() {
    const a = (engine() && engine().adapter && engine().adapter()) || null;
    let ctx = null;
    try { ctx = a && a.context ? a.context(document) : null; } catch (e) {}
    if (a) ctx = Object.assign({ platform: !!a.platform }, ctx || {});
    const host = location.hostname;
    const api = L();
    const brand = api ? api.brandFor(ctx, a && a.label, host)
      : String((ctx && ctx.brand) || host);
    const label = api
      ? (api.cleanLabel((ctx && ctx.category) || document.title, brand, host)
         || api.labelFromUrl(location.href) || host)
      : String((ctx && ctx.category) || document.title || host).slice(0, 60);
    return { brand, label, url: location.href, scannable: !!a };
  }

  const listOf = id => lists.find(l => l.id === id) || null;
  const inList = (l, url) => {
    const api = L(); if (!api) return false;
    const k = api.normUrl(url);
    return (l.entries || []).some(e => api.normUrl(e.url) === k);
  };

  function renderChips() {
    const url = location.href;
    const box = $("#chips");
    box.innerHTML = lists.map(l =>
      `<button class="chip${inList(l, url) ? " has" : ""}" data-id="${esc(l.id)}" type="button">
         <i class="dot" style="background:${hueOf(l.name)}"></i>${esc(l.name)}
         <span class="n">${(l.entries || []).length}</span>
       </button>`).join("") +
      `<button class="chip new" id="newlist" type="button">＋ New list</button>`;
    box.querySelectorAll(".chip[data-id]").forEach(b =>
      b.addEventListener("click", () => grab(b.dataset.id, b)));
    const nl = box.querySelector("#newlist");
    if (nl) nl.addEventListener("click", makeList);

    // Say where this page already lives — grabbing it twice is a no-op, and
    // silence about that reads as a broken button.
    const already = lists.filter(l => inList(l, url)).map(l => l.name);
    const msg = $("#msg");
    if (already.length) {
      msg.innerHTML = `Already in <b>${esc(already.join(", "))}</b> — tap a chip to update its name.`;
      msg.classList.add("on");
    } else if (!dirty) {
      msg.classList.remove("on");
    }
  }

  function paintCount() {
    const l = listOf(lastId) || lists[0];
    const n = l ? (l.entries || []).length : 0;
    const c = $("#count");
    c.textContent = n > 99 ? "99+" : String(n);
    c.classList.toggle("on", n > 0);
  }

  async function load() {
    const api = L();
    lists = api ? await api.load() : [];
    const o = await get(LAST);
    lastId = o[LAST] || (lists[0] && lists[0].id) || "";
    paintCount();
    if (open) renderChips();
  }

  async function makeList() {
    const name = prompt("New list name", "");
    if (name == null) return;
    const clean = String(name).trim();
    if (!clean) return;
    const api = L(); if (!api) return;
    lists.push({ id: "l" + Date.now(), name: clean, entries: [], createdAt: Date.now() });
    await api.save(lists);
    renderChips();
  }

  /* Drop the page into a list. The brand and category used are whatever the
     two fields say at this moment, so an edit is part of the same gesture. */
  async function grab(listId, chipEl) {
    const api = L(); if (!api) return;
    const l = listOf(listId); if (!l) return;
    const entry = {
      brand: $("#fbrand").value.trim() || readPage().brand,
      label: $("#flabel").value.trim() || readPage().label,
      url: location.href,
      scannable: true,      // it is a web page we are standing on — of course it can be scanned
    };
    const m = api.mergeEntries(l.entries || [], [entry]);
    l.entries = m.list;
    await api.save(lists);
    lastId = listId;
    await set({ [LAST]: listId });

    if (chipEl) {
      chipEl.classList.add("hit");
      setTimeout(() => chipEl.classList.remove("hit"), 420);
    }
    const pop = $("#pop");
    pop.textContent = m.added ? "+1" : "✓";
    pop.classList.remove("go"); void pop.offsetWidth; pop.classList.add("go");
    $("#fab").classList.add("saved");
    setTimeout(() => $("#fab").classList.remove("saved"), 700);

    dirty = true;
    const msg = $("#msg");
    msg.innerHTML = m.added
      ? `Grabbed into <b>${esc(l.name)}</b> — ${(l.entries || []).length} sites.`
      : `Updated in <b>${esc(l.name)}</b>.`;
    msg.classList.add("on");
    paintCount(); renderChips();
    setTimeout(() => { if (open) close(); dirty = false; }, 950);
  }

  function openCard() {
    const p = readPage();
    $("#fbrand").value = p.brand;
    $("#flabel").value = p.label;
    dirty = false;
    renderChips();
    $("#card").classList.add("show");
    open = true;
  }
  function close() { $("#card").classList.remove("show"); open = false; }

  $("#fab").addEventListener("click", () => (open ? close() : openCard()));
  $("#x").addEventListener("click", close);
  $("#hide").addEventListener("click", async () => {
    close();
    host.style.display = "none";
    await set({ [HIDDEN]: true });
  });
  // Scanning belongs to the panel, but the page you are looking at is the one
  // case where starting from here saves a round trip.
  $("#run").addEventListener("click", () => {
    const e = engine(); if (!e) return;
    close();
    try { e.startJob({ withSpec: true, filters: {} }); } catch (x) {}
  });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && open) close(); });

  // A scan running anywhere shows on the button; its controls stay in the panel.
  function paintJob() {
    const on = !!(job && job.active);
    $("#fab").classList.toggle("busy", on && !job.paused);
    $("#run").disabled = on;
    $("#run").textContent = on ? "Scanning…" : "▶ Scan this page";
  }

  if (alive()) {
    try {
      chrome.storage.onChanged.addListener((ch, area) => {
        if (area !== "local") return;
        if (ch[JOB]) { job = ch[JOB].newValue || null; paintJob(); }
        if (ch.wpb_lists) { load(); }
      });
    } catch (e) {}
  }

  (async () => {
    const o = await get([JOB, HIDDEN]);
    if (o[HIDDEN]) return;                    // user tucked it away
    job = o[JOB] || null;
    document.documentElement.appendChild(host);
    await load();
    paintJob();
  })();
})();
