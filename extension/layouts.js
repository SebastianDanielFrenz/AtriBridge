// A classic script (not a module) so it also loads as a content script, where a dynamic import would run under the
// page's origin and be refused; popup.js and offscreen.js read it from globalThis.KsfLayouts.
// Layout names and the speakers each one has. Shared by the popup and the offscreen page.
// Speaker names are the ones the bridge understands.
const BASES = {
  "5.0": ["FL", "FR", "FC", "SL", "SR"],
  "7.0": ["FL", "FR", "FC", "SL", "SR", "BL", "BR"],
  "9.0": ["FL", "FR", "FC", "SL", "SR", "BL", "BR", "FWL", "FWR"],
};
const HEIGHTS = {
  "0": [],
  "2": ["TFL", "TFR"],
  "4": ["TFL", "TFR", "TBL", "TBR"],
  "6": ["TFL", "TFR", "TML", "TMR", "TBL", "TBR"],
};
const LAYOUTS = [];
for (const base of Object.keys(BASES)) {
  for (const h of Object.keys(HEIGHTS)) LAYOUTS.push(h === "0" ? base : `${base}.${h}`);
}
function speakersOf(layout) {
  const [a, b, h] = layout.split(".");
  return [...BASES[`${a}.${b}`], ...HEIGHTS[h || "0"]];
}
// Heights need the bridge: a browser is only ever given a flat 7.1 bed.
const needsBridge = (layout) => layout.split(".").length === 3;
// What a browser can play on its own, in Web Audio's discrete channel order (L R C LFE SL SR BL BR).
const DIRECT_ORDER = {
  6: ["FL", "FR", "FC", "LFE", "SL", "SR"],
  8: ["FL", "FR", "FC", "LFE", "SL", "SR", "BL", "BR"],
  2: ["FL", "FR"],
};
globalThis.KsfLayouts = { BASES, HEIGHTS, LAYOUTS, speakersOf, needsBridge, DIRECT_ORDER };
