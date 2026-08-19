# tests

The regression suite. It lives **in the repository** — it used to live in a
scratch directory outside it, and on 2026-08-18 that directory was cleared
between sessions and roughly 150 suites went with it. Code that is worth
keeping is code that is committed.

`pack.sh` builds the store ZIP from a whitelist, so nothing here is ever
shipped to a browser.

## Running

Playwright drives a real Chrome with the extension loaded. Headless cannot
load extensions, so the display comes from xvfb, and Playwright is installed
globally in this environment:

```sh
cd tests
NODE_PATH=/opt/node22/lib/node_modules xvfb-run -a node updnote-e2e.js
```

Pure-Node suites need neither:

```sh
node tests/encoding-test.js
```

## What is here

| file | what it holds to |
| --- | --- |
| `run-all.sh` | every contract below, in one command — `sh tests/run-all.sh` |
| `goal-e2e.js` | the goal sentence: three differently-shaped shops → one Scan all → every row with brand, name, photo and composition → clean health → LAB → dashboard |
| `edge-e2e.js` | the extension still opens on a Chromium browser with no side-panel API (Edge): the toolbar button falls back to a tab |
| `price-test.js` | money as the shops write it, including the comma decimal that read "120,00 €" as 12000 |
| `naming-test.js` | what a page is filed as: a house brand on its parent's domain is not the parent (Athleta ≠ GAP), and a category is a noun phrase, never an interstitial's question |
| `tabs-e2e.js` | the panel's furniture, measured on screen: the ＋ never prints under a tab, no Filter sites box, PRODUCTS keeps its search and selects pinned, the grab button carries no count |
| `matrix-probe.js` | 83 generated shop shapes; the reader's output checked against what the page actually says (explorer and contract in one file) |
| `athleta-e2e.js` | Athleta's shape: a grid that renders in waves and recycles its tiles, and product pages that state the blend under Fabric & care — one rendered, one a shell with it only in the page source |
| `varley-e2e.js` | a grid that previews its colourways: the swatch is not the garment and not its name, and the fifteen behind the Load more button still come back — in the shop's order |
| `gymgrid-e2e.js` | a collection grid that grows on scroll with no button: all fifty-one come back in the page's order, and the star rating in the title block is not part of the name |
| `unfile-e2e.js` | taking an address out of a list takes out what it collected — except a garment another saved address still collects — and says the number before it does |
| `gymshark-e2e.js` | where Gymshark states the blend — MATERIALS & CARE in a tab panel the bulk JSON does not carry, with marketing prose above it and care text glued to it |
| `weekbucket-e2e.js` | a week is Monday to Sunday and is named 2026-W34: three sittings land in one pile, one brand gets one heading, and a second pass duplicates nothing |
| `rail-e2e.js` | three tabs, not five; the backup door and the site grades at the foot of the LAB; and a filter rail drawn like a shop's own — brand, category, fabric, colour, no counts, no box |
| `siteorder-e2e.js` | the shop's own order kept from the page to the wall, the feeds and the workbook — and no price table on the LAB |
| `shelf-test.js` | the two closed vocabularies the analysis counts on: twelve colours and fifteen fibres, what folds into each, and what is deliberately left off |
| `shelf-e2e.js` | the same on screen — the COLOUR axis names colours not sales names, the fibre blocks name one fibre once, and the rail draws twelve swatches that really narrow the feed |
| `fibreblocks-e2e.js` | the fibre read of the window on the LAB — watch list, ranking, volume, share lines and the rising/falling pair — over eight weeks that actually move |
| `rescan-e2e.js` | scanning the same page again: nothing wiped, first-seen kept, today's price wins, and the product pages are not opened a second time (8 requests → 0) |
| `shortgrid-e2e.js` | a grid that hands over 4 of 14 and says nothing about it, and one with a View More and no count — the two shapes that graded a half scan as complete |
| `assetfetch-e2e.js` | the download through the redirect GitHub really serves — nothing routed, so host_permissions apply at every hop the way they do for a teammate |
| `labtools-e2e.js` | the file is built from the LAB (HTML button at the end of its bar), the take-away controls are off the product wall, and the rail lists values without counts |
| `dashboard-e2e.js` | the exported HTML is the dashboard, is self-contained, and its figures agree with each other |
| `encoding-test.js` | no shipped file carries a Unicode noncharacter (Chrome refuses the whole manifest over one), the ship list is real, the manifest parses |
| `updnote-e2e.js` | a new version reaches the person: one owner for the toolbar badge, the repo asked on a timer, an optional notification said once per version |
| `menuimport-e2e.js` | Import lives on the list's right-click menu and really opens a file picker, landing rows in the list the menu was opened on |
| `panelshot.js` | draws the panel (Collector and Products) to `shot-panel-*.png` — for looking, not asserting |
| `panelgeo.js` | prints the geometry of the panel's controls |
| `install-probe.js` | takes the PUBLISHED release asset, unzips it and loads it — the file a teammate actually downloads, not the repo |
| `updnote-probe.js` | prints what the browser currently says about a new version |

## Rebuilding what was lost

The suites named throughout `CLAUDE.md` — `panelui-e2e`, `compact-e2e`,
`health-test`, `label-test`, `shapes-e2e`, `goal-e2e` and the rest — are gone.
Each is worth rebuilding at the moment its area is next touched, against the
contract described in the charter entry that introduced it, rather than all at
once from memory: a test rebuilt without re-deriving what it was guarding
passes without guarding anything.

## The rule that made these worth writing

A new test must **fail on the code before the fix**. Check it:

```sh
git stash -q && (cd tests && NODE_PATH=/opt/node22/lib/node_modules xvfb-run -a node <file>) ; git stash pop
```

Run `git stash pop` from the repository root, not from `tests/`.
