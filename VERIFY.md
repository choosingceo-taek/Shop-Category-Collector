# VERIFY — 유지보수 가이드

로직(추출 스코핑, 페이지네이션, 중복 제거, 상세 추출, 엑셀 생성, 출처 규칙)은
Node에서 22개 케이스로 회귀 테스트되어 있습니다. 남는 리스크는 하나:
**월마트가 페이지 구조를 바꾸는 경우**입니다.

## 수집이 깨졌을 때 (0개 수집, 개수 불일치 등)

1. 문제가 나는 월마트 페이지에서 **F12 → Console**
2. `diagnose-console.js` 파일 내용 전체를 붙여넣고 Enter
3. 출력 전체(자동으로 클립보드에 복사됨)를 개발자/Claude에게 전달

출력에는 실제 데이터 blob 개수, 상품 배열 위치, 샘플 필드 값, 페이지네이션
정보가 담겨 있어 **추측 없이** `sites.js`의 월마트 어댑터를 수정할 수 있습니다.

## 어디를 고치나

전부 `sites.js`의 walmart 어댑터 안입니다. `content.js`(엔진)은 건드릴 일 없음.

| 증상 | 함수 |
|---|---|
| 목록 0개 / 개수 불일치 | `mainContainer` / `stacksItems` / `scrapeList` |
| 페이지를 안 넘어감 / 너무 넘어감 | `totalPages` / `resultCount` / `nextPageUrl` |
| 원단 조성 누락 | `findComposition` (스펙 쌍 + "Material: ..." 불릿 + FIBER 검증) |
| 색상 누락 | `extractColorways` (variantCriteria/variantList) |
| 디자인 특징 누락 | `collectSpecs` + `pickDesign` (DESIGN_LABELS 목록) |

## 지켜야 할 규칙 (zero-hallucination)

값은 **페이지에 실제로 있는 텍스트만** 기입합니다. 코드가 가격·원단·색상을
만들어내면 안 됩니다. 추론이 필요하면 "재확인 필요", 못 찾으면 "정보 확인"
(+원인)으로 빨갛게 표시하는 것이 계약입니다 — `excel.js`가 강제합니다.

## 새 사이트 추가

`sites.js`에 어댑터 객체를 하나 추가하고 `ADAPTERS`에 등록한 뒤,
`manifest.json`의 `content_scripts.matches` + `host_permissions`에 URL 패턴을
추가하면 끝입니다. `SITES.shared`의 공용 헬퍼(JSON 전수 스캔, 인라인 state
복구, 상품 배열 탐색)를 재사용하세요. 무한 스크롤 사이트는 엔진에 스크롤
모드 추가가 필요합니다(1회 작업, 이후 재사용).
