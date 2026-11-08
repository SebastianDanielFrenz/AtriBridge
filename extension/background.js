// The popup asks for a capture; the capture itself lives in the offscreen document (a service worker has
// no audio). Chrome mutes a captured tab's own sound: what you hear is the upmix.
let capturedTab = null;

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html", reasons: ["USER_MEDIA", "AUDIO_PLAYBACK"], justification: "Upmix the captured tab's audio",
  });
}

async function start(tabId, layout) {
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  await ensureOffscreen();
  const style = (await chrome.storage.local.get("style")).style || "equal";
  const r = await chrome.runtime.sendMessage({ target: "offscreen", cmd: "start", streamId, layout, style });
  if (r && r.ok) capturedTab = tabId;
  return r;
}

async function stop() {
  capturedTab = null;
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
    if (capturedTab == null) { reply({ ok: false }); return true; }
    start(capturedTab, m.layout).then(reply, (e) => reply({ ok: false, error: String((e && e.message) || e) }));
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

chrome.tabs.onRemoved.addListener((id) => { if (id === capturedTab) stop(); });

// A tab that starts playing pauses every other taking-part tab (the content script of each one acts on it).
chrome.runtime.onMessage.addListener((m, sender) => {
  if (m.type !== "ksf-playing" || !sender.tab) return;
  chrome.tabs.query({}).then((tabs) => {
    for (const t of tabs) if (t.id !== sender.tab.id) chrome.tabs.sendMessage(t.id, { type: "ksf-pause" }).catch(() => {});
  });
  autoUpmix(sender.tab);
});

// A site with a saved layout (popup: "Always upmix ...") is upmixed as soon as a tab of it starts playing. Only one
// capture exists at a time: this tab replaces the previous one, which is paused by the code above anyway.
// Starting a capture makes the tab's media element stall and fire "playing" again; without the guards below every one
// of those events restarted the capture (user, 2026-11-08: half a second of sound, 2 s of silence, forever).
const autoTried = new Map();
async function autoUpmix(tab) {
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
    chrome.action.setTitle({ title: "Auto-upmix failed: " + ((r && r.error) || "unknown") + ". Click the icon and press Upmix this tab.", tabId: tab.id });
  }
}
