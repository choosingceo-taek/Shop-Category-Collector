# Market Lens — 프로젝트 헌장

온라인 쇼핑몰의 카테고리/검색 결과를 수집해 **키워드 중심 비주얼 트렌드 리서치**의
원천 데이터(xlsx)를 만드는 크롬 확장(MV3). 최종 비전: 카테고리 구조를 인식해
카테고리별로 상품을 샘플링하고, 그 데이터로 트렌드 레포트를 생성한다.

**사용자는 스타일 디자이너(비개발자).** 시즌별로 "어느 브랜드가 유명하고, 어떤
제품이 잘 팔리고, 그 제품의 원단이 무엇인지"를 리서치한다. UI 문구·에러 메시지·
문서는 이 사용자가 읽는다는 전제로 쓴다.

## 제품 목표 — 무엇을 성공으로 볼 것인가

**디자인팀 구성원 전원이 각자 크롬에서 이 도구를 켜고 계속 쓰는 것.** 기능 수가
아니라 채택과 유지가 목표다. 그래서 우선순위는 이 순서로 판단한다:

1. **정확도가 채택의 조건이다.** 쓰는 사람이 여럿이므로 숫자가 한 번 틀리면
   신뢰가 팀 전체에서 무너지고 다시 열지 않는다. 새 기능보다 기존 수집의
   정확도 검증이 항상 앞선다.
2. **설명 없이 시작돼야 한다.** 팀원마다 붙어서 알려줄 수 없다. 아이콘을 누르면
   사이드 패널이 페이지를 읽고 "여기선 이걸 하면 된다"를 먼저 말해준다.
   (그래서 패널은 부가 UI가 아니라 온보딩의 핵심이다.)
3. **사이트 커버리지는 현재 범위로 충분하다.** 팀이 보는 몰이 대체로 지원된다고
   확인됨(2026-08). 새 어댑터 추가보다 정확도·사용성이 우선.
4. **업데이트가 쉬워야 계속 쓴다.** ZIP 덮어쓰기→리로드→F5는 비개발자에게 매번
   실패 지점이다. 팀 배포는 웹스토어 Unlisted로 가서 자동 업데이트를 받는다.

## 현재 상태 요약 (v1.7.x)

- 수집: **현재 페이지만** (기본값). 카테고리 전체를 훑으면 리서치 한 번에 쓸 수
  없는 양이 나오고, 목적은 "고른 카테고리들의 리스트"이지 전수 덤프가 아니다.
  무한 스크롤 그리드는 스크롤로 다 펼쳐지는 그 한 페이지가 대상.
  전 페이지 순회 코드는 남아 있고 `singlePage:false`로 켤 수 있다.
- 엔진 라우팅: `sites.js`의 어댑터 레지스트리 `[walmart, target, cottonon, zara, aritzia, cos, massimodutti, shopify, generic]`
  - walmart: 커스텀 SPA 엔진 (embedded JSON 컨테이너 스코핑 + 상세 fetch)
  - target: 커스텀 SPA (?Nao=24 오프셋 페이지네이션, JSON-LD·불릿 상세, multiBrand)
  - shopify: **플랫폼 감지형** (페이지 내 CDN 마커) — Edikted 등 모든 Shopify 몰
  - cottonon: SFCC(Demandware) — URL 슬러그/cgid + PDP variationAttributes.
    PDP 할인가(정가/세일가) 추출 → Current Price 반영
  - zara: 단일 브랜드 SPA (무한 스크롤 lazy-scroll 60라운드, -p코드.html 상품, JSON-LD 상세)
  - cos / massimodutti: **house-brand 팩토리**(`houseBrandAdapter`) — zara 모델 일반화.
    단일 브랜드 + 무한 스크롤 그리드, 카테고리=URL 슬러그(JSON-LD 브레드크럼 우선).
    사이트별 CSS 셀렉터 하드코딩 없음. 이미지 CDN/상품 URL 패턴은 사용자 진단
    (diagnose-generic.js) 출력으로 보정
    - cos 상세=JSON-LD + 섬유% 텍스트(기본 PDP fetch)
    - massimodutti 상세=**Inditex 카탈로그 API**(`itxrest/…/productsArray`, brandId 3).
      PDP HTML엔 조성이 없음 — API의 `bundleProductSummaries[].detail`에서 조성·색상·
      사이즈·세일가를 구조화 JSON으로 직접 수집. store/catalog는 페이지에서 발견
      (하드코딩 아님). list 스크랩은 DOM 그대로, 상세만 API로 교체. `inditex` 헬퍼
  - generic: DOM 휴리스틱 + JSON-LD 병합 폴백
- 상세 수집(옵션): 원단 조성(섬유 검증), 색상 전체 목록, 사이즈, 브랜드, 정가
- 출력: **7컬럼 xlsx** — 브랜드 · 카테고리 · 상품명 · 썸네일 · URL · 원단 · 혼용률.
  원단(섬유명)과 혼용률(비율)은 별도 컬럼. 혼용률은 페이지 텍스트를 잘라 오는 게
  아니라 실제 발견된 `숫자% 섬유` 쌍으로 **재구성**한다(JSON-LD 안에 조성을 넣는
  Zara류에서 마크업이 새는 것을 원천 차단). 출처 규칙 — 실측값 검정 /
  미확인 "정보 확인" 빨강 + 원인
