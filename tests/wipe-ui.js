/* What does Chrome 141's own "Delete browsing data" dialog actually contain,
   and does running it touch an extension's IndexedDB? */
const { chromium } = require("playwright");
const EXT = require("path").resolve(__dirname, "..");

const WALK = `(() => {
  const all = [];
  const visit = (root) => {
    root.querySelectorAll("*").forEach(el => {
      all.push(el);
      if (el.shadowRoot) visit(el.shadowRoot);
    });
  };
  visit(document);
  return all;
})()`;

(async () => {
  const ctx = await chromium.launchPersistentContext("/tmp/pw-wipeui", {
    executablePath: "/opt/pw-browsers/chromium", headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-sandbox"] });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker");
  const p = await ctx.newPage();
  for (const url of ["chrome://settings/clearBrowserData", "chrome://settings/deleteBrowsingData"]) {
    try {
      await p.goto(url);
      await p.waitForTimeout(2000);
      const found = await p.evaluate(w => {
        const all = eval(w);
        const btns = all.filter(e => /^(CR-BUTTON|BUTTON)$/.test(e.tagName))
          .map(e => (e.textContent || "").trim().slice(0, 30) + " [" + (e.id || "") + "]")
          .filter(Boolean);
        const boxes = all.filter(e => e.tagName === "CR-CHECKBOX")
          .map(e => (e.textContent || "").trim().slice(0, 40) + " checked=" + !!e.checked);
        const dlg = all.filter(e => /DIALOG/.test(e.tagName)).map(e => e.tagName);
        return { url: location.href, buttons: btns, boxes, dialogs: [...new Set(dlg)] };
      }, WALK);
      console.log(JSON.stringify(found, null, 1).slice(0, 1400));
    } catch (e) { console.log(url, "->", e.message.split("\n")[0]); }
  }
  await ctx.close();
})().catch(e => console.log("ERR " + e.message));
