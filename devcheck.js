/* Developer tool — NOT part of the extension the team uses.

   Paste this whole file into the EXTENSION'S SERVICE WORKER console:
     chrome://extensions → Market Lens → "service worker" → Console

   It walks the saved list, opens each URL in one tab, reads it with the real
   engine (the same scrapeList a scan calls) and prints a verdict per site:

     ✅ ready       products found, name + image + price all filled
     ⚠️  gaps        products found, but a column comes back empty
     ❌ broken      no products, or no engine in the page

   It COLLECTS NOTHING — no catalog rows, no spreadsheet, no snapshot — so it
   is safe on an uncurated list and cannot pollute the weekly trend data.

   This lives out of the panel on purpose. The designers using Market Lens
   never need it; opening a shop up is the developer's job, and a button they
   must learn not to press is worse than no button.

   Usage:
     devcheck()                 // every site in every list
     devcheck("26SS tops")      // only that list, by name
     devcheck(null, 20)         // stop after 20 sites
     devcheckStop()             // stop a run in progress
     devhealth()                // what scans ALREADY recorded — no walking

   Since v1.67 the scans record all of this by themselves: every Scan all
   leaves a verdict per URL in storage, failing sites get an automatic page
   photograph (the diagnose-generic facts), and a run with failures downloads
   a sitecheck_….txt on its own. devhealth() reads that record instantly;
   devcheck() is only for probing a list WITHOUT running a real scan.
*/
(() => {
  const PROBE_WAIT = 15000;     // how long to allow one page load
  const PAINT_WAIT = 900;       // let a grid render after load fires
  let stopping = false;

  self.devcheckStop = () => { stopping = true; console.log("stopping after this site…"); };

  const waitForLoad = (tabId, ms) => new Promise(res => {
    let done = false;
    const finish = v => {
      if (done) return; done = true;
      try { chrome.tabs.onUpdated.removeListener(onUp); } catch (e) {}
      res(v);
    };
    const onUp = (id, info) => { if (id === tabId && info.status === "complete") finish(true); };
    try { chrome.tabs.onUpdated.addListener(onUp); } catch (e) { return finish(false); }
    setTimeout(() => finish(false), ms);
  });

  const probe = tabId => new Promise(res => {
    try {
      chrome.tabs.sendMessage(tabId, { type: "probe" }, r => { void chrome.runtime.lastError; res(r || null); });
    } catch (e) { res(null); }
  });

  // The engine is only auto-injected on the sites in the manifest; anywhere
  // else the worker has to put it there first (same path a real run uses).
  const inject = tabId => new Promise(res => {
    try {
      if (typeof ensureEngine === "function") return ensureEngine(tabId).then(res, () => res(null));
      res(null);
    } catch (e) { res(null); }
  });

  function verdict(p) {
    if (!p || !p.ok) return { mark: "❌", note: p && p.reason === "no-engine" ? "no engine in page" : "no answer" };
    if (!p.count) return { mark: "❌", note: "0 products" };
    const miss = [];
    if (p.named < p.count) miss.push(`name×${p.count - p.named}`);
    if (p.imaged < p.count) miss.push(`image×${p.count - p.imaged}`);
    if (p.priced < p.count) miss.push(`price×${p.count - p.priced}`);
    return miss.length
      ? { mark: "⚠️", note: `${p.count} found · missing ${miss.join(" ")}` }
      : { mark: "✅", note: `${p.count} found · complete` };
  }

  self.devcheck = async function devcheck(listName, limit) {
    stopping = false;
    const lists = await new Promise(r => chrome.storage.local.get("wpb_lists", o => r(o.wpb_lists || [])));
    const picked = listName ? lists.filter(l => l.name === listName) : lists;
    if (!picked.length) {
      console.log("no such list. available:", lists.map(l => l.name));
      return;
    }
    let entries = picked.flatMap(l => (l.entries || []).map(e => ({ ...e, list: l.name })))
      .filter(e => e.scannable !== false && /^https?:/i.test(e.url || ""));
    if (limit) entries = entries.slice(0, limit);
    if (!entries.length) return console.log("nothing to check");

    console.log(`devcheck: ${entries.length} sites — collects nothing, safe to run.`);
    const rows = [];
    const tab = await chrome.tabs.create({ url: entries[0].url, active: true });
    for (let i = 0; i < entries.length && !stopping; i++) {
      const e = entries[i];
      if (i) { try { await chrome.tabs.update(tab.id, { url: e.url }); } catch (x) { break; } }
      await waitForLoad(tab.id, PROBE_WAIT);
      await new Promise(r => setTimeout(r, PAINT_WAIT));
      let p = await probe(tab.id);
      if (!p) { await inject(tab.id); await new Promise(r => setTimeout(r, 800)); p = await probe(tab.id); }
      const v = verdict(p);
      const line = `${v.mark} ${e.brand || ""} · ${e.label || ""} — ${v.note}`;
      console.log(`[${i + 1}/${entries.length}] ${line}`);
      rows.push({
        mark: v.mark, brand: e.brand || "", label: e.label || "", note: v.note, url: e.url,
        engine: (p && p.adapterId) || "", platform: ((p && p.platform) || []).join("+"),
        count: (p && p.count) || 0, sample: ((p && p.samples) || [])[0] || null,
      });
    }
    try { await chrome.tabs.remove(tab.id); } catch (e) {}

    const by = m => rows.filter(r => r.mark === m).length;
    console.log(`\ndone — ✅ ${by("✅")} ready · ⚠️ ${by("⚠️")} gaps · ❌ ${by("❌")} broken`);
    console.table(rows.map(r => ({ "": r.mark, brand: r.brand, category: r.label,
      engine: r.engine, found: r.count, note: r.note })));
    // Paste-ready text — the failures are what a fix starts from.
    const bad = rows.filter(r => r.mark !== "✅");
    if (bad.length) {
      console.log("\n--- paste this ---\n" + bad.map(r =>
        `${r.mark} ${r.brand} · ${r.label}\n   ${r.note}${r.engine ? ` | engine=${r.engine}` : ""}${r.platform ? ` | ${r.platform}` : ""}\n   ${r.url}` +
        (r.sample ? `\n   e.g. "${r.sample.name}" ${r.sample.price || ""} ${r.sample.img ? "" : "(no image)"}` : "")
      ).join("\n") + "\n--- end ---");
    }
    self.devcheckRows = rows;      // left behind for further poking
    return rows;
  };

  // What the real scans already found out — read from storage, zero browsing.
  self.devhealth = async function devhealth() {
    const all = await new Promise(r => chrome.storage.local.get("wpb_sitehealth", o => r(o.wpb_sitehealth || {})));
    const recs = Object.values(all).sort((a, b) => (b.ts || 0) - (a.ts || 0));
    if (!recs.length) return console.log("no scan has recorded anything yet — run a scan (or devcheck)");
    const by = m => recs.filter(r => r.mark === m).length;
    console.log(`${recs.length} scanned collections — ✅ ${by("✅")} ready · ⚠️ ${by("⚠️")} gaps · ❌ ${by("❌")} broken`);
    console.table(recs.map(r => ({ "": r.mark, brand: r.brand, category: r.label, engine: r.adapter,
      found: r.count, when: new Date(r.ts).toISOString().slice(0, 16), url: (r.url || "").slice(0, 60) })));
    const bad = recs.filter(r => r.mark !== "✅");
    if (bad.length) console.log("--- paste this ---\n" + bad.map(r =>
      `${r.mark} ${r.brand} · ${r.label}\n   ${r.count} found (name ${r.named} · image ${r.imaged} · price ${r.priced}${r.withSpec ? ` · fabric ${r.fabric}` : ""}) | engine=${r.adapter}\n   ${r.url}` +
      (r.diag ? `\n   diag: ${JSON.stringify(r.diag)}` : "") +
      (r.diagDetail ? `\n   pdp: ${JSON.stringify(r.diagDetail)}` : "")).join("\n") + "\n--- end ---");
    self.devhealthRows = recs;
    return recs;
  };

  console.log("devcheck ready. run:  devcheck()   |   devcheck(\"My references\")   |   devhealth()   |   devcheckStop()");
})();
