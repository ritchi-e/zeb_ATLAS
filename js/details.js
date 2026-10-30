// Detail renderers for regions, markers and neurons (used by the Explorer inspector and catalog pages).
import { db, esc, fmt, mediaUrl, regionPath, neuronsInRegion, neuronMeta, post, isLoadable } from "./data.js";
import { state, addRegion, addMarker, addNeurons, setCursor, setFocus, remove, emit } from "./state.js";
import { regionCenter } from "./viewer3d.js";
import { drawPreview, markerDir, regionDir } from "./slice.js";
import { loadSwc } from "./swc.js";

export const goExplorer = () => { if (location.hash !== "#explorer") location.hash = "#explorer"; };
export function toast(msg, ms = 2600) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(t._t); t._t = setTimeout(() => (t.hidden = true), ms);
}
const isUrl = (u) => /^https?:\/\//i.test(u || "");
const link = (url, label) => (isUrl(url) ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(label || url)}</a>` : `<span class="muted">${esc(url || "–")}</span>`);
const shortUrl = (u) => { try { const x = new URL(u); return x.hostname.replace(/^www\./, "") + (x.pathname.length > 1 ? "/…" : ""); } catch { return u; } };

export async function gotoRegion(id) {
  const c = await regionCenter(id);
  if (c) setCursor(c, "goto");
}

/* ---------------- region ---------------- */
export function regionDetail(el, id, { full = false } = {}) {
  const r = db.regions[id];
  if (!r) { el.innerHTML = `<p class="muted">Unknown region.</p>`; return; }
  const path = regionPath(id);
  const kids = (r.sub_regions_ids || []).map((k) => db.regions[k]).filter(Boolean);
  const color = r.visualization_data?.color || "#888";
  const inViewer = state.regions.has(id);
  const loadable = isLoadable(r);
  const rel = db.regionNeurons?.[id];
  const cnt = (k) => (rel?.[k] ? fmt(rel[k].length) : "…");
  el.innerHTML = `
    <div class="breadcrumb">${path.slice(0, -1).map((p) => `<a data-region="${p.id}">${esc(p.short_name || p.name)}</a>`).join(" › ") || "top level"}</div>
    <h2><span class="dot" style="background:${color}"></span> ${esc(r.name)}</h2>
    <div class="small muted">Atlas version ${esc(r.version.display_name)} · ID ${r.id}${r.is_container ? " · container" : ""}</div>
    <div class="actions">
      ${loadable ? `<button class="btn small" data-act="toggle">${inViewer ? "Remove from viewer" : "Add to viewer"}</button>
      <button class="btn small ghost" data-act="goto">Go to region</button>` : `<span class="tag">not loadable in viewer</span>`}
      ${kids.length ? `<button class="btn small ghost" data-act="kids">Add ${kids.length} subregions</button>` : ""}
    </div>
    <dl>
      <dt>Full name</dt><dd>${esc(r.name_across_versions || r.name)}</dd>
      <dt>Parent</dt><dd>${r.parent && db.regions[r.parent] ? `<a data-region="${r.parent}">${esc(db.regions[r.parent].name)}</a>` : "–"}</dd>
      <dt>Neurons</dt><dd>${rel ? `${cnt("soma")} soma · ${cnt("terminate")} terminate · ${cnt("pass")} pass through` : `<span class="muted">query below</span>`}</dd>
      <dt>Downloads</dt><dd>${r.downloads?.stl ? `<a href="${mediaUrl(r.downloads.stl)}" download>mesh (.stl)</a>` : ""} ${r.downloads?.stack ? ` · <a href="${mediaUrl(r.downloads.stack)}" download>mask stack (.tif)</a>` : ""}</dd>
    </dl>
    ${kids.length ? `<div class="small muted">Subregions</div><div>${kids.map((k) => `<span class="region-chip" data-region="${k.id}"><span class="dot" style="background:${k.visualization_data?.color}"></span>${esc(k.short_name || k.name)}</span>`).join("")}</div>` : ""}
    <div class="small muted" style="margin-top:12px">Neurons in this region</div>
    <div class="actions">
      <button class="btn small ghost" data-nq="soma">Soma here</button>
      <button class="btn small ghost" data-nq="terminate">Terminate here</button>
      <button class="btn small ghost" data-nq="pass">Pass through</button>
    </div>
    <div class="nq-result small muted"></div>
    ${full && loadable ? `<div class="thumbs"><figure><canvas data-v="dorsal"></canvas><figcaption>dorsal</figcaption></figure><figure><canvas data-v="sagittal"></canvas><figcaption>sagittal</figcaption></figure><figure><canvas data-v="coronal"></canvas><figcaption>coronal</figcaption></figure></div>` : ""}
  `;
  el.querySelectorAll("[data-region]").forEach((a) => (a.onclick = () => el.dispatchEvent(new CustomEvent("navigate-region", { bubbles: true, detail: +a.dataset.region }))));
  const act = (k, fn) => { const b = el.querySelector(`[data-act="${k}"]`); if (b) b.onclick = fn; };
  act("toggle", () => {
    if (state.regions.has(id)) { remove("region", id); }
    else { addRegion(id); setFocus("region", id); toast(`Added “${r.name}” to the viewer`); }
    regionDetail(el, id, { full });
  });
  act("goto", () => { if (!state.regions.has(id)) addRegion(id); setFocus("region", id); gotoRegion(id); goExplorer(); });
  act("kids", () => { kids.forEach((k) => addRegion(k.id, { silent: true })); emit("layers", {}); toast(`Added ${kids.length} subregions`); });
  el.querySelectorAll("[data-nq]").forEach((b) => (b.onclick = async () => {
    const out = el.querySelector(".nq-result");
    out.innerHTML = `<span class="spinner"></span> searching…`;
    try {
      const ids = await neuronsInRegion(id, b.dataset.nq);
      out.innerHTML = ids.length
        ? `${fmt(ids.length)} neurons. <a href="#" data-show>Show ${ids.length > 300 ? "first 300" : "all"} in viewer</a> · <a href="#" data-list>open in Neurons table</a>`
        : "No neurons found.";
      const s = out.querySelector("[data-show]");
      if (s) s.onclick = (e) => { e.preventDefault(); addNeurons(ids.slice(0, 300)); goExplorer(); };
      const l = out.querySelector("[data-list]");
      if (l) l.onclick = (e) => { e.preventDefault(); document.dispatchEvent(new CustomEvent("filter-neurons", { detail: { region: id, mode: b.dataset.nq } })); location.hash = "#neurons"; };
    } catch (e) { out.textContent = "Search failed: " + e.message; }
  }));
  if (full && loadable) {
    regionCenter(id).then((c) => {
      if (!c) return;
      el.querySelectorAll("canvas[data-v]").forEach((cv) => {
        const v = cv.dataset.v;
        const slice = Math.round(v === "dorsal" ? c.z : v === "sagittal" ? c.x : c.y);
        drawPreview(cv, v, slice, { dir: regionDir(r, v, "fill"), color, alpha: 0.75 });
      });
    }).catch(() => {});
  }
}

/* ---------------- marker ---------------- */
export function markerDetail(el, id, { full = false } = {}) {
  const m = db.markers[id];
  if (!m) { el.innerHTML = `<p class="muted">Unknown marker.</p>`; return; }
  const inViewer = state.markers.has(id);
  const hasNeurons = db.mpin?.markersWithNeuronsIDs?.includes(+id);
  const img = !!markerDir(m, "dorsal");
  el.innerHTML = `
    <h2>${esc(m.name)}</h2>
    <div class="small muted">${esc(m.full_name || "")}</div>
    <div class="actions">
      ${img ? `<button class="btn small" data-act="toggle">${inViewer ? "Remove from viewer" : "Show expression in viewer"}</button>` : `<span class="tag">no image data</span>`}
      ${hasNeurons ? `<button class="btn small ghost" data-act="neurons">Show traced neurons from this line</button>` : ""}
    </div>
    <dl>
      <dt>Category</dt><dd>${esc(m.category?.name || "–")}</dd>
      <dt>Type</dt><dd>${esc(m.type_to_str || "–")}</dd>
      <dt>Effector</dt><dd>${esc(m.effector || "–")}</dd>
      <dt>Synonyms</dt><dd>${esc(m.synonyms || "–")}</dd>
      <dt>Lab</dt><dd>${m.lab ? (m.lab.link ? link(m.lab.link, m.lab.name) : esc(m.lab.name)) : "–"}${m.lab?.institution ? `<div class="muted small">${esc(m.lab.institution)}</div>` : ""}</dd>
      <dt>ZFIN</dt><dd>${m.zfin_link ? link(m.zfin_link, shortUrl(m.zfin_link)) : "–"}</dd>
      <dt>Publication</dt><dd>${m.original_publication ? link(m.original_publication, shortUrl(m.original_publication)) : "–"}</dd>
      <dt>Imaged in</dt><dd>${m.scanned_by ? link(m.scanned_by, shortUrl(m.scanned_by)) : "–"}</dd>
      <dt>Download</dt><dd>${m.downloads?.stack ? `<a href="${mediaUrl(m.downloads.stack)}" download>average stack</a>` : "–"}</dd>
    </dl>
    ${full && img ? `<div class="small muted">Average expression (mid-slices)</div><div class="thumbs"><figure><canvas data-v="dorsal"></canvas><figcaption>dorsal z=180</figcaption></figure><figure><canvas data-v="sagittal"></canvas><figcaption>sagittal x=298</figcaption></figure><figure><canvas data-v="coronal"></canvas><figcaption>coronal y=450</figcaption></figure></div>` : ""}
    <div class="nq-result small muted"></div>`;
  const b = el.querySelector('[data-act="toggle"]');
  if (b) b.onclick = () => {
    if (state.markers.has(id)) remove("marker", +id);
    else { addMarker(+id); toast(`Added “${m.name}” — expression shown in the slice viewer and on 3D slice planes`); }
    markerDetail(el, id, { full });
  };
  const nb = el.querySelector('[data-act="neurons"]');
  if (nb) nb.onclick = async () => {
    const r = await post("search_for_neurons_IDs_by_lines", { selectedLineID: +id });
    addNeurons(r.neuronsIDs.slice(0, 300)); toast(`${r.neuronsIDs.length} neurons from ${m.name}`); goExplorer();
  };
  if (full && img) {
    const at = { dorsal: 180, sagittal: 298, coronal: 450 };
    el.querySelectorAll("canvas[data-v]").forEach((cv) => drawPreview(cv, cv.dataset.v, at[cv.dataset.v], { dir: markerDir(m, cv.dataset.v), color: "#39ff6a", mode: "lighter", alpha: 1 }));
  }
}

/* ---------------- neuron ---------------- */
export async function neuronDetail(el, id, { full = false } = {}) {
  el.innerHTML = `<span class="spinner"></span> loading neuron ${id}…`;
  let meta, swc;
  try { meta = await neuronMeta(id); swc = state.neurons.get(id)?.swc || (await loadSwc(mediaUrl(meta.swc))); }
  catch (e) { el.innerHTML = `<p class="muted">Could not load neuron ${id}: ${esc(e.message)}</p>`; return; }
  const inViewer = state.neurons.has(id);
  const so = swc.soma;
  const markerId = Object.values(db.markers).find((m) => m.name === meta.marker)?.id;
  el.innerHTML = `
    <h2>Neuron ${id}</h2>
    <div class="small muted mono">${esc(meta.name)}</div>
    <div class="actions">
      <button class="btn small" data-act="toggle">${inViewer ? "Remove from viewer" : "Add to viewer"}</button>
      <button class="btn small ghost" data-act="goto">Go to soma</button>
      <button class="btn small ghost" data-act="similar">Find 10 most similar</button>
      <a class="btn small ghost" href="${mediaUrl(meta.swc)}" download>SWC</a>
    </div>
    <dl>
      <dt>Cell type</dt><dd>${esc(meta.cell_type || "–")}</dd>
      <dt>Marker line</dt><dd>${markerId ? `<a href="#markers" data-marker="${markerId}">${esc(meta.marker)}</a>` : esc(meta.marker || "–")}</dd>
      <dt>Lab</dt><dd>${esc(meta.lab || "–")}</dd>
      <dt>Publication</dt><dd>${meta.publication ? link(meta.publication, shortUrl(meta.publication)) : "–"}</dd>
      ${meta.function ? `<dt>Function</dt><dd>${esc(meta.function)}</dd>` : ""}
      <dt>Soma</dt><dd class="mono">${so ? `x ${so.x.toFixed(0)}, y ${so.y.toFixed(0)}, z ${so.z.toFixed(0)}` : "–"}</dd>
      <dt>Cable length</dt><dd class="mono">${fmt(Math.round(swc.length))} µm</dd>
      <dt>Branch points</dt><dd class="mono">${fmt(swc.branchPoints)}</dd>
      <dt>Terminal tips</dt><dd class="mono">${fmt(swc.tips)}</dd>
      <dt>Extent</dt><dd class="mono">${["x", "y", "z"].map((a, i) => `${a} ${Math.round(swc.bbox.max[i] - swc.bbox.min[i])}`).join(" · ")} µm</dd>
    </dl>
    <div class="nq-result small muted"></div>
    ${full ? `<div class="thumbs"><figure><canvas data-v="dorsal"></canvas><figcaption>dorsal</figcaption></figure><figure><canvas data-v="sagittal"></canvas><figcaption>sagittal</figcaption></figure><figure><canvas data-v="coronal"></canvas><figcaption>coronal</figcaption></figure></div>` : ""}`;
  el.querySelector('[data-act="toggle"]').onclick = () => {
    if (state.neurons.has(id)) remove("neuron", id);
    else addNeurons([id]);
    setTimeout(() => neuronDetail(el, id, { full }), 50);
  };
  el.querySelector('[data-act="goto"]').onclick = () => { if (!state.neurons.has(id)) addNeurons([id]); setFocus("neuron", id); if (so) setCursor(so, "goto"); goExplorer(); };
  el.querySelector('[data-act="similar"]').onclick = async () => {
    const out = el.querySelector(".nq-result");
    out.innerHTML = `<span class="spinner"></span> scoring morphology similarity (mapZebrain NBLAST-style search)…`;
    try {
      const r = await post("search_for_neuron_similarities", { neuronID: id, topNSimilar: 10 });
      out.innerHTML = `${esc(r.group_name)}<br>${r.neuronsIDs.map((n) => `<a href="#" data-n="${n}">${n}</a>`).join(", ")} · <a href="#" data-all>show all in viewer</a>`;
      out.querySelectorAll("[data-n]").forEach((a) => (a.onclick = (e) => { e.preventDefault(); el.dispatchEvent(new CustomEvent("navigate-neuron", { bubbles: true, detail: +a.dataset.n })); }));
      out.querySelector("[data-all]").onclick = (e) => { e.preventDefault(); addNeurons([id, ...r.neuronsIDs]); goExplorer(); };
    } catch (e) { out.textContent = "Similarity search failed: " + e.message; }
  };
  el.querySelectorAll("[data-marker]").forEach((a) => (a.onclick = (e) => { e.preventDefault(); document.dispatchEvent(new CustomEvent("open-marker", { detail: +a.dataset.marker })); }));
  if (full && so) {
    const at = { dorsal: so.z, sagittal: so.x, coronal: so.y };
    el.querySelectorAll("canvas[data-v]").forEach((cv) => drawPreview(cv, cv.dataset.v, Math.round(at[cv.dataset.v]), { swc, color: "#ffd23f" }));
  }
}

export function showDetail(el, kind, id, opts) {
  if (kind === "region") return regionDetail(el, id, opts);
  if (kind === "marker") return markerDetail(el, id, opts);
  if (kind === "neuron") return neuronDetail(el, id, opts);
}
