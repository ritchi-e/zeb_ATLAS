// Regions tree, markers table and neurons table.
import { db, esc, fmt, neuronsInRegion, isLoadable } from "./data.js";
import { state, on, addNeurons } from "./state.js";
import { regionDetail, markerDetail, neuronDetail, goExplorer, toast } from "./details.js";

const $ = (s) => document.querySelector(s);

/* ======================= REGIONS ======================= */
export function initRegions() {
  const sel = $("#region-version"), tree = $("#region-tree"), detail = $("#region-detail"), filter = $("#region-filter");
  sel.innerHTML = db.versions.map((v) => `<option value="${esc(v.display_name)}" ${v.display_name === db.defaultVersion ? "selected" : ""}>Atlas ${esc(v.display_name)}</option>`).join("");
  let current = null;
  const soma = (id) => db.regionNeurons?.[id]?.soma?.length;

  function render() {
    const q = filter.value.trim().toLowerCase();
    const roots = db.trees[sel.value] || [];
    const matches = (n) => db.regions[n.id].name.toLowerCase().includes(q) || n.children.some(matches);
    const hl = (s) => (q ? esc(s).replace(new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig"), (m) => `<mark>${m}</mark>`) : esc(s));
    const li = (n, depth) => {
      if (q && !matches(n)) return "";
      const r = db.regions[n.id];
      const c = soma(n.id);
      const collapsed = !q && depth >= 1 && n.children.length ? "collapsed" : "";
      return `<li class="${collapsed}" data-id="${n.id}">
        <div class="node ${current === n.id ? "sel" : ""}" data-id="${n.id}">
          <span class="tw">${n.children.length ? (collapsed ? "▶" : "▼") : ""}</span>
          <span class="dot" style="background:${r.visualization_data?.color || "#666"}"></span>
          <span>${hl(r.name)}</span>
          ${state.regions.has(n.id) ? `<span class="in-viewer" title="In viewer">●</span>` : ""}
          ${c != null ? `<span class="n-count" title="Neurons with soma in region">${fmt(c)}</span>` : ""}
        </div>
        ${n.children.length ? `<ul>${n.children.map((k) => li(k, depth + 1)).join("")}</ul>` : ""}
      </li>`;
    };
    tree.innerHTML = `<div class="small muted" style="margin-bottom:6px">${fmt(db.regionList.filter((r) => r.version.display_name === sel.value).length)} regions${db.regionNeurons ? " · right column: neurons with soma in region" : ""}</div><ul>${roots.map((n) => li(n, 0)).join("")}</ul>`;
  }
  tree.addEventListener("click", (e) => {
    const node = e.target.closest(".node"); if (!node) return;
    const lis = node.parentElement;
    if (e.target.classList.contains("tw")) { lis.classList.toggle("collapsed"); e.target.textContent = lis.classList.contains("collapsed") ? "▶" : "▼"; return; }
    open(+node.dataset.id);
  });
  function open(id) {
    current = id;
    const r = db.regions[id];
    if (r && r.version.display_name !== sel.value) { sel.value = r.version.display_name; render(); }
    tree.querySelectorAll(".node.sel").forEach((n) => n.classList.remove("sel"));
    const node = tree.querySelector(`.node[data-id="${id}"]`);
    if (node) {
      node.classList.add("sel");
      for (let p = node.parentElement; p && p !== tree; p = p.parentElement) if (p.tagName === "LI" && p !== node.parentElement) { p.classList.remove("collapsed"); const tw = p.querySelector(":scope > .node .tw"); if (tw && tw.textContent) tw.textContent = "▼"; }
      node.scrollIntoView({ block: "nearest" });
    }
    regionDetail(detail, id, { full: true });
  }
  detail.addEventListener("navigate-region", (e) => open(e.detail));
  sel.onchange = render; filter.oninput = render;
  $("#region-expand").onclick = () => tree.querySelectorAll("li.collapsed").forEach((l) => { l.classList.remove("collapsed"); const t = l.querySelector(".tw"); if (t) t.textContent = "▼"; });
  $("#region-collapse").onclick = render;
  on("layers", (d) => { if (d?.kind === "region") render(); });
  render();
  return { open };
}

/* ======================= generic sortable table ======================= */
function table(el, cols, { onRow, rowClass }) {
  let rows = [], sortKey = null, asc = true, limit = 300;
  function draw() {
    const sorted = sortKey ? [...rows].sort((a, b) => {
      const c = cols.find((x) => x.key === sortKey);
      const va = c.sort ? c.sort(a) : a[sortKey], vb = c.sort ? c.sort(b) : b[sortKey];
      return (va > vb ? 1 : va < vb ? -1 : 0) * (asc ? 1 : -1);
    }) : rows;
    const shown = sorted.slice(0, limit);
    el.innerHTML = `<thead><tr>${cols.map((c) => `<th data-k="${c.key}" class="${c.key === sortKey ? "sorted" + (asc ? " asc" : "") : ""}">${c.label}</th>`).join("")}</tr></thead>
      <tbody>${shown.map((r) => `<tr data-id="${r.id}" class="${rowClass?.(r) || ""}">${cols.map((c) => `<td class="${c.num ? "num" : ""}">${c.html ? c.html(r) : esc(r[c.key] ?? "")}</td>`).join("")}</tr>`).join("")}
      ${sorted.length > limit ? `<tr><td colspan="${cols.length}" class="muted" style="text-align:center"><a href="#" data-more>Show ${Math.min(500, sorted.length - limit)} more of ${fmt(sorted.length - limit)} remaining</a></td></tr>` : ""}</tbody>`;
  }
  el.addEventListener("click", (e) => {
    const th = e.target.closest("th");
    if (th) { const k = th.dataset.k; asc = sortKey === k ? !asc : true; sortKey = k; draw(); return; }
    if (e.target.matches("[data-more]")) { e.preventDefault(); limit += 500; draw(); return; }
    const tr = e.target.closest("tr[data-id]");
    if (tr) { el.querySelectorAll("tr.sel").forEach((x) => x.classList.remove("sel")); tr.classList.add("sel"); onRow(tr.dataset.id); }
  });
  return { set(r) { rows = r; limit = 300; draw(); }, draw };
}

/* ======================= MARKERS ======================= */
export function initMarkers() {
  const withNeurons = new Set(db.mpin?.markersWithNeuronsIDs || []);
  const cat = $("#marker-category"), lab = $("#marker-lab"), q = $("#marker-filter"), hasN = $("#marker-has-neurons");
  cat.innerHTML += db.markerCategories.map((c) => `<option>${esc(c)}</option>`).join("");
  const labs = [...new Set(db.markerList.map((m) => m.lab?.name).filter(Boolean))].sort();
  lab.innerHTML += labs.map((l) => `<option>${esc(l)}</option>`).join("");
  const detail = $("#marker-detail");
  const rows = db.markerList.map((m) => ({
    id: m.id, name: m.name, category: m.category?.name || "", lab: m.lab?.name || "", type: m.type_to_str || "",
    effector: m.effector && m.effector !== "-" ? m.effector : "", search: `${m.name} ${m.full_name} ${m.synonyms || ""} ${m.type_to_str}`.toLowerCase(),
    zfin: m.zfin_link && m.zfin_link !== "Pending" ? m.zfin_link : "", neurons: withNeurons.has(m.id),
  }));
  const t = table($("#marker-table"), [
    { key: "name", label: "Name", html: (r) => `<b>${esc(r.name)}</b>${state.markers.has(r.id) ? ` <span class="in-viewer" title="in viewer" style="color:var(--accent)">●</span>` : ""}` },
    { key: "category", label: "Category", html: (r) => `<span class="tag">${esc(r.category)}</span>` },
    { key: "type", label: "Type" },
    { key: "effector", label: "Effector" },
    { key: "lab", label: "Lab" },
    { key: "neurons", label: "Neurons", html: (r) => (r.neurons ? "✓" : ""), sort: (r) => (r.neurons ? 0 : 1) },
  ], { onRow: (id) => markerDetail(detail, +id, { full: true }) });
  function apply() {
    const s = q.value.trim().toLowerCase();
    const f = rows.filter((r) => (!s || r.search.includes(s)) && (!cat.value || r.category === cat.value) && (!lab.value || r.lab === lab.value) && (!hasN.checked || r.neurons));
    $("#marker-count").textContent = `${fmt(f.length)} of ${fmt(rows.length)} markers`;
    t.set(f);
  }
  [q, cat, lab, hasN].forEach((x) => x.addEventListener("input", apply));
  apply();
  document.addEventListener("open-marker", (e) => { location.hash = "#markers"; q.value = db.markers[e.detail]?.name || ""; apply(); markerDetail(detail, e.detail, { full: true }); });
  on("layers", (d) => { if (d?.kind === "marker") t.draw(); });
}

/* ======================= NEURONS ======================= */
export function initNeurons() {
  const detail = $("#neuron-detail");
  const q = $("#neuron-filter"), ct = $("#neuron-celltype"), mk = $("#neuron-marker"), lb = $("#neuron-lab"), rg = $("#neuron-region"), mode = $("#neuron-region-mode");
  const rows = db.neuronIds.map((id) => {
    const n = db.neurons[id] || {};
    return { id, name: n.name || "", cell_type: n.cell_type || "", marker: n.marker || "", lab: n.lab || "", pub: n.publication || "" };
  });
  const uniq = (k) => [...new Set(rows.map((r) => r[k]).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const counts = (k) => rows.reduce((m, r) => (m.set(r[k], (m.get(r[k]) || 0) + 1), m), new Map());
  const opt = (k, el) => { const c = counts(k); el.innerHTML += uniq(k).map((v) => `<option value="${esc(v)}">${esc(v)} (${c.get(v)})</option>`).join(""); };
  opt("cell_type", ct); opt("marker", mk); opt("lab", lb);
  const regs = db.regionList.filter((r) => r.version.display_name === db.defaultVersion && isLoadable(r)).sort((a, b) => a.name.localeCompare(b.name));
  rg.innerHTML += regs.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join("");
  if (!db.hasNeuronMeta) {
    [ct, mk, lb].forEach((s) => (s.disabled = true));
    $("#neuron-count").title = "Run scripts/fetch_data.py to enable metadata filters";
  }
  const pubShort = (u) => { const p = db.mpin?.publications?.find((x) => x.url && u && u.startsWith(x.url.slice(0, 40))); return p ? p.name : u ? new URL(u).hostname.replace("www.", "") : ""; };
  const t = table($("#neuron-table"), [
    { key: "id", label: "ID", num: true, html: (r) => `${r.id}${state.neurons.has(r.id) ? ` <span style="color:var(--accent)">●</span>` : ""}` },
    { key: "cell_type", label: "Cell type" },
    { key: "marker", label: "Marker line" },
    { key: "lab", label: "Lab" },
    { key: "pub", label: "Source", html: (r) => esc(pubShort(r.pub)) },
  ], { onRow: (id) => neuronDetail(detail, +id, { full: true }) });

  let filtered = rows, regionSet = null;
  async function apply() {
    if (rg.value) {
      $("#neuron-count").innerHTML = `<span class="spinner"></span> region query…`;
      try { regionSet = new Set(await neuronsInRegion(+rg.value, mode.value)); } catch { regionSet = new Set(); }
    } else regionSet = null;
    const s = q.value.trim().toLowerCase();
    filtered = rows.filter((r) => (!s || String(r.id).includes(s) || r.name.toLowerCase().includes(s)) &&
      (!ct.value || r.cell_type === ct.value) && (!mk.value || r.marker === mk.value) && (!lb.value || r.lab === lb.value) &&
      (!regionSet || regionSet.has(r.id)));
    $("#neuron-count").textContent = `${fmt(filtered.length)} of ${fmt(rows.length)} neurons`;
    t.set(filtered);
  }
  [q, ct, mk, lb, rg, mode].forEach((x) => x.addEventListener("input", apply));
  $("#neuron-show-filtered").onclick = () => {
    const ids = filtered.slice(0, 300).map((r) => r.id);
    addNeurons(ids); toast(`Loading ${ids.length} neurons into the viewer`); goExplorer();
  };
  $("#neuron-download-ids").onclick = () => {
    const csv = "id,name,cell_type,marker,lab,publication\n" + filtered.map((r) => [r.id, r.name, r.cell_type, r.marker, r.lab, r.pub].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); a.download = "neurons_filtered.csv"; a.click();
  };
  detail.addEventListener("navigate-neuron", (e) => neuronDetail(detail, e.detail, { full: true }));
  document.addEventListener("filter-neurons", (e) => { rg.value = e.detail.region; mode.value = e.detail.mode; apply(); });
  document.addEventListener("filter-neurons-ids", (e) => {
    rg.value = ""; q.value = ""; ct.value = ""; mk.value = ""; lb.value = "";
    const set = new Set(e.detail.ids);
    filtered = rows.filter((r) => set.has(r.id));
    $("#neuron-count").textContent = `${fmt(filtered.length)} neurons · ${e.detail.label}`;
    t.set(filtered);
  });
  on("layers", (d) => { if (d?.kind === "neuron") t.draw(); });
  apply();
}
