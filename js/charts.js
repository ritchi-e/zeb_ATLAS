// Overview dashboard + region-to-region connectivity heatmap.
import { db, esc, fmt, isLoadable } from "./data.js";
import { addNeurons, addRegion } from "./state.js";
import { goExplorer, toast } from "./details.js";

const $ = (s) => document.querySelector(s);
const tip = () => document.getElementById("tooltip");
function showTip(e, html) { const t = tip(); t.innerHTML = html; t.hidden = false; const x = Math.min(e.clientX + 14, innerWidth - t.offsetWidth - 8); t.style.left = x + "px"; t.style.top = e.clientY + 14 + "px"; }
const hideTip = () => (tip().hidden = true);
const compact = (n) => (n >= 10000 ? (n / 1000).toFixed(1) + "K" : fmt(n));

/* ======================= OVERVIEW ======================= */
function countBy(list, key, top = 14) {
  const m = new Map();
  for (const x of list) { const k = typeof key === "function" ? key(x) : x[key]; if (k) m.set(k, (m.get(k) || 0) + 1); }
  let rows = [...m].sort((a, b) => b[1] - a[1]);
  if (rows.length > top) { const rest = rows.slice(top).reduce((s, r) => s + r[1], 0); rows = [...rows.slice(0, top), [`Other (${rows.length - top})`, rest]]; }
  return rows;
}

