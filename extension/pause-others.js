// Runs in the pages that take part: when something in this tab starts playing, the other taking-part tabs are paused
// (the background script relays it), like Enhancer for YouTube does between YouTube tabs. A muted element does not
// count: YouTube's silent hover previews must not pause the music.
(() => {
  if (window.__ksfPauseOthers) return;
  window.__ksfPauseOthers = true;
  let enabled = true;
  chrome.storage.local.get("pauseOthers").then((r) => { enabled = r.pauseOthers !== false; }).catch(() => {});
  chrome.storage.onChanged.addListener((c) => { if (c.pauseOthers) enabled = c.pauseOthers.newValue !== false; });
  document.addEventListener("playing", (e) => {
    const el = e.target;
    if (!enabled || !(el instanceof HTMLMediaElement) || el.muted || el.volume === 0) return;
    chrome.runtime.sendMessage({ type: "ksf-playing" }).catch(() => {});
  }, true);
  chrome.runtime.onMessage.addListener((m) => {
    if (m.type !== "ksf-pause" || !enabled) return;
    for (const el of document.querySelectorAll("audio, video")) if (!el.paused && !el.muted) el.pause();
  });
})();
