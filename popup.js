const tabQ = () => new Promise(r => chrome.tabs.query({ active: true, currentWindow: true }, t => r(t[0])));
const send = (id, msg) => new Promise(r => chrome.tabs.sendMessage(id, msg, res => {
  if (chrome.runtime.lastError) return r(null);
  r(res);
}));

const el = id => document.getElementById(id);

async function refresh() {
  const tab = await tabQ();
  const ctx = tab ? await send(tab.id, { type: "context" }) : null;
  if (!ctx || !ctx.site) {
    // tab.url is only populated when we hold host permission for this page —
    // i.e. it IS a supported site but the content script isn't answering
    // (usually the tab needs a refresh after an extension reload/update).
    const url = (tab && tab.url) || "";
    el("ctx").textContent = url
      ? "Not connected to this page — refresh (F5) and reopen. (needed right after an extension update)"
      : "Open a supported store's category/search page.";
    el("go").disabled = true;
    el("pauseresume").disabled = true;
    return;
  }
  const brandPart = ctx.brand ? ` · ${ctx.brand}` : "";
  el("ctx").textContent = `${ctx.site}${brandPart} · ${ctx.totalPages ? ctx.totalPages + "p total" : "auto-detect pages"} (page ${ctx.page || 1})`;

  el("genericNote").style.display = ctx.hasDetail ? "none" : "";

  const st = await send(tab.id, { type: "status" });
  const running = !!(st && st.active);
  el("go").disabled = running;                       // finish or reset before a new run
  el("pauseresume").disabled = !running;
  el("pauseresume").textContent = (st && st.paused) ? "▶ Resume" : "⏸ Pause";
  if (st && st.status) el("status").textContent = st.status;
}

const terms = id => el(id).value.split(",").map(s => s.trim()).filter(Boolean);

el("go").onclick = async () => {
  const tab = await tabQ();
  const filters = {
    nameInclude: terms("fInclude"),
    nameExclude: terms("fExclude"),
  };
  // remember the choices so the on-page scan button reuses them
  chrome.storage.local.set({ wpb_opts: { withSpec: true, filters } });
  await send(tab.id, { type: "start", withSpec: true, filters });
  el("status").textContent = "Started. Keeps running after you close this popup.";
  refresh();
};

el("pauseresume").onclick = async () => {
  const tab = await tabQ();
  const st = await send(tab.id, { type: "status" });
  if (st && st.active && st.paused) {
    await send(tab.id, { type: "resume" });
    el("status").textContent = "Resumed.";
  } else if (st && st.active) {
    await send(tab.id, { type: "pause" });
    el("status").textContent = "Paused. Press Resume to continue.";
  }
  refresh();
};

el("reset").onclick = async () => {
  const tab = await tabQ();
  await send(tab.id, { type: "reset" });
  el("status").textContent = "Job cleared. You can start a new one.";
  refresh();
};

setInterval(refresh, 1200); refresh();
