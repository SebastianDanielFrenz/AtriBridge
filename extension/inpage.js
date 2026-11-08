// In-page upmix: for a site with a saved layout (popup: "Always upmix <site>"), the page's own <video>/<audio> element
// is routed through a Web Audio graph made here, so no tab capture - and so no click per tab - is needed.
//  - A browser layout (5.0, 7.0, 9.0): element -> upmix -> the device's channels.
//  - A bridge layout (x.x.2 ...): element -> upmix -> blocks relayed through the extension's offscreen page to the
//    KSF Spatial Bridge (the bridge only accepts its own sites and the extension as origin, not youtube.com).
// Limits: media from another origin without CORS plays silence through Web Audio (YouTube's blob: streams are fine);
// a failed setup puts the element back on the plain output and asks the background script to flag it.
(() => {
  if (window.__ksfInpage) return;
  window.__ksfInpage = true;
  const entries = new WeakMap();                 // element -> entry
  const live = new Set();                        // entries, to rebuild them when the saved layout changes
  let cfg = { layout: null, style: "equal" };
  let suspended = false;                         // the tab is under capture: this route stays out of the way
  const layouts = () => globalThis.KsfLayouts;     // layouts.js is the first content script

  async function loadCfg() {
    const st = await chrome.storage.local.get(["sites", "style"]);
    cfg = { layout: (st.sites || {})[location.host] || null, style: st.style || "equal" };
  }

  function b64(i16) {
    const u = new Uint8Array(i16.buffer, i16.byteOffset, i16.byteLength);
    let s = "";
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(s);
  }

  // The route to the bridge for one entry: a port to the offscreen page, opened while the element plays.
  function bridgeRoute(e) {
    let port = null, closeT = 0;
    const r = {
      live: false,
      async open() {
        clearTimeout(closeT);
        if (port || r.opening) return;
        r.opening = true;
        // the offscreen page that holds the socket may not exist yet
        try { await chrome.runtime.sendMessage({ type: "ksf-ensure-offscreen" }); } catch (err) { r.opening = false; return; }
        r.opening = false;
        if (port || e.route !== r) return;
        try {
          port = chrome.runtime.connect({ name: "ksf-inpage" });
        } catch (err) { port = null; return; }
        const mine = port;
        port.onMessage.addListener((m) => {
          if (port !== mine) return;
          if (m.t === "info") { r.live = true; e.setBridge(true); }
          else if (m.t === "gone" || m.t === "closed" || m.t === "replaced") { r.live = false; e.setBridge(false); if (m.t === "replaced") r.drop(); }
        });
        port.onDisconnect.addListener(() => { if (port === mine) { port = null; r.live = false; e.setBridge(false); } });
        port.postMessage({ t: "open", rate: e.ctx.sampleRate, speakers: e.speakers.join(",") });
      },
      send(f32) {
        if (!port || !r.live) return;
        const i16 = new Int16Array(f32.length);
        for (let i = 0; i < f32.length; i++) { const x = f32[i]; i16[i] = x >= 1 ? 32767 : x <= -1 ? -32768 : Math.round(x * 32767); }
        try { port.postMessage({ t: "b", d: b64(i16) }); } catch (err) { /* port is gone */ }
      },
      closeSoon() { clearTimeout(closeT); closeT = setTimeout(() => r.drop(), 2500); },   // paused: let the bridge go to another tab
      drop() { clearTimeout(closeT); if (port) { try { port.disconnect(); } catch (err) { /* gone */ } } port = null; r.live = false; e.setBridge(false); },
    };
    return r;
  }

  async function build(e) {
    const L = layouts();
    if (!L) throw new Error("layouts.js was not loaded in this page (reload the tab)");
    teardown(e);
    if (suspended) { e.pass.gain.value = 1; return; }
    if (!cfg.layout || !L.LAYOUTS.includes(cfg.layout)) { e.pass.gain.value = 1; return; }     // no rule: plain output
    const bridge = L.needsBridge(cfg.layout);
    let speakers, ch = 2;
    if (bridge) speakers = L.speakersOf(cfg.layout);
    else {
      const max = e.ctx.destination.maxChannelCount || 2;
      const want = L.speakersOf(cfg.layout).length + 1;
      ch = max >= 8 && want > 6 ? 8 : max >= 6 ? 6 : 2;
      speakers = L.DIRECT_ORDER[ch];
    }
    e.speakers = speakers;
    const opts = { speakers, emit: bridge, style: cfg.style, rate: e.ctx.sampleRate };
    let node;
    try {
      await e.ctx.audioWorklet.addModule(chrome.runtime.getURL("upmix-worklet.js"));
      node = new AudioWorkletNode(e.ctx, "ksf-upmix", {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [speakers.length],
        channelCount: 2, channelCountMode: "explicit", processorOptions: opts,
      });
      node.port.onmessage = (ev) => { if (e.route) e.route.send(new Float32Array(ev.data)); };
      e.how = "worklet";
    } catch (err) {
      // the page's policy refused the module: the same class on a ScriptProcessor (main thread, so it can glitch with a busy page)
      const dsp = new globalThis.KsfUpmix({ processorOptions: opts });
      const sp = e.ctx.createScriptProcessor(2048, 2, speakers.length);
      dsp.port = { postMessage: (buf) => { if (e.route) e.route.send(new Float32Array(buf)); } };
      sp.onaudioprocess = (ev) => {
        const out = [];
        for (let c = 0; c < speakers.length; c++) out.push(ev.outputBuffer.getChannelData(c));
        dsp.process([[ev.inputBuffer.getChannelData(0), ev.inputBuffer.getChannelData(1)]], [out]);
      };
      node = sp;
      e.how = "scriptprocessor";
    }
    e.node = node;
    e.src.connect(node);
    if (bridge) {
      const mute = e.ctx.createGain();
      mute.gain.value = 0;                              // the node must be pulled; the bridge plays, not the browser
      node.connect(mute).connect(e.ctx.destination);
      e.mute = mute;
      e.route = bridgeRoute(e);
      e.pass.gain.value = 1;                            // until the bridge answers: plain stereo
      if (!e.el.paused) e.route.open();
    } else {
      e.ctx.destination.channelCount = speakers.length;
      e.ctx.destination.channelCountMode = "explicit";
      e.ctx.destination.channelInterpretation = "discrete";
      node.connect(e.ctx.destination);
      e.pass.gain.value = 0;
    }
    console.debug("[ksf-upmix] in-page upmix on", location.host, cfg.layout, cfg.style, e.how, speakers.length + " ch");
  }

  function teardown(e) {
    if (e.route) { e.route.drop(); e.route = null; }
    if (e.node) { try { e.src.disconnect(e.node); } catch (err) { /* gone */ } try { e.node.disconnect(); } catch (err) { /* gone */ } e.node = null; }
    if (e.mute) { try { e.mute.disconnect(); } catch (err) { /* gone */ } e.mute = null; }
    try { e.ctx.destination.channelCount = 2; e.ctx.destination.channelCountMode = "explicit"; e.ctx.destination.channelInterpretation = "speakers"; } catch (err) { /* as is */ }
  }

  async function attach(el) {
    if (entries.has(el)) return;
    const ctx = new AudioContext({ latencyHint: "interactive" });
    let src;
    try { src = ctx.createMediaElementSource(el); } catch (err) { ctx.close().catch(() => {}); return; }   // already routed by the page
    const pass = ctx.createGain();                      // the plain way to the speakers, open when no upmix is active
    src.connect(pass).connect(ctx.destination);
    const e = {
      el, ctx, src, pass, node: null, mute: null, route: null, speakers: [], how: "",
      setBridge(on) { pass.gain.setTargetAtTime(on ? 0 : 1, ctx.currentTime, 0.01); },
    };
    entries.set(el, e);
    live.add(e);
    const wake = () => { if (ctx.state !== "running") ctx.resume().catch(() => {}); if (e.route) e.route.open(); };
    el.addEventListener("playing", wake);
    el.addEventListener("play", wake);
    for (const ev of ["pause", "ended", "emptied"]) el.addEventListener(ev, () => { if (e.route) e.route.closeSoon(); });
    try {
      await build(e);
      wake();
    } catch (err) {
      console.warn("[ksf-upmix] in-page upmix failed, plain output restored:", err);
      try { teardown(e); } catch (x) { /* as is */ }
      pass.gain.value = 1;
      chrome.runtime.sendMessage({ type: "ksf-inpage-failed", why: String((err && err.message) || err) }).catch(() => {});
    }
  }

  function consider(el) {
    if (!cfg.layout || suspended || !(el instanceof HTMLMediaElement) || el.muted || el.volume === 0) return;
    if (!chrome.runtime || !chrome.runtime.id) return;
    attach(el);
  }
  const onPlay = (ev) => consider(ev.target);
  document.addEventListener("playing", onPlay, true);
  document.addEventListener("play", onPlay, true);

  chrome.runtime.onMessage.addListener((m) => {
    if (m.type !== "ksf-inpage") return;
    suspended = !!m.suspended;
    for (const e of live) build(e).catch(() => { e.pass.gain.value = 1; });
    if (!suspended && cfg.layout) for (const el of document.querySelectorAll("audio, video")) if (!el.paused) consider(el);
  });
  chrome.storage.onChanged.addListener(async (c) => {
    if (!c.sites && !c.style) return;
    await loadCfg();
    for (const e of live) build(e).catch(() => { e.pass.gain.value = 1; });
    if (cfg.layout) for (const el of document.querySelectorAll("audio, video")) if (!el.paused) consider(el);
  });
  loadCfg().then(() => { if (cfg.layout) for (const el of document.querySelectorAll("audio, video")) if (!el.paused) consider(el); });
})();
