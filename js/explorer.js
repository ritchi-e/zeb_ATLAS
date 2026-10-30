// Explorer page: layer list, global search, inspector, cursor read-outs.
import { db, esc, fmt, post, isLoadable } from "./data.js";
import { state, on, emit, addRegion, addMarker, addNeurons, remove, clearKind, setFocus, update } from "./state.js";
import { showDetail, toast, goExplorer, gotoRegion } from "./details.js";
import { describeHover } from "./slice.js";

const $ = (s) => document.querySelector(s);
const MAX_LIST = 80;

export function initExplorer(slices) {
  /* ----- toolbar ----- */
  $("#layout-seg").onclick = (e) => {
    const b = e.target.closest("button"); if (!b) return;
    $("#layout-seg").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    const g = $("#viewer-grid");
    g.className = `viewer-grid layout-${b.dataset.layout}`;
    g.querySelectorAll(".pane").forEach((p) => p.classList.remove("max"));
  };
  $("#region-style-seg").onclick = (e) => {
    const b = e.target.closest("button"); if (!b) return;
    $("#region-style-seg").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    state.regionStyle = b.dataset.style; update();
  };
  $("#slab").oninput = (e) => { state.slab = +e.target.value; $("#slab-val").textContent = `±${state.slab} µm`; update(); };
  $("#neuron-ghost").onchange = (e) => { state.ghost = e.target.checked; update(); };
  $("#crosshair-on").onchange = (e) => { state.crosshair = e.target.checked; update(); };
  $("#base-visible").onchange = (e) => { state.baseVisible = e.target.checked; update(); };
  $("#base-gain").oninput = (e) => { state.baseGain = +e.target.value; update(); };
  $("#reset-views").onclick = () => slices.reset();
  $("#clear-all").onclick = () => { ["region", "marker", "neuron"].forEach(clearKind); };

  /* ----- quick adds ----- */
  document.querySelector(".quick-add").onclick = async (e) => {
    const b = e.target.closest("[data-quick]"); if (!b) return;
    const k = b.dataset.quick;
    if (k === "major-regions") {
      const roots = db.trees[db.defaultVersion];
      const ids = roots.flatMap((r) => r.children.length ? r.children.map((c) => c.id) : [r.id]).filter((id) => isLoadable(db.regions[id]));
      ids.forEach((id) => addRegion(id, { silent: true })); emit("layers", {});
      toast(`Added ${ids.length} major divisions`);
    } else if (k === "sample-neurons") {
      const pool = [...db.neuronIds];
      const pick = Array.from({ length: 25 }, () => pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
      addNeurons(pick); toast("Loading 25 random neurons…");
    } else if (k === "mitral") {
      const r = await post("search_for_neurons_IDs_by_cell_type", { selectedCellTypeID: 2 });
      addNeurons(r.neuronsIDs, { color: "#3fd0ff" }); toast(`${r.neuronsIDs.length} mitral cells (olfactory bulb output neurons)`);
    }
  };

  /* ----- layer list ----- */
  const groups = $("#layer-groups");
  function renderLayers() {
    const sec = (kind, label, map, nameOf) => {
      if (!map.size) return "";
      const g = state.group[kind + "s"];
      const items = [...map.values()];
      const shown = items.slice(0, MAX_LIST);
      const loading = kind === "neuron" ? items.filter((n) => n.loading).length : 0;
      return `<div class="layer-group" data-kind="${kind}">
        <div class="layer-group-head">
          <input type="checkbox" data-gvis ${g.visible ? "checked" : ""} title="Show/hide all">
          <b>${label}</b><span class="count">${fmt(map.size)}${loading ? ` · loading ${loading}` : ""}</span>
          <span class="spacer"></span><button class="link-btn" data-gclear>clear</button>
        </div>
        <div class="opacity">opacity <input type="range" min="0.05" max="1" step="0.05" value="${g.opacity}" data-gop></div>
        ${shown.map((it) => `<div class="layer-item ${state.focus?.kind === kind && state.focus.id === it.id ? "focused" : ""}" data-id="${it.id}">
            <input type="checkbox" data-vis ${it.visible ? "checked" : ""}>
            <input type="color" value="${it.color}" data-col>
            <span class="name" title="${esc(nameOf(it.id))}">${it.loading ? '<span class="spinner"></span> ' : ""}${it.error ? "⚠ " : ""}${esc(nameOf(it.id))}</span>
            <button class="x" data-rm title="Remove">×</button>
          </div>`).join("")}
        ${items.length > MAX_LIST ? `<div class="small muted" style="padding:4px 6px">+ ${fmt(items.length - MAX_LIST)} more (all drawn)</div>` : ""}
      </div>`;
    };
    groups.innerHTML =
      sec("region", "Regions", state.regions, (id) => db.regions[id]?.short_name || db.regions[id]?.name) +
      sec("marker", "Markers", state.markers, (id) => db.markers[id]?.name) +
      sec("neuron", "Neurons", state.neurons, (id) => {
        const n = db.neurons[id];
        return n?.cell_type ? `${id} · ${n.cell_type}` : `${id}${n?.marker ? " · " + n.marker : ""}`;
      }) ||
      `<p class="small muted" style="margin-top:12px">Nothing loaded yet. Search above, use a quick-add, or pick items on the Regions / Markers / Neurons pages.</p>`;
  }
  let layerTimer;
  const renderSoon = () => { clearTimeout(layerTimer); layerTimer = setTimeout(renderLayers, 60); };
  on("layers", renderSoon); on("neuron-loaded", renderSoon); on("focus", renderSoon);

  const mapOf = (kind) => ({ region: state.regions, marker: state.markers, neuron: state.neurons })[kind];
  groups.addEventListener("input", (e) => {
    const g = e.target.closest(".layer-group"); if (!g) return;
    const kind = g.dataset.kind;
    if (e.target.matches("[data-gop]")) { state.group[kind + "s"].opacity = +e.target.value; update(); return; }
    const row = e.target.closest(".layer-item"); if (!row) return;
    const it = mapOf(kind).get(+row.dataset.id);
    if (e.target.matches("[data-col]")) { it.color = e.target.value; update(); }
  });
  groups.addEventListener("change", (e) => {
    const g = e.target.closest(".layer-group"); if (!g) return;
    const kind = g.dataset.kind;
    if (e.target.matches("[data-gvis]")) { state.group[kind + "s"].visible = e.target.checked; update(); return; }
    const row = e.target.closest(".layer-item");
    if (row && e.target.matches("[data-vis]")) { mapOf(kind).get(+row.dataset.id).visible = e.target.checked; update(); }
  });
  groups.addEventListener("click", (e) => {
    const g = e.target.closest(".layer-group"); if (!g) return;
    const kind = g.dataset.kind;
    if (e.target.matches("[data-gclear]")) { clearKind(kind); return; }
    const row = e.target.closest(".layer-item"); if (!row) return;
    const id = +row.dataset.id;
    if (e.target.matches("[data-rm]")) remove(kind, id);
    else if (e.target.matches(".name")) setFocus(kind, id);
  });

  /* ----- inspector ----- */
  const detail = $("#detail-panel");
  on("focus", (f) => { if (f) showDetail(detail, f.kind, f.id); });
  detail.addEventListener("navigate-region", (e) => { setFocus("region", e.detail); });
  detail.addEventListener("navigate-neuron", (e) => { setFocus("neuron", e.detail); });

  const xyz = $("#cursor-xyz");
  on("cursor", () => { const c = state.cursor; xyz.textContent = `x ${c.x}, y ${c.y}, z ${c.z}`; });
  emit("cursor");
  const hov = $("#hover-info");
  on("hover", (h) => (hov.innerHTML = describeHover(h)));

  const rap = $("#regions-at-point");
  async function identify() {
    rap.innerHTML = `<span class="spinner"></span> asking mapZebrain…`;
    try {
      const r = await post("get_regions_of_position", { position: { ...state.cursor } });
      const regs = r.regionsIDs.map((id) => db.regions[id]).filter(Boolean)
        .sort((a, b) => (a.version.number + a.name).localeCompare(b.version.number + b.name));
      if (!regs.length) { rap.innerHTML = `<span class="muted">Outside annotated regions.</span>`; return; }
      const byV = {};
      regs.forEach((x) => (byV[x.version.display_name] ||= []).push(x));
      rap.innerHTML = Object.entries(byV).map(([v, list]) => `<div class="small muted" style="margin:4px 0 2px">${esc(v)}</div>` +
        list.map((x) => `<span class="region-chip" data-id="${x.id}" title="Click to add to viewer"><span class="dot" style="background:${x.visualization_data?.color}"></span>${esc(x.short_name || x.name)}</span>`).join("")).join("");
      rap.querySelectorAll("[data-id]").forEach((c) => (c.onclick = () => { addRegion(+c.dataset.id); setFocus("region", +c.dataset.id); }));
    } catch (e) { rap.textContent = "Lookup failed: " + e.message; }
  }
  $("#identify-btn").onclick = identify;
  document.addEventListener("keydown", (e) => {
    if ((e.key === "r" || e.key === "R") && !e.metaKey && !e.ctrlKey && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) && location.hash.replace("#", "") === "explorer") identify();
  });

  initSearch();
  renderLayers();
}

