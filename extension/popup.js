import "./layouts.js";
const { LAYOUTS, needsBridge, speakersOf } = globalThis.KsfLayouts;

const $ = (id) => document.getElementById(id);
const sel = $("layout");
// Only layouts this system can actually drive are offered:
//  - browser output: 5.0 needs 6 device channels, 7.0 needs 8 (probed here, like the music page does);
//  - with the bridge: the bed the bridge last reported ("7.1.4" = 7 ear-level speakers and 4 heights); before it has
//    ever reported, a 7.1.4 Atmos bed is assumed.
let canUse = () => true;
async function probeCapabilities() {
  let maxCh = 2;
  try { const c = new AudioContext(); maxCh = c.destination.maxChannelCount || 2; c.close().catch(() => {}); } catch (e) { /* no audio */ }
  const dev = (await chrome.storage.local.get("device")).device;
  let ear = 7, tops = 4;
  const m = dev && /^(\d+)\.\d+\.(\d+)$/.exec(String(dev.bed || ""));
  if (m) { ear = +m[1]; tops = +m[2]; }
  canUse = (l) => {
    const [a, , h] = l.split(".");
    const base = +a;
    if (!needsBridge(l)) return base === 5 ? maxCh >= 6 : base === 7 ? maxCh >= 8 : false;
    return base <= ear && +h <= tops;
  };
}
function fillLayouts() {
  sel.textContent = "";
  // Only the best each route can drive: a smaller layout has no use on a system that can do the larger one.
  const best = (list) => (list.length ? [list.reduce((x, y) => (speakersOf(y).length > speakersOf(x).length ? y : x))] : []);
  const groups = [
    ["Browser output (no bridge)", best(LAYOUTS.filter((l) => !needsBridge(l) && canUse(l)))],
    ["With the KSF Spatial Bridge", best(LAYOUTS.filter((l) => needsBridge(l) && canUse(l)))],
  ];
  for (const [label, list] of groups) {
    if (!list.length) continue;
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
}
let running = false;

function hint() {
  const l = sel.value;
  const n = speakersOf(l).length;
  if (needsBridge(l)) $("hint").textContent = n + " speakers through Windows Spatial Sound. Needs the bridge app running." + (l.startsWith("9") ? " Untested: the wide speakers have not been tried on real 9.x hardware." : "");
  else if (l.startsWith("9")) $("hint").textContent = "A browser can play at most 7.1, so the two wide speakers are folded into the front. Use 9.0.2 or more with the bridge for real wides.";
  else $("hint").textContent = n + " speakers on the browser's own audio output (set the Windows speaker setup to " + (l.startsWith("5") ? "5.1" : "7.1") + ").";
}

// The tab's own upmix (the site rule runs it in the page, inpage.js): what that content script reports, or null
let pageSt = null;
function renderPage() {
  const p = pageSt;
  if (!p || !p.rule) return;
  const active = !p.suspended && p.built > 0;
  let line;
  if (p.suspended) line = "Stopped on this tab (reload the tab to start it again)";
  else if (!p.built) line = "Always " + p.rule + " on this site: starts when something plays";
  else {
    line = "Upmixing as " + p.rule + " (in the page)";
    if (p.bridge) {
      if (p.blocked) line += " - the bridge is used by another page, press play here to take it back";
      else if (p.ctxRunning === false) line += " - waiting for a click on the page (the browser blocks the audio until then)";
      else if (p.live) line += " - bridge connected";
      else line += " - connecting to the bridge...";
    }
  }
  $("state").textContent = line;
  $("go").textContent = active ? "Stop" : "Upmix this tab";
  $("go").classList.toggle("stop", active);
}
async function refreshPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  pageSt = tab ? await chrome.tabs.sendMessage(tab.id, { type: "ksf-inpage-status" }).catch(() => null) : null;
  if (!running) { $("go").textContent = "Upmix this tab"; $("go").classList.remove("stop"); if (capErr) $("state").textContent = capErr; else { $("state").textContent = "Not running"; renderPage(); } }
}
let capErr = "";

function show(st) {
  running = !!st && st.state === "running";
  capErr = st && st.error ? "Could not start: " + st.error : "";
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
  if (!running && !capErr) renderPage();
  const w = [st && st.note, st && st.warn].filter(Boolean).join(" ");
  $("warn").hidden = !w;
  $("warn").textContent = w;
  if (running && st.layout && Date.now() - userPicked > 3000) { sel.value = st.layout; hint(); }   // (not while the user is choosing)
}

async function init() {
  await probeCapabilities();
  fillLayouts();
  const saved = (await chrome.storage.local.get("layout")).layout;
  sel.value = saved && LAYOUTS.includes(saved) && canUse(saved) ? saved : (sel.options[0] ? sel.options[0].value : "");
  hint();
  $("pauseOthers").checked = (await chrome.storage.local.get("pauseOthers")).pauseOthers !== false;
  show(await chrome.runtime.sendMessage({ cmd: "status" }).catch(() => ({ state: "idle" })));
  await refreshPage();
  setInterval(refreshPage, 1000);
}

