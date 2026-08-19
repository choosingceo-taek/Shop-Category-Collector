/* The download itself — through the redirect GitHub actually serves.

   "Update now" stopped working the moment the download moved to the release
   asset (v3.21.0). The address in the panel is on github.com, which is
   declared, but GitHub answers it with a 302 to its asset host — measured
   today, https://release-assets.githubusercontent.com/... — and an extension's
   fetch is bound by host_permissions AT EVERY HOP. That host was not declared,
   so the fetch died on the redirect and the box said only "could not finish".

   Nothing caught it because the suites that cover this ROUTE the request and
   fulfill it directly: no redirect happens, and (measured earlier, and written
   into updatefetch-e2e at the time) routing bypasses the origin checks
   entirely. A test that fulfils the request is testing the unzip, not the
   download.

   So this one does not route anything. The two hostnames are pointed at a
   local HTTPS server in the resolver, that server issues a real 302 across
   origins, and the panel's own button does the fetch. Which is also why the
   permission is declared as *.githubusercontent.com rather than the one host:
   GitHub has moved this asset host before (objects. → release-assets.), and a
   host that moves takes every teammate's updates down silently when it does.

   Run: NODE_PATH=/opt/node22/lib/node_modules xvfb-run -a node assetfetch-e2e.js */
"use strict";
const { chromium } = require("playwright");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const REPO = path.resolve(__dirname, "..");

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log("  ok  " + n); } else { fail++; console.log("FAIL  " + n + (x ? "\n      " + x : "")); } };

const ZIPDIR = "/tmp/ml-af-zip";
function makeZip(version) {
  execSync(`rm -rf ${ZIPDIR} && mkdir -p ${ZIPDIR}`);
  execSync(`cd ${REPO} && git ls-files | tar -cf - -T - | tar -x -C ${ZIPDIR}`);
  const mf = `${ZIPDIR}/manifest.json`;
  const m = JSON.parse(fs.readFileSync(mf, "utf8"));
  m.version = version;
  fs.writeFileSync(mf, JSON.stringify(m, null, 2));
  execSync(`cd ${ZIPDIR} && rm -rf tests dist`);
  execSync("rm -f /tmp/ml-af.zip");            // zip APPENDS to an existing archive
  execSync(`cd ${ZIPDIR} && zip -qr /tmp/ml-af.zip .`);
  return fs.readFileSync("/tmp/ml-af.zip");
}

const PORT = 8461;
const ASSET_HOST = "release-assets.githubusercontent.com";
const HOSTS = ["github.com", ASSET_HOST];

if (!fs.existsSync("/tmp/ml-key.pem")) {
  execSync('openssl req -x509 -newkey rsa:2048 -nodes -keyout /tmp/ml-key.pem ' +
    '-out /tmp/ml-cert.pem -days 365 -subj "/CN=localhost" 2>/dev/null');
}

const zip = makeZip("99.7.0");
let hops = [];
const server = https.createServer(
  { key: fs.readFileSync("/tmp/ml-key.pem"), cert: fs.readFileSync("/tmp/ml-cert.pem") },
  (req, res) => {
    const host = String(req.headers.host || "").split(":")[0];
    const url = req.url || "/";
    hops.push(host + url.split("?")[0]);
    // the panel appends a cache-buster, so the path is matched, not the whole URL
    if (host === "github.com" && /market-lens\.zip(\?|$)/.test(url)) {
      /* Exactly what GitHub does: the stable address answers with a redirect
         to a signed URL on a different origin. */
      res.writeHead(302, { location: `https://${ASSET_HOST}/asset/market-lens.zip?sig=abc` });
      return res.end();
    }
    if (host === ASSET_HOST) {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      return res.end(zip);
    }
    res.writeHead(404); res.end("no");
  });
const serverReady = new Promise(r => server.listen(PORT, "127.0.0.1", r));

