/* Does the browser actually SAY a new version exists?

   The extension already checks GitHub and sets a NEW badge, so the question is
   not whether the check works — it is whether the mark survives long enough to
   be seen, and whether anything at all happens when the panel is closed (which
   is nearly always). Measured, not read. */
const { chromium } = require("playwright");
const EXT = "/home/user/Fabric-Scanner";

(async () => {
  const ctx = await chromium.launchPersistentContext("/tmp/pw-updnote", {
    executablePath: "/opt/pw-browsers/chromium", headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-sandbox"] });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker");

  // the repo says a newer version exists
  await ctx.route("https://raw.githubusercontent.com/**/manifest.json*", r =>
    r.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ version: "99.0.0" }) }));

  const badge = () => sw.evaluate(() => chrome.action.getBadgeText({}));
  const perms = await sw.evaluate(() => chrome.runtime.getManifest().permissions);
  console.log("permissions:", JSON.stringify(perms));
  console.log("notifications API in worker:", await sw.evaluate(() => typeof chrome.notifications));

  console.log("badge at rest:", JSON.stringify(await badge()));

  const rec = await sw.evaluate(async () => {
    /* Ask the real decision function, with the network answer injected — the
       route below does not reach a service worker's own fetch. */
    const real = self.LensUpdate.check;
    self.LensUpdate.check = async () => ({ ok: true, current: chrome.runtime.getManifest().version,
      latest: "99.0.0", newer: true });
    const out = await refreshUpdate(true);
    self.LensUpdate.check = real;
    return out;
  });
  console.log("check says:", JSON.stringify(rec));
  await sw.evaluate(() => new Promise(r => setTimeout(r, 400)));
  console.log("badge after the check:", JSON.stringify(await badge()));

  /* The disk watcher runs every five minutes whether or not anything is on
     disk. Fire it once by hand and look again. */
  await sw.evaluate(() => checkForReplacedFiles());
  await sw.evaluate(() => new Promise(r => setTimeout(r, 400)));
  console.log("badge after one disk check:", JSON.stringify(await badge()));

  console.log("stored record:", JSON.stringify(await sw.evaluate(() => new Promise(r =>
    chrome.storage.local.get("wpb_update", o => r(o.wpb_update))))));

  await ctx.close();
})().catch(e => console.log("ERROR " + (e && e.message || e)));
