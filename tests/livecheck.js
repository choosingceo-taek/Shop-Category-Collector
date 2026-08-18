/* What does the extension's OWN update check get, against the real URL?
   No stub, no route — the request the installed copy makes. */
const { chromium } = require("playwright");
const EXT = require("path").resolve(__dirname, "..");
(async () => {
  const ctx = await chromium.launchPersistentContext("", {
    executablePath: "/opt/pw-browsers/chromium", headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-sandbox"] });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker");
  console.log(await sw.evaluate(async () => {
    const out = { src: self.LensUpdate.SRC, zip: self.LensUpdate.ZIP };
    try {
      const r = await fetch(out.src + "?t=" + Date.now(), { cache: "no-store" });
      out.status = r.status;
      out.body = (await r.text()).slice(0, 120);
    } catch (e) { out.error = String(e); }
    out.check = await self.LensUpdate.check({ current: "3.13.0" });
    try {
      const z = await fetch(out.zip, { method: "GET" });
      out.zipStatus = z.status;
      out.zipBytes = (await z.arrayBuffer()).byteLength;
    } catch (e) { out.zipError = String(e); }
    return out;
  }));
  await ctx.close();
})().catch(e => console.log("ERR " + e.message));
