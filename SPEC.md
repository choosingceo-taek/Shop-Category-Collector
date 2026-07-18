# SPEC — 로드맵 & 미구현 항목

프로젝트 비전·원칙은 `CLAUDE.md` 참조. 이 문서는 **아직 안 된 것과 그 순서**만
다룬다. 최종 비전: *카테고리 구조 인식 → 카테고리별 샘플링 → 비주얼 트렌드 레포트*.

## 현재까지 된 것 (요약)

- 어댑터 레지스트리 `[walmart, cottonon, shopify, generic]`, 플랫폼 감지형(shopify)
- 전 페이지 자동 순회(probe 방식), 상세 수집(원단·색상·사이즈·브랜드·정가)
- 12컬럼 xlsx(썸네일 임베드 + 출처 규칙), post-scan 필터, FAB + 팝업 UI
- Node+jsdom 9개 스위트 139+ 케이스

## Phase 1 — 플랫폼 엔진 일반화 (다음 우선순위)

지금은 어댑터가 사이트별로 나뉘어 있다. 원칙("사이트가 아니라 플랫폼")에 맞춰
**플랫폼 엔진**으로 수렴시킨다.

- [ ] **SFCC 엔진**: `cottonon` 어댑터를 SFCC(Demandware) 범용 엔진으로 승격.
      감지 마커: `dwvar_`/`cgid=` URL, `demandware`/`dwstatic` 자산 경로.
      → 다른 SFCC 몰(수많은 패션 리테일러)이 코드 없이 라우팅됨.
- [ ] **엔진 = {shopify, sfcc, custom-spa(walmart류), generic}** 로 재정리.
      `sites.js`를 adapter→engine 2계층으로. walmart는 custom-spa 엔진의 config.
- [ ] Target 추가 검토(커스텀 SPA, Walmart와 유사). 실제 페이지 진단 필요.

## Phase 2 — 카테고리 taxonomy 인식

- [ ] 페이지의 네비게이션/브레드크럼/사이드바에서 **카테고리 트리 추출**
      (JSON-LD BreadcrumbList, `nav[aria-label]`, SFCC `cgid` 계층).
- [ ] 추출한 트리를 팝업에 보여주고 **사용자가 정리**(포함/제외/이름수정).
      원칙: 자동 감지는 출발점, 사용자가 확정.

## Phase 3 — 카테고리별 샘플링 (트렌드 왜곡 방지)

- [ ] 여러 카테고리를 큐에 넣고 **카테고리당 N개 샘플링**(상위 N / 균등).
      pre-scan 단계에선 범위 필터만(카테고리·깊이·정렬), 속성 필터는 post-scan.
- [ ] 인기 신호 컬럼: **Rank(정렬 순서), Rating, Reviews, Best-seller 뱃지**.
      "잘 팔리는 제품 → 그 원단" 리서치 흐름 완성. (사이트 노출분만, zero-halluc.)

## Phase 4 — 스캔 프로필 저장/재사용

- [ ] per-site **스캔 프로필**(카테고리 목록·샘플 수·필터·상세수집 여부)을
      `chrome.storage`에 저장 → 시즌마다 재사용. 프로필 UI(선택/편집/삭제).

## Phase 5 — 비주얼 레포트 렌더러

- [ ] 수집 데이터로 **정량 레포트를 순수 계산으로** 생성(색 분포·가격대·원단
      비중·브랜드 점유·키워드 빈도). 차트는 확장 내 렌더(LLM 없이).
- [ ] 서술형 해석은 xlsx를 Claude에 핸드오프하는 별도 레이어(확장 안엔 LLM 없음).

## 상시 백로그

- [ ] 무한 스크롤 사이트 대응(스크롤-수집 모드). 현재는 `?page=N` 우선.
- [ ] optional_permissions로 사이트 추가 시 재심사 없이 권한 요청.
- [ ] 스토어 제출용 클린 패키지 스크립트(테스트/진단 파일 제외).

## 유지보수 메모

- 라이브 사이트 접근이 막힌 개발 환경 → 실제 구조는 사용자가
  `diagnose-console.js`/`diagnose-generic.js` 콘솔 출력으로 확인해 어댑터를 맞춘다.
- 모든 변경은 `scratchpad/*.js` Node 스위트로 회귀 확인 후 커밋.
