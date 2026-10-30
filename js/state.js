// Shared selection + view state for the slice viewer and 3D viewer.
import { db, VOL, neuronMeta, mediaUrl } from "./data.js";
import { loadSwc } from "./swc.js";

const listeners = new Map();
export function on(evt, fn) { if (!listeners.has(evt)) listeners.set(evt, new Set()); listeners.get(evt).add(fn); }
export function emit(evt, detail) { listeners.get(evt)?.forEach((fn) => fn(detail)); }

// Fluorescence-like colours for markers (read well additively on black)
const MARKER_COLORS = ["#39ff6a", "#ff4fd8", "#3fd0ff", "#ffd23f", "#ff7a3d", "#9b8cff", "#ffffff", "#7dffcf"];
let markerColorIdx = 0, neuronColorIdx = 0;
export function neuronColor(i = neuronColorIdx++) {
  const h = (i * 137.508 + 20) % 360;
  return hslToHex(h, 85, 62);
}
function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
  return "#" + [f(0), f(8), f(4)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export const state = {
  regions: new Map(),   // id → {id, color, visible}
  markers: new Map(),   // id → {id, color, visible}
  neurons: new Map(),   // id → {id, color, visible, swc, loading}
  group: {
    regions: { opacity: 0.45, visible: true },
    markers: { opacity: 1.0, visible: true },
    neurons: { opacity: 1.0, visible: true },
  },
  cursor: { x: Math.round(VOL.x / 2), y: 420, z: 180 },
  regionStyle: "fill",
  slab: 12,
  ghost: true,
  baseVisible: true,
  baseGain: 1.2,
  crosshair: true,
  focus: null,          // {kind, id}
};

export function setCursor(p, source) {
  state.cursor = {
    x: clamp(Math.round(p.x), 0, VOL.x - 1),
    y: clamp(Math.round(p.y), 0, VOL.y - 1),
    z: clamp(Math.round(p.z), 0, VOL.z - 1),
  };
  emit("cursor", source);
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function addRegion(id, opts = {}) {
  const r = db.regions[id];
  if (!r || state.regions.has(id)) return;
  state.regions.set(id, { id, color: r.visualization_data?.color || "#3987e5", visible: true, ...opts });
  if (!opts.silent) emit("layers", { kind: "region", id, added: true });
}
export function addMarker(id) {
  if (!db.markers[id] || state.markers.has(id)) return;
  state.markers.set(id, { id, color: MARKER_COLORS[markerColorIdx++ % MARKER_COLORS.length], visible: true });
  emit("layers", { kind: "marker", id, added: true });
}

/** Add neurons; morphologies stream in with limited concurrency. */
export async function addNeurons(ids, { color, replace = false } = {}) {
  if (replace) state.neurons.clear();
  const fresh = ids.filter((id) => !state.neurons.has(id));
  fresh.forEach((id) => state.neurons.set(id, { id, color: color || neuronColor(), visible: true, swc: null, loading: true }));
  emit("layers", { kind: "neuron", added: true });
  let i = 0;
  const worker = async () => {
    while (i < fresh.length) {
      const id = fresh[i++];
      const n = state.neurons.get(id);
      if (!n) continue;
      try {
        const meta = await neuronMeta(id);
        n.swc = await loadSwc(mediaUrl(meta.swc));
      } catch (e) { n.error = String(e); }
      n.loading = false;
      emit("neuron-loaded", id);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  emit("layers", { kind: "neuron" });
}

export function remove(kind, id) {
  ({ region: state.regions, marker: state.markers, neuron: state.neurons })[kind].delete(id);
  if (state.focus?.kind === kind && state.focus.id === id) state.focus = null;
  emit("layers", { kind, id, removed: true });
}
export function clearKind(kind) {
  ({ region: state.regions, marker: state.markers, neuron: state.neurons })[kind].clear();
  emit("layers", { kind, cleared: true });
}
export function setFocus(kind, id) {
  state.focus = kind ? { kind, id } : null;
  emit("focus", state.focus);
}
export function update(evt = "render") { emit(evt); }
