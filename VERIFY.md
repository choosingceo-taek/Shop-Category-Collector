# VERIFY — finish & maintain with Codex/ChatGPT

The logic (classification, routing, Excel fill) is tested. Two browser-side hooks
must be confirmed once on a live Walmart page, because the sandbox that built this
has no Chrome. Ask Codex to help with each.

## 1. Product-list extraction  (content.js → scrapeList / findItems)
On a category page, open DevTools console and run:
```js
JSON.parse(document.getElementById('__NEXT_DATA__').textContent)
```
Find the array of products and confirm the field names used in `scrapeList`
(`name`, `priceInfo.linePrice`, `canonicalUrl`, `imageInfo.thumbnailUrl`, `usItemId`).
If Walmart uses different keys, update `scrapeList()`. A DOM fallback exists but the
`__NEXT_DATA__` path is more reliable.

## 2. Fabric composition  (content.js → fetchComposition)
Open a product page, run the same `__NEXT_DATA__` parse, and find where the spec
lives (look for "Fabric Material" / "Material"). Update the regex/path in
`fetchComposition()` if needed.

## 3. Pagination count  (content.js → totalPages)
Confirm `maxPage`/`numberOfPages` exists in `__NEXT_DATA__`; else the DOM fallback
reads numbered pagination links. Adjust if the site markup differs.

## Prompts you can give Codex
- "Open Walmart Time&Tru Tops&Tees, read __NEXT_DATA__, and fix scrapeList field paths in content.js."
- "The composition regex misses some products — make fetchComposition parse the specifications array instead."
- "Add Sweatpants keyword synonyms to CATEGORY_RULES in pipeline.js."

## Rule to keep (zero-hallucination)
Only mark `Verified` when a value is literally on the page. Never let the code
invent price/fabric/color. Interpretation goes only in Material Analysis /
Commercial Opportunity, grounded in the Verified facts.
