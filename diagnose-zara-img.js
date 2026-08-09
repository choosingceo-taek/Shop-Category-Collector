/* Zara 썸네일 진단 — 회색 카드의 원인을 특정한다.

   카드가 "NO IMAGE"가 아니라 회색이면 저장된 URL은 있는데 이미지 로드가
   실패하는 것이다. 원인은 둘 중 하나:
     A. 목록에서 뽑은 URL이 애초에 잘못됨 (진짜처럼 생긴 빈/죽은 이미지)
     B. URL은 맞는데 확장 화면에서의 요청을 CDN이 거부함
   이 스크립트가 둘을 가른다.

   사용법
     ① ZARA 카테고리 페이지를 열고 그리드를 몇 화면 스크롤한다
     ② F12 → Console → 이 파일 전체 붙여넣기 → Enter
     ③ 몇 초 뒤 출력 전체를 복사해 보내기 (클립보드에 자동 복사됨)

   추가로 LAB 화면(catalog.html)에서도 F12 → Console에 아래 한 줄:
     CatalogStore.allProducts().then(r=>console.log(JSON.stringify(r.filter(x=>/zara/i.test(x.brand)).slice(0,6).map(x=>x.image_url))))
   → 그 출력도 함께 보내주면, "저장된 값"과 "페이지에 있는 값"을 비교할 수 있다. */
(async () => {
  const OUT = [];
  const log = (...a) => { OUT.push(a.join(" ")); console.log(...a); };
  const cut = (s, n) => { s = String(s || ""); return s.length > n ? s.slice(0, n) + "…" : s; };

  log("=== ZARA 썸네일 진단 ===");
  log("URL:", location.href);
  log("");

  // 상품 타일: -p<코드>.html 링크가 기준 (확장과 같은 규칙)
  const anchors = [...document.querySelectorAll('a[href*="-p"]')]
    .filter(a => /-p\d{5,}\.html/i.test(a.getAttribute("href") || ""));
  log(`상품 링크 ${anchors.length}개 발견`);
  const seen = new Set();
  const tiles = [];
  for (const a of anchors) {
    const code = ((a.getAttribute("href") || "").match(/-p(\d{5,})\.html/i) || [])[1];
    if (!code || seen.has(code)) continue;
    seen.add(code);
    tiles.push(a);
    if (tiles.length >= 8) break;
  }

  // 확장의 bestImage와 같은 선택 로직 (요약판)
  const PLACEHOLDER = /^data:|(?:^|\/)(?:blank|placeholder|spacer|transparent|1x1|pixel)\.(?:gif|png|svg)(?:[?#]|$)/i;
  const widest = ss => {
    let best = "", w0 = -1;
    String(ss || "").replace(/data:\S*/gi, " ").split(",").forEach(part => {
      const bits = part.trim().split(/\s+/);
      const url = bits[0]; if (!url || PLACEHOLDER.test(url)) return;
      const d = bits[1] || "";
      const w = /(\d+)w$/.test(d) ? parseInt(d, 10) : /(\d+(?:\.\d+)?)x$/.test(d) ? parseFloat(d) * 1000 : 0;
      if (w > w0) { w0 = w; best = url; }
    });
    return best;
  };

  const picks = [];
  tiles.forEach((a, n) => {
    log(`--- 타일 ${n + 1}: ${cut(a.getAttribute("href"), 70)}`);
    const imgs = a.querySelectorAll("img");
    log(`  img ${imgs.length}개, source ${a.querySelectorAll("source").length}개`);
    imgs.forEach((img, i) => {
      log(`  img[${i}] src=${cut(img.getAttribute("src"), 90) || "(없음)"}`);
      const ss = img.getAttribute("srcset");
      if (ss) log(`         srcset=${cut(ss, 130)}`);
      [...img.attributes].forEach(at => {
        if (/^data-/.test(at.name)) log(`         ${at.name}=${cut(at.value, 90)}`);
      });
      if (img.currentSrc) log(`         currentSrc=${cut(img.currentSrc, 90)}`);
    });
    a.querySelectorAll("source").forEach((s, i) =>
      log(`  source[${i}] srcset=${cut(s.getAttribute("srcset") || s.getAttribute("data-srcset"), 130)}`));

    // 확장이 골랐을 URL
    const cands = [];
    const img = a.querySelector("img");
    if (img) {
      cands.push(widest(img.getAttribute("srcset")));
      cands.push(widest(img.getAttribute("data-srcset")));
      ["src", "data-src", "data-lazy-src", "data-original", "data-image"].forEach(k => cands.push(img.getAttribute(k) || ""));
      cands.push(img.currentSrc || "");
    }
    a.querySelectorAll("picture source, source").forEach(s =>
      cands.push(widest(s.getAttribute("srcset") || s.getAttribute("data-srcset"))));
    const pick = cands.find(c => c && !PLACEHOLDER.test(c) && /^https?:/i.test(c)) || "";
    log(`  >> 확장 선택: ${pick ? cut(pick, 110) : "(없음 — 이게 원인 A)"}`);
    if (pick) picks.push(pick);
    log("");
  });

  // 고른 URL이 실제로 뜨는 이미지인지 (이 페이지 안에서) 확인
  log("--- 선택 URL 로드 테스트 (페이지 컨텍스트) ---");
  await Promise.all(picks.slice(0, 5).map(u => new Promise(res => {
    const im = new Image();
    const done = msg => { log(`  ${msg}  ${cut(u, 90)}`); res(); };
    const t = setTimeout(() => done("TIMEOUT"), 8000);
    im.onload = () => { clearTimeout(t); done(`OK ${im.naturalWidth}x${im.naturalHeight}${im.naturalWidth < 10 ? " (사실상 빈 이미지!)" : ""}`); };
    im.onerror = () => { clearTimeout(t); done("FAIL(로드 실패)"); };
    im.src = u;
  })));
  log("");
  log("결론 읽는 법: '확장 선택'이 비어 있으면 A(추출 실패), URL이 있는데");
  log("FAIL/빈 이미지면 그 URL이 문제, OK인데 LAB에서만 안 보이면 B(CDN 거부)다.");

  try { await navigator.clipboard.writeText(OUT.join("\n")); log("(클립보드에 복사됨)"); }
  catch (e) { log("(복사 실패 — 출력을 직접 복사해 주세요)"); }
})();
