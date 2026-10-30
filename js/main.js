import { db, loadAll, fmt, esc } from "./data.js";
import { state, setCursor, addRegion, addNeurons, addMarker, emit, clearKind } from "./state.js";
import { initSlices } from "./slice.js";
import { initThree } from "./viewer3d.js";
import { initExplorer } from "./explorer.js";
import { initRegions, initMarkers, initNeurons } from "./catalogs.js";
import { initOverview, initConnectivity } from "./charts.js";

const $ = (s) => document.querySelector(s);
const status = $("#data-status");

/* ---------- theme ---------- */
try { const t = localStorage.getItem("zba-theme"); if (t) document.documentElement.dataset.theme = t; } catch {}
$("#theme-toggle").onclick = () => {
  const t = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem("zba-theme", t); } catch {}
  document.dispatchEvent(new Event("theme"));
};

/* ---------- routing ---------- */
const inited = new Set();
const lazy = { overview: initOverview, connectivity: initConnectivity };
function route() {
  const tab = (location.hash.replace("#", "").split("?")[0]) || "explorer";
  document.querySelectorAll(".page").forEach((p) => p.classList.toggle("on", p.id === `page-${tab}`));
  document.querySelectorAll("#tabs a").forEach((a) => a.classList.toggle("on", a.dataset.tab === tab));
  if (lazy[tab] && !inited.has(tab) && db.brain) { inited.add(tab); lazy[tab](); }
}
window.addEventListener("hashchange", () => {
  // a pasted share link into an already-open app: replace the current scene
  if (db.brain && location.hash.includes("?")) { ["region", "marker", "neuron"].forEach(clearKind); restoreView(); }
  route();
});

/* ---------- shareable view state (URL ?query on the explorer hash) ---------- */
function encodeView() {
  const p = new URLSearchParams();
  const c = state.cursor; p.set("c", `${c.x},${c.y},${c.z}`);
  if (state.regions.size) p.set("r", [...state.regions.keys()].join(","));
  if (state.markers.size) p.set("m", [...state.markers.keys()].join(","));
  if (state.neurons.size && state.neurons.size <= 300) p.set("n", [...state.neurons.keys()].join(","));
  return `${location.origin}${location.pathname}#explorer?${p}`;
}
function restoreView() {
  const q = location.hash.split("?")[1];
  if (!q) return false;
  const p = new URLSearchParams(q);
  const nums = (k) => (p.get(k) || "").split(",").filter(Boolean).map(Number);
  const c = nums("c"); if (c.length === 3) setCursor({ x: c[0], y: c[1], z: c[2] }, "url");
  nums("r").forEach((id) => addRegion(id, { silent: true }));
  nums("m").forEach((id) => addMarker(id));
  emit("layers", {});
  const n = nums("n"); if (n.length) addNeurons(n);
  return true;
}

/* ---------- boot ---------- */
(async function boot() {
  try {
    await loadAll((m) => (status.textContent = m));
  } catch (e) {
    status.textContent = "data failed to load"; status.className = "status-pill warn";
    document.querySelector("main").insertAdjacentHTML("afterbegin", `<div class="card" style="margin:20px">Could not load atlas data: ${esc(e.message)}.<br>Serve this folder over http (e.g. <code>python3 -m http.server</code>) and check your connection to api.mapzebrain.org.</div>`);
    return;
  }
  const setStatus = () => {
    const s = db.status;
    const src = s.live.length && !s.snapshot.length ? "live API" : s.live.length ? "snapshot + live" : `snapshot ${s.fetched || ""}`;
    const api = s.apiOnline == null ? "checking API…" : s.apiOnline ? "API online" : "API offline (images unavailable)";
    status.textContent = `${src} · ${api}`;
    status.className = "status-pill " + (s.apiOnline === false ? "warn" : s.apiOnline ? "ok" : "");
    status.title = `Snapshot files: ${s.snapshot.join(", ") || "none"}\nLive-fetched: ${s.live.join(", ") || "none"}`;
  };
  setStatus();
  document.addEventListener("api-status", setStatus);

  const slices = initSlices();
  initThree($("#pane-3d"));
  initExplorer(slices);
  initRegions(); initMarkers(); initNeurons();
  renderAbout();

  // share-link button lives in the viewer toolbar
  const share = document.createElement("button");
  share.className = "btn ghost"; share.textContent = "Copy link to view";
  share.title = "Copy a URL that restores the cursor and loaded layers";
  share.onclick = async () => { try { await navigator.clipboard.writeText(encodeView()); share.textContent = "Copied ✓"; } catch { prompt("Copy this link:", encodeView()); } setTimeout(() => (share.textContent = "Copy link to view"), 1800); };
  $("#reset-views").after(share);

  if (!restoreView()) {
    // a helpful starting scene: major divisions as outlines + a few neurons
    const tect = db.regionList.find((r) => r.version.display_name === db.defaultVersion && /periventricular layer|tectum/i.test(r.name));
    if (tect) addRegion(tect.id);
  }
  route();
})();

