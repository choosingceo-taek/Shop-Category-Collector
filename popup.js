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
    el("ctx").textContent = "지원 사이트의 카테고리 페이지에서 열어주세요.";
    el("go").disabled = true;
    el("pauseresume").disabled = true;
    return;
  }
  const brandPart = ctx.brand ? ` · ${ctx.brand}` : "";
  el("ctx").textContent = `${ctx.site}${brandPart} · ${ctx.totalPages ? "총 " + ctx.totalPages + "p" : "페이지 자동 감지"} (현재 ${ctx.page || 1})`;

  el("specRow").style.display = ctx.hasDetail ? "" : "none";
  el("genericNote").style.display = ctx.hasDetail ? "none" : "";

  const st = await send(tab.id, { type: "status" });
  const running = !!(st && st.active);
  el("go").disabled = running;                       // finish or reset before a new run
  el("pauseresume").disabled = !running;
  el("pauseresume").textContent = (st && st.paused) ? "▶ 재개" : "⏸ 일시정지";
  if (st && st.status) el("status").textContent = st.status;
}

const terms = id => el(id).value.split(",").map(s => s.trim()).filter(Boolean);

el("go").onclick = async () => {
  const tab = await tabQ();
  const filters = {
    dominantBrandOnly: el("fDomOnly").checked,
    brands: terms("fBrand"),
    nameInclude: terms("fInclude"),
    nameExclude: terms("fExclude"),
  };
  // remember the choices so the on-page scan button reuses them
  chrome.storage.local.set({ wpb_opts: { withSpec: el("spec").checked, filters } });
  await send(tab.id, { type: "start", withSpec: el("spec").checked, filters });
  el("status").textContent = "시작했습니다. 팝업을 닫아도 진행됩니다.";
  refresh();
};

el("pauseresume").onclick = async () => {
  const tab = await tabQ();
  const st = await send(tab.id, { type: "status" });
  if (st && st.active && st.paused) {
    await send(tab.id, { type: "resume" });
    el("status").textContent = "재개했습니다.";
  } else if (st && st.active) {
    await send(tab.id, { type: "pause" });
    el("status").textContent = "일시정지됨. ▶ 재개를 누르면 이어서 진행합니다.";
  }
  refresh();
};

el("reset").onclick = async () => {
  const tab = await tabQ();
  await send(tab.id, { type: "reset" });
  el("status").textContent = "작업이 삭제되었습니다. 새로 시작할 수 있습니다.";
  refresh();
};

setInterval(refresh, 1200); refresh();
