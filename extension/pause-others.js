// Runs in the pages that take part: when something in this tab STARTS playing, the other taking-part tabs are paused
// (the background script relays it), like Enhancer for YouTube does between YouTube tabs. A muted element does not
// count: YouTube's silent hover previews must not pause the music.
// Only a start counts, not every "playing" event: YouTube fires "playing" again after each rebuffer, and each one used
// to pause the other tab again (user, 2026-11-08: the music page paused about once a second while YouTube was paused).
// A tab that was just paused by another one does not answer with a pause of its own unless the user touched it.
(() => {
  if (window.__ksfPauseOthers) return;
  window.__ksfPauseOthers = true;
  let enabled = true;
  if (!chrome.storage) return;
  chrome.storage.local.get("pauseOthers").then((r) => { enabled = r.pauseOthers !== false; }).catch(() => {});
  chrome.storage.onChanged.addListener((c) => { if (c.pauseOthers) enabled = c.pauseOthers.newValue !== false; });
  const announced = new WeakSet();               // elements whose current play has been announced
  let pausedByOtherAt = 0;
  function announce(el) {
    if (!enabled || !(el instanceof HTMLMediaElement) || announced.has(el)) return;
    if (el.muted || el.volume === 0) return;
    if (Date.now() - pausedByOtherAt < 10000 && !(navigator.userActivation && navigator.userActivation.isActive)) {
      console.info("[ksf-upmix] resumed by the page right after another tab paused it: not pausing the other tab back");
      return;
    }
    announced.add(el);
    console.info("[ksf-upmix] started playing here, pausing the other tabs");
    // After the extension is reloaded or updated this copy of the script stays in the open tab with a dead connection
    // (sendMessage then throws "Extension context invalidated"): it quietly stops until the tab is reloaded.
    try {
      if (!chrome.runtime || !chrome.runtime.id) { stopListening(); return; }
      chrome.runtime.sendMessage({ type: "ksf-playing" }).catch(() => {});
    } catch (err) { stopListening(); }
  }
  const onPlay = (e) => announce(e.target);
  const onStop = (e) => { if (e.target instanceof HTMLMediaElement) announced.delete(e.target); };
  function stopListening() {
    for (const ev of ["playing", "play"]) document.removeEventListener(ev, onPlay, true);
    for (const ev of ["pause", "ended", "emptied"]) document.removeEventListener(ev, onStop, true);
  }
  // "play" and "playing": a page that starts a stream through Web Audio may not get a clean one of either.
  document.addEventListener("playing", onPlay, true);
  document.addEventListener("play", onPlay, true);
  for (const ev of ["pause", "ended", "emptied"]) document.addEventListener(ev, onStop, true);

  // YouTube and YouTube Music start a video again when a script merely calls pause() on the element, so there the
  // player's own button is pressed (what the user would do), and the element is only paused if that did not work.
  const YT = /(^|\.)youtube\.com$/.test(location.hostname);
  const playingEls = () => [...document.querySelectorAll("audio, video")].filter((el) => !el.paused && !el.muted);
  function pressYoutubePlayButton() {
    for (const sel of ["ytmusic-player-bar #play-pause-button", ".ytp-play-button"]) {
      const b = document.querySelector(sel);
      if (b) { b.click(); return true; }
    }
    return false;
  }
  function pauseHere(why) {
    const els = playingEls();
    if (!els.length) return;
    pausedByOtherAt = Date.now();
    console.info("[ksf-upmix] pausing here: " + why);
    if (YT && pressYoutubePlayButton()) {
      setTimeout(() => { for (const el of playingEls()) el.pause(); }, 600);
    } else {
      for (const el of els) el.pause();
    }
  }
  globalThis.KsfPauseHere = pauseHere;            // inpage.js: this page lost the bridge, so it stops
  chrome.runtime.onMessage.addListener((m) => {
    if (m.type === "ksf-pause-forced") { pauseHere("the bridge was taken by another page"); return; }   // not subject to the setting
    if (m.type !== "ksf-pause" || !enabled) return;
    pauseHere((m.from || "another tab") + " started playing");
  });
})();
