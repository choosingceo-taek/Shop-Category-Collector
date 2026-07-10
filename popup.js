const tabQ = () => new Promise(r => chrome.tabs.query({ active: true, currentWindow: true }, t => r(t[0])));
const send = (id, msg) => new Promise(r => chrome.tabs.sendMessage(id, msg, res => r(res)));

async function refresh() {
  const tab = await tabQ();
  const ctxEl = document.getElementById("ctx");
  const goEl = document.getElementById("go");
  // content script only loads on supported sites; if messaging fails, it's unsupported
  const ctx = tab ? await send(tab.id, { type: "context" }).catch(() => null) : null;
  if (!ctx || !ctx.site) {
    ctxEl.textContent = "지원 사이트의 카테고리 페이지에서 열어주세요.";
    goEl.disabled = true; return;
  }
  goEl.disabled = false;
  ctxEl.textContent = `${ctx.site} · ${ctx.brand || "브랜드?"} · ${ctx.totalPages ? "총 " + ctx.totalPages + "p" : "페이지 자동 감지"} (현재 ${ctx.page || 1})`;
  const st = await send(tab.id, { type: "status" }).catch(() => null);
  if (st && st.status) document.getElementById("status").textContent = st.status;
}
document.getElementById("go").onclick = async () => {
  const tab = await tabQ();
  await send(tab.id, { type: "start", withSpec: document.getElementById("spec").checked });
  document.getElementById("status").textContent = "시작했습니다. 창을 닫아도 진행됩니다.";
};
document.getElementById("cancel").onclick = async () => {
  const tab = await tabQ(); await send(tab.id, { type: "cancel" });
  document.getElementById("status").textContent = "중지됨.";
};
setInterval(refresh, 1500); refresh();
