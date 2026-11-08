// Stereo -> the speakers named in options.speakers (any of FL FR FC LFE SL SR BL BR FWL FWR TFL TFR TML TMR TBL TBR).
// A plain matrix upmixer in the spirit of Pro Logic: the centre is the common part, the surrounds and the
// heights are the difference ("ambience") part, delayed and filtered differently so they do not collapse
// into the front. Speakers the output does not have are folded into the nearest one that it has.
// options.emit: also post interleaved 10 ms blocks to the main thread (for the bridge).
const FOLD = {
  SL: ["BL", "FL"], SR: ["BR", "FR"], BL: ["SL", "FL"], BR: ["SR", "FR"],
  FWL: ["FL"], FWR: ["FR"], TFL: ["FL"], TFR: ["FR"], TML: ["TFL", "TBL", "FL"], TMR: ["TFR", "TBR", "FR"],
  TBL: ["TFL", "BL", "FL"], TBR: ["TFR", "BR", "FR"],
};

class Delay {
  constructor(samples) { this.b = new Float32Array(Math.max(1, samples | 0)); this.i = 0; }
  tick(x) { const y = this.b[this.i]; this.b[this.i] = x; this.i = (this.i + 1) % this.b.length; return y; }
}
class Lp {
  constructor(hz, rate) { this.a = 1 - Math.exp(-2 * Math.PI * hz / rate); this.y = 0; }
  tick(x) { this.y += this.a * (x - this.y); return this.y; }
}

// The same file is loaded two ways: as an AudioWorklet module (registerProcessor) and, as a fallback, as a plain
// content script that runs the class from a ScriptProcessor (the page's security policy may refuse a worklet module).
const BaseProcessor = typeof AudioWorkletProcessor === "function" ? AudioWorkletProcessor : class { constructor() { this.port = { postMessage() {} }; } };
class Upmix extends BaseProcessor {
  constructor(o) {
    super();
    const opt = o.processorOptions || {};
    this.names = opt.speakers;
    this.emit = !!opt.emit;
    // "equal": every speaker plays its side of the stereo at the full level (left side L, right side R, centre the
    // mid), the way the music page's "all" mode does. "ambience": the Pro Logic-like matrix below, where the
    // surrounds and heights carry only the L-R difference and are very quiet on near-mono music.
    this.equal = opt.style === "equal";
    const r = opt.rate || sampleRate, ms = (v) => Math.round(v * r / 1000);
    this.d = {
      SL: new Delay(ms(12)), SR: new Delay(ms(12)), BL: new Delay(ms(24)), BR: new Delay(ms(26)),
      FWL: new Delay(ms(4)), FWR: new Delay(ms(4)), TFL: new Delay(ms(3)), TFR: new Delay(ms(3)),
      TML: new Delay(ms(8)), TMR: new Delay(ms(8)), TBL: new Delay(ms(15)), TBR: new Delay(ms(17)),
    };
    this.lp = {};
    for (const k of ["SL", "SR", "BL", "BR"]) this.lp[k] = new Lp(7000, r);
    this.hp = {};   // high-pass = x - lowpass(x)
    for (const k of ["TFL", "TFR", "TML", "TMR", "TBL", "TBR"]) this.hp[k] = new Lp(800, r);
    this.gain = this.equal ? 1 : 0.75;
    this.block = 480;
    this.acc = new Float32Array(this.block * this.names.length);
    this.fill = 0;
    this.sig = {};
    this.v = new Float32Array(this.names.length);
    // for every speaker the output lacks: where its signal goes
    const has = (k) => this.names.indexOf(k);
    this.fold = [];
    for (const k of Object.keys(FOLD)) {
      if (has(k) >= 0) continue;
      for (const t of FOLD[k]) if (has(t) >= 0) { this.fold.push([k, has(t)]); break; }
    }
    this.fc = has("FC") >= 0 ? null : [has("FL"), has("FR")];
  }
  hpf(k, x) { return x - this.hp[k].tick(x); }
  process(inputs, outputs) {
    const inp = inputs[0], out = outputs[0];
    if (!inp || !inp.length) return true;
    const L = inp[0], R = inp[1] || inp[0], n = L.length, names = this.names, nc = names.length;
    const sig = this.sig, d = this.d, g = this.gain, v = this.v;
    for (let i = 0; i < n; i++) {
      const l = L[i], r = R[i], m = 0.5 * (l + r), s = 0.5 * (l - r);
      if (this.equal) {
        sig.FL = l; sig.FR = r; sig.FC = m; sig.SL = l; sig.SR = r; sig.BL = l; sig.BR = r; sig.FWL = l; sig.FWR = r;
        sig.TFL = l; sig.TFR = r; sig.TML = l; sig.TMR = r; sig.TBL = l; sig.TBR = r;
      } else {
      sig.FL = l - 0.3 * m; sig.FR = r - 0.3 * m; sig.FC = 0.9 * m;
      sig.SL = d.SL.tick(this.lp.SL.tick(0.8 * s + 0.25 * l));
      sig.SR = d.SR.tick(this.lp.SR.tick(-0.8 * s + 0.25 * r));
      sig.BL = d.BL.tick(this.lp.BL.tick(0.6 * s + 0.2 * l));
      sig.BR = d.BR.tick(this.lp.BR.tick(-0.6 * s + 0.2 * r));
      sig.FWL = d.FWL.tick(0.5 * (l - 0.3 * m)); sig.FWR = d.FWR.tick(0.5 * (r - 0.3 * m));
      sig.TFL = d.TFL.tick(this.hpf("TFL", 0.45 * l + 0.25 * s)); sig.TFR = d.TFR.tick(this.hpf("TFR", 0.45 * r - 0.25 * s));
      sig.TML = d.TML.tick(this.hpf("TML", 0.35 * l + 0.35 * s)); sig.TMR = d.TMR.tick(this.hpf("TMR", 0.35 * r - 0.35 * s));
      sig.TBL = d.TBL.tick(this.hpf("TBL", 0.3 * s + 0.15 * l)); sig.TBR = d.TBR.tick(this.hpf("TBR", -0.3 * s + 0.15 * r));
      }
      for (let c = 0; c < nc; c++) v[c] = names[c] === "LFE" ? 0 : sig[names[c]];
      if (!this.equal) for (let f = 0; f < this.fold.length; f++) v[this.fold[f][1]] += 0.8 * sig[this.fold[f][0]];   // (equal: a speaker that is missing is just a copy of one that is there)
      if (this.fc) { v[this.fc[0]] += 0.707 * sig.FC; v[this.fc[1]] += 0.707 * sig.FC; }
      for (let c = 0; c < nc; c++) {
        let x = v[c] * g;
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