let userPicked = 0;
sel.addEventListener("change", () => { hint(); userPicked = Date.now(); chrome.storage.local.set({ layout: sel.value }); restartIfRunning(); });
// Changing the layout while a tab is being upmixed restarts the upmix with the new one.
async function restartIfRunning() {
  if (!running) return;
  const r = await chrome.runtime.sendMessage({ cmd: "restart", layout: sel.value }).catch((e) => ({ ok: false, error: String(e) }));
  if (r && !r.ok) $("state").textContent = "Could not switch: " + (r.error || "unknown");
}
// What the pause-other-tabs relay last saw, so a silent site can be told apart from a missing script.
async function showLastPlaying() {
  const lp = (await chrome.storage.local.get("lastPlaying")).lastPlaying;
  $("lastPlaying").textContent = lp ? "Last start seen: " + (lp.host || "?") + ", " + Math.round((Date.now() - lp.t) / 1000) + " s ago." : "No playing tab seen yet (reload the music tab).";
}
$("go").addEventListener("click", async () => {
  if (running) {
    await chrome.runtime.sendMessage({ cmd: "stop" });
    show({ state: "idle" });
    return;
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  // a site with a rule upmixes in the page: the button stops it / starts it again (no capture needed)
  if (pageSt && pageSt.rule && (pageSt.suspended || pageSt.built > 0)) {
    await chrome.tabs.sendMessage(tab.id, { type: "ksf-inpage", suspended: !pageSt.suspended }).catch(() => {});
    await new Promise((r) => setTimeout(r, 150));
    await refreshPage();
    return;
  }
  await chrome.storage.local.set({ layout: sel.value });
  const r = await chrome.runtime.sendMessage({ cmd: "start", tabId: tab.id, layout: sel.value });
  if (!r || !r.ok) show({ state: "idle", error: r && r.error });
});
$("pauseOthers").addEventListener("change", () => chrome.storage.local.set({ pauseOthers: $("pauseOthers").checked }));
// Lets the current tab's site take part (asks Chrome for access to it, then injects the script there).
async function joinSite(tab, u) {
  const origin = u.origin + "/*";
  if (!(await chrome.permissions.request({ origins: [origin] }))) return false;
  const id = "ksf-" + u.host;
  try { await chrome.scripting.unregisterContentScripts({ ids: [id] }); } catch (e) { /* not registered yet */ }
  await chrome.scripting.registerContentScripts([{ id, matches: [origin], js: ["layouts.js", "upmix-worklet.js", "pause-others.js", "inpage.js"], runAt: "document_idle", persistAcrossSessions: true }]);
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["layouts.js", "upmix-worklet.js", "pause-others.js", "inpage.js"] }).catch(() => {});
  return true;
}
async function activeSite() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try { const u = new URL(tab.url); if (/^https?:$/.test(u.protocol)) return { tab, u }; } catch (e) { /* no page */ }
  return null;
}
$("addSite").addEventListener("click", async () => {
  const a = await activeSite();
  if (!a) { $("siteHint").textContent = "This page cannot take part."; return; }
  $("siteHint").textContent = (await joinSite(a.tab, a.u)) ? a.u.host + " now takes part." : "Access was not granted.";
});
// Per-site layout: a tab of this site that starts playing is upmixed with the layout saved here, no click needed.
async function saveRule() {
  const a = await activeSite();
  if (!a) { $("siteRule").checked = false; $("siteHint").textContent = "This page cannot be upmixed automatically."; return; }
  const sites = (await chrome.storage.local.get("sites")).sites || {};
  if ($("siteRule").checked) {
    if (!(await joinSite(a.tab, a.u))) { $("siteRule").checked = false; $("siteHint").textContent = "Access was not granted."; return; }
    sites[a.u.host] = sel.value;
    $("siteHint").textContent = a.u.host + ": always " + sel.value + ".";
    // The page's own audio is upmixed in the page (inpage.js) from its next play on; no capture and no click per tab.
  } else {
    delete sites[a.u.host];
    $("siteHint").textContent = a.u.host + ": upmix only when started by hand.";
  }
  await chrome.storage.local.set({ sites });
}
$("siteRule").addEventListener("change", saveRule);
sel.addEventListener("change", async () => {
  if (!$("siteRule").checked) return;
  const a = await activeSite();
  if (!a) return;
  const sites = (await chrome.storage.local.get("sites")).sites || {};
  sites[a.u.host] = sel.value;
  await chrome.storage.local.set({ sites });
});
async function showRule() {
  const a = await activeSite();
  if (!a) { $("siteRule").disabled = true; return; }
  $("siteRuleText").textContent = "Always upmix " + a.u.host + " with this layout";
  const sites = (await chrome.storage.local.get("sites")).sites || {};
  if (sites[a.u.host] && LAYOUTS.includes(sites[a.u.host]) && canUse(sites[a.u.host])) { $("siteRule").checked = true; sel.value = sites[a.u.host]; hint(); }
}
chrome.runtime.onMessage.addListener((m) => { if (m.type === "status") show(m.status); });
$("version").textContent = "v" + chrome.runtime.getManifest().version;
init().then(showRule).then(showLastPlaying);
