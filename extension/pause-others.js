// Runs in the pages that take part: when something in this tab starts playing, the other taking-part tabs are paused
// (the background script relays it), like Enhancer for YouTube does between YouTube tabs. A muted element does not
// count: YouTube's silent hover previews must not pause the music.
(() => {
  if (window.__ksfPauseOthers) return;
  window.__ksfPauseOthers = true;
  let enabled = true;
  chrome.storage.local.get("pauseOthers").then((r) => { enabled = r.pauseOthers !== false; }).catch(() => {});
  chrome.storage.onChanged.addListener((c) => { if (c.pauseOthers) enabled = c.pauseOthers.newValue !== false; });
  function onPlaying(e) {
    const el = e.target;
    if (!enabled || !(el instanceof HTMLMediaElement)) return;
    if (el.muted || el.volume === 0) { console.debug("[ksf-upmix] ignored a muted element"); return; }
    console.debug("[ksf-upmix] playing here, pausing the other tabs");
    // After the extension is reloaded or updated this copy of the script stays in the open tab with a dead connection
    // (sendMessage then throws "Extension context invalidated"): it quietly stops until the tab is reloaded.
    try {
      if (!chrome.runtime || !chrome.runtime.id) { stopListening(); return; }
      chrome.runtime.sendMessage({ type: "ksf-playing" }).catch(() => {});
    } catch (err) { stopListening(); }
  }
  // "play" too: a page that starts a stream through Web Audio may not get a clean "playing" before it is audible.
  function stopListening() { document.removeEventListener("playing", onPlaying, true); document.removeEventListener("play", onPlaying, true); }
  document.addEventListener("playing", onPlaying, true);
  document.addEventListener("play", onPlaying, true);
  chrome.runtime.onMessage.addListener((m) => {
    if (m.type !== "ksf-pause" || !enabled) return;
    for (const el of document.querySelectorAll("audio, video")) if (!el.paused && !el.muted) el.pause();
  });
})();
