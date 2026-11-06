// Layout names and the speakers each one has. Shared by the popup and the offscreen page.
// Speaker names are the ones the bridge understands.
export const BASES = {
  "5.0": ["FL", "FR", "FC", "SL", "SR"],
  "7.0": ["FL", "FR", "FC", "SL", "SR", "BL", "BR"],
  "9.0": ["FL", "FR", "FC", "SL", "SR", "BL", "BR", "FWL", "FWR"],
};
export const HEIGHTS = {
  "0": [],
  "2": ["TFL", "TFR"],
  "4": ["TFL", "TFR", "TBL", "TBR"],
  "6": ["TFL", "TFR", "TML", "TMR", "TBL", "TBR"],
};
export const LAYOUTS = [];
for (const base of Object.keys(BASES)) {
  for (const h of Object.keys(HEIGHTS)) LAYOUTS.push(h === "0" ? base : `${base}.${h}`);
}
export function speakersOf(layout) {
  const [a, b, h] = layout.split(".");
  return [...BASES[`${a}.${b}`], ...HEIGHTS[h || "0"]];
}
// Heights need the bridge: a browser is only ever given a flat 7.1 bed.
export const needsBridge = (layout) => layout.split(".").length === 3;
// What a browser can play on its own, in Web Audio's discrete channel order (L R C LFE SL SR BL BR).
export const DIRECT_ORDER = {
  6: ["FL", "FR", "FC", "LFE", "SL", "SR"],
  8: ["FL", "FR", "FC", "LFE", "SL", "SR", "BL", "BR"],
  2: ["FL", "FR"],
};
