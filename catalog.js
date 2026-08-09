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

  let items = [];             // everything in the catalog
  let projects = [];
  let snapshots = [];         // frozen weekly numbers (survive product cleanup)
  let merged = 0;             // rows collapsed as the same product
  const picked = new Set();   // product keys the user has selected

  const priceNum = v => { const m = String(v || "").replace(/,/g, "").match(/\d+(?:\.\d+)?/); return m ? parseFloat(m[0]) : null; };

  /* Freeze this week's numbers (and re-confirm earlier ones) every time the LAB
     is opened. Products are live — re-scanned, updated, eventually cleaned up —
     so the weekly aggregate is written down separately and never shrinks. That
     is what makes the long view possible: a year from now the charts still have
     every week, at a few KB each, whether or not the products are still here. */
  async function rollup() {
    const scanned = items.filter(i => i && i.source !== "clip" && i.addedAt);
    if (!scanned.length) return;
    const oldest = Math.min(...scanned.map(i => i.addedAt));
    const months = Math.max(2, Math.ceil((Date.now() - oldest) / (30 * 864e5)) + 1);
    try {
      await S.putSnapshots(window.TrendCalc.weeklySnapshots(scanned, { months }));
      snapshots = await S.allSnapshots();
    } catch (e) { /* snapshots are an optimisation — never block the view */ }
  }

  async function load() {
    // one product, one row — see store.dedupe for what counts as the same product
    const raw = await S.allProducts();
    const dd = S.dedupe(raw);
    items = dd.rows; merged = dd.merged;
    projects = await S.allProjects();
    try { snapshots = await S.allSnapshots(); } catch (e) { snapshots = []; }
    await rollup();
    fillFilters();
    fillProjects();
    render();
    if (!$("#v-lab").hidden) renderLab();
    const brands = new Set(items.map(i => i.brand).filter(Boolean)).size;
    const dated = items.filter(i => i.launched_at).length;
    $("#stats").textContent = items.length
      ? `상품 ${items.length.toLocaleString()}개 · 브랜드 ${brands}` +
        (merged ? ` · 중복 ${merged}개 합침` : "") +
        (dated ? ` · 업로드일 확인 ${dated}개` : "")
      : "아직 비어 있습니다";
  }

  function fillFilters() {
    const fill = (sel, values, label) => {
      const cur = sel.value;
      sel.innerHTML = `<option value="">${label}</option>` +
        [...values].sort((a, b) => a.localeCompare(b)).map(v => `<option>${esc(v)}</option>`).join("");
      sel.value = cur;
    };
    fill($("#brand"), new Set(items.map(i => i.brand).filter(Boolean)), "모든 브랜드");
    fill($("#cat"), new Set(items.map(i => i.category).filter(Boolean)), "모든 카테고리");
    fill($("#src"), new Set(items.map(i => i.site || i.source).filter(Boolean)), "모든 사이트");
  }
  function fillProjects() {
    const sel = $("#proj"), cur = sel.value;
    sel.innerHTML = projects.length
      ? projects.map(p => `<option value="${esc(p.id)}">${esc(p.name)} (${(p.keys || []).length})</option>`).join("")
      : `<option value="">프로젝트 없음</option>`;
    if (cur) sel.value = cur;
    // the same list also filters the catalog down to one project's contents
    const f = $("#projf"), curF = f.value;
    f.innerHTML = `<option value="">모든 상품</option>` +
      projects.map(p => `<option value="${esc(p.id)}">📁 ${esc(p.name)} (${(p.keys || []).length})</option>`).join("");
    f.value = curF;
  }

  // Window for the period filter, on addedAt — the moment a product FIRST
  // entered the catalog. That is what "이번 주 신규" means to a designer: newly
  // seen this week, not merely re-scanned. Weeks start Monday.
  /* The shop's own publish date, where the shop states one.

     Only some platforms tell us: Shopify's products.json carries published_at.
     There is no way to infer it for the rest, and guessing would be exactly the
     kind of invented value the output rules forbid — so a product without one
     simply has no upload date, and the date filter says how many rows it can
     actually see rather than silently filtering on a field most rows lack. */
  const launchedAt = i => {
    if (!i || !i.launched_at) return null;
    const t = Date.parse(i.launched_at);
    return isFinite(t) ? t : null;
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
        // "수집일" = when we first saw it; "업로드일" = when the shop published
        // it. A row with no upload date is dropped from an upload-date window
        // rather than falling back to a different measure.
        const t = $("#datebasis").value === "launch" ? launchedAt(i) : (i.addedAt || 0);
        if (t == null || !(t >= range.from && t < range.to)) return false;
      }
      if (q) {
        const hay = [i.name, i.fabric_composition, i.colorways, i.brand, i.design].join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const sort = $("#sort").value;
    out.sort((x, y) =>
      sort === "priceUp" ? (priceNum(x.price) ?? 1e12) - (priceNum(y.price) ?? 1e12)
      : sort === "priceDown" ? (priceNum(y.price) ?? -1) - (priceNum(x.price) ?? -1)
      : sort === "name" ? String(x.name).localeCompare(String(y.name))
      // newest upload first; rows with no upload date go last, never guessed at
      : sort === "launch" ? ((launchedAt(y) ?? -1) - (launchedAt(x) ?? -1))
      : sort === "brand" ? (String(x.brand || "￿").localeCompare(String(y.brand || "￿"))
                            || (y.addedAt || 0) - (x.addedAt || 0))
      : (y.addedAt || 0) - (x.addedAt || 0));
    return out;
  }

  function render() {
    const rows = visible();
    const grid = $("#grid");
    if (!items.length) {
      grid.innerHTML = "";
      grid.insertAdjacentHTML("beforeend",
        '<div class="empty" style="grid-column:1/-1">카탈로그가 비어 있습니다.<br>' +
        '쇼핑몰에서 <b>전체 스캔</b>을 한 번 돌리면 수집한 상품이 여기에 쌓입니다.</div>');
      return;
    }
    if (!rows.length) {
      grid.innerHTML = '<div class="empty" style="grid-column:1/-1">조건에 맞는 상품이 없습니다.</div>';
      return;
    }
    grid.innerHTML = rows.map(i => {
      const onSale = i.price_was && i.price && priceNum(i.price_was) > priceNum(i.price);
      const img = i.image_url
        ? `<img class="thumb" src="${esc(i.image_url)}" alt="" loading="lazy">`
        : `<div class="thumb"></div>`;
      const link = i.product_url ? `<a href="${esc(i.product_url)}" target="_blank" rel="noopener">` : "";
      return `<div class="c${picked.has(i.key) ? " sel" : ""}" data-k="${esc(i.key)}">
        <input class="pick" type="checkbox" ${picked.has(i.key) ? "checked" : ""} title="선택">
        ${link}${img}${link ? "</a>" : ""}
        <div class="body">
          ${i.brand ? `<div class="bd">${esc(i.brand)}</div>` : ""}
          <div class="nm">${link}${esc(i.name || "(이름 없음)")}${link ? "</a>" : ""}</div>
          ${i.price ? `<div class="pr${onSale ? " sale" : ""}">${esc(i.price)}${onSale ? `<s>${esc(i.price_was)}</s>` : ""}</div>` : ""}
          ${i.fabric_composition ? `<div class="fb">${esc(i.fabric_composition)}</div>` : ""}
        </div></div>`;
    }).join("");
    paintSel();
  }

  function paintSel() {
    $("#selbar").classList.toggle("on", picked.size > 0);
    $("#selcount").textContent = `${picked.size}개 선택`;
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
    const name = prompt("새 프로젝트 이름", "26SS 리서치");
    if (!name) return;
    const p = await S.saveProject({ name: name.trim(), keys: [] });
    projects = await S.allProjects();
    fillProjects();
    $("#proj").value = p.id;
  });
  $("#addproj").addEventListener("click", async () => {
    const id = $("#proj").value;
    if (!id) return alert("먼저 프로젝트를 만들어 주세요.");
    const p = projects.find(x => x.id === id);
    if (!p) return;
    const before = (p.keys || []).length;
    p.keys = [...new Set([...(p.keys || []), ...picked])];
    await S.saveProject(p);
    projects = await S.allProjects();
    fillProjects();
    const added = p.keys.length - before;
    alert(`"${p.name}"에 ${added}개를 담았습니다. (총 ${p.keys.length}개)`);
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
    if (!rows.length) return alert("리포트에 담을 상품이 없습니다.");
    const btn = $("#report");
    const label = btn.textContent;
    btn.disabled = true;

    const images = {};
    let done = 0, ok = 0;
    for (const r of rows) {
      btn.textContent = `이미지 담는 중… ${++done}/${rows.length}`;
      if (!r.image_url || !r.product_url) continue;
      const got = await fetchImage(r.image_url);
      if (!got) continue;
      const small = await downscale("data:image/" + (got.ext || "jpeg") + ";base64," + got.base64);
      if (small) { images[r.product_url] = small; ok++; }
    }

    btn.textContent = "리포트 만드는 중…";
    const b = $("#brand").value, c = $("#cat").value, s = $("#src").value;
    const scope = [b, c, s].filter(Boolean).join(" · ");
    // say plainly which slice this is, so the file still explains itself later
    const basis = $("#datebasis").value === "launch" ? "업로드" : "수집";
    const periodLabel = ({ "7": `최근 7일 ${basis}`, "14": `최근 14일 ${basis}`, "30": `최근 30일 ${basis}`,
      thisweek: `이번 주 ${basis}`, lastweek: `지난 주 ${basis}` })[$("#period").value] || "";
    const proj = projects.find(p => p.id === $("#projf").value);
    const today = new Date().toISOString().slice(0, 10);
    const html = window.ReportGen.build(rows, images, {
      title: proj ? proj.name : (scope ? `${scope} 마켓 리서치` : "마켓 리서치 리포트"),
      subtitle: [periodLabel, proj ? scope : ""].filter(Boolean).join(" · ") || (scope ? "" : "카탈로그 전체"),
      scope, period: periodLabel, generatedAt: today,
      template: $("#tmpl").value,
      source: [...new Set(rows.map(r => r.site || r.source).filter(Boolean))].join(", "),
    });

    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `리서치_${scope ? scope.replace(/[^\w가-힣]+/g, "_") + "_" : ""}${today}.html`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 8000);

    btn.disabled = false; btn.textContent = label;
    const mb = (blob.size / 1048576).toFixed(1);
    alert(`리포트를 저장했습니다.\n상품 ${rows.length}개 · 이미지 ${ok}개 내장 · ${mb} MB\n\n` +
      `이미지와 수치가 파일 안에 들어 있어 인터넷 없이도, 원본 쇼핑몰이 사라져도 그대로 열립니다.`);
  }
  $("#report").addEventListener("click", makeReport);

  // ---- Excel export ---------------------------------------------------------
  // The storyline ends in a spreadsheet, and a scan's own xlsx only ever covers
  // that one scan. This exports whatever the catalog is currently showing — many
  // brands and categories collected over weeks — through the same 12-column
  // builder the scans use, so the sourcing rules (real value / red "정보 확인")
  // and embedded thumbnails are identical.
  async function exportXlsx() {
    const rows = visible();
    if (!rows.length) return alert("내보낼 상품이 없습니다.");
    const btn = $("#xlsx");
    const label = btn.textContent;
    btn.disabled = true;
    try {
      const { bytes } = await window.WPBExcel.buildKnitWorkbook(rows, {
        ExcelJS: window.ExcelJS,
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
        onProgress: (i, total) => { btn.textContent = `이미지 담는 중… ${i}/${total}`; },
      });
      const b = $("#brand").value, c = $("#cat").value;
      const proj = projects.find(p => p.id === $("#projf").value);
      const tag = (proj ? proj.name : [b, c].filter(Boolean).join("_")) || "카탈로그";
      const name = `${tag.replace(/[^\w가-힣]+/g, "_")}_${rows.length}items_${new Date().toISOString().slice(0, 10)}.xlsx`;
      const blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 8000);
      alert(`Excel로 내보냈습니다.\n${rows.length}개 상품 · ${(blob.size / 1048576).toFixed(1)} MB`);
    } catch (e) {
      alert("내보내기 실패: " + (e && e.message || e));
    } finally { btn.disabled = false; btn.textContent = label; }
  }
  $("#xlsx").addEventListener("click", exportXlsx);

  ["q", "brand", "cat", "src", "sort", "period", "datebasis", "projf"].forEach(id =>
    $("#" + id).addEventListener("input", render));
  $("#reset").addEventListener("click", () => {
    ["q", "brand", "cat", "src", "period", "projf"].forEach(id => { $("#" + id).value = ""; });
    $("#sort").value = "new"; $("#datebasis").value = "added"; render();
  });

  // ---- scan lists tab -------------------------------------------------------
  const L = window.ScanLists;
  let lists = [], curList = null;

  function tabTo(view) {
    document.querySelectorAll(".tab").forEach(b => b.classList.toggle("on", b.dataset.view === view));
    $("#v-lab").hidden = view !== "lab";
    $("#v-products").hidden = view !== "products";
    $("#v-lists").hidden = view !== "lists";
    // the search/brand/period row belongs to the product grid only
    document.querySelector(".filters").hidden = view !== "products";
    if (view === "lists") renderLists();
    if (view === "lab") renderLab();
  }

  // LAB — change over time, computed from what we collected (no external service)
  function renderLab() {
    window.LabView.render($("#labbody"), items, {
      months: parseInt($("#labmonths").value, 10) || 6,
      granularity: $("#labgran").value,
      dim: $("#labdim").value,
      snapshots,
    });
  }
  ["labmonths", "labgran", "labdim"].forEach(id =>
    $("#" + id).addEventListener("change", renderLab));
  document.querySelectorAll(".tab").forEach(b =>
    b.addEventListener("click", () => tabTo(b.dataset.view)));

  async function loadLists() {
    lists = await L.load();
    if (!lists.length) {
      lists = [{ id: "l" + Date.now(), name: "주간 리서치", entries: [], createdAt: Date.now() }];
      await L.save(lists);
    }
    curList = lists.find(x => x.id === (curList && curList.id)) || lists[0];
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
      rows.innerHTML = '<div class="empty">아직 등록된 URL이 없습니다.<br>' +
        '아래에 브랜드와 카테고리 URL을 붙여넣어 추가하세요.</div>';
    } else {
      rows.innerHTML = entries.map((e, i) => `<div class="ur" data-i="${i}">
        <span class="n">${i + 1}</span>
        <span class="bd">${esc(e.brand || "—")}</span>
        <span class="lb">${esc(e.label || "")}<small>${esc(e.url)}</small></span>
        <button class="x" title="삭제">✕</button></div>`).join("");
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
      box.innerHTML = `<b>스캔 중 · ${q.idx + 1}/${q.list.length}</b> — ` +
        `${esc(cur.brand || "")} ${esc(cur.label || "")}<br>` +
        `<span style="color:var(--muted);font-size:12px">스캔은 원래 탭에서 진행됩니다. 이 창은 닫아도 됩니다.</span>`;
      document.querySelectorAll(".ur").forEach((el, i) => el.classList.toggle("cur", i === q.idx));
    }
  }
  setInterval(() => { if (!$("#v-lists").hidden) paintRunState(); }, 2500);

  $("#listsel").addEventListener("change", e => {
    curList = lists.find(l => l.id === e.target.value) || curList;
    renderLists();
  });
  $("#newlist").addEventListener("click", async () => {
    const name = prompt("새 목록 이름", "주간 리서치");
    if (!name) return;
    curList = { id: "l" + Date.now(), name: name.trim(), entries: [], createdAt: Date.now() };
    lists.push(curList); await L.save(lists); renderLists();
  });
  $("#dellist").addEventListener("click", async () => {
    if (!curList || lists.length < 2) return alert("목록이 하나뿐이라 삭제할 수 없습니다.");
    if (!confirm(`"${curList.name}" 목록을 삭제할까요?`)) return;
    lists = lists.filter(l => l.id !== curList.id);
    curList = lists[0]; await L.save(lists); renderLists();
  });
  $("#addbulk").addEventListener("click", async () => {
    const text = $("#bulk").value;
    const parsed = L.parseList(text);
    if (!parsed.length) return alert("URL을 찾지 못했습니다. 형식을 확인해 주세요.");
    const m = L.mergeEntries(curList.entries || [], parsed);
    curList.entries = m.list;
    await L.save(lists);
    $("#bulk").value = "";
    renderLists();
    alert(`${m.added}개 추가했습니다.` + (m.skipped ? ` (이미 있는 ${m.skipped}개는 건너뜀)` : ""));
  });

  // Run the list: hand it to a tab's content script, which walks the URLs.
  $("#runlist").addEventListener("click", async () => {
    const entries = (curList && curList.entries) || [];
    if (!entries.length) return alert("목록이 비어 있습니다.");
    if (!confirm(`"${curList.name}"의 ${entries.length}개 URL을 순서대로 전체 스캔합니다.\n` +
      `시간이 걸리고, 스캔하는 탭은 자동으로 이동합니다. 시작할까요?`)) return;
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
  load();
})();
