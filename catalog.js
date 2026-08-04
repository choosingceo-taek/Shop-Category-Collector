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
  const picked = new Set();   // product keys the user has selected

  const priceNum = v => { const m = String(v || "").replace(/,/g, "").match(/\d+(?:\.\d+)?/); return m ? parseFloat(m[0]) : null; };

  async function load() {
    items = await S.allProducts();
    projects = await S.allProjects();
    fillFilters();
    fillProjects();
    render();
    const st = await S.stats();
    $("#stats").textContent = st.products
      ? `상품 ${st.products.toLocaleString()}개 · 브랜드 ${st.brands} · 카테고리 ${st.categories} · 사이트 ${st.sources}`
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
      sort === "priceUp" ? (priceNum(x.price) ?? 1e12) - (priceNum(y.price) ?? 1e12)
      : sort === "priceDown" ? (priceNum(y.price) ?? -1) - (priceNum(x.price) ?? -1)
      : sort === "name" ? String(x.name).localeCompare(String(y.name))
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
    const periodLabel = ({ "7": "최근 7일 수집", "14": "최근 14일 수집", "30": "최근 30일 수집",
      thisweek: "이번 주 신규", lastweek: "지난 주 신규" })[$("#period").value] || "";
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

  ["q", "brand", "cat", "src", "sort", "period", "projf"].forEach(id =>
    $("#" + id).addEventListener("input", render));
  $("#reset").addEventListener("click", () => {
    ["q", "brand", "cat", "src", "period", "projf"].forEach(id => { $("#" + id).value = ""; });
    $("#sort").value = "new"; render();
  });

  load();
})();