/* ---------------- global search ---------------- */
function initSearch() {
  const input = $("#global-search"), box = $("#search-results");
  let items = [], active = 0;
  const norm = (s) => (s || "").toLowerCase();
  function search(q) {
    q = norm(q.trim());
    if (q.length < 2) return [];
    const score = (name, extra = "") => {
      const n = norm(name);
      if (n === q) return 0; if (n.startsWith(q)) return 1; if (n.includes(q)) return 2;
      if (norm(extra).includes(q)) return 3; return -1;
    };
    const regions = db.regionList.filter((r) => isLoadable(r))
      .map((r) => ({ kind: "region", id: r.id, name: r.name, sub: "v" + r.version.number, s: score(r.name, r.short_name) + (r.version.display_name === db.defaultVersion ? 0 : 0.5), color: r.visualization_data?.color }))
      .filter((x) => x.s >= 0).sort((a, b) => a.s - b.s).slice(0, 8);
    const markers = db.markerList.map((m) => ({ kind: "marker", id: m.id, name: m.name, sub: m.category?.name, s: score(m.name, m.synonyms + " " + m.full_name) }))
      .filter((x) => x.s >= 0).sort((a, b) => a.s - b.s).slice(0, 8);
    const neurons = [];
    if (/^\d+$/.test(q) && db.neurons[q]) neurons.push({ kind: "neuron", id: +q, name: `Neuron ${q}`, sub: db.neurons[q].cell_type || db.neurons[q].marker, s: 0 });
    const types = new Map();
    for (const [id, n] of Object.entries(db.neurons)) if (n.cell_type && norm(n.cell_type).includes(q)) { if (!types.has(n.cell_type)) types.set(n.cell_type, []); types.get(n.cell_type).push(+id); }
    for (const [t, ids] of [...types].slice(0, 5)) neurons.push({ kind: "celltype", ids, name: t, sub: `${ids.length} neurons` });
    return [["Regions", regions], ["Markers", markers], ["Neurons & cell types", neurons]];
  }
  function render(groups) {
    items = groups.flatMap(([, l]) => l);
    if (!items.length) { box.hidden = input.value.trim().length < 2; box.innerHTML = `<div class="sr-item muted">No matches</div>`; return; }
    let i = 0;
    box.innerHTML = groups.filter(([, l]) => l.length).map(([g, l]) => `<div class="sr-group">${g}</div>` + l.map((x) => `
      <div class="sr-item ${i === active ? "active" : ""}" data-i="${i++}">${x.color ? `<span class="dot" style="background:${x.color}"></span>` : ""}<span>${esc(x.name)}</span><small>${esc(x.sub || "")}</small></div>`).join("")).join("");
    box.hidden = false;
  }
  function choose(x) {
    if (!x) return;
    if (x.kind === "region") { addRegion(x.id); setFocus("region", x.id); gotoRegion(x.id); }
    if (x.kind === "marker") { addMarker(x.id); setFocus("marker", x.id); }
    if (x.kind === "neuron") { addNeurons([x.id]); setFocus("neuron", x.id); }
    if (x.kind === "celltype") { addNeurons(x.ids.slice(0, 300)); toast(`Loading ${Math.min(300, x.ids.length)} ${x.name} neurons`); }
    box.hidden = true; input.value = ""; goExplorer();
  }
  input.addEventListener("input", () => { active = 0; render(search(input.value)); });
  input.addEventListener("keydown", (e) => {
    if (box.hidden) return;
    if (e.key === "ArrowDown") { active = Math.min(items.length - 1, active + 1); render(search(input.value)); e.preventDefault(); }
    if (e.key === "ArrowUp") { active = Math.max(0, active - 1); render(search(input.value)); e.preventDefault(); }
    if (e.key === "Enter") choose(items[active]);
    if (e.key === "Escape") box.hidden = true;
  });
  box.addEventListener("mousedown", (e) => { const it = e.target.closest("[data-i]"); if (it) { e.preventDefault(); choose(items[+it.dataset.i]); } });
  input.addEventListener("blur", () => setTimeout(() => (box.hidden = true), 150));
}
