# Shop Category Collector — 프로젝트 헌장

온라인 쇼핑몰의 카테고리/검색 결과를 수집해 **키워드 중심 비주얼 트렌드 리서치**의
원천 데이터(xlsx)를 만드는 크롬 확장(MV3). 최종 비전: 카테고리 구조를 인식해
카테고리별로 상품을 샘플링하고, 그 데이터로 트렌드 레포트를 생성한다.

**사용자는 스타일 디자이너(비개발자).** 시즌별로 "어느 브랜드가 유명하고, 어떤
제품이 잘 팔리고, 그 제품의 원단이 무엇인지"를 리서치한다. UI 문구·에러 메시지·
문서는 이 사용자가 읽는다는 전제로 쓴다.

## 현재 상태 요약 (v1.7.x)

- 수집: 현재 카테고리/검색의 **전 페이지 자동 순회** (모르면 다음 페이지를 직접
  열어 확인하는 probe 방식 — 감지 실패로 페이지가 누락되지 않음)
- 엔진 라우팅: `sites.js`의 어댑터 레지스트리 `[walmart, target, cottonon, shopify, generic]`
  - walmart: 커스텀 SPA 엔진 (embedded JSON 컨테이너 스코핑 + 상세 fetch)
  - target: 커스텀 SPA (?Nao=24 오프셋 페이지네이션, JSON-LD·불릿 상세, multiBrand)
  - shopify: **플랫폼 감지형** (페이지 내 CDN 마커) — Edikted 등 모든 Shopify 몰
  - cottonon: SFCC(Demandware) — URL 슬러그/cgid + PDP variationAttributes
  - generic: DOM 휴리스틱 + JSON-LD 병합 폴백
- 상세 수집(옵션): 원단 조성(섬유 검증), 색상 전체 목록, 사이즈, 브랜드, 정가
- 출력: 12컬럼 xlsx (썸네일 이미지 임베드, 정가/현재가 세일 빨강, Color Count,
  출처 규칙 — 실측값 검정 / 미확인 "정보 확인" 빨강 + 원인)
- UI: 페이지 좌하단 플로팅 스캔 버튼(FAB) + 팝업(옵션·필터), ⏸/▶/✕, 작업 서명으로
  이전 작업 혼입 차단
- post-scan 필터: 브랜드/주브랜드만/이름 포함·제외 (내보내기 시점 적용)
- 테스트: `scratchpad`의 9개 스위트 139+ 케이스 (Node + jsdom, 브라우저 불필요)

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
  미사용 권한은 발견 즉시 제거. (현재 `permissions: ["storage"]` 뿐)
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
- 배포 방향: 팀 배포는 Chrome 웹스토어 Unlisted 게시(개인 크롬 환경).
