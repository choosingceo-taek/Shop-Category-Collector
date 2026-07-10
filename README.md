# Walmart PB Knit Collector — Chrome Extension

One click on a Walmart brand-category page → auto-collect **all pages** →
(optional) fetch each product's fabric composition → download the knit-DB Excel
**template already filled**. No paid services, runs in your own logged-in Chrome
(so Walmart's anti-bot sees a normal human session).

## Install (담당자, 1회 · 약 5분)
1. Unzip this folder.
2. Open `chrome://extensions`
3. Turn on **개발자 모드 / Developer mode** (top-right).
4. Click **압축해제된 확장 프로그램 로드 / Load unpacked** → select this folder.
5. The toolbar shows the extension icon. Done.

> If Developer mode is greyed out, your company Chrome is managed — ask IT to
> allowlist this extension, or use an unmanaged Chrome profile. (See VERIFY.md.)

## Use (daily)
1. In Chrome, open the Walmart category page you want
   (e.g. Time and Tru → Tops & Tees).
2. Click the extension icon → confirm brand / page count.
3. (Optional) keep **"원단 조성까지 수집"** checked for Verified composition (slower).
4. Click **"이 카테고리 전 페이지 수집 → 엑셀"**.
5. The tab flips through pages automatically; when done, a filled `.xlsx`
   downloads. Open it once in Excel to recalc the Audit Summary.

## What it fills
The bundled `template.xlsx` (your 20-column schema, all sheets preserved). Each
value is tagged `Verified` (published), `Visual Observation` (name/image-derived)
or `Needs Review` — the zero-hallucination rule. Out-of-scope items (sweaters,
woven, denim, non-target categories) are auto-dropped.

## Scope (edit in pipeline.js)
Categories: T-shirts · Sweatshirts & Hoodies · Tank Tops · Leggings · Sweatpants.
Cut & Sew knit only. Brands route to their sheet; Wonder Nation / Weekend Academy
split Girls/Boys by department.

## Files
- `manifest.json` — MV3 config
- `content.js` — scrape + auto-paginate + spec fetch + build/download
- `pipeline.js` — classification / routing / provenance / Excel fill (shared logic)
- `popup.html` / `popup.js` — the button UI
- `xlsx.full.min.js` — SheetJS (Excel writer)
- `template.xlsx` — your workbook template (edit/replace to change output shape)

## Limits (honest)
- New rows are written as data; heavy cell styling from the template may not carry
  to new rows (SheetJS community). Data + sheet structure are preserved.
- If Walmart changes its page structure, the scrape may break → see VERIFY.md
  (Codex can fix selectors in minutes).
- Keep collection at a human pace (built-in delays) to avoid anti-bot flags.
