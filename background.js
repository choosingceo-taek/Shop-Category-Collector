/* MV3 service worker — image fetcher.
   Content scripts can't read cross-origin image bytes (CORS uses the page's
   origin). The service worker CAN, using the extension's host_permissions for
   walmartimages.com. It fetches an image, detects its real type from the magic
   bytes, and returns base64 so the content script can embed it via ExcelJS. */

function detectExt(b) {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return "png";
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return "jpeg";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "webp";
  return "unknown";
}

function toBase64(bytes) {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

chrome.runtime.onMessage.addListener((msg, _sender, send) => {
  if (msg && msg.type === "fetchImage" && msg.url) {
    (async () => {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 10000);
        let res;
        try { res = await fetch(msg.url, { signal: ctrl.signal }); }
        finally { clearTimeout(timer); }
        if (!res.ok) { send({ ok: false, error: "HTTP " + res.status }); return; }
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (!bytes.length || bytes.length > 8000000) { send({ ok: false, error: "size" }); return; }
        send({ ok: true, base64: toBase64(bytes), ext: detectExt(bytes) });
      } catch (e) {
        send({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;   // keep the message channel open for the async reply
  }
});
