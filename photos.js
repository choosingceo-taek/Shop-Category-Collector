/* Product photographs, asked for once and eight at a time.

   Every file this tool hands over — the HTML dashboard, the workbook —
   carries the photographs inside it, because a report that merely linked to a
   shop's CDN loses every picture the season the shop rotates its paths. So
   building a file means fetching a few hundred photographs, and until v3.62.0
   that was a single file loop: ask, wait, ask, wait. Measured at a generous
   120ms shop, 120 products took 16.0s and made 120 requests for 60 distinct
   addresses; a real catalog is three times that, on a slower CDN, and a shop
   that does not answer costs the worker's ten-second timeout PER ROW. That is
   the ten minutes of nothing a designer reported.

   Three things live here, and they are the three reasons it was slow:

     · LANES — the step is pure network waiting, the same shape as the detail
       step v1.96.0 took from 4 lanes to 8. Same number, same reasoning: it is
       still fewer connections than a browser opens for one shop page.

     · one address, one round trip — colourways of one garment share a
       photograph, and the report and the workbook both want it. Successes are
       kept for the life of the page, so pressing HTML and then EXCEL fetches
       nothing twice.

     · a host that does not answer is asked five times, not four hundred. A
       CDN is reachable or it is not; discovering that four hundred times, ten
       seconds each, is over an hour of a person watching a button. What it
       said the first time is kept, so the finishing line can name the host and
       the reason rather than leaving a file quietly short of pictures.

   Failures are NOT kept between builds — pressing the button again really does
   retry what failed, which is the right answer for a shop that was briefly
   busy. Only successes are permanent. */
(function (root) {
  const LANES = 8;
  const GIVE_UP = 5;          // failures from one host with nothing to show for them

  const kept = new Map();     // url -> {ok, base64, ext}
  const miss = new Set();     // url -> failed during THIS build
  const hosts = new Map();    // host -> {fails, wins, why}

  const hostOf = u => { try { return new URL(u).host; } catch (e) { return ""; } };

  /* One record per host, made before anything waits on it. Eight lanes read
     this counter at the same moment, so a record created per call means eight
     private copies of "0 failures so far" and a give-up that only trips a
     round or two late — measured at 32 requests into a dead CDN where it
     should have been 8. */
  function rec(host) {
    let h = hosts.get(host);
    if (!h) { h = { fails: 0, wins: 0, why: "" }; hosts.set(host, h); }
    return h;
  }

  function ask(url) {
    return new Promise(res => {
      try {
        chrome.runtime.sendMessage({ type: "fetchImage", url }, r => {
          void chrome.runtime.lastError;      // the worker may have gone away
          res(r || null);
        });
      } catch (e) { res(null); }
    });
  }

  async function get(url) {
    if (!url) return null;
    if (kept.has(url)) return kept.get(url);
    if (miss.has(url)) return null;
    const h = rec(hostOf(url));
    if (h.wins === 0 && h.fails >= GIVE_UP) { h.skipped = (h.skipped || 0) + 1; miss.add(url); return null; }

    const r = await ask(url);
    const good = r && r.ok && r.base64 ? r : null;
    if (good) { h.wins++; kept.set(url, good); }
    else {
      h.fails++;
      if (!h.why) h.why = (r && (r.error || (r.need && "no access to " + r.need))) || "no answer";
      miss.add(url);
    }
    return good;
  }

  /* Fetch a whole catalog's photographs before anything consumes them, so the
     consumer — the report's downscaler, the workbook's row loop — reads an
     answer that is already here instead of waiting for one. */
  async function warm(urls, onProgress) {
    miss.clear(); hosts.clear();                 // this build gets a fresh chance
    const list = [...new Set((urls || []).filter(Boolean))].filter(u => !kept.has(u));
    const total = list.length;
    if (onProgress) onProgress(0, total);
    if (!total) return kept;
    let next = 0, done = 0;
    await Promise.all(Array.from({ length: Math.min(LANES, total) }, async () => {
      while (next < list.length) {
        await get(list[next++]);
        if (onProgress) onProgress(++done, total);
      }
    }));
    return kept;
  }

  /* What the finishing line should say about the pictures that are not there.
     A failure with no host and no reason attached sends the next round of
     guessing somewhere else (v1.99.0). */
  function trouble() {
    const out = [];
    hosts.forEach((h, host) => {
      if (!h.fails) return;
      out.push({ host, fails: h.fails, skipped: h.skipped || 0, why: h.why,
        gaveUp: h.wins === 0 && h.fails >= GIVE_UP });
    });
    return out.sort((a, b) => (b.fails + b.skipped) - (a.fails + a.skipped));
  }

  function troubleLine() {
    const t = trouble();
    if (!t.length) return "";
    return t.slice(0, 3).map(h =>
      `${h.host} — ${h.why}` +
      (h.gaveUp ? ` (${h.fails + h.skipped} photos skipped after ${h.fails} tries)`
        : ` (${h.fails} photos)`)
    ).join("\n");
  }

  function forget() { kept.clear(); miss.clear(); hosts.clear(); }

  root.Photos = { get, warm, trouble, troubleLine, forget, LANES, GIVE_UP };
  if (typeof module !== "undefined" && module.exports) module.exports = root.Photos;
})(typeof self !== "undefined" ? self : this);