- UI: **사이드 패널**(툴바 아이콘 = 리서치 컴패니언) + 페이지 좌하단 FAB.
  패널은 탭이 바뀔 때마다 페이지를 읽어 상황을 말하고 **맞는 행동 하나를 제안**한다
  (지원 쇼핑몰=전체 스캔 / 그 외=상품 담기 / 미허용 사이트=권한 요청). 스캔 중에는
  진행 상황을 그대로 중계. ⏸/▶/✕, 작업 서명으로 이전 작업 혼입 차단
- 컬렉션(clip): 브라우징 중 발견한 상품/이미지를 패널 컬렉션에 담아 JSON으로 내보냄.
  `clip.js`는 어느 사이트에서나 동작하는 단일 상품 추출기(JSON-LD→OG→DOM 순).
  **트렌드 통계에는 섞지 않는다** — 손으로 담은 표본은 편향되므로 inspo·참고용.
  우클릭 담기는 activeTab만 사용(사전 권한 0), 패널 버튼은 클릭 시점에 해당
  오리진만 요청(`optional_host_permissions`)
- post-scan 필터: 브랜드/주브랜드만/이름 포함·제외 (내보내기 시점 적용)
- 테스트: `scratchpad`의 Node 스위트 + Playwright로 실제 Chrome에 확장을 로드해
  패널·카탈로그·스캔 흐름을 검증(xvfb 필요, headless는 확장 로드 불가)

로드맵과 미구현 항목은 `SPEC.md` 참조.

## 아키텍처 원칙 (ALWAYS / NEVER)

- **NEVER 사이트별 CSS 셀렉터 하드코딩.** Walmart·Target류는 클래스명이 해시라
  금방 깨진다. 추출은 항상 `구조화 데이터(embedded JSON / JSON-LD) → DOM 휴리스틱
  → config 힌트` 순서의 다단 폴백. DOM 셀렉터는 최후의 폴백으로만, 시맨틱한
  속성(`data-*`, aria, href 패턴) 위주로.
- **ALWAYS 사이트가 아니라 "플랫폼 타입"을 타겟한다.** 엔진 = Shopify / SFCC /
  커스텀 SPA. 새 사이트 지원 = 플랫폼 감지 → 기존 엔진 라우팅이 우선이고,
  전용 어댑터는 그게 안 될 때의 선택지다. (cottonon 어댑터는 SFCC 엔진으로
  일반화할 것 — SPEC Phase 1)
- **NEVER 트렌드 왜곡.** 스캔 전(pre-scan)엔 범위 필터만(카테고리·깊이·정렬).
  가격·색·소재·브랜드 같은 속성 필터는 스캔 후(post-scan) 내보내기/분석 단계에서만.
  분포를 보존해야 트렌드가 보인다. (현재 팝업 필터는 내보내기 시점 적용 = 준수)
- **ALWAYS 권한 최소.** `permissions`/`host_permissions` 추가는 스토어 심사를
  느리게 하므로, 추가 시 반드시 사유와 심사 영향을 커밋 메시지에 명시.
  미사용 권한은 발견 즉시 제거. (현재 `permissions: ["storage","downloads","sidePanel","contextMenus","scripting","activeTab"]` — downloads는 일부 리테일러(Target)가 앵커
  다운로드를 막아 SW 경유 저장에 필요. 호스트 접근은 기본 0: 우클릭 담기는 activeTab,
  패널 버튼은 클릭 시점에 해당 오리진만 `optional_host_permissions`로 요청)
- **정량 레포트는 LLM 크레딧 없이 순수 계산으로.** 서술형 해석은 선택 레이어이며
  확장 안에 LLM을 넣지 않는다. xlsx를 Claude에 핸드오프하는 방식으로.
- **자동 감지는 "출발점"이지 "정답"이 아니다.** 카테고리 자동 감지 → 사용자가
  정리 → 프로필 저장(chrome.storage) → 재사용.
- **zero-hallucination 출력 규칙.** 셀 값은 사이트에 실제로 있는 텍스트만.
  추론 필요 → 빨간 "재확인 필요", 못 찾음 → 빨간 "정보 확인"(+원인).
  `excel.js`가 강제한다. 새 필드를 추가할 때도 이 규칙을 따른다.

## 작업 관행

- 모든 변경은 Node 테스트(`scratchpad/*.js` 스위트)로 회귀 확인 후 커밋.
  라이브 사이트 접근이 차단된 환경이므로, 실제 페이지 구조는 사용자가
  `diagnose-console.js`(Walmart) / `diagnose-generic.js`(기타)를 콘솔에 붙여넣은
  출력으로 확인해서 어댑터를 맞춘다 — 추측으로 셀렉터를 고치지 않는다.
- 사용자가 코드 업데이트를 받는 절차: ZIP 덮어쓰기 → 확장 ↻ 리로드 → 대상 탭 F5.
  이 순서를 어기면 "Extension context invalidated"가 난다. 안내 시 항상 명시.
- **커밋·푸시할 때마다 ZIP 다운로드 링크를 함께 안내한다** (사용자 요청).
  `https://github.com/choosingceo-taek/Shop-Category-Collector/archive/refs/heads/claude/main-session-cudnkx.zip`
  압축을 풀면 폴더가 한 겹 더 생기므로 `manifest.json`이 직접 든 안쪽 폴더를 로드해야 한다.
  버전 번호도 같이 알려 리로드 반영 여부를 사용자가 확인할 수 있게 한다.
- 배포 방향: 팀 배포는 Chrome 웹스토어 Unlisted 게시(개인 크롬 환경).
