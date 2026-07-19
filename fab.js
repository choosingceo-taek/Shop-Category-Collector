/* On-page floating scan button (FAB) — dark frosted-glass control panel.
   Injected bottom-left on every supported page. Clicking the icon opens a
   control panel (not an instant scan): detail-collection + filters, plus a live
   progress gauge, the current brand/category, and 작업 시작 / 일시정지·재개 /
   초기화 — always present. The panel STAYS open while a run is going so progress
   is visible in place; the icon itself turns frosted glass while active. Because
   pagination reloads the page, this script re-injects per page and re-renders
   from the stored job, re-opening the panel automatically during a run.

   Rendered inside a Shadow DOM so site CSS can't restyle it. */
(function () {
  "use strict";
  if (window.__wpbFabInjected) return;
  window.__wpbFabInjected = true;

  const JOB = "wpb_job";
  const OPTS = "wpb_opts";
  const COLLAPSED = "wpb_fab_collapsed";      // remembers a user-collapse across page navs
  const engine = () => self.WPB_ENGINE || null;

  const host = document.createElement("div");
  host.id = "wpb-fab-host";
  const sh = host.attachShadow({ mode: "open" });
  sh.innerHTML = `
<style>
  :host { all: initial; }
  * { box-sizing: border-box; }
  #wrap {
    position: fixed; left: 16px; bottom: 16px; z-index: 2147483647;
    font: 12.5px/1.4 -apple-system, system-ui, sans-serif;
    display: flex; flex-direction: column; align-items: flex-start; gap: 10px;
  }

  /* ---------- the floating icon / status pill ---------- */
  #fab {
    display: flex; align-items: center; gap: 8px;
    background: rgba(18,20,26,.92); color: #f4f4f7;
    border: 1px solid rgba(255,255,255,.12);
    border-radius: 999px; padding: 8px;
    box-shadow: 0 6px 20px rgba(0,0,0,.35);
    max-width: 320px; transition: padding .15s ease, background .2s ease;
    -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
  }
  /* active -> frosted translucent glass showing live work */
  #fab.running, #fab.paused {
    padding: 8px 14px;
    background: rgba(28,30,38,.55);
    border-color: rgba(255,255,255,.22);
    -webkit-backdrop-filter: blur(16px) saturate(1.3);
    backdrop-filter: blur(16px) saturate(1.3);
  }
  #fab.done { padding: 8px 14px; }
  button { all: unset; box-sizing: border-box; cursor: pointer; display: inline-flex;
    align-items: center; justify-content: center; border-radius: 999px; }
  #main { width: 30px; height: 30px; flex: 0 0 auto; }
  #main:hover { background: rgba(255,255,255,.12); }
  #main svg { width: 20px; height: 20px; display: block; }
  #label { display: none; white-space: nowrap; font-weight: 600; }
  #fab.idle:hover #label, #fab.open #label { display: inline; padding-right: 6px; }
  #status { display: none; max-width: 220px; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; }
  #fab.running #status, #fab.paused #status, #fab.done #status { display: inline; }
  #fab.running #main, #fab.paused #main { display: none; }
  #spin { display: none; width: 15px; height: 15px; flex: 0 0 auto;
    border: 2px solid rgba(255,255,255,.3); border-top-color: #ff6fae;
    border-radius: 50%; animation: r .9s linear infinite; }
  #fab.running #spin { display: inline-block; }
  @keyframes r { to { transform: rotate(360deg); } }

  /* ---------- the control panel ---------- */
  /* the panel floats ABOVE the icon (absolute, so it doesn't push the pill) and
     scales/fades out of the icon's corner — as if it flows from the icon. */
  #panel {
    position: absolute; left: 0; bottom: 54px;
    display: flex; flex-direction: column;
    width: 320px; max-width: 88vw;
    max-height: calc(100vh - 84px);          /* headroom so it rarely needs to scroll */
    background: rgba(20,21,26,.9); color: #f2f2f7;
    border: 1px solid rgba(255,255,255,.10);
    border-radius: 18px; overflow: hidden;
    box-shadow: 0 16px 44px rgba(0,0,0,.5);
    -webkit-backdrop-filter: blur(24px) saturate(1.4);
    backdrop-filter: blur(24px) saturate(1.4);
    transform-origin: 0 100%;                /* bottom-left = the icon */
    transform: scale(.86) translateY(12px);
    opacity: 0; visibility: hidden; pointer-events: none;
    transition: transform .2s cubic-bezier(.2,.8,.2,1.1), opacity .16s ease, visibility 0s .2s;
  }
  #panel.show {
    transform: none; opacity: 1; visibility: visible; pointer-events: auto;
    transition: transform .2s cubic-bezier(.2,.8,.2,1.1), opacity .16s ease;
  }
  .head { flex: 0 0 auto; display: flex; align-items: center;
    justify-content: space-between; padding: 12px 14px 6px; }
  .head b { font-size: 13.5px; font-weight: 700; }
  #x { color: #cdcdd4; width: 24px; height: 24px; font-size: 15px;
    background: rgba(255,255,255,.08); }
  #x:hover { background: rgba(255,255,255,.16); }
  .body { flex: 1 1 auto; overflow-y: auto; padding: 2px 14px 12px; }
  .body::-webkit-scrollbar { width: 6px; }
  .body::-webkit-scrollbar-thumb { background: rgba(255,255,255,.16); border-radius: 6px; }

  /* progress / context card */
  .card { background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.08);
    border-radius: 12px; padding: 10px 11px; margin-bottom: 9px; }
  .crow { display: flex; justify-content: space-between; gap: 10px; margin: 2px 0;
    font-size: 11.5px; }
  .crow .k { color: #9a9aa4; }
  .crow .v { color: #f2f2f7; font-weight: 600; text-align: right;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 200px; }
  #progBar { height: 7px; border-radius: 999px; background: rgba(255,255,255,.12);
    overflow: hidden; margin: 8px 0 5px; }
  #progFill { height: 100%; width: 0%; border-radius: 999px;
    background: linear-gradient(90deg,#7b61ff,#ff6fae); transition: width .3s ease; }
  #progFill.indet { width: 38% !important; animation: slide 1.1s ease-in-out infinite; }
  @keyframes slide { 0% { margin-left: -40%; } 100% { margin-left: 100%; } }
  #progText { font-size: 11px; color: #c5c5cd; }

  /* switch toggle */
  .switchrow { display: flex; align-items: center; justify-content: space-between;
    gap: 12px; padding: 7px 2px; cursor: pointer; }
  .switchrow .t { font-size: 12.5px; }
  .switchrow .t small { display: block; color: #9a9aa4; font-size: 10.5px; margin-top: 1px; }
  .switch { position: relative; width: 42px; height: 24px; flex: 0 0 auto; }
  .switch input { opacity: 0; width: 0; height: 0; }
  .switch i { position: absolute; inset: 0; border-radius: 999px;
    background: rgba(255,255,255,.18); transition: background .2s; }
  .switch i::after { content: ""; position: absolute; top: 3px; left: 3px;
    width: 18px; height: 18px; border-radius: 50%; background: #fff; transition: transform .2s; }
  .switch input:checked + i { background: linear-gradient(90deg,#7b61ff,#ff6fae); }
  .switch input:checked + i::after { transform: translateX(18px); }

  #note { display: none; background: rgba(255,196,84,.12); color: #ffcf80;
    border-radius: 10px; padding: 8px; font-size: 11px; margin: 5px 0; }
  #filters { border: 1px solid rgba(255,255,255,.10); border-radius: 11px;
    padding: 2px 11px; margin: 7px 0; background: rgba(255,255,255,.04); }
  #filters[data-active="1"] { border-color: rgba(255,111,174,.55); background: rgba(255,111,174,.08); }
  #filters summary { cursor: pointer; font-size: 12px; font-weight: 600;
    color: #e6e6ea; padding: 9px 2px; list-style: none;
    display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  #filters summary::-webkit-details-marker { display: none; }
  #fsum .badge { color: #ff9ec7; font-weight: 700; }
  .chev { flex: 0 0 auto; width: 22px; height: 22px; border-radius: 7px;
    background: rgba(255,255,255,.12); color: #e6e6ea; font-size: 11px;
    display: inline-flex; align-items: center; justify-content: center;
    transition: transform .18s ease; }
  #filters[open] .chev { transform: rotate(180deg); }
  #filters[data-active="1"] .chev { background: rgba(255,111,174,.3); color: #ff9ec7; }
  .f { margin: 7px 0; }
  .f label { display: block; margin-bottom: 3px; color: #9a9aa4; font-size: 11px; }
  .f input[type=text] { width: 100%; padding: 7px; border: 1px solid rgba(255,255,255,.14);
    border-radius: 8px; font-size: 12px; background: rgba(0,0,0,.25); color: #f2f2f7; }
  .f small { color: #77777f; font-size: 10px; }
  .chk { display: flex; gap: 8px; align-items: center; margin: 7px 0; font-size: 12px; }
  #fclear { display: block; width: 100%; padding: 7px; margin: 4px 0 8px;
    font-size: 11.5px; color: #ffb0b0; background: rgba(255,92,92,.12); border-radius: 8px; }

  .act { display: flex; width: 100%; min-width: 0; max-width: 100%;
    padding: 10px 8px; font-weight: 700; font-size: 12px; line-height: 1.25;
    border-radius: 11px; justify-content: center; text-align: center;
    white-space: normal; word-break: keep-all; margin-top: 8px; }
  .act[disabled] { opacity: .4; cursor: default; }
  /* accent matches the panel mood (same violet→pink as the progress bar/switch) */
  #run { background: linear-gradient(90deg,#7b61ff,#c15fd6); color: #fff; }
  #run:not([disabled]):hover { filter: brightness(1.1); }
  .actrow { display: flex; gap: 8px; }
  .actrow .act { flex: 1 1 0; margin-top: 8px; }
  #pr2 { background: rgba(255,255,255,.12); color: #f2f2f7; }
  #pr2:not([disabled]):hover { background: rgba(255,255,255,.2); }
  #reset2 { background: rgba(255,92,92,.16); color: #ff8a8a; }
  #reset2:hover { background: rgba(255,92,92,.26); }
  #hint { color: #77777f; font-size: 10.5px; margin-top: 8px; text-align: center; }
</style>
<div id="wrap">
  <div id="panel">
    <div class="head"><b>이 페이지 상품 수집</b><button id="x" title="닫기">✕</button></div>
    <div class="body">
      <div class="card">
        <div class="crow"><span class="k">브랜드</span><span class="v" id="pbrand">—</span></div>
        <div class="crow"><span class="k">카테고리</span><span class="v" id="pcat">—</span></div>
        <div id="progBar"><div id="progFill"></div></div>
        <div id="progText">대기 중 — 시작을 누르세요</div>
        <div id="ctx" style="display:none"></div>
      </div>
      <label class="switchrow">
        <span class="t">상품 상세까지 수집<small>원단·색상·디자인 (느림)</small></span>
        <span class="switch"><input type="checkbox" id="spec" checked><i></i></span>
      </label>
      <div id="note">이 사이트는 전용 지원이 없어 기본 정보(썸네일·이름·가격·URL)만 수집됩니다. 색상/원단/디자인 칸은 "정보 확인"으로 남습니다.</div>
      <details id="filters">
        <summary><span id="fsum">필터 (선택)</span><span class="chev">▾</span></summary>
        <div class="chk"><input type="checkbox" id="fDomOnly"><label style="margin:0;color:#cdcdd4">대표 브랜드만 남기기 <small style="color:#77777f">— 섞여 들어온 다른 브랜드 제외</small></label></div>
        <div class="f"><label>브랜드</label>
          <input type="text" id="fBrand" placeholder="예: No Boundaries, Time and Tru">
          <small>이 브랜드만 남김 · 쉼표로 여러 개 · 비우면 전체</small></div>
        <div class="f"><label>상품명 포함</label>
          <input type="text" id="fInclude" placeholder="예: Women, Legging">
          <small>이 단어가 있는 것만 · 쉼표 구분</small></div>
        <div class="f"><label>상품명 제외</label>
          <input type="text" id="fExclude" placeholder="예: Men's, Juniors">
          <small>이 단어가 있으면 버림 · 쉼표 구분</small></div>
        <button id="fclear">✕ 필터 모두 지우기</button>
      </details>
      <button id="run" class="act">전 페이지 수집 → 엑셀</button>
      <div class="actrow">
        <button id="pr2" class="act" disabled>⏸ 일시정지</button>
        <button id="reset2" class="act">↺ 초기화</button>
      </div>
      <div id="hint">시작하면 팝업을 닫아도 계속 진행됩니다.</div>
    </div>
  </div>
  <div id="fab" class="idle">
    <span id="spin"></span>
    <button id="main" title="상품 정보 수집 — 옵션 / 작업 제어 열기">
      <svg viewBox="0 0 24 24" fill="none">
        <!-- product grid being scanned + collected -->
        <rect x="3" y="3.5" width="7" height="7" rx="1.6" fill="#fff"/>
        <rect x="3" y="13" width="7" height="7" rx="1.6" fill="#fff" fill-opacity=".5"/>
        <rect x="12.5" y="3.5" width="7" height="7" rx="1.6" fill="#fff" fill-opacity=".5"/>
        <!-- magnifier scanning the products -->
        <circle cx="15.3" cy="15.1" r="4.3" fill="none" stroke="#ff8fc4" stroke-width="2"/>
        <line x1="18.5" y1="18.3" x2="21.4" y2="21.2" stroke="#ff8fc4" stroke-width="2" stroke-linecap="round"/>
      </svg>
    </button>
    <span id="label">스캔 옵션</span>
    <span id="status"></span>
  </div>
</div>`;

  const el = id => sh.getElementById(id);
  const fab = el("fab");
  const panel = el("panel");
  const terms = id => (el(id).value || "").split(",").map(s => s.trim()).filter(Boolean);
  const isFinished = job => !!(job && job.status && /완료|종료|실패/.test(job.status) && !(job && job.active));
  const setStore = (k, v) => { try { chrome.storage.local.set({ [k]: v }); } catch (e) {} };

  let lastJob = null;
  let doneTimer = null;

  // --- derive a 0..100 progress + label from the stored job ---
  function progress(job) {
    if (!job) return { pct: 0, text: "대기 중 — 시작을 누르세요", indet: false };
    const items = (job.items && job.items.length) || 0;
    if (isFinished(job)) return { pct: 100, text: job.status, indet: false };
    if (job.phase === "spec") {
      const t = items, i = job.specIdx || 0;
      return { pct: t ? 62 + Math.round((i / t) * 33) : 62, text: `상품 상세 수집… ${i}/${t}`, indet: false };
    }
    if (job.phase === "build") return { pct: 97, text: "엑셀 생성 중… (썸네일 포함)", indet: true };
    // list phase
    if (job.resultCount) return { pct: Math.min(58, Math.round((items / job.resultCount) * 58)), text: `상품 수집… ${items}/${job.resultCount}`, indet: false };
    if (job.totalPages) return { pct: Math.min(58, Math.round(((job.pagesDone || 0) / job.totalPages) * 58)), text: `페이지 ${job.pagesDone || 0}/${job.totalPages} · ${items}개`, indet: false };
    return { pct: 12, text: `상품 수집 중… ${items}개 (${job.pagesDone || 0}p)`, indet: !!(job.active) };  // total unknown -> indeterminate
  }

  function setPillClass(c) { fab.classList.remove("idle", "open", "running", "paused", "done"); fab.classList.add(c); }
  function paintPill(job) {
    clearTimeout(doneTimer);
    const active = job && job.active, paused = active && job.paused;
    if (paused) { setPillClass("paused"); el("status").textContent = job.status || "일시정지됨"; }
    else if (active) { setPillClass("running"); el("status").textContent = job.status || "Scanning…"; }
    else if (isFinished(job)) { setPillClass("done"); el("status").textContent = job.status; doneTimer = setTimeout(() => setPillClass("idle"), 8000); }
    else { setPillClass("idle"); }
  }
  function paintPanel(job) {
    const active = job && job.active, paused = active && job.paused;
    el("run").disabled = !!active;
    el("pr2").disabled = !active;
    el("pr2").textContent = paused ? "▶ 재개" : "⏸ 일시정지";
    const p = progress(job);
    el("progFill").style.width = p.pct + "%";
    el("progFill").classList.toggle("indet", !!p.indet);
    el("progText").textContent = paused ? "⏸ 일시정지됨 — ▶ 재개로 이어집니다" : p.text;
  }
  function paint(job) {
    lastJob = job || null;
    paintPanel(lastJob);
    if (!panel.classList.contains("show")) paintPill(lastJob);
  }

  // brand + category for the panel header (from the active adapter)
  function fillContext() {
    const eng = engine();
    let a = null; try { a = eng && eng.adapter && eng.adapter(); } catch (e) {}
    if (!a) { el("pbrand").textContent = "—"; el("pcat").textContent = "지원 사이트에서 열어주세요"; return; }
    let c = {}; try { c = a.context(document) || {}; } catch (e) {}
    const pages = c.totalPages ? `총 ${c.totalPages}p` : "페이지 자동 감지";
    el("pbrand").textContent = c.brand || a.label || "—";
    el("pcat").textContent = c.category || "—";
    el("ctx").textContent = `${a.label} · ${pages} (현재 ${c.page || 1})`;   // kept for reference
    const hasDetail = typeof a.fetchDetail === "function";
    el("spec").closest(".switchrow").style.display = hasDetail ? "" : "none";
    el("note").style.display = hasDetail ? "none" : "block";
  }
  // reflect whether any filter is set — a stale filter silently dropping most
  // results was a real footgun, so make it loud: badge + accent + auto-expand.
  function refreshFilterState() {
    const active = el("fDomOnly").checked || el("fBrand").value.trim() ||
      el("fInclude").value.trim() || el("fExclude").value.trim();
    el("filters").setAttribute("data-active", active ? "1" : "0");
    el("fsum").innerHTML = active
      ? '필터 <span class="badge">● 적용 중 — 일부 상품 제외됨</span>'
      : "필터 (선택)";
    if (active) el("filters").open = true;
  }
  function prefill() {
    try {
      chrome.storage.local.get(OPTS, o => {
        const opts = (o && o[OPTS]) || {};
        el("spec").checked = opts.withSpec !== false;
        const f = opts.filters || {};
        el("fDomOnly").checked = !!f.dominantBrandOnly;
        el("fBrand").value = (f.brands || []).join(", ");
        el("fInclude").value = (f.nameInclude || []).join(", ");
        el("fExclude").value = (f.nameExclude || []).join(", ");
        refreshFilterState();
      });
    } catch (e) {}
  }
  function openPanel(remember) {
    prefill(); fillContext(); paintPanel(lastJob);
    panel.classList.add("show");
    setPillClass("open");
    if (remember !== false) setStore(COLLAPSED, false);
  }
  function closePanel(remember) {
    panel.classList.remove("show");
    paintPill(lastJob);
    if (remember !== false) setStore(COLLAPSED, true);
  }

  el("main").addEventListener("click", e => {
    e.stopPropagation();
    if (panel.classList.contains("show")) closePanel(); else openPanel();
  });
  el("x").addEventListener("click", e => { e.stopPropagation(); closePanel(); });

  el("run").addEventListener("click", async e => {
    e.stopPropagation();
    const eng = engine(); if (!eng) return;
    const j = await eng.getJob();
    if (j && j.active) return;
    const filters = {
      dominantBrandOnly: el("fDomOnly").checked,
      brands: terms("fBrand"),
      nameInclude: terms("fInclude"),
      nameExclude: terms("fExclude"),
    };
    const withSpec = el("spec").checked;
    setStore(OPTS, { withSpec, filters });
    setStore(COLLAPSED, false);                 // keep the panel open through the run
    eng.startJob({ withSpec, filters });
    // stay open and show progress in place
    paint({ active: true, paused: false, phase: "list", items: [], status: "시작…" });
  });

  async function togglePause() {
    const eng = engine(); if (!eng) return;
    const j = await eng.getJob();
    if (j && j.active && j.paused) eng.resumeJob(); else if (j && j.active) eng.pauseJob();
  }
  el("pr2").addEventListener("click", e => { e.stopPropagation(); togglePause(); });
  // clear the filter inputs + persist the cleared state (shared by 필터 지우기 and 초기화)
  function clearFilters() {
    el("fDomOnly").checked = false;
    el("fBrand").value = ""; el("fInclude").value = ""; el("fExclude").value = "";
    setStore(OPTS, { withSpec: el("spec").checked, filters: {} });
    refreshFilterState();
  }
  // 초기화 = discard the job AND clear the filters, so nothing carries into the next run
  function doReset() { const eng = engine(); if (eng) eng.resetJob(); clearFilters(); paint(null); }
  el("reset2").addEventListener("click", e => { e.stopPropagation(); doReset(); });

  // keep the filter badge in sync as the user edits, and let them clear in one tap
  ["fDomOnly", "fBrand", "fInclude", "fExclude"].forEach(id => {
    el(id).addEventListener("input", refreshFilterState);
    el(id).addEventListener("change", refreshFilterState);
  });
  el("fclear").addEventListener("click", e => { e.stopPropagation(); clearFilters(); });

  // click outside closes the panel — but NOT while a job is active: the panel
  // must stay open during a run so 일시정지 is always one tap away.
  document.addEventListener("click", e => {
    if (!panel.classList.contains("show") || e.target === host) return;
    if (lastJob && lastJob.active) return;            // keep it open mid-run
    closePanel();
  });

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[JOB]) paint(changes[JOB].newValue);
    });
  } catch (e) {}

  function mount() {
    (document.body || document.documentElement).appendChild(host);
    try {
      chrome.storage.local.get([JOB, COLLAPSED], o => {
        const job = o && o[JOB];
        paint(job);
        // during an active run, always re-open the panel so progress + 일시정지
        // stay visible across the page reloads that pagination triggers.
        if (job && job.active) openPanel(false);
      });
    } catch (e) {}
  }
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount, { once: true });
})();
