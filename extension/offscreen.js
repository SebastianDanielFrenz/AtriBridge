// Holds the captured tab audio, the upmixer and (for heights) the connection to the KSF Spatial Bridge.
import "./layouts.js";
const { speakersOf, needsBridge, DIRECT_ORDER } = globalThis.KsfLayouts;

const BRIDGE_URL = "ws://127.0.0.1:47321";
let ctx = null, stream = null, node = null, ws = null, running = false, retry = null;
let status = { state: "idle" };
let replaced = false, capSpeakers = null;


function setStatus(patch) {
  status = { ...status, ...patch };
  chrome.runtime.sendMessage({ type: "status", status }).catch(() => {});
}

async function start({ streamId, layout }) {
  await stop(true);
  replaced = false; openAt = 0;
  const bridge = needsBridge(layout);
  stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
  });
  // The bridge path is fixed at 48 kHz (the app resamples nothing). The browser-output path takes the device's own
  // rate, like the music page does: a forced rate gave 2 channels on a device whose 7.1 the page reaches (user, 2026-11-08).
  ctx = new AudioContext(bridge ? { sampleRate: 48000, latencyHint: "interactive" } : { latencyHint: "interactive" });
  await ctx.audioWorklet.addModule("upmix-worklet.js");
  const src = ctx.createMediaStreamSource(stream);
  let speakers, note = "";
  if (bridge) {
    speakers = speakersOf(layout);
  } else {
    const max = ctx.destination.maxChannelCount || 2;
    const want = speakersOf(layout).length + 1;           // + LFE
    const ch = max >= 8 && want > 6 ? 8 : max >= 6 ? 6 : 2;
    speakers = DIRECT_ORDER[ch];
    const lost = speakersOf(layout).filter((s) => !speakers.includes(s));
    if (lost.length) {
      note = "The browser sees " + max + " output channels. This output only has " + (ch === 2 ? "stereo" : ch === 6 ? "5.1" : "7.1") + ": " + lost.join(", ") +
        " are folded into the nearest speaker." + (ch < 8 ? " Set the Windows speaker setup to 7.1 for the full bed." : "");
    }
  }
  node = new AudioWorkletNode(ctx, "ksf-upmix", {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [speakers.length],
    channelCount: 2, channelCountMode: "explicit",
    processorOptions: { speakers, emit: bridge },
  });
  src.connect(node);
  if (bridge) {
    const mute = ctx.createGain();                      // the worklet must be pulled; the bridge plays, not the browser
    mute.gain.value = 0;
    node.connect(mute).connect(ctx.destination);
    node.port.onmessage = (e) => { if (ws && ws.readyState === 1 && ws.bufferedAmount < (1 << 20)) ws.send(e.data); };
    running = true;
    capSpeakers = speakers;
    connectBridge(speakers);
  } else {
    ctx.destination.channelCount = speakers.length;
    ctx.destination.channelCountMode = "explicit";
    ctx.destination.channelInterpretation = "discrete";
    node.connect(ctx.destination);
    running = true;
  }
  setStatus({ state: "running", layout, bridge, note, warn: "", error: "", channels: speakers.length, bridgeState: bridge ? "connecting" : "off" });
}

let openAt = 0, shortLives = 0;
function connectBridge(speakers) {
  if (!running) return;
  ws = new WebSocket(BRIDGE_URL);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => { openAt = Date.now(); ws.send(JSON.stringify({ type: "hello", rate: 48000, speakers: speakers.join(",") })); };
  ws.onmessage = (e) => {
    if (typeof e.data !== "string") return;
    let m;
    try { m = JSON.parse(e.data); } catch (err) { return; }
    if (m.type === "info") {
      chrome.storage.local.set({ device: { bed: m.bed, objects: m.objects || 0, name: m.device, t: Date.now() } }).catch(() => {});
      const need = speakers.length, have = m.objects || 0;
      setStatus({
        bridgeState: "ok", device: m.device, bed: m.bed, objects: have,
        warn: have && need > have ? "The output offers " + have + " speaker objects, this layout has " + need + ": the extra ones are folded." : "",
      });
    } else if (m.type === "replaced") {          // another page or tab took the app: do not take it back in a loop
      replaced = true;
      chrome.runtime.sendMessage({ type: "ksf-bridge-taken" }).catch(() => {});      // the captured tab pauses
      setStatus({ bridgeState: "taken", warn: "The bridge is in use by another page. Press play on the tab to take it back." });
    } else if (m.type === "gone") {
      setStatus({ bridgeState: "nospatial", warn: "Turn on Windows Spatial Sound (Dolby Atmos / Windows Sonic) for the default output." });
    }
  };
  ws.onclose = () => {
    ws = null;
    if (!running || replaced) return;
    if (openAt) { replaced = true; chrome.runtime.sendMessage({ type: "ksf-bridge-taken" }).catch(() => {}); setStatus({ bridgeState: "taken", warn: "The bridge connection ended. Press play on the tab to take it back." }); return; }   // it was up: no re-claiming, the user starts it again
    setStatus({ bridgeState: "missing" });
    retry = setTimeout(() => connectBridge(speakers), 2000);
  };
  ws.onerror = () => {};
}

