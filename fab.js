/* On-page floating scan button (FAB).
   Injected on every supported page, bottom-left. Clicking it does NOT scan
   immediately — it expands into a full control panel (same as the popup):
   detail-collection + post-scan filters, plus 작업 시작 / 일시정지·재개 /
   새 작업(리셋). While a run is going it collapses to a live status pill; click
   the pill any time to reopen the panel and pause, resume, or reset the job.
   Because pagination reloads the page, this script re-injects on every page and
   re-renders from the stored job, so the button follows the whole run.

   Rendered inside a Shadow DOM so site CSS can't restyle it. */
(function () {
  "use strict";
  if (window.__wpbFabInjected) return;
  window.__wpbFabInjected = true;

  const JOB = "wpb_job";
  const OPTS = "wpb_opts";
  const engine = () => self.WPB_ENGINE || null;

  // ---- DOM ----
  const host = document.createElement("div");
  host.id = "wpb-fab-host";
  const sh = host.attachShadow({ mode: "open" });
  sh.innerHTML = `
<style>
  :host { all: initial; }
  * { box-sizing: border-box; }
  #wrap {
    position: fixed; left: 16px; bottom: 16px; z-index: 2147483647;
    font: 12.5px/1.4 system-ui, sans-serif;
    display: flex; flex-direction: column; align-items: flex-start; gap: 10px;
  }

  /* --- the pill (collapsed / running / done) --- */
  #fab {
    display: flex; align-items: center; gap: 8px;
    background: #0F3B5F; color: #fff;
    border-radius: 999px; padding: 8px;
    box-shadow: 0 4px 14px rgba(0,0,0,.28);
    max-width: 340px; transition: padding .15s ease;
  }
  #fab.running, #fab.paused, #fab.done { padding: 8px 12px; }
  button {
    all: unset; cursor: pointer; display: inline-flex; align-items: center;
    justify-content: center; border-radius: 999px;
  }
  #main { width: 28px; height: 28px; flex: 0 0 auto; }
  #main:hover { background: rgba(255,255,255,.14); }
  #main svg { width: 20px; height: 20px; display: block; }
  #label { display: none; white-space: nowrap; font-weight: 600; }
  #fab.idle:hover #label, #fab.open #label { display: inline; padding-right: 4px; }
  #status { display: none; max-width: 230px; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; }
  #fab.running #status, #fab.paused #status, #fab.done #status { display: inline; }
  #fab.running #main, #fab.paused #main { display: none; }
  .ctl { display: none; width: 24px; height: 24px; flex: 0 0 auto;
    font-size: 12px; background: rgba(255,255,255,.16); }
  .ctl:hover { background: rgba(255,255,255,.3); }
  #fab.running .ctl, #fab.paused .ctl { display: inline-flex; }
  #spin { display: none; width: 14px; height: 14px; flex: 0 0 auto;
    border: 2px solid rgba(255,255,255,.35); border-top-color: #fff;
    border-radius: 50%; animation: r 0.9s linear infinite; }
  #fab.running #spin { display: inline-block; }
  @keyframes r { to { transform: rotate(360deg); } }

  /* --- the control panel (expands upward) --- */
  #panel {
    display: none; width: 300px; max-width: 82vw;
    background: #fff; color: #222; border-radius: 12px;
    box-shadow: 0 8px 28px rgba(0,0,0,.30); overflow: hidden;
  }
  #panel.show { display: block; }
  .head { background: #0F3B5F; color: #fff; padding: 10px 12px;
    display: flex; align-items: center; justify-content: space-between; }
  .head b { font-size: 13px; }
  #x { color: #fff; width: 22px; height: 22px; font-size: 15px;
    background: rgba(255,255,255,.15); }
  #x:hover { background: rgba(255,255,255,.3); }
  .body { padding: 12px; }
  #ctx { color: #555; font-size: 11.5px; margin-bottom: 8px; }
  #pstatus { display: none; margin: 8px 0; padding: 8px; background: #f4f6f8;
    border-radius: 8px; font-size: 11.5px; color: #333; }
  .opt { display: flex; gap: 7px; align-items: flex-start; margin: 8px 0;
    cursor: pointer; }
  .opt input { margin-top: 1px; flex: 0 0 auto; }
  .opt span { font-size: 12px; }
  #note { display: none; background: #fff6e5; color: #8a5a00;
    border-radius: 8px; padding: 8px; font-size: 11px; margin: 8px 0; }
  #filters { border: 1px solid #e6e6e6; border-radius: 8px;
    padding: 4px 10px; margin: 10px 0; }
  #filters summary { cursor: pointer; font-size: 12px; font-weight: 600;
    color: #333; padding: 4px 0; }
  .f { margin: 8px 0; }
  .f label { display: block; margin-bottom: 3px; color: #555; font-size: 11px; }
  .f input[type=text] { width: 100%; padding: 6px; border: 1px solid #ccc;
    border-radius: 6px; font-size: 12px; }
  .f small { color: #999; font-size: 10px; }
  .act { width: 100%; padding: 10px; font-weight: 700; font-size: 12.5px;
    border-radius: 8px; justify-content: center; margin-top: 8px; }
  .act[disabled] { opacity: .45; cursor: default; }
  #run { background: #0071dc; color: #fff; }
  #run:not([disabled]):hover { background: #005fbb; }
  #pr2 { background: #eee; color: #333; }
  #reset2 { background: #fbe9e9; color: #b00000; }
  #hint { color: #888; font-size: 10.5px; margin-top: 8px; text-align: center; }
</style>
<div id="wrap">
  <div id="panel">
    <div class="head"><b>이 페이지 상품 수집</b><button id="x" title="닫기">✕</button></div>
    <div class="body">
      <div id="ctx">페이지 감지 중…</div>
      <div id="pstatus"></div>
      <label class="opt"><input type="checkbox" id="spec" checked>
        <span>상품 상세까지 수집 — 원단·색상·디자인 <b>(느림)</b></span></label>
      <div id="note">이 사이트는 전용 지원이 없어 기본 정보(썸네일·이름·가격·URL)만 수집됩니다. 색상/원단/디자인 칸은 "정보 확인"으로 남습니다.</div>
      <details id="filters">
        <summary>필터 (선택) — 엑셀에 담기 전에 정제</summary>
        <label class="opt" style="margin:8px 0"><input type="checkbox" id="fDomOnly">
          <span>주 브랜드만 (제3자 셀러 자동 제외)</span></label>
        <div class="f"><label>브랜드만 남기기</label>
          <input type="text" id="fBrand" placeholder="예: No Boundaries, Time and Tru">
          <small>쉼표로 여러 개 · 비우면 전체</small></div>
        <div class="f"><label>상품명 포함 (이 단어가 있는 것만)</label>
          <input type="text" id="fInclude" placeholder="예: Women, Legging">
          <small>쉼표 구분 · 비우면 전체</small></div>
        <div class="f"><label>상품명 제외 (이 단어가 있으면 버림)</label>
          <input type="text" id="fExclude" placeholder="예: Men's, Juniors">
          <small>쉼표 구분</small></div>
      </details>
      <button id="run" class="act">이 카테고리 전 페이지 수집 → 엑셀</button>
      <button id="pr2" class="act" disabled>⏸ 일시정지</button>
      <button id="reset2" class="act">🗑 새 작업 (현재 작업 삭제)</button>
      <div id="hint">시작하면 팝업을 닫아도 계속 진행됩니다.</div>
    </div>
  </div>
  <div id="fab" class="idle">
    <span id="spin"></span>
    <button id="main" title="스캔 옵션 / 작업 제어 열기">
      <svg viewBox="0 0 24 24" fill="none">
        <rect x="3" y="4" width="18" height="16" rx="2.5" fill="#fff"/>
        <rect x="3" y="4" width="18" height="5" rx="2.5" fill="#0071dc"/>
        <line x1="3" y1="13.5" x2="21" y2="13.5" stroke="#0F3B5F" stroke-opacity=".35"/>
        <line x1="12" y1="9" x2="12" y2="20" stroke="#0F3B5F" stroke-opacity=".35"/>
      </svg>
    </button>
    <span id="label">스캔 옵션</span>
    <span id="status"></span>
    <button id="pr" class="ctl" title="일시정지 / 재개">⏸</button>
    <button id="stop" class="ctl" title="중지 (작업 삭제)">✕</button>
  </div>
</div>`;

  const el = id => sh.getElementById(id);
  const fab = el("fab");
  const panel = el("panel");
  const terms = id => (el(id).value || "").split(",").map(s => s.trim()).filter(Boolean);
  const isFinished = job => !!(job && job.status && /완료|종료|실패/.test(job.status) && !(job && job.active));

  let lastJob = null;
  let doneTimer = null;

  function setPillClass(c) { fab.classList.remove("idle", "open", "running", "paused", "done"); fab.classList.add(c); }

  // the collapsed pill reflects job state (only when the panel is closed)
  function paintPill(job) {
    clearTimeout(doneTimer);
    const active = job && job.active, paused = active && job.paused;
    if (paused) { setPillClass("paused"); el("status").textContent = job.status || "일시정지됨"; el("pr").textContent = "▶"; }
    else if (active) { setPillClass("running"); el("status").textContent = job.status || "Scanning this page…"; el("pr").textContent = "⏸"; }
    else if (isFinished(job)) { setPillClass("done"); el("status").textContent = job.status; doneTimer = setTimeout(() => setPillClass("idle"), 8000); }
    else { setPillClass("idle"); }
  }

  // the panel's controls reflect job state (start disabled while running, etc.)
  function paintPanel(job) {
    const active = job && job.active, paused = active && job.paused;
    el("run").disabled = !!active;                 // finish or reset before a new run
    el("pr2").disabled = !active;
    el("pr2").textContent = paused ? "▶ 재개" : "⏸ 일시정지";
    const s = (job && job.status) || "";
    el("pstatus").textContent = s;
    el("pstatus").style.display = s ? "block" : "none";
  }

  function paint(job) {
    lastJob = job || null;
    paintPanel(lastJob);
    if (!panel.classList.contains("show")) paintPill(lastJob);
  }

  // ---- panel open/close ----
  function fillContext() {
    const eng = engine();
    let a = null; try { a = eng && eng.adapter && eng.adapter(); } catch (e) {}
    if (!a) { el("ctx").textContent = "지원 사이트의 카테고리/검색 페이지에서 열어주세요."; return; }
    let c = {}; try { c = a.context(document) || {}; } catch (e) {}
    const hasDetail = typeof a.fetchDetail === "function";
    const brand = c.brand ? ` · ${c.brand}` : "";
    const pages = c.totalPages ? `총 ${c.totalPages}p` : "페이지 자동 감지";
    el("ctx").textContent = `${a.label}${brand} · ${pages} (현재 ${c.page || 1})`;
    el("spec").closest(".opt").style.display = hasDetail ? "" : "none";
    el("note").style.display = hasDetail ? "none" : "block";
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
      });
    } catch (e) {}
  }
  function openPanel() {
    prefill(); fillContext(); paintPanel(lastJob);
    panel.classList.add("show");
    setPillClass("open");
  }
  function closePanel() {
    panel.classList.remove("show");
    paintPill(lastJob);                            // pill resumes showing job state
  }

  // ---- interactions ----
  el("main").addEventListener("click", e => {
    e.stopPropagation();
    if (panel.classList.contains("show")) closePanel(); else openPanel();
  });
  el("x").addEventListener("click", e => { e.stopPropagation(); closePanel(); });

  el("run").addEventListener("click", async e => {
    e.stopPropagation();
    const eng = engine(); if (!eng) return;
    const j = await eng.getJob();
    if (j && j.active) return;                     // already running — use pause/reset
    const filters = {
      dominantBrandOnly: el("fDomOnly").checked,
      brands: terms("fBrand"),
      nameInclude: terms("fInclude"),
      nameExclude: terms("fExclude"),
    };
    const withSpec = el("spec").checked;
    try { chrome.storage.local.set({ [OPTS]: { withSpec, filters } }); } catch (e) {}
    closePanel();
    setPillClass("running");
    el("status").textContent = "Scanning this page…";
    eng.startJob({ withSpec, filters });
  });

  async function togglePause() {
    const eng = engine(); if (!eng) return;
    const j = await eng.getJob();
    if (j && j.active && j.paused) eng.resumeJob(); else if (j && j.active) eng.pauseJob();
  }
  el("pr").addEventListener("click", e => { e.stopPropagation(); togglePause(); });
  el("pr2").addEventListener("click", e => { e.stopPropagation(); togglePause(); });

  function doReset() { const eng = engine(); if (eng) eng.resetJob(); paint(null); }
  el("stop").addEventListener("click", e => { e.stopPropagation(); doReset(); });
  el("reset2").addEventListener("click", e => { e.stopPropagation(); doReset(); });

  // click anywhere outside the widget closes the panel
  document.addEventListener("click", e => {
    if (panel.classList.contains("show") && e.target !== host) closePanel();
  });

  // live updates: the engine persists the job to storage as it works
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[JOB]) paint(changes[JOB].newValue);
    });
  } catch (e) {}

  function mount() {
    (document.body || document.documentElement).appendChild(host);
    try { chrome.storage.local.get(JOB, o => paint(o && o[JOB])); } catch (e) {}
  }
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount, { once: true });
})();
