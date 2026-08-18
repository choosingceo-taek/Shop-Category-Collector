/* Unicode noncharacters in a source file brick the whole extension.

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

// every shipped file exists — a whitelist naming a file that is gone ships a broken zip
ok("every file on the ship list is present", !dirty.some(d => /MISSING/.test(d)),
  dirty.filter(d => /MISSING/.test(d)).join(" | "));

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
