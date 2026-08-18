/* Update notifier — the closest thing to auto-update WITHOUT the Web Store.

   Chrome only silently installs new versions from two places: the Web Store,
   or an enterprise-managed browser force-installing a self-hosted CRX. On
   personal Chrome with a developer-mode load, neither applies — the files on
   disk ARE the extension, and nothing can replace them but the user.

   So this does the half that is possible: the extension checks the GitHub
   branch it was built from and, when the version there is newer, says so —
   badge on the toolbar icon, banner in the panel with a one-click ZIP link.
   The user's remaining part is three actions (download → overwrite → reload),
   and nobody unknowingly stays on an old build.

   The check reads ONLY manifest.json from the repo (a few hundred bytes) and
   sends nothing. If the repo is private or offline the check fails silently —
   an update notice is a convenience, never an error. */
(function (root) {
  "use strict";

  const OWNER_REPO = "choosingceo-taek/Shop-Category-Collector";
  const BRANCH = "claude/main-session-cudnkx";
  const SRC = `https://raw.githubusercontent.com/${OWNER_REPO}/${BRANCH}/manifest.json`;
  /* The release asset, not the branch archive. A branch archive wraps the
     extension in a folder named after the branch, and choosing that wrapper
     instead of the folder inside it is the commonest way this install goes
     wrong — and the commonest way a catalog is lost, since an unpacked
     extension's identity is its path. The release asset is flat: unzip it and
     the folder you unzipped IS the extension. The link never moves. */
  const ZIP = `https://github.com/${OWNER_REPO}/releases/latest/download/market-lens.zip`;

  // "1.42.0" vs "1.9.3" — numeric per segment, so 42 > 9 (string compare lies)
  function cmp(a, b) {
    const pa = String(a || "").split(".").map(n => parseInt(n, 10) || 0);
    const pb = String(b || "").split(".").map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d < 0 ? -1 : 1;
    }
    return 0;
  }

  /* One network read; injectable fetch/current for the Node suite. */
  async function check(opts) {
    opts = opts || {};
    const current = opts.current ||
      (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getManifest
        ? chrome.runtime.getManifest().version : "");
    const f = opts.fetch || (typeof fetch !== "undefined" ? fetch : null);
    if (!f) return { ok: false };
    try {
      const res = await f(SRC + "?t=" + Date.now(), { cache: "no-store" });
      if (!res.ok) return { ok: false };
      const m = await res.json();
      const latest = (m && m.version) || "";
      if (!latest) return { ok: false };
      return { ok: true, current, latest, newer: cmp(current, latest) < 0, zip: ZIP };
    } catch (e) { return { ok: false }; }
  }

  const API = { check, cmp, SRC, ZIP };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  root.LensUpdate = API;
})(typeof self !== "undefined" ? self : this);