(async () => {
  const MAP = HOSTS.map(h => `MAP ${h} 127.0.0.1:${PORT}`).join(",");
  const ctx = await chromium.launchPersistentContext("/tmp/pw-assetfetch", {
    executablePath: "/opt/pw-browsers/chromium", headless: false, ignoreHTTPSErrors: true,
    args: [`--disable-extensions-except=${REPO}`, `--load-extension=${REPO}`, "--no-sandbox",
      `--host-resolver-rules=${MAP}`, "--ignore-certificate-errors", "--no-proxy-server"] });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker");
  const id = sw.url().split("/")[2];
  await serverReady;

  /* The asset host must be declared, or the fetch dies on the second hop with
     nothing but a generic failure to show for it. */
  const declared = await sw.evaluate(h => new Promise(r => {
    chrome.permissions.contains({ origins: [`https://${h}/*`] }, v => r(!!v));
  }), ASSET_HOST);
  ok(`${ASSET_HOST} is a declared host`, declared);

  // never take the extension down mid-test
  await sw.evaluate(() => { chrome.runtime.reload = () => {}; }).catch(() => {});
  await sw.evaluate(() => new Promise(r =>
    chrome.storage.local.set({ wpb_reloadok: false, wpb_autoupdate: false }, r)));

  const panel = await ctx.newPage();
  await panel.setViewportSize({ width: 380, height: 900 });
  const errs = []; panel.on("pageerror", e => errs.push(e.message));

  /* The folder is the origin's own private directory — the one handle a page
     can legitimately obtain — put in place before the panel's scripts run.
     Everything after it is the real path: fetch, unzip, write, verify. */
  await panel.addInitScript(() => {
    window.__mlFolderReady = (async () => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle("af-folder", { create: true });
      const mf = await dir.getFileHandle("manifest.json", { create: true });
      const w = await mf.createWritable();
      await w.write(JSON.stringify({ manifest_version: 3, name: "Market Lens", version: "1.0.0" }));
      await w.close();
      window.showDirectoryPicker = async () => dir;
      return dir;
    })();
  });
  await panel.goto(`chrome-extension://${id}/sidepanel.html`);
  await panel.waitForTimeout(800);
  await panel.evaluate(async () => {
    const dir = await window.__mlFolderReady;
    await window.LensInstaller.saveFolder(dir);
  });

  await panel.reload();
  await panel.waitForTimeout(1500);
  if (await panel.locator("#updbox").isHidden()) {
    await panel.click("#verchip");
    await panel.waitForTimeout(1200);
  }
  hops = [];
  await panel.click("#uauto");
  await panel.waitForTimeout(8000);

  const note = await panel.locator("#uautonote").innerText().catch(() => "");
  ok("the download went through the redirect and installed",
    /written into|installed/i.test(note) && /99\.7\.0/.test(note), note);
  ok("both hops were really made", hops.some(h => h.startsWith("github.com")) &&
    hops.some(h => h.startsWith(ASSET_HOST)), hops.join(" → ") || "(no request arrived)");

  const wrote = await panel.evaluate(async () => {
    const dir = await window.__mlFolderReady;
    const names = [];
    for await (const [n] of dir.entries()) names.push(n);
    let ver = "";
    try {
      const f = await (await dir.getFileHandle("manifest.json")).getFile();
      ver = JSON.parse(await f.text()).version;
    } catch (e) { ver = "ERR"; }
    return { count: names.length, ver, hasEngine: names.includes("sites.js") };
  });
  ok("the new files are in the folder", wrote.count > 15 && wrote.hasEngine, JSON.stringify(wrote));
  ok("…at the version the asset carried", wrote.ver === "99.7.0", JSON.stringify(wrote));

  ok("no page errors", errs.length === 0, errs.join(" | "));
  console.log(`\n${pass} passed, ${fail} failed`);
  server.close();
  await ctx.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log("HARNESS " + (e && e.message || e)); server.close(); process.exit(1); });