function hbarCard(title, sub, rows, { onClick, unit = "" } = {}) {
  const max = Math.max(...rows.map((r) => r[1]), 1);
  const card = document.createElement("div");
  card.className = "card chart-card";
  card.innerHTML = `<button class="btn small ghost toggle-table">Table</button><h2>${esc(title)}</h2><div class="sub">${esc(sub)}</div>
    <div class="hbar ${onClick ? "clickable" : ""}">${rows.map(([k, v], i) => `<div class="row-hit" data-i="${i}">
      <div class="lbl" title="${esc(k)}">${esc(k)}</div>
      <div class="track"><div class="bar" style="width:${(v / max) * 82}%"></div><span class="val">${compact(v)}</span></div></div>`).join("")}</div>
    <table class="chart-table" hidden><tbody>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${fmt(v)}</td></tr>`).join("")}</tbody></table>`;
  const total = rows.reduce((s, r) => s + r[1], 0);
  card.querySelectorAll(".row-hit").forEach((r) => {
    const [k, v] = rows[+r.dataset.i];
    r.querySelectorAll(".lbl,.track").forEach((el) => {
      el.addEventListener("mousemove", (e) => showTip(e, `<b>${esc(k)}</b><br><span class="tt-val">${fmt(v)}</span>${unit} · ${((v / total) * 100).toFixed(1)}%${onClick && !k.startsWith("Other") ? "<br><span class='muted'>click to explore</span>" : ""}`));
      el.addEventListener("mouseleave", hideTip);
      if (onClick && !k.startsWith("Other")) el.addEventListener("click", () => { hideTip(); onClick(k); });
    });
  });
  card.querySelector(".toggle-table").onclick = (e) => {
    const tb = card.querySelector("table"), hb = card.querySelector(".hbar");
    tb.hidden = !tb.hidden; hb.hidden = !tb.hidden; e.target.textContent = tb.hidden ? "Table" : "Chart";
  };
  return card;
}

export function initOverview() {
  const neurons = Object.values(db.neurons);
  const regionsV = db.regionList.filter((r) => r.version.display_name === db.defaultVersion);
  const markerLabs = new Set(db.markerList.map((m) => m.lab?.name).filter((x) => x && x !== "Undefined" && x !== "Various"));
  const cellTypes = new Set(neurons.map((n) => n.cell_type).filter(Boolean));
  const kpi = (label, value, sub) => `<div class="kpi"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;
  $("#kpis").innerHTML =
    kpi("Brain regions", fmt(regionsV.length), `atlas ${esc(db.defaultVersion)} · ${db.versions.length} versions`) +
    kpi("Markers & lines", fmt(db.markerList.length), `${db.markerCategories.length} categories`) +
    kpi("Traced neurons", fmt(db.neuronIds.length), db.hasNeuronMeta ? `${cellTypes.size} annotated cell types` : "metadata via live API") +
    kpi("Contributing labs", fmt(markerLabs.size), "marker data") +
    kpi("Neuron publications", fmt(db.mpin?.publications?.length || 0), "single-cell datasets");

  const g = $("#charts");
  g.innerHTML = "";
  const goMarkers = (field) => (k) => { location.hash = "#markers"; const el = $(field); el.value = k; el.dispatchEvent(new Event("input")); };
  const goNeurons = (field) => (k) => { location.hash = "#neurons"; const el = $(field); el.value = k; el.dispatchEvent(new Event("input")); };
  g.append(hbarCard("Markers by category", "Registered expression patterns per data type", countBy(db.markerList, (m) => m.category?.name), { onClick: goMarkers("#marker-category"), unit: " markers" }));
  g.append(hbarCard("Markers by contributing lab", "Top 14 labs; remainder grouped", countBy(db.markerList, (m) => m.lab?.name), { onClick: goMarkers("#marker-lab"), unit: " markers" }));
  if (db.hasNeuronMeta) {
    const withType = neurons.filter((n) => n.cell_type);
    g.append(hbarCard("Neurons by annotated cell type", `${fmt(withType.length)} of ${fmt(neurons.length)} neurons carry a cell-type label`, countBy(withType, "cell_type"), { onClick: goNeurons("#neuron-celltype"), unit: " neurons" }));
    g.append(hbarCard("Neurons by labelling line", "Which transgenic line sparsely labelled the cell", countBy(neurons, "marker"), { onClick: goNeurons("#neuron-marker"), unit: " neurons" }));
    g.append(hbarCard("Neurons by lab", "Where morphologies were traced", countBy(neurons, "lab"), { onClick: goNeurons("#neuron-lab"), unit: " neurons" }));
  }
  if (db.regionNeurons) {
    const roots = db.trees[db.defaultVersion];
    const majors = roots.flatMap((r) => (r.children.length ? r.children : [r]));
    const somaIn = (n) => { const s = new Set(); const walk = (x) => { (db.regionNeurons[x.id]?.soma || []).forEach((i) => s.add(i)); x.children.forEach(walk); }; walk(n); return s.size; };
    const rows = majors.map((n) => [db.regions[n.id].name, somaIn(n)]).filter((r) => r[1] > 0).sort((a, b) => b[1] - a[1]);
    g.append(hbarCard("Neurons by soma location", "Major brain divisions (atlas " + db.defaultVersion + ")", rows, { unit: " neurons" }));
  }
}

/* ======================= CONNECTIVITY ======================= */
function cutTree(level) {
  const roots = db.trees[db.defaultVersion];
  const out = [];
  const depthLimit = level === "top" ? 1 : level === "mid" ? 2 : 99;
  const walk = (n, d) => {
    if (d === depthLimit || !n.children.length) { out.push(n); return; }
    n.children.forEach((c) => walk(c, d + 1));
  };
  roots.forEach((r) => walk(r, 0));
  return out.filter((n) => isLoadable(db.regions[n.id]));
}
const unionIds = (n, mode) => { const s = new Set(); const w = (x) => { (db.regionNeurons[x.id]?.[mode] || []).forEach((i) => s.add(i)); x.children.forEach(w); }; w(n); return s; };

function ramp(t) {
  // sequential, one hue; reads tokens so light/dark both work
  const cs = getComputedStyle(document.documentElement);
  const stops = [0, 1, 2, 3, 4, 5].map((i) => cs.getPropertyValue(`--seq-${i}`).trim());
  const rgb = stops.map((h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)));
  const x = Math.max(0, Math.min(1, t)) * (rgb.length - 1), i = Math.min(rgb.length - 2, Math.floor(x)), f = x - i;
  return `rgb(${rgb[i].map((c, k) => Math.round(c + (rgb[i + 1][k] - c) * f)).join(",")})`;
}

