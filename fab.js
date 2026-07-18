/* On-page floating scan button (FAB).
   Injected on every supported page, bottom-left. One click starts the scan
   using the last options chosen in the popup (default: detail collection ON,
   no filters); while running it shows the live job status right on the page,
   with pause/resume and stop controls. Because pagination reloads the page,
   this script re-injects on every page and re-renders from the stored job, so
   the button follows the whole run.

   Rendered inside a closed-off Shadow DOM so site CSS can't restyle it. */
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
  #fab {
    position: fixed; left: 16px; bottom: 16px; z-index: 2147483647;
    display: flex; align-items: center; gap: 8px;
    background: #0F3B5F; color: #fff;
    border-radius: 999px; padding: 8px;
    box-shadow: 0 4px 14px rgba(0,0,0,.28);
    font: 12.5px/1.35 system-ui, sans-serif;
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
  #fab.idle:hover #label { display: inline; padding-right: 4px; }
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
</style>
<div id="fab" class="idle">
  <span id="spin"></span>
  <button id="main" title="이 페이지의 상품을 엑셀로 수집 (Scan this page)">
    <svg viewBox="0 0 24 24" fill="none">
      <rect x="3" y="4" width="18" height="16" rx="2.5" fill="#fff"/>
      <rect x="3" y="4" width="18" height="5" rx="2.5" fill="#0071dc"/>
      <line x1="3" y1="13.5" x2="21" y2="13.5" stroke="#0F3B5F" stroke-opacity=".35"/>
      <line x1="12" y1="9" x2="12" y2="20" stroke="#0F3B5F" stroke-opacity=".35"/>
    </svg>
  </button>
  <span id="label">Scan this page → Excel</span>
  <span id="status"></span>
  <button id="pr" class="ctl" title="일시정지 / 재개">⏸</button>
  <button id="stop" class="ctl" title="중지 (작업 삭제)">✕</button>
</div>`;

  const el = id => sh.getElementById(id);
  const fab = el("fab");

  let doneTimer = null;
  function render(job) {
    clearTimeout(doneTimer);
    if (job && job.active && job.paused) {
      fab.className = "paused";
      el("status").textContent = job.status || "일시정지됨";
      el("pr").textContent = "▶";
    } else if (job && job.active) {
      fab.className = "running";
      el("status").textContent = job.status || "Scanning this page…";
      el("pr").textContent = "⏸";
    } else if (job && job.status && /완료|종료|실패/.test(job.status)) {
      // finished — show the result for a few seconds, then collapse to idle
      fab.className = "done";
      el("status").textContent = job.status;
      doneTimer = setTimeout(() => { fab.className = "idle"; }, 8000);
    } else {
      fab.className = "idle";
    }
  }

  el("main").addEventListener("click", async e => {
    e.stopPropagation();
    const eng = engine(); if (!eng) return;
    const j = await eng.getJob();
    if (j && j.active) return;             // already running — controls handle it
    fab.className = "running";
    el("status").textContent = "Scanning this page…";
    chrome.storage.local.get(OPTS, o => {
      const opts = (o && o[OPTS]) || {};   // last popup choices; defaults otherwise
      eng.startJob({ withSpec: opts.withSpec !== false, filters: opts.filters || {} });
    });
  });
  el("pr").addEventListener("click", async e => {
    e.stopPropagation();
    const eng = engine(); if (!eng) return;
    const j = await eng.getJob();
    if (j && j.active && j.paused) eng.resumeJob(); else if (j && j.active) eng.pauseJob();
  });
  el("stop").addEventListener("click", e => {
    e.stopPropagation();
    const eng = engine(); if (eng) eng.resetJob();
    fab.className = "idle";
  });

  // live updates: the engine persists the job to storage as it works
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[JOB]) render(changes[JOB].newValue);
    });
  } catch (e) {}

  function mount() {
    (document.body || document.documentElement).appendChild(host);
    try { chrome.storage.local.get(JOB, o => render(o && o[JOB])); } catch (e) {}
  }
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount, { once: true });
})();
