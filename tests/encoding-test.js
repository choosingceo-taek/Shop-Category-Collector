/* What must never be inside a file this extension ships.

   Two things, both of which stop the extension reaching anybody, and neither
   of which shows up when the code runs:

     · a Unicode noncharacter, which Chrome rejects outright
     · a line that reads like a script downloader, which an antivirus flags —
       and a virus scanner reads characters, not intent, so a COMMENT counts

   Unicode noncharacters in a source file brick the whole extension.

   U+FFFF, U+FFFE and U+FDD0–U+FDEF are tempting as sort sentinels ("always
   last"), and nothing in Node complains about them. Chrome does: it rejects
   the file as "isn't UTF-8 encoded", and the manifest fails to load — the
   extension does not install at all. So this walks every file the extension
   actually ships and fails on one.

   Run: node tests/encoding-test.js */
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log("  ok  " + n); } else { fail++; console.log("FAIL  " + n + (x ? "\n      " + x : "")); } };

// U+FDD0–U+FDEF, and U+FFFE/U+FFFF at the top of every plane
const BAD = /[﷐-﷯￾￿]|[\uD83F\uD87F\uD8BF\uD8FF\uD93F\uD97F\uD9BF\uD9FF\uDA3F\uDA7F\uDABF\uDAFF\uDB3F\uDB7F\uDBBF\uDBFF][\uDFFE\uDFFF]/;

function shipped() {
  /* The whitelist in pack.sh IS the definition of what the extension loads —
     read it rather than keeping a second copy that drifts out of step. */
  const sh = fs.readFileSync(path.join(ROOT, "pack.sh"), "utf8");
  const zip = sh.split(/zip -q "\$OUT" \\/)[1] || "";
  const block = zip.split(/\n\s*\n/)[0] || "";
  return block.split(/\s+/)
    .map(s => s.replace(/\\$/, "").trim())
    .filter(f => f && !f.startsWith("#") && /\.(js|json|html|css)$/.test(f));
}

const files = shipped();
ok("the ship list was read from pack.sh", files.length >= 15, String(files.length));

let dirty = [];
files.forEach(f => {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) { dirty.push(f + " MISSING"); return; }
  const text = fs.readFileSync(p, "utf8");
  const m = text.match(BAD);
  if (m) {
    const at = text.indexOf(m[0]);
    dirty.push(`${f} @${at} U+${m[0].codePointAt(0).toString(16).toUpperCase()}`);
  }
});
ok("no shipped file carries a Unicode noncharacter", dirty.length === 0, dirty.join(" | "));

/* Nothing in a shipped file may read like a script downloader.

   v3.53.0 removed update.bat because Windows Defender flagged it — and the
   commit explaining why quoted the offending command line into installer.js,
   which ships. The zip then carried the flagged string itself and the download
   was blocked as a virus. The fix for one scanner complaint had created
   another, in the same release.

   So the vocabulary is banned from the files we author. It is a closed list of
   the tokens scanners key on for the download-and-run family: name the shell,
   the fetch verb, and the switch that turns script safety off, and the file
   looks like a dropper however innocent the sentence around it is.

   exceljs.min.js is exempt: it is a third-party bundle, its minifier emits
   `new Function` and `fromCharCode` as a matter of course, and it has shipped
   unchanged since long before any of this. Ours is the half we control. */
const BAIT = /powershell|invoke-webrequest|executionpolicy|cmd\.exe|ActiveXObject|WScript|ADODB|SaveToFile|Scripting\.FileSystemObject|\beval\(|new Function\(/i;
const VENDOR = /exceljs\.min\.js$/;
const baited = [];
files.filter(f => !VENDOR.test(f)).forEach(f => {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) return;
  const m = fs.readFileSync(p, "utf8").match(BAIT);
  if (m) baited.push(`${f}: "${m[0]}"`);
});
ok("no shipped file of ours reads like a script downloader",
  baited.length === 0, baited.join(" | "));
ok("…and the detector really catches it",
  BAIT.test('powershell -NoProfile -ExecutionPolicy Bypass -Command "x"'));
ok("…while leaving ordinary prose alone",
  !BAIT.test("the shell was asked to fetch an archive and unpack it"));

// every shipped file exists — a whitelist naming a file that is gone ships a broken zip
ok("every file on the ship list is present", !dirty.some(d => /MISSING/.test(d)),
  dirty.filter(d => /MISSING/.test(d)).join(" | "));

/* Every script a shipped page asks for is itself shipped.

   The ship list is hand-kept, so adding a file means remembering two places.
   Forget the second and the zip is not merely missing a feature: the page
   loads, the script 404s, and everything after it in that page is gone — a
   LAB that opens to nothing. Nothing here caught that, which is why it is
   here now. The same goes for what the worker importScripts. */
const asked = new Set();
/* the pages come from the ship list too — popup.html is still in the repo and
   is NOT shipped, and a hand-kept list here would have made that a failure
   about a page nobody installs */
files.filter(f => f.endsWith(".html")).forEach(page => {
  const p = path.join(ROOT, page);
  if (!fs.existsSync(p)) return;
  const html = fs.readFileSync(p, "utf8");
  let m;
  const re = /<script[^>]*\ssrc="([^"]+)"/gi;
  while ((m = re.exec(html))) if (!/^[a-z]+:/i.test(m[1])) asked.add(m[1].replace(/^\.\//, ""));
});
const wk = fs.readFileSync(path.join(ROOT, "background.js"), "utf8");
let im;
const imre = /importScripts\(\s*"([^"]+)"/g;
while ((im = imre.exec(wk))) asked.add(im[1]);

const shipSet = new Set(files);
const orphans = [...asked].filter(f => !shipSet.has(f));
ok("every script the shipped pages load is on the ship list", orphans.length === 0,
  orphans.join(" | "));
const gone = [...asked].filter(f => !fs.existsSync(path.join(ROOT, f)));
ok("…and every one of them exists", gone.length === 0, gone.join(" | "));

// the manifest still parses — the one file whose loss takes everything with it
let mf = null;
try { mf = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")); } catch (e) {}
ok("manifest.json parses", !!mf && !!mf.version, mf ? "" : "unparseable");

// [the detector itself works]
ok("it really does catch U+FFFF", BAD.test("a￿b"));
ok("…and U+FDD0", BAD.test("a﷐b"));
ok("…and leaves ordinary Korean and symbols alone",
  !BAD.test("원단 · 혼용률 · ▶ ⏸ ■ ⬇ ＋ ✓ 🔔"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
