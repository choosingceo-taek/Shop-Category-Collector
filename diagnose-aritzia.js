/* Aritzia probe — reports how this site actually ships its data so the adapter
   matches reality instead of a guess (charter: 추측으로 셀렉터를 고치지 않는다).

   It answers exactly what the adapter needs to know:
     1) what product links look like (the URL pattern that identifies a product)
     2) whether the grid is virtualized (Massimo Dutti's was — DOM only ever
        holds a fraction, so DOM scraping silently loses most products)
     3) how many products the page claims vs how many are reachable
     4) where the data lives: JSON-LD, an embedded state blob, or an API call
     5) whether the PDP carries the fabric composition

   HOW TO USE
   1. Open an Aritzia category page, e.g.
      https://www.aritzia.com/intl/en/clothing/tops
   2. Scroll to the bottom a few times so the grid loads what it will.
   3. F12 → Console → paste this whole file → Enter.
   4. Copy ALL output back.

   It only reads; it changes nothing and submits nothing. */
(async function () {
  const R = []; const log = (...a) => R.push(a.join(" "));
  const j = (v, n) => { try { return JSON.stringify(v).slice(0, n || 300); } catch (e) { return String(v).slice(0, n || 300); } };
  const uniq = a => [...new Set(a)];

  log("=== ARITZIA PROBE ===");
  log("URL:", location.href);
  log("스크롤 높이:", document.body.scrollHeight, "| 화면:", innerHeight);

  // ---- 1) product links -----------------------------------------------------
  const hrefs = [...document.querySelectorAll("a[href]")].map(a => a.getAttribute("href")).filter(Boolean);
  const abs = h => { try { return new URL(h, location.href).pathname; } catch (e) { return h; } };
  const paths = uniq(hrefs.map(abs));
  // group by path shape so the product pattern stands out from navigation
  const shape = p => p.replace(/\d+/g, "#").replace(/\/[^/]{25,}/g, "/<long>");
  const byShape = {};
  paths.forEach(p => { const s = shape(p); (byShape[s] = byShape[s] || []).push(p); });
  const top = Object.entries(byShape).sort((a, b) => b[1].length - a[1].length).slice(0, 12);
  log("");
  log("--- [1] 링크 패턴 (많은 순) ---");
  top.forEach(([s, list]) => log("  " + String(list.length).padStart(4), s, "  예:", list[0]));

  // which of those look like products (repeat a lot AND sit under a product-ish path)
  const prodLike = paths.filter(p => /\/product\/|\/p\/|-p\d|\/prod/i.test(p));
  log("  product스러운 링크 수:", prodLike.length, "| 예시:", j(prodLike.slice(0, 3)));

  // ---- 2) virtualization check ---------------------------------------------
  log("");
  log("--- [2] 가상화(스크롤 시 DOM에서 사라지는가) 확인 ---");
  const countTiles = () => uniq([...document.querySelectorAll("a[href]")]
    .map(a => abs(a.getAttribute("href")))
    .filter(p => /\/product\/|\/p\/|-p\d|\/prod/i.test(p))).length;
  const atTop = countTiles();
  window.scrollTo(0, 0); await new Promise(r => setTimeout(r, 900));
  const afterTop = countTiles();
  window.scrollTo(0, document.body.scrollHeight); await new Promise(r => setTimeout(r, 1600));
  const afterBottom = countTiles();
  log("  현재:", atTop, "| 맨 위로 이동 후:", afterTop, "| 맨 아래로 이동 후:", afterBottom);
  log("  →", (afterTop < atTop || afterBottom < atTop)
    ? "가상화 의심 (스크롤에 따라 DOM 상품 수가 줄어듦 — API 캡처 방식 필요)"
    : "가상화 아님으로 보임 (DOM 스크랩 가능)");

  // ---- 3) claimed total ----------------------------------------------------
  log("");
  log("--- [3] 페이지가 밝힌 상품 총 개수 ---");
  const bodyTxt = (document.body.innerText || "").slice(0, 20000);
  const counts = uniq((bodyTxt.match(/(\d[\d,]{1,6})\s*(?:items?|products?|results?|스타일|개)/gi) || []).slice(0, 6));
  log("  텍스트에서:", j(counts));
  const h1 = document.querySelector("h1");
  log("  H1:", j(h1 && h1.textContent.trim(), 120));

  // ---- 4) where the data lives ---------------------------------------------
  log("");
  log("--- [4] 데이터 위치 ---");
  const lds = [...document.querySelectorAll('script[type="application/ld+json"]')];
  log("  JSON-LD 블록:", lds.length);
  lds.slice(0, 4).forEach((s, i) => {
    let d; try { d = JSON.parse(s.textContent); } catch (e) { return log("    [" + i + "] 파싱 실패"); }
    const types = [].concat(d && d["@graph"] ? d["@graph"] : d).map(n => n && n["@type"]).filter(Boolean);
    log("    [" + i + "] @type:", j(types, 160));
  });
  // embedded state blobs (__NEXT_DATA__, __PRELOADED_STATE__, window.digitalData…)
  const globals = Object.keys(window).filter(k => /^__|state|initial|preload|digital|dataLayer/i.test(k)).slice(0, 25);
  log("  전역 상태 후보:", j(globals, 400));
  ["__NEXT_DATA__", "__PRELOADED_STATE__", "__INITIAL_STATE__", "__APOLLO_STATE__"].forEach(k => {
    if (window[k]) log("    window." + k + " 존재 — 크기:", JSON.stringify(window[k]).length);
  });
  const inlineJson = [...document.querySelectorAll("script:not([src])")]
    .map(s => s.textContent || "").filter(t => t.length > 3000 && /"price"|"productId"|"sku"/i.test(t));
  log("  상품 정보가 든 인라인 스크립트:", inlineJson.length, inlineJson.length ? "(첫 300자: " + j(inlineJson[0].slice(0, 300)) + ")" : "");

  // ---- 5) network: does the grid come from an API? -------------------------
  log("");
  log("--- [5] 네트워크 (API로 상품을 받는가) ---");
  let res = [];
  try { res = (performance.getEntriesByType("resource") || []).map(e => e.name); } catch (e) {}
  const apiish = res.filter(u => /\/api\/|graphql|search|product|catalog|plp|\.json/i.test(u) && !/\.(png|jpe?g|webp|svg|gif|css|woff2?)/i.test(u));
  log("  API 같은 요청:", apiish.length);
  uniq(apiish).slice(0, 12).forEach(u => log("    " + u.slice(0, 190)));

  // ---- 6) PDP: is the composition there? -----------------------------------
  log("");
  log("--- [6] 상품 상세에 원단 조성이 있는가 ---");
  const FIB = /\d{1,3}\s?%\s?(cotton|polyester|viscose|rayon|elastane|spandex|nylon|wool|linen|modal|lyocell|silk|cashmere|acrylic|polyamide)/i;
  if (FIB.test(bodyTxt)) {
    log("  현재 페이지에 섬유% 있음:", j((bodyTxt.match(new RegExp(FIB.source, "gi")) || []).slice(0, 5)));
  } else {
    log("  현재 페이지(목록)엔 섬유% 없음 — 정상. 상품 상세를 확인합니다.");
    const first = prodLike[0];
    if (first) {
      try {
        const html = await (await fetch(new URL(first, location.href).toString(), { credentials: "include" })).text();
        log("  상세 fetch:", first, "| 길이:", html.length);
        const m = html.match(new RegExp(FIB.source, "gi"));
        log("  상세 HTML에 섬유%:", m ? j(uniq(m).slice(0, 6)) : "없음 → JS 렌더링이거나 API에만 있음(Massimo Dutti와 같은 상황)");
        const ld = html.match(/application\/ld\+json[^>]*>([\s\S]{0,4000}?)<\/script>/i);
        log("  상세 JSON-LD:", ld ? j(ld[1].slice(0, 260)) : "없음");
      } catch (e) { log("  상세 fetch 실패:", e.message); }
    } else log("  상품 링크를 못 찾아 상세 확인 불가");
  }

  log("");
  log("=== END (전체 복사해서 붙여주세요) ===");
  const text = R.join("\n");
  console.log(text);
  try { copy(text); console.log("(클립보드에 복사됨)"); } catch (e) {}
  return text;
})();
