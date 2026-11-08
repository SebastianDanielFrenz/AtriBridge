// The popup asks for a capture; the capture itself lives in the offscreen document (a service worker has
// no audio). Chrome mutes a captured tab's own sound: what you hear is the upmix.
let capturedTab = null;
// The service worker is stopped after ~30 s idle and forgets its variables; the captured tab survives in session storage.
const capturedReady = chrome.storage.session.get("capturedTab").then((r) => { if (capturedTab == null && r.capturedTab != null) capturedTab = r.capturedTab; }).catch(() => {});
function setCaptured(id) { capturedTab = id; chrome.storage.session.set({ capturedTab: id }).catch(() => {}); }

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html", reasons: ["USER_MEDIA", "WORKERS"], justification: "Upmix the captured tab's audio and relay the in-page upmix to the bridge",
  });
}

async function start(tabId, layout) {
  await capturedReady;
  // A tab that is already being captured cannot get a new stream id: let the running capture go first (a restart
  // from the popup, user 2026-11-08: "changing the layout during an upmix is not possible").
  if (await chrome.offscreen.hasDocument()) await chrome.runtime.sendMessage({ target: "offscreen", cmd: "stop" }).catch(() => {});
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  await ensureOffscreen();
  const style = (await chrome.storage.local.get("style")).style || "equal";
  const r = await chrome.runtime.sendMessage({ target: "offscreen", cmd: "start", streamId, layout, style });
  if (r && r.ok) { setCaptured(tabId); inpageSuspend(tabId, true); }      // the capture takes the tab: the in-page upmix steps aside
  return r;
}

// One route at a time per tab: a tab under capture must not also relay its own in-page upmix to the bridge (two
// sockets taking the bridge from each other: audio drops).
function inpageSuspend(tabId, on) { if (tabId != null) chrome.tabs.sendMessage(tabId, { type: "ksf-inpage", suspended: on }).catch(() => {}); }

async function stop() {
  const was = capturedTab;
  setCaptured(null);
  inpageSuspend(was, false);
  if (await chrome.offscreen.hasDocument()) {
    await chrome.runtime.sendMessage({ target: "offscreen", cmd: "stop" }).catch(() => {});
    await chrome.offscreen.closeDocument().catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((m, _sender, reply) => {
  if (m.target) return;
  if (m.cmd === "start") {
    start(m.tabId, m.layout).then(reply, (e) => reply({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
  if (m.cmd === "stop") {
    stop().then(() => reply({ ok: true }));
    return true;
  }
  if (m.cmd === "restart") {                 // layout or style changed in the popup while a tab is being upmixed
    capturedReady.then(() => {
      if (capturedTab == null) return reply({ ok: false, error: "no tab is being upmixed" });
      return start(capturedTab, m.layout).then(reply, (e) => reply({ ok: false, error: String((e && e.message) || e) }));
    });
    return true;
  }
  if (m.cmd === "status") {
    chrome.offscreen.hasDocument().then(async (has) => {
      if (!has) return reply({ state: "idle" });
      reply(await chrome.runtime.sendMessage({ target: "offscreen", cmd: "status" }).catch(() => ({ state: "idle" })));
    });
    return true;
  }
});

chrome.tabs.onRemoved.addListener(async (id) => { await capturedReady; if (id === capturedTab) stop(); });

// A tab that starts playing pauses every other taking-part tab (the content script of each one acts on it).
chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (m.type === "ksf-ensure-offscreen") { ensureOffscreen().then(() => reply({ ok: true }), () => reply({ ok: false })); return true; }
  if (m.type === "ksf-inpage-failed" && sender.tab) {
    chrome.action.setBadgeBackgroundColor({ color: "#ef4444" });
    chrome.action.setBadgeText({ text: "!", tabId: sender.tab.id });
    chrome.action.setTitle({ title: "The in-page upmix could not start here (" + m.why + "). Press Alt+Shift+U to upmix this tab by capture instead.", tabId: sender.tab.id });
    return;
  }
  if (m.type !== "ksf-playing" || !sender.tab) return;
  let host = "";
  try { host = new URL(sender.tab.url).host; } catch (e) { /* no url */ }
  chrome.storage.local.set({ lastPlaying: { host, t: Date.now() } }).catch(() => {});
  chrome.tabs.query({}).then((tabs) => {
    for (const t of tabs) if (t.id !== sender.tab.id) chrome.tabs.sendMessage(t.id, { type: "ksf-pause" }).catch(() => {});
  });
});

// A site with a saved layout (popup: "Always upmix ...") is upmixed as soon as a tab of it starts playing. Only one
// capture exists at a time: this tab replaces the previous one, which is paused by the code above anyway.
// Starting a capture makes the tab's media element stall and fire "playing" again; without the guards below every one
// of those events restarted the capture (user, 2026-11-08: half a second of sound, 2 s of silence, forever).
const autoTried = new Map();
async function autoUpmix(tab) {
  await capturedReady;
  if (tab.id === capturedTab) return;
  const last = autoTried.get(tab.id) || 0;
  if (Date.now() - last < 15000) return;          // one attempt per tab per 15 s, whatever the result
  autoTried.set(tab.id, Date.now());
  let host;
  try { host = new URL(tab.url).host; } catch (e) { return; }
  const layout = ((await chrome.storage.local.get("sites")).sites || {})[host];
  if (!layout) return;
  const r = await start(tab.id, layout).catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
  if (!r || !r.ok) {
    chrome.action.setBadgeBackgroundColor({ color: "#ef4444" });
    chrome.action.setBadgeText({ text: "!", tabId: tab.id });
    chrome.action.setTitle({ title: "Auto-upmix needs one click per tab: Chrome only allows capturing a tab after you invoked the extension on it. Press Alt+Shift+U on this tab (or open the popup once). Chrome said: " + ((r && r.error) || "unknown"), tabId: tab.id });
  }
}

// Alt+Shift+U (change it at chrome://extensions/shortcuts): Chrome counts a shortcut as invoking the extension on the
// tab, which is what allows capturing it. Upmixes the active tab with its site's saved layout, or stops it.
chrome.commands.onCommand.addListener(async (cmd, tab) => {
  if (cmd !== "toggle-upmix") return;
  await capturedReady;
  if (!tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  if (tab.id === capturedTab) { await stop(); return; }
  let host = "";
  try { host = new URL(tab.url).host; } catch (e) { /* no url */ }
  const st = await chrome.storage.local.get(["sites", "layout"]);
  const layout = (st.sites || {})[host] || st.layout || "7.0";
  const r = await start(tab.id, layout).catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
  if (!r || !r.ok) {
    chrome.action.setBadgeBackgroundColor({ color: "#ef4444" });
    chrome.action.setBadgeText({ text: "!", tabId: tab.id });
    chrome.action.setTitle({ title: "Could not upmix: " + ((r && r.error) || "unknown"), tabId: tab.id });
  } else {
    chrome.action.setBadgeText({ text: "", tabId: tab.id });
  }
});

// Sites the user added in the popup were registered with the script list of the version that added them; after an
// update they get the current list.
chrome.runtime.onInstalled.addListener(async () => {
  try {
    const reg = await chrome.scripting.getRegisteredContentScripts();
    const ids = reg.filter((r) => r.id.startsWith("ksf-")).map((r) => r.id);
    if (ids.length) await chrome.scripting.updateContentScripts(ids.map((id) => ({ id, js: ["layouts.js", "upmix-worklet.js", "pause-others.js", "inpage.js"] })));
  } catch (e) { /* none registered */ }
});
