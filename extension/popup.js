import { LAYOUTS, needsBridge, speakersOf } from "./layouts.js";

const $ = (id) => document.getElementById(id);
const sel = $("layout");
const groups = [
  ["Browser output (no bridge)", LAYOUTS.filter((l) => !needsBridge(l))],
  ["With the KSF Spatial Bridge", LAYOUTS.filter(needsBridge)],
];
for (const [label, list] of groups) {
  const og = document.createElement("optgroup");
  og.label = label;
  for (const l of list) {
    const o = document.createElement("option");
    o.value = l;
    o.textContent = l;
    og.appendChild(o);
  }
  sel.appendChild(og);
}
let running = false;

function hint() {
  const l = sel.value;
  const n = speakersOf(l).length;
  if (needsBridge(l)) $("hint").textContent = n + " speakers through Windows Spatial Sound. Needs the bridge app running.";
  else if (l.startsWith("9")) $("hint").textContent = "A browser can play at most 7.1, so the two wide speakers are folded into the front. Use 9.0.2 or more with the bridge for real wides.";
  else $("hint").textContent = n + " speakers on the browser's own audio output (set the Windows speaker setup to " + (l.startsWith("5") ? "5.1" : "7.1") + ").";
}

function show(st) {
  running = !!st && st.state === "running";
  $("go").textContent = running ? "Stop" : "Upmix this tab";
  $("go").classList.toggle("stop", running);
  let line = running ? "Upmixing as " + st.layout : "Not running";
  if (running && st.bridge) {
    const b = st.bridgeState;
    if (b === "ok") line += " - bridge: " + st.device + " (" + st.bed + ")";
    else if (b === "connecting") line += " - connecting to the bridge...";
    else if (b === "nospatial") line += " - bridge has no Spatial Sound";
    else line += " - bridge not running";
  }
  if (st && st.error) line = "Could not start: " + st.error;
  $("state").textContent = line;
  const w = [st && st.note, st && st.warn].filter(Boolean).join(" ");
  $("warn").hidden = !w;
  $("warn").textContent = w;
  if (running && st.layout) { sel.value = st.layout; hint(); }
}

async function init() {
  const saved = (await chrome.storage.local.get("layout")).layout;
  sel.value = saved && LAYOUTS.includes(saved) ? saved : "7.0";
  hint();
  show(await chrome.runtime.sendMessage({ cmd: "status" }).catch(() => ({ state: "idle" })));
}

sel.addEventListener("change", hint);
$("go").addEventListener("click", async () => {
  if (running) {
    await chrome.runtime.sendMessage({ cmd: "stop" });
    show({ state: "idle" });
    return;
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await chrome.storage.local.set({ layout: sel.value });
  const r = await chrome.runtime.sendMessage({ cmd: "start", tabId: tab.id, layout: sel.value });
  if (!r || !r.ok) show({ state: "idle", error: r && r.error });
});
chrome.runtime.onMessage.addListener((m) => { if (m.type === "status") show(m.status); });
init();