// ---- relay for the in-page upmix (inpage.js): a content script cannot open a socket to the bridge (it would present
// the page's origin, which the bridge refuses), so its blocks come here over a port and go out as this extension.
let inpage = null;
function closeInpage() {
  if (!inpage) return;
  const me = inpage;
  inpage = null;
  me.dead = true;
  clearTimeout(me.retry);
  if (me.ws) { try { me.ws.close(); } catch (e) {} me.ws = null; }
}
function connectInpageWs(me) {
  if (me.dead) return;
  const ws = new WebSocket(BRIDGE_URL);
  me.ws = ws;
  ws.binaryType = "arraybuffer";
  ws.onopen = () => { me.openAt = Date.now(); ws.send(JSON.stringify({ type: "hello", rate: me.rate, speakers: me.speakers })); };
  ws.onmessage = (e) => {
    if (typeof e.data !== "string") return;
    let m;
    try { m = JSON.parse(e.data); } catch (err) { return; }
    if (m.type === "info") {
      chrome.storage.local.set({ device: { bed: m.bed, objects: m.objects || 0, name: m.device, t: Date.now() } }).catch(() => {});
      me.port.postMessage({ t: "info" });
    }
    else if (m.type === "gone") me.port.postMessage({ t: "gone" });
    else if (m.type === "replaced") { me.replaced = true; me.port.postMessage({ t: "replaced" }); }
  };
  ws.onclose = () => {
    if (me.dead || me.replaced) return;
    // once it was up, a loss means another client has it (or the app quit): the page stops, no re-claiming; only
    // "the app is not there yet" is retried
    if (me.openAt) { me.replaced = true; try { me.port.postMessage({ t: "replaced" }); } catch (err) {} return; }
    try { me.port.postMessage({ t: "closed" }); } catch (err) {}
    me.retry = setTimeout(() => connectInpageWs(me), 2000);
  };
  ws.onerror = () => {};
}
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "ksf-inpage") return;
  if (inpage) { try { inpage.port.postMessage({ t: "superseded" }); inpage.port.disconnect(); } catch (e) {} closeInpage(); }
  const me = { port, ws: null, rate: 48000, speakers: "", dead: false, replaced: false, retry: 0 };
  inpage = me;
  port.onMessage.addListener((m) => {
    if (m.t === "open") { me.rate = m.rate || 48000; me.speakers = m.speakers || ""; connectInpageWs(me); }
    else if (m.t === "b" && me.ws && me.ws.readyState === 1 && me.ws.bufferedAmount < (1 << 20)) {
      const bin = atob(m.d), n = bin.length >> 1, f = new Float32Array(n);
      for (let i = 0; i < n; i++) { const v = (bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8)) << 16 >> 16; f[i] = v / 32768; }
      me.ws.send(f.buffer);
    }
  });
  port.onDisconnect.addListener(() => { if (inpage === me) closeInpage(); });
});

async function stop(quiet) {
  running = false;
  clearTimeout(retry);
  if (ws) { try { ws.close(); } catch (e) {} ws = null; }
  if (node) { try { node.disconnect(); } catch (e) {} node = null; }
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  if (ctx) { try { await ctx.close(); } catch (e) {} ctx = null; }
  if (!quiet) setStatus({ state: "idle", bridgeState: "off", note: "", warn: "" });
}

chrome.runtime.onMessage.addListener((m, _sender, reply) => {
  if (m.target !== "offscreen") return;
  if (m.cmd === "start") {
    start(m).then(() => reply({ ok: true }), (e) => {
      const msg = String((e && e.message) || e);
      setStatus({ state: "idle", error: msg });
      reply({ ok: false, error: msg });
    });
  } else if (m.cmd === "stop") {
    stop().then(() => reply({ ok: true }));
  } else if (m.cmd === "status") {
    reply(status);
  } else if (m.cmd === "reclaim") {            // the captured tab was started again by the user: take the bridge back
    if (running && replaced && capSpeakers && !ws) { replaced = false; openAt = 0; connectBridge(capSpeakers); }
    reply({ ok: true });
  }
  return true;
});
