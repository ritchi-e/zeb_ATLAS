// Data layer: local snapshot first (fast, stable), live mapZebrain API as fallback
// and for queries that can't be precomputed.

export const API = "https://api.mapzebrain.org/api/";
export const MEDIA = "https://api.mapzebrain.org";

// Reference volume, in voxels (≈ µm). Slice index == coordinate on the sliced axis.
//   dorsal   slice z → pixel (x, y)          597 × 974, 359 slices
//   sagittal slice x → pixel (y, 358 − z)    974 × 359, 597 slices
//   coronal  slice y → pixel (x, 358 − z)    597 × 359, 974 slices
export const VOL = { x: 597, y: 974, z: 359 };

export const VIEWS = {
  dorsal:   { axis: "z", w: VOL.x, h: VOL.y, n: VOL.z, label: "Dorsal (horizontal)", h2: ["x", "y"] },
  sagittal: { axis: "x", w: VOL.y, h: VOL.z, n: VOL.x, label: "Sagittal", h2: ["y", "z"] },
  coronal:  { axis: "y", w: VOL.x, h: VOL.z, n: VOL.y, label: "Coronal (transverse)", h2: ["x", "z"] },
};

/** volume (x,y,z) → pixel (u,v) in a view */
export function toPixel(view, p) {
  if (view === "dorsal") return [p.x, p.y];
  if (view === "sagittal") return [p.y, VOL.z - 1 - p.z];
  return [p.x, VOL.z - 1 - p.z];
}
/** pixel (u,v) + slice index → volume (x,y,z) */
export function toVolume(view, u, v, slice) {
  if (view === "dorsal") return { x: u, y: v, z: slice };
  if (view === "sagittal") return { x: slice, y: u, z: VOL.z - 1 - v };
  return { x: u, y: slice, z: VOL.z - 1 - v };
}
// Server paths are already URL-escaped where needed (e.g. "tectum_%26_tori"); only escape spaces/#/?.
export const mediaUrl = (path) => (path.startsWith("http") ? path : MEDIA + path.replace(/ /g, "%20").replace(/#/g, "%23").replace(/\?/g, "%3F"));
export const sliceUrl = (dir, i) => mediaUrl(`${dir}/${i}.webp`);

export async function post(endpoint, payload = {}) {
  const r = await fetch(API + endpoint + "/", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`${endpoint}: HTTP ${r.status}`);
  return r.json();
}
async function get(endpoint) {
  const r = await fetch(API + endpoint + "/");
  if (!r.ok) throw new Error(`${endpoint}: HTTP ${r.status}`);
  return r.json();
}
async function local(name) {
  const r = await fetch(`data/${name}.json`);
  if (!r.ok) throw new Error("no snapshot");
  return r.json();
}
async function either(name, live, status) {
  try { const d = await local(name); status.snapshot.push(name); return d; }
  catch { const d = await live(); status.live.push(name); return d; }
}

export const db = {
  status: { snapshot: [], live: [], fetched: null, apiOnline: null },
  counts: null, brain: null, views: null, labs: [], markerTypes: [], mpin: null,
  regions: {}, regionList: [], versions: [], defaultVersion: null, trees: {},
  markers: {}, markerList: [], markerCategories: [],
  neurons: {}, neuronIds: [], hasNeuronMeta: false,
  regionNeurons: null,
};

export async function loadAll(onProgress = () => {}) {
  const s = db.status;
  onProgress("Loading atlas metadata…");
  const [counts, brain, views, labs, types, mpin, meta] = await Promise.all([
    either("counts", () => post("get_items_count"), s),
    either("brain", async () => (await get("load_brain_data")).data, s),
    either("views", async () => (await get("load_2d_views_images_info")).data, s),
    either("labs", async () => (await get("get_labs")).labs, s),
    either("marker_types", async () => (await get("get_markers_types")).markers_types, s),
    either("mpin", async () => (await post("search_for_MPIN_data")).data, s),
    local("meta").catch(() => null),
  ]);
  Object.assign(db, { counts, brain, views, labs, markerTypes: types, mpin });
  s.fetched = meta?.fetched || null;

  onProgress("Loading regions…");
  const regions = await either("regions", async () => {
    const v = (await get("load_newest_region_version_data")).versionData;
    return (await post("load_region_data_by_version", { regionVersion: v.display_name })).data;
  }, s);
  indexRegions(regions);

  onProgress("Loading markers…");
  const markers = await either("markers", async () => (await post("load_markers_data", { share_view_markers_ids: [] })).data, s);
  db.markers = markers.dictionary;
  db.markerList = Object.values(markers.dictionary).filter((m) => !m.deleted && !m.hidden)
    .sort((a, b) => a.name.localeCompare(b.name));
  db.markerCategories = [...new Set(db.markerList.map((m) => m.category?.name).filter(Boolean))].sort();

  onProgress("Loading neurons…");
  try {
    db.neurons = await local("neurons");
    db.hasNeuronMeta = true; s.snapshot.push("neurons");
    db.neuronIds = Object.keys(db.neurons).map(Number);
  } catch {
    const r = await post("load_all_neurons");
    db.neuronIds = r.neuronsIDs; s.live.push("neurons");
    db.neuronIds.forEach((id) => (db.neurons[id] = { name: `Neuron ${id}` }));
  }
  try { db.regionNeurons = await local("region_neurons"); s.snapshot.push("region_neurons"); } catch { db.regionNeurons = null; }

  // API liveness check (non-blocking)
  post("get_items_count").then(() => (s.apiOnline = true)).catch(() => (s.apiOnline = false))
    .finally(() => document.dispatchEvent(new CustomEvent("api-status")));
}

function indexRegions(data) {
  db.regions = {};
  for (const r of Object.values(data.regions_dictionary)) db.regions[r.id] = r;
  db.regionList = Object.values(db.regions);
  const vmap = new Map();
  for (const r of db.regionList) vmap.set(r.version.display_name, r.version);
  db.versions = [...vmap.values()].sort((a, b) => a.number.localeCompare(b.number));
  db.defaultVersion = (data.region_version_data || db.versions.find((v) => v.default_version)).display_name;
  for (const v of db.versions) db.trees[v.display_name] = buildTree(v.display_name);
}

/** Build a hierarchy from parent links (works for every version, not just the default). */
function buildTree(versionName) {
  const nodes = db.regionList.filter((r) => r.version.display_name === versionName);
  const ids = new Set(nodes.map((r) => r.id));
  const kids = new Map();
  for (const r of nodes) {
    const p = r.parent && ids.has(r.parent) ? r.parent : null;
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(r.id);
  }
  const make = (id) => ({ id, children: (kids.get(id) || []).map(make) });
  // keep API ordering for the default hierarchy where available, else alphabetical
  const sortRec = (n) => { n.children.sort((a, b) => db.regions[a.id].name.localeCompare(db.regions[b.id].name)); n.children.forEach(sortRec); };
  const roots = (kids.get(null) || []).map(make);
  roots.forEach(sortRec);
  roots.sort((a, b) => db.regions[a.id].name.localeCompare(db.regions[b.id].name));
  return roots;
}

export function regionPath(id) {
  const out = [];
  let r = db.regions[id];
  while (r) { out.unshift(r); r = r.parent ? db.regions[r.parent] : null; if (out.length > 20) break; }
  return out;
}
export function regionDepth(id) { return regionPath(id).length - 1; }
// A few container regions list slice folders but have no data on the server; they also lack a mesh.
export function isLoadable(r) { return !!(r && r.visualization_data?._2d?.orthogonal_views?.dorsal && r.visualization_data?._3d?.mesh_file); }

/** neurons related to a region: from snapshot, else live API */
export async function neuronsInRegion(regionId, mode = "soma") {
  const snap = db.regionNeurons?.[regionId]?.[mode];
  if (snap) return snap;
  const opt = { soma: 1, terminate: 2, pass: 3 }[mode];
  const r = await post("search_for_neurons_IDs_by_region", { regionId, searchOption: opt, minimumNeuronLengthInRegion: 10 });
  return r.neuronsIDs || [];
}

export async function neuronMeta(id) {
  const n = db.neurons[id];
  if (n && n.swc) return n;
  const r = await post("get_neuron_metadata", { neuronID: id });
  const d = r.neuron_data;
  const m = { name: d.name, swc: d.files.original, ...d.info };
  db.neurons[id] = m;
  return m;
}

export const fmt = (n) => (n == null ? "–" : n.toLocaleString("en-US"));
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