function renderAbout() {
  const c = db.counts || {};
  $("#about-content").innerHTML = `
  <h1>About this explorer</h1>
  <p>An independent research interface to the <a href="https://mapzebrain.org/atlas/" target="_blank" rel="noopener">mapZebrain</a> larval zebrafish brain atlas (Baier lab, Max Planck Institute for Biological Intelligence). All images, meshes, morphologies and annotations belong to mapZebrain and its contributors. This app only re-presents them.</p>

  <h2>Please cite</h2>
  <p>Kunst M, Laurell E, Mokayes N, et al. <i>A cellular-resolution atlas of the larval zebrafish brain.</i> Neuron 103(1):21–38 (2019). <a href="https://doi.org/10.1016/j.neuron.2019.04.034" target="_blank" rel="noopener">doi:10.1016/j.neuron.2019.04.034</a><br>
  Also cite the original publication of any specific marker line or neuron dataset you use (linked in each detail panel), and check mapzebrain.org for the most recent atlas paper describing region version 2.0.</p>

  <h2>What's in the data right now</h2>
  <table><tbody>
    <tr><td>Regions</td><td>${fmt(db.regionList.length)} annotations across ${db.versions.length} atlas versions (${db.versions.map((v) => esc(v.display_name)).join("; ")}). The website counts ${fmt(c.regionCount)} for the default version.</td></tr>
    <tr><td>Markers</td><td>${fmt(db.markerList.length)} visible (${fmt(c.markersCount)} reported by API)</td></tr>
    <tr><td>Neurons</td><td>${fmt(db.neuronIds.length)} traced morphologies${db.hasNeuronMeta ? ", with metadata snapshot" : ""}</td></tr>
    <tr><td>Snapshot</td><td>${esc(db.status.fetched || "none (live API only)")}</td></tr>
  </tbody></table>

  <h2>How data is fetched</h2>
  <p>mapZebrain doesn't publish a documented API. This app uses the same endpoints the official site calls, at <code>https://api.mapzebrain.org/api/</code>. They are open, need no key and allow cross-origin requests. Metadata is snapshotted into <code>data/*.json</code> by <code>scripts/fetch_data.py</code>, so the app loads fast and keeps working if the endpoints change. Slice images, meshes and SWC files stream on demand from <code>https://api.mapzebrain.org/media/</code>.</p>
  <table><thead><tr><th>Endpoint</th><th>Payload</th><th>Used for</th></tr></thead><tbody>
    <tr><td><code>get_items_count</code></td><td><code>{}</code></td><td>totals</td></tr>
    <tr><td><code>load_region_data_by_version</code></td><td><code>{"regionVersion": "2.0 (MECE, 2024)"}</code></td><td>all region versions, hierarchy, mesh & slice paths</td></tr>
    <tr><td><code>load_markers_data</code></td><td><code>{"share_view_markers_ids": []}</code></td><td>marker catalog</td></tr>
    <tr><td><code>load_all_neurons</code> / <code>get_neuron_metadata</code></td><td><code>{}</code> / <code>{"neuronID": 9358}</code></td><td>neuron list, metadata, SWC path</td></tr>
    <tr><td><code>search_for_neurons_IDs_by_region</code></td><td><code>{"regionId", "searchOption": 1 soma | 2 terminate | 3 pass, "minimumNeuronLengthInRegion": 10}</code></td><td>region queries, connectivity matrix</td></tr>
    <tr><td><code>get_regions_of_position</code></td><td><code>{"position": {"x","y","z"}}</code></td><td>“Identify regions” at cursor</td></tr>
    <tr><td><code>search_for_neuron_similarities</code></td><td><code>{"neuronID", "topNSimilar"}</code></td><td>morphology similarity search</td></tr>
    <tr><td><code>search_for_neurons_IDs_by_cell_type</code> / <code>_by_lines</code></td><td><code>{"selectedCellTypeID"}</code> / <code>{"selectedLineID"}</code></td><td>cell type & line queries</td></tr>
    <tr><td><code>search_for_MPIN_data</code>, <code>get_labs</code>, <code>get_markers_types</code></td><td><code>{}</code></td><td>publications, cell types, labs</td></tr>
  </tbody></table>

  <h2>Coordinate system</h2>
  <p>Everything is registered to one reference brain of ${fmt(597)} × ${fmt(974)} × ${fmt(359)} voxels (≈ µm). Slice number equals the coordinate along the slicing axis: dorsal (horizontal) slices index <i>z</i>, sagittal index <i>x</i>, coronal index <i>y</i>. Small <i>y</i> is anterior and large <i>z</i> is dorsal. Region meshes and SWC neurons use the same space, so 2D and 3D overlays line up exactly. Horizontal slices are shown as stored in the atlas, with <i>x</i> increasing to the right. The 3D “Dorsal” preset looks down from above, so left and right appear mirrored relative to the 2D horizontal pane. Use “Ventral” in 3D to match the 2D orientation.</p>

  <h2>Reading the views</h2>
  <ul>
    <li><b>Markers</b> are averaged, registered expression stacks, blended additively like fluorescence channels.</li>
    <li><b>Neurons</b> in slices: segments within the slab (±µm, toolbar) of the current slice are drawn bright; the faint trace is the full projection.</li>
    <li><b>Connectivity</b> counts neurons by where their soma sits and where they terminate (mapZebrain's region-search criteria, ≥ 10 µm of arbor). It is a projection map, not a synaptic connectome, and depends on which neurons happened to be traced.</li>
  </ul>

  <h2>Refreshing the snapshot</h2>
  <pre>cd zebrafish-atlas
python3 scripts/fetch_data.py      # ~10 min, polite (4 parallel requests)
python3 -m http.server 8000        # then open http://localhost:8000</pre>
  `;
}