export function initConnectivity() {
  const wrap = $("#conn-matrix"), detail = $("#conn-detail");
  if (!db.regionNeurons) {
    wrap.innerHTML = `<p class="muted">The connectivity matrix needs the region↔neuron snapshot. Run <code>python3 scripts/fetch_data.py</code> and reload.</p>`;
    return;
  }
  const lvl = $("#conn-level"), tmode = $("#conn-target-mode"), hideEmpty = $("#conn-hide-empty"), logS = $("#conn-log");
  let M = null;

  function compute() {
    const nodes = cutTree(lvl.value);
    const soma = nodes.map((n) => unionIds(n, "soma"));
    const tgt = nodes.map((n) => unionIds(n, tmode.value));
    const mat = soma.map((s) => tgt.map((t) => { let c = 0; for (const i of s) if (t.has(i)) c++; return c; }));
    let rows = nodes.map((_, i) => i), cols = nodes.map((_, i) => i);
    if (hideEmpty.checked) { rows = rows.filter((i) => mat[i].some((v) => v)); cols = cols.filter((j) => mat.some((r) => r[j])); }
    M = { nodes, soma, tgt, mat, rows, cols };
  }

  function draw() {
    compute();
    const { nodes, mat, rows, cols } = M;
    const name = (i) => db.regions[nodes[i].id].short_name || db.regions[nodes[i].id].name;
    const trunc = (s, n = 34) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
    const max = Math.max(1, ...rows.flatMap((i) => cols.map((j) => mat[i][j])));
    const cs = Math.max(9, Math.min(22, Math.floor(620 / Math.max(rows.length, cols.length))));
    const L = 210, T = 190;
    const W = L + cols.length * cs + 10, H = T + rows.length * cs + 10;
    const scale = (v) => (logS.checked ? Math.log1p(v) / Math.log1p(max) : v / max);
    const zero = getComputedStyle(document.documentElement).getPropertyValue("--surface-2").trim();
    let cells = "";
    rows.forEach((i, ri) => cols.forEach((j, cj) => {
      const v = mat[i][j];
      cells += `<rect class="cell" x="${L + cj * cs}" y="${T + ri * cs}" width="${cs - 1}" height="${cs - 1}" rx="1.5" fill="${v ? ramp(0.08 + 0.92 * scale(v)) : zero}" data-i="${i}" data-j="${j}"/>`;
    }));
    const rlab = rows.map((i, ri) => `<text x="${L - 6}" y="${T + ri * cs + cs / 2 + 3.5}" text-anchor="end" data-r="${i}">${esc(trunc(name(i)))}</text>`).join("");
    const clab = cols.map((j, cj) => `<text transform="translate(${L + cj * cs + cs / 2 + 3.5},${T - 6}) rotate(-60)" data-c="${j}">${esc(trunc(name(j), 30))}</text>`).join("");
    wrap.innerHTML = `
      <div class="legend-ramp">0 <div class="ramp" style="background:linear-gradient(90deg, ${[0, .25, .5, .75, 1].map((t) => ramp(0.08 + 0.92 * t)).join(",")})"></div> ${fmt(max)} neurons ${logS.checked ? "(log scale)" : ""} · ${rows.length} × ${cols.length} regions</div>
      <svg width="${W}" height="${H}" role="img" aria-label="Connectivity heatmap">
        <text class="axis-title" x="${L - 6}" y="${T - 8}" text-anchor="end">soma in ↓ · ${tmode.value === "pass" ? "passes through" : "terminates in"} →</text>
        ${rlab}${clab}${cells}
      </svg>`;
    const svg = wrap.querySelector("svg");
    svg.addEventListener("mousemove", (e) => {
      const c = e.target.closest("rect.cell");
      svg.querySelectorAll(".hl").forEach((x) => x.classList.remove("hl"));
      if (!c) return hideTip();
      const i = +c.dataset.i, j = +c.dataset.j;
      svg.querySelector(`[data-r="${i}"]`)?.classList.add("hl"); svg.querySelector(`[data-c="${j}"]`)?.classList.add("hl");
      showTip(e, `<b>${esc(name(i))}</b> → <b>${esc(name(j))}</b><br><span class="tt-val">${fmt(mat[i][j])}</span> neurons<br><span class="muted">${fmt(M.soma[i].size)} with soma in source</span>`);
    });
    svg.addEventListener("mouseleave", hideTip);
    svg.addEventListener("click", (e) => { const c = e.target.closest("rect.cell"); if (c) openCell(+c.dataset.i, +c.dataset.j); });
    summary();
  }

  function idsFor(i, j) { const t = M.tgt[j]; return [...M.soma[i]].filter((x) => t.has(x)); }
  function openCell(i, j) {
    const a = db.regions[M.nodes[i].id], b = db.regions[M.nodes[j].id];
    const ids = idsFor(i, j);
    const types = new Map(); ids.forEach((id) => { const t = db.neurons[id]?.cell_type || "unlabelled"; types.set(t, (types.get(t) || 0) + 1); });
    detail.innerHTML = `<h2>${esc(a.name)} → ${esc(b.name)}</h2>
      <p class="small muted">${fmt(ids.length)} neurons with soma in the source that ${tmode.value === "pass" ? "pass through" : "terminate in"} the target.</p>
      <div class="actions"><button class="btn small" data-show>Show in viewer (with both regions)</button><button class="btn small ghost" data-table>Open in Neurons table</button></div>
      <div class="small muted">Cell types</div>
      <table class="chart-table"><tbody>${[...types].sort((x, y) => y[1] - x[1]).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${fmt(v)}</td></tr>`).join("")}</tbody></table>
      <div class="small muted" style="margin-top:10px">Neuron IDs</div><div class="mono small" style="word-break:break-all">${ids.slice(0, 400).join(", ")}${ids.length > 400 ? " …" : ""}</div>`;
    detail.querySelector("[data-show]").onclick = async () => {
      addRegion(a.id); if (b.id !== a.id) addRegion(b.id);
      addNeurons(ids.slice(0, 300)); toast(`Loading ${Math.min(300, ids.length)} neurons`); goExplorer();
    };
    detail.querySelector("[data-table]").onclick = () => { document.dispatchEvent(new CustomEvent("filter-neurons-ids", { detail: { ids, label: `${a.short_name || a.name} → ${b.short_name || b.name}` } })); location.hash = "#neurons"; };
  }
  function summary() {
    const list = [];
    M.rows.forEach((i) => M.cols.forEach((j) => { if (i !== j && M.mat[i][j]) list.push([i, j, M.mat[i][j]]); }));
    list.sort((a, b) => b[2] - a[2]);
    const nm = (i) => esc(db.regions[M.nodes[i].id].short_name || db.regions[M.nodes[i].id].name);
    detail.innerHTML = `<h2>Strongest projections</h2><p class="small muted">Off-diagonal cells, ranked. Click a row (or any matrix cell) for the neurons behind it.</p>
      <table class="chart-table"><tbody>${list.slice(0, 25).map(([i, j, v]) => `<tr data-i="${i}" data-j="${j}" style="cursor:pointer"><td>${nm(i)} → ${nm(j)}</td><td>${fmt(v)}</td></tr>`).join("")}</tbody></table>`;
    detail.querySelectorAll("tr[data-i]").forEach((tr) => (tr.onclick = () => openCell(+tr.dataset.i, +tr.dataset.j)));
  }
  [lvl, tmode, hideEmpty, logS].forEach((x) => x.addEventListener("input", draw));
  document.addEventListener("theme", draw);
  draw();
}
