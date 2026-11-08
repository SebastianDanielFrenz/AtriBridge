// Stereo -> the speakers named in options.speakers (any of FL FR FC LFE SL SR BL BR FWL FWR TFL TFR TML TMR TBL TBR).
// Every speaker plays its side of the stereo at the full level: the left side (FL SL BL FWL TFL TML TBL) gets L, the
// right side R, the centre the mid (L+R)/2, the LFE nothing, the way the music page's "all" mode does. A speaker the
// output does not have is simply not played (the others already carry that side); without a centre speaker the
// mid goes to FL and FR at -3 dB.
// options.emit: also post interleaved 10 ms blocks to the main thread (for the bridge).
const LEFT = new Set(["FL", "SL", "BL", "FWL", "TFL", "TML", "TBL"]);
const RIGHT = new Set(["FR", "SR", "BR", "FWR", "TFR", "TMR", "TBR"]);

// The same file is loaded two ways: as an AudioWorklet module (registerProcessor) and, as a fallback, as a plain
// content script that runs the class from a ScriptProcessor (the page's security policy may refuse a worklet module).
const BaseProcessor = typeof AudioWorkletProcessor === "function" ? AudioWorkletProcessor : class { constructor() { this.port = { postMessage() {} }; } };
class Upmix extends BaseProcessor {
  constructor(o) {
    super();
    const opt = o.processorOptions || {};
    this.names = opt.speakers;
    this.emit = !!opt.emit;
    this.block = 480;
    this.acc = new Float32Array(this.block * this.names.length);
    this.fill = 0;
    const has = (k) => this.names.indexOf(k);
    // per output channel: 1 = left, 2 = right, 3 = mid, 0 = silent
    this.role = this.names.map((k) => (LEFT.has(k) ? 1 : RIGHT.has(k) ? 2 : k === "FC" ? 3 : 0));
    this.fc = has("FC") >= 0 ? null : [has("FL"), has("FR")];
  }
  process(inputs, outputs) {
    const inp = inputs[0], out = outputs[0];
    if (!inp || !inp.length) return true;
    const L = inp[0], R = inp[1] || inp[0], n = L.length, nc = this.names.length, role = this.role, fc = this.fc;
    for (let i = 0; i < n; i++) {
      const l = L[i], r = R[i], m = 0.5 * (l + r);
      for (let c = 0; c < nc; c++) {
        let x = role[c] === 1 ? l : role[c] === 2 ? r : role[c] === 3 ? m : 0;
        if (fc && (c === fc[0] || c === fc[1])) x += 0.707 * m;
        x = x > 1 ? 1 : x < -1 ? -1 : x;
        if (out[c]) out[c][i] = x;
        if (this.emit) this.acc[this.fill * nc + c] = x;
      }
      if (this.emit && ++this.fill === this.block) {
        this.port.postMessage(this.acc.buffer, [this.acc.buffer]);
        this.acc = new Float32Array(this.block * nc);
        this.fill = 0;
      }
    }
    return true;
  }
}
if (typeof registerProcessor === "function") registerProcessor("ksf-upmix", Upmix);
else globalThis.KsfUpmix = Upmix;
