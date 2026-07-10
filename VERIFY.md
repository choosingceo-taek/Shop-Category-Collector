# VERIFY — one-time live check & maintenance

The shared logic (extraction, dedupe, pagination stop-conditions, classification,
routing, Excel fill, generic export) is unit-tested in Node against Walmart's known
JSON shape. The extraction now has 4 layered fallbacks (see README), so it should
survive most Walmart changes. Still, confirm once on a live page — the sandbox that
built this has no Chrome. All Walmart logic is in **`sites.js`** (the `walmart`
adapter); `content.js` is the site-agnostic engine.

## 0. Load & smoke
`chrome://extensions` → Load unpacked → open a Walmart category page → click the
icon. The popup should show `Walmart · <brand> · 총 Np (현재 1)`. If it says
"지원 사이트가 아닙니다", the URL isn't matched — add its pattern to `manifest.json`.

## 1. Product-list extraction  (sites.js → walmart.scrapeList)
On a category page, DevTools console:
```js
// what the extractor sees, in priority order:
JSON.parse(document.getElementById('__NEXT_DATA__')?.textContent || 'null')      // 1
[...document.querySelectorAll('script[type="application/json"]')].map(s=>s.textContent) // 2
```
Find the product array and confirm the fields `scrapeList` reads: `name`,
`priceInfo.linePrice|currentPrice`, `canonicalUrl`, `imageInfo.thumbnailUrl`,
`usItemId`. The extractor is tolerant (also tries `title`, `productUrl`, `id`,
inline `__PRELOADED_STATE__`, and a DOM fallback), so it usually just works — only
touch it if a live run collects 0 items.

## 2. Fabric composition  (sites.js → walmart.fetchComposition)
Open a product page, parse `__NEXT_DATA__`, find where the spec lives (search for
"Fabric Material" / "Material" / "Composition"). `fetchComposition` deep-searches
for `{name, value}` spec pairs across the whole blob, so new nesting is usually
fine. If Walmart's bot wall blocks the raw fetch, the field is left blank (never
invented) — that's the zero-hallucination rule.

## 3. Pagination  (sites.js → walmart.totalPages / nextPageUrl + engine)
`totalPages` is only a display hint now. The engine keeps advancing `?page=N` until
a page adds **no new items** or a next page doesn't exist, so it collects every page
even if the count is wrong. Confirm Walmart still uses `?page=` (it does on
`/browse` and `/search`); if a shelf uses infinite scroll instead, tell Codex to add
a scroll-and-collect branch to the `list` phase.

## Prompts you can give Codex
- "On live Walmart Time&Tru Tops&Tees, confirm walmart.scrapeList in sites.js reads the right fields; fix if 0 items."
- "fetchComposition misses some products — widen the spec-key list / nesting in sites.js."
- "Add a second adapter to sites.js for <store>: implement match/scrapeList/totalPages/nextPageUrl and register it."

## Rule to keep (zero-hallucination)
Only mark `Verified` when a value is literally on the page. Never let the code
invent price/fabric/color. Interpretation goes only in Material Analysis /
Commercial Opportunity, grounded in the Verified facts.
