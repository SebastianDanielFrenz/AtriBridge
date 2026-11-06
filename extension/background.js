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
  const r = await chrome.runtime.sendMessage({ target: "offscreen", cmd: "start", streamId, layout });
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
  if (m.cmd === "status") {
    chrome.offscreen.hasDocument().then(async (has) => {
      if (!has) return reply({ state: "idle" });
      reply(await chrome.runtime.sendMessage({ target: "offscreen", cmd: "status" }).catch(() => ({ state: "idle" })));
    });
    return true;
  }
});

chrome.tabs.onRemoved.addListener((id) => { if (id === capturedTab) stop(); });
