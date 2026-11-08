// Holds the captured tab audio, the upmixer and (for heights) the connection to the KSF Spatial Bridge.
import { speakersOf, needsBridge, DIRECT_ORDER } from "./layouts.js";

const BRIDGE_URL = "ws://127.0.0.1:47321";
let ctx = null, stream = null, node = null, ws = null, running = false, retry = null;
let status = { state: "idle" };
let replaced = false;


function setStatus(patch) {
  status = { ...status, ...patch };
  chrome.runtime.sendMessage({ type: "status", status }).catch(() => {});
}

async function start({ streamId, layout }) {
  await stop(true);
  replaced = false;
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

function connectBridge(speakers) {
  if (!running) return;
  ws = new WebSocket(BRIDGE_URL);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => ws.send(JSON.stringify({ type: "hello", rate: 48000, speakers: speakers.join(",") }));
  ws.onmessage = (e) => {
    if (typeof e.data !== "string") return;
    let m;
    try { m = JSON.parse(e.data); } catch (err) { return; }
    if (m.type === "info") {
      const need = speakers.length, have = m.objects || 0;
      setStatus({
        bridgeState: "ok", device: m.device, bed: m.bed, objects: have,
        warn: have && need > have ? "The output offers " + have + " speaker objects, this layout has " + need + ": the extra ones are folded." : "",
      });
    } else if (m.type === "replaced") {          // another page or tab took the app: do not take it back in a loop
      replaced = true;
      setStatus({ bridgeState: "taken", warn: "The bridge is in use by another page. Press Start again to take it back." });
    } else if (m.type === "gone") {
      setStatus({ bridgeState: "nospatial", warn: "Turn on Windows Spatial Sound (Dolby Atmos / Windows Sonic) for the default output." });
    }
  };
  ws.onclose = () => {
    if (!running || replaced) return;
    setStatus({ bridgeState: "missing" });
    retry = setTimeout(() => connectBridge(speakers), 2000);
  };
  ws.onerror = () => {};
}

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
  }
  return true;
});
