#!/bin/sh
# Chrome 웹스토어 제출용 ZIP 빌드.
#
# 개발 저장소를 통째로 올리지 않는다: diagnose-*.js 같은 개발 도구와 문서는
# 확장 동작에 필요 없고, 심사자가 읽어야 할 코드만 늘린다(= 심사 지연).
# 여기의 화이트리스트가 곧 "확장이 실제로 싣는 파일"의 정의다 —
# manifest / HTML이 참조하는 파일을 바꾸면 이 목록도 같이 바꿀 것.
#
# 사용:  sh pack.sh   →  dist/market-lens-<버전>.zip
set -e
cd "$(dirname "$0")"

VERSION=$(grep -o '"version": *"[^"]*"' manifest.json | grep -o '[0-9][0-9.]*')
OUT="dist/market-lens-$VERSION.zip"
mkdir -p dist
rm -f "$OUT"

# 런타임 파일 전부 — manifest, 서비스워커(+importScripts), content scripts,
# 패널/카탈로그 페이지와 그 스크립트, 아이콘
zip -q "$OUT" \
  manifest.json \
  background.js store.js clip.js \
  exceljs.min.js excel.js sites.js content.js fab.js md-capture.js \
  sidepanel.html sidepanel.js lists.js \
  catalog.html catalog.js lab.js \
  report/report.js report/reportgen.js report/trend.js \
  icons/icon16.png icons/icon32.png icons/icon48.png icons/icon128.png

echo "built: $OUT"
unzip -l "$OUT" | tail -3
