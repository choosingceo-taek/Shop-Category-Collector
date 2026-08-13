/* One-click update for a folder-loaded extension.

   Chrome never updates an extension you loaded yourself — the files on disk
   ARE the extension — so updating has always meant: download a zip, unzip it,
   find the inner folder, copy everything over the right directory, reload.
   Five steps, and the two in the middle are where a non-developer loses.

   The browser can do those two. An extension page may ask for a folder with
   showDirectoryPicker() and, once granted, write into it — the grant persists,
   so the folder is chosen ONCE and every update afterwards is a single click.
   Unzipping needs no library either: a zip's central directory is a few fixed
   fields, and DecompressionStream("deflate-raw") does the rest.

   What this deliberately does NOT do is reload the extension afterwards.
   chrome.runtime.reload() was measured on an unpacked extension: it unloads
   and does not reliably come back, and an extension that vanishes from a
   designer's browser is a far worse outcome than one more click. So this ends
   with the files in place and the reload left to a person.

   Nothing here is site-specific and nothing runs on its own; every entry point
   below needs a click. */
(function (root) {
  "use strict";

  // ---- reading a zip --------------------------------------------------------
  // Only the two methods a GitHub archive uses: stored (0) and deflate (8).
  const EOCD_SIG = 0x06054b50, CEN_SIG = 0x02014b50;

  async function unzip(buffer) {
    const dv = new DataView(buffer);
    const u8 = new Uint8Array(buffer);
    // the end-of-central-directory record lives in the last 64 KB
    let eocd = -1;
    for (let i = dv.byteLength - 22; i >= Math.max(0, dv.byteLength - 65558); i--) {
      if (dv.getUint32(i, true) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("not a zip file");
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const out = [];
    for (let n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== CEN_SIG) break;
      const method = dv.getUint16(p + 10, true);
      const compSize = dv.getUint32(p + 20, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const commentLen = dv.getUint16(p + 32, true);
      const local = dv.getUint32(p + 42, true);
      const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + commentLen;
      if (/\/$/.test(name)) continue;                       // a directory entry
      // the local header repeats the name and carries its own extra field
      const lNameLen = dv.getUint16(local + 26, true);
      const lExtraLen = dv.getUint16(local + 28, true);
      const start = local + 30 + lNameLen + lExtraLen;
      const raw = u8.subarray(start, start + compSize);
      let bytes;
      if (method === 0) bytes = raw.slice();
      else if (method === 8) bytes = await inflateRaw(raw);
      else throw new Error("unsupported compression in " + name);
      out.push({ path: name, bytes });
    }
    return out;
  }

  async function inflateRaw(bytes) {
    const ds = new DecompressionStream("deflate-raw");
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /* A GitHub archive wraps everything in one folder named after the branch.
     That wrapper is exactly what people copy by mistake, so it is dropped
     here: the files land in the folder Chrome already knows. */
  function stripTopFolder(entries) {
    const tops = new Set(entries.map(e => e.path.split("/")[0]));
    if (tops.size !== 1) return entries;
    const top = [...tops][0] + "/";
    return entries.map(e => ({ ...e, path: e.path.slice(top.length) }))
      .filter(e => e.path);
  }

  // ---- writing into the chosen folder ---------------------------------------
  async function writeAll(dir, entries, onProgress) {
    let done = 0;
    for (const e of entries) {
      const parts = e.path.split("/").filter(Boolean);
      const file = parts.pop();
      let here = dir;
      for (const seg of parts) here = await here.getDirectoryHandle(seg, { create: true });
      const fh = await here.getFileHandle(file, { create: true });
      const w = await fh.createWritable();
      await w.write(e.bytes);
      await w.close();
      done++;
      if (onProgress) onProgress(done, entries.length);
    }
    return done;
  }

  /* Refuse to write anything that is not this extension. Pointing the picker
     at the wrong folder should fail loudly rather than scatter files into
     Documents. */
  function looksLikeTheExtension(entries) {
    const names = new Set(entries.map(e => e.path));
    return names.has("manifest.json") && names.has("content.js") && names.has("sites.js");
  }

  // ---- remembering the folder ----------------------------------------------
  // A directory handle survives in IndexedDB, which is what turns "pick the
  // folder" into a one-time step.
  const DB = "mlens-fs", STORE = "handles", KEY = "extdir";
  function idb() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function saveFolder(handle) {
    const db = await idb();
    return new Promise((res, rej) => {
      const t = db.transaction(STORE, "readwrite");
      t.objectStore(STORE).put(handle, KEY);
      t.oncomplete = res; t.onerror = () => rej(t.error);
    });
  }
  async function loadFolder() {
    try {
      const db = await idb();
      return await new Promise((res, rej) => {
        const r = db.transaction(STORE, "readonly").objectStore(STORE).get(KEY);
        r.onsuccess = () => res(r.result || null);
        r.onerror = () => rej(r.error);
      });
    } catch (e) { return null; }
  }
  async function folderReady(handle, ask) {
    if (!handle || !handle.queryPermission) return false;
    const opts = { mode: "readwrite" };
    if (await handle.queryPermission(opts) === "granted") return true;
    if (!ask) return false;
    return await handle.requestPermission(opts) === "granted";
  }

  // ---- the whole job, from one click ---------------------------------------
  async function install(dir, zipBuffer, onProgress) {
    const entries = stripTopFolder(await unzip(zipBuffer));
    if (!looksLikeTheExtension(entries))
      throw new Error("that archive does not look like Market Lens");
    const written = await writeAll(dir, entries, onProgress);
    const mf = entries.find(e => e.path === "manifest.json");
    let version = "";
    try { version = JSON.parse(new TextDecoder().decode(mf.bytes)).version || ""; } catch (e) {}
    return { written, version };
  }

  const API = { unzip, stripTopFolder, writeAll, looksLikeTheExtension,
    saveFolder, loadFolder, folderReady, install };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  root.LensInstaller = API;
})(typeof self !== "undefined" ? self : this);
