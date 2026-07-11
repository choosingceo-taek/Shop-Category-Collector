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
1. In Chrome, open the Walmart search/category page you want
   (e.g. Time and Tru → Leggings), with any filters applied.
2. Click the extension icon → confirm brand / page count.
3. (Optional) keep **"상품 상세까지 수집 — 원단·색상·디자인"** checked to fill
   Fabric Composition / Colorways / Key Design Details from each product page
   (slower).
4. Click **"이 카테고리 전 페이지 수집 → 엑셀"**. Collection always starts from
   page 1 and walks every page to the end (per-search page counts differ; the
   engine stops when the site's reported total is collected).
5. When done, a styled `.xlsx` downloads with a unique name
   (`walmart_<brand>_<category>_<N>items_<time>.xlsx`).

Buttons:
- **⏸ 일시정지 / ▶ 재개** — pause the current run without losing progress, then
  continue where it left off (page-accurate; no skipped or duplicated pages).
- **🗑 새 작업 (현재 작업 삭제)** — discard the current/stale job entirely, e.g.
  when a run went wrong or you switch category. A job is also auto-discarded if
  you open a different search (collection-signature check), so a previous run
  can never leak into a new category's output.

## What it fills
The bundled `template.xlsx` (your 20-column schema, all sheets preserved). Each
value is tagged `Verified` (published), `Visual Observation` (name/image-derived)
or `Needs Review` — the zero-hallucination rule. Out-of-scope items (sweaters,
woven, denim, non-target categories) are auto-dropped.

## Scope (edit in pipeline.js)
Categories: T-shirts · Sweatshirts & Hoodies · Tank Tops · Leggings · Sweatpants.
Cut & Sew knit only. Brands route to their sheet; Wonder Nation / Weekend Academy
split Girls/Boys by department.

## Architecture (site-adapter)
The engine is site-agnostic; per-store knowledge is isolated in **adapters**.

- `content.js` — **generic engine**. Picks `SITES.active(url)` and drives it:
  scrape each page → auto-paginate → (optional) fetch detail → build → download.
  Robust pagination: stops when there's no next page, when a page adds **0 new
  items** (global dedupe by id/url), or at a safety cap (200p) — a changed layout
  can never loop forever. Crash-safe: any error surfaces to the status box.
- `sites.js` — **adapter registry**. The Walmart adapter lives here plus shared,
  hardened extraction helpers (see below). **To add another store, add one adapter
  object** — the engine doesn't change.
- `excel.js` — **styled workbook builder (ExcelJS)**. Produces the clean
  9-column output with **embedded thumbnail images** and readable formatting
  (frozen header, column widths, wrap, row heights, hyperlinked URLs).
- `background.js` — MV3 service worker that fetches thumbnail image bytes with
  the extension's host permissions (a content-script fetch would hit CORS).
- `pipeline.js` — Walmart classification / scope filtering / design-detail
  derivation, plus a generic flat exporter (`fillGeneric`) for future adapters.
- `popup.html` / `popup.js` — the button UI (shows the detected site + page count).
- `exceljs.min.js` — ExcelJS (writes images + styles). `xlsx.full.min.js` —
  SheetJS (still used by the generic fallback path).
- `template.xlsx` — legacy knit-DB template (no longer used for output).

## What it collects
**Every product in the current search/category**, across all pages. It reads the
main results grid only, so the site's recommended / related / sponsored carousels
are excluded. Only exact duplicates are dropped — there is no category/brand
filtering. Pagination continues until the site's reported result count is reached.

## Output columns
Thumbnail (embedded image) · Product URL (hyperlink) · Brand · Category ·
Product Name · Retail Price · Colorways · Fabric Composition · Key Design Details.

Provenance: only words literally on the page are written as values. Inferred
fields (e.g. Key Design Details with no descriptor in the name) show **재확인 필요**;
not-found fields show **정보 확인** — both in **red** so unconfirmed cells stand out.
When a problem caused a miss, the cause is appended, e.g. "정보 확인 (상세 페이지 차단됨)".
Thumbnails embed the real image; if the bytes can't be fetched (or are webp,
which xlsx can't embed) the cell falls back to an `=IMAGE("url")` formula
(renders in Excel 365 / Google Sheets) and keeps the URL as a note.

### Why the scrape is hard to break
`sites.js` extraction tries, in order of reliability:
1. `__NEXT_DATA__` JSON, 2. every `application/json` / `ld+json` script,
3. inline redux/preloaded state (`__WML_REDUX_INITIAL_STATE__`,
`__PRELOADED_STATE__`, …) recovered by brace-balanced slicing,
4. a DOM fallback over product tiles.
It deep-searches **all** of that for product arrays and **merges + dedupes** them
(Walmart splits results across several `itemStacks`), so it keeps working even
when Walmart renames or moves its data blob.

## Adding a new site later
In `sites.js`, add an adapter with `match / context / scrapeList / totalPages /
nextPageUrl / fetchComposition / buildWorkbook`, register it in `ADAPTERS`, and add
the site's URL patterns to `manifest.json` (`content_scripts.matches` +
`host_permissions`). Reuse the shared helpers under `SITES.shared`. A non-Walmart
adapter can set `templateUrl: null` and use `WPB.fillGeneric` for a plain export.

## Limits (honest)
- New rows are written as data; heavy cell styling from the template may not carry
  to new rows (SheetJS community). Data + sheet structure are preserved.
- The Excel "Thumbnail" column holds the image **URL/reference**, not an embedded
  picture (embedding images into cells is a separate feature — say the word).
- Walmart's page structure still needs a **one-time live check** (see VERIFY.md).
  The layered fallbacks make breakage far less likely, but the sandbox that built
  this has no Chrome, so the field names are confirmed against Walmart's known
  JSON shape, not a live capture.
- Keep collection at a human pace (built-in delays) to avoid anti-bot flags. The
  optional detail-fetch step can be blocked by Walmart's bot wall; the code guards
  for that and leaves the field blank rather than inventing a value.
