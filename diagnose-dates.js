/* 업로드 일자 진단 — 상품 페이지에 "언제 올라왔는지"가 실제로 들어있는지 확인.

   사용법
     1) 확인하고 싶은 브랜드의 **상품 상세 페이지**를 연다 (목록 아님)
     2) F12 → Console 탭
     3) 이 파일 전체를 붙여넣고 Enter
     4) 출력 전체를 복사해서 보내주기

   무엇을 보는가
     - JSON-LD (script[type=application/ld+json])의 날짜 필드
     - 페이지에 박혀 있는 JSON 덩어리(__NEXT_DATA__, __PRELOADED_STATE__ 등)
     - <meta> 태그의 날짜
     - 사이트가 부른 API 응답 URL (거기에 날짜가 있을 수 있음)

   추측하지 않는다. 실제로 있는 값만 그대로 찍는다. 값이 없으면 "없음"이라고
   적는다 — 그게 이 진단의 결론이다. */
(async () => {
  const OUT = [];
  const log = (...a) => { OUT.push(a.join(" ")); console.log(...a); };
  const DATE_KEY = /(date|time|publish|release|launch|created|added|onsale|available|since|new)/i;
  // 날짜처럼 보이는 값만 (2024-05-01, 2024/05/01, ISO, epoch ms)
  const looksLikeDate = v => {
    if (typeof v === "number") return v > 946684800000 && v < 4102444800000;   // 2000~2100 (ms)
    if (typeof v !== "string") return false;
    if (/^\d{4}[-/]\d{2}[-/]\d{2}/.test(v)) return true;
    return /^\d{13}$/.test(v) && looksLikeDate(Number(v));
  };
  const show = v => {
    if (typeof v === "number" || /^\d{13}$/.test(String(v))) {
      try { return `${v}  (= ${new Date(Number(v)).toISOString().slice(0, 10)})`; } catch (e) { return String(v); }
    }
    return String(v).slice(0, 60);
  };

  log("=== 업로드 일자 진단 ===");
  log("URL:", location.href);
  log("");

  // ---- 1) JSON-LD -----------------------------------------------------------
  log("--- 1) JSON-LD ---");
  let ldHits = 0;
  document.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
    let d; try { d = JSON.parse(s.textContent); } catch (e) { return; }
    const walk = (node, path) => {
      if (!node || typeof node !== "object") return;
      Object.keys(node).forEach(k => {
        const v = node[k];
        if (v && typeof v === "object") return walk(v, path + "." + k);
        if (DATE_KEY.test(k) && looksLikeDate(v)) { ldHits++; log(`  ${path}.${k} = ${show(v)}`); }
      });
    };
    walk(d, "ld");
  });
  if (!ldHits) log("  없음");
  log("");

  // ---- 2) 페이지에 박힌 JSON ------------------------------------------------
  log("--- 2) 페이지 내 JSON ---");
  const blobs = [];
  ["__NEXT_DATA__", "__PRELOADED_STATE__", "__INITIAL_STATE__", "__NUXT__", "_state"].forEach(k => {
    if (window[k]) blobs.push([k, window[k]]);
  });
  document.querySelectorAll("script:not([src])").forEach((s, i) => {
    const t = s.textContent || "";
    if (t.length < 80 || t.length > 4e6) return;
    const m = t.match(/[[{][\s\S]*[\]}]/);
    if (!m) return;
    try { blobs.push(["inline#" + i, JSON.parse(m[0])]); } catch (e) {}
  });
  let jsonHits = 0;
  const seen = new Set();
  blobs.forEach(([name, root]) => {
    const walk = (node, path, depth) => {
      if (!node || typeof node !== "object" || depth > 8 || jsonHits > 60) return;
      Object.keys(node).forEach(k => {
        const v = node[k];
        if (v && typeof v === "object") return walk(v, path + "." + k, depth + 1);
        if (DATE_KEY.test(k) && looksLikeDate(v)) {
          const sig = k + "=" + v;
          if (seen.has(sig)) return;
          seen.add(sig); jsonHits++;
          log(`  ${path}.${k} = ${show(v)}`);
        }
      });
    };
    walk(root, name, 0);
  });
  if (!jsonHits) log("  없음");
  log("");

  // ---- 3) meta 태그 ---------------------------------------------------------
  log("--- 3) meta 태그 ---");
  let metaHits = 0;
  document.querySelectorAll("meta[property], meta[name], meta[itemprop]").forEach(m => {
    const key = m.getAttribute("property") || m.getAttribute("name") || m.getAttribute("itemprop") || "";
    const val = m.getAttribute("content") || "";
    if (DATE_KEY.test(key) && looksLikeDate(val)) { metaHits++; log(`  ${key} = ${val}`); }
  });
  if (!metaHits) log("  없음");
  log("");

  // ---- 4) 이 페이지가 부른 API ----------------------------------------------
  log("--- 4) 상품 데이터를 가져온 API 후보 ---");
  let api = 0;
  try {
    (performance.getEntriesByType("resource") || []).forEach(e => {
      if (!/xmlhttprequest|fetch/i.test(e.initiatorType || "")) return;
      if (/\.(png|jpe?g|webp|gif|css|woff2?|svg)(\?|$)/i.test(e.name)) return;
      if (api++ < 15) log("  " + e.name.slice(0, 190));
    });
  } catch (e) {}
  if (!api) log("  없음 (또는 resource timing이 비어 있음 — 새로고침 후 다시 실행)");
  log("");

  // ---- 결론 -----------------------------------------------------------------
  const total = ldHits + jsonHits + metaHits;
  log("--- 결론 ---");
  log(total
    ? `날짜로 보이는 값 ${total}개를 찾았습니다. 위 출력을 그대로 보내주시면 어느 것이 실제 업로드일인지 확인해 어댑터에 연결하겠습니다.`
    : "이 페이지에는 업로드 일자로 쓸 값이 없습니다. (4)의 API 목록이 있으면 그중 상품 API 응답을 함께 보내주세요.");
  log("");
  log("=== 아래 한 줄을 복사해서 보내셔도 됩니다 ===");
  try {
    await navigator.clipboard.writeText(OUT.join("\n"));
    log("(클립보드에 복사했습니다 — 그대로 붙여넣기 하세요)");
  } catch (e) {
    log("(클립보드 복사 실패 — 위 출력을 직접 복사해 주세요)");
  }
})();
