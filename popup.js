const tabQ = () => new Promise(r => chrome.tabs.query({ active: true, currentWindow: true }, t => r(t[0])));
const send = (id, msg) => new Promise(r => chrome.tabs.sendMessage(id, msg, res => r(res)));

async function refresh() {
  const tab = await tabQ();
  if (!tab || !/walmart\.com\/(browse|search)/.test(tab.url || "")) {
    document.getElementById("ctx").textContent = "Walmart 카테고리 페이지에서 열어주세요.";
    document.getElementById("go").disabled = true; return;
  }
  const ctx = await send(tab.id, { type: "context" }).catch(() => null);
  if (ctx) document.getElementById("ctx").textContent = `브랜드: ${ctx.brand || "?"} · 총 ${ctx.totalPages || "?"}페이지 (현재 ${ctx.page})`;
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
