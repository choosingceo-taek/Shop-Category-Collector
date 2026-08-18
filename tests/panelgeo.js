const { chromium } = require("playwright");
const EXT = "/home/user/Fabric-Scanner";
(async () => {
  const ctx = await chromium.launchPersistentContext("", {
    executablePath: "/opt/pw-browsers/chromium", headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-sandbox"] });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker");
  const id = sw.url().split("/")[2];
  const p = await ctx.newPage();
  await p.setViewportSize({ width: 350, height: 800 });
  await p.goto(`chrome-extension://${id}/sidepanel.html`);
  await p.evaluate(() => new Promise(r => chrome.storage.local.set({ wpb_lists: [{
    id: "s1", name: "Young Women's", createdAt: 1, entries: [
      { brand: "ZARA", label: "New In", url: "https://www.zara.com/us/en/woman-new-in-l1180.html" },
      { brand: "COS", label: "New In", url: "https://www.cos.com/en_usd/women/new-arrivals.html" },
    ] }] }, r)));
  await p.reload(); await p.waitForTimeout(1400);
  console.log(await p.evaluate(() => {
    const g = s => { const e = document.querySelector(s); if (!e) return s + " MISSING";
      const r = e.getBoundingClientRect();
      return `${s} ${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}${e.hidden?" [hidden]":""}`; };
    return [".runbar", "#listresult", ".runrow", "#runlist", "#jpause", "#jreset", "#jxlsx",
            ".addrow", "#importbtn", "#lsearch", "#lq", "#lfold", ".tabs"].map(g).join("\n");
  }));
  await ctx.close();
})();
