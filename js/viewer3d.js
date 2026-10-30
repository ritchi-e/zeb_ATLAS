// 3D viewer: brain surface meshes, region meshes, neuron skeletons and live textured slice planes.
import * as THREE from "three";
import { TrackballControls } from "three/addons/controls/TrackballControls.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { db, VOL, mediaUrl } from "./data.js";
import { state, on, setFocus, setCursor } from "./state.js";
import { composeSlice } from "./slice.js";

const CENTER = new THREE.Vector3(VOL.x / 2, VOL.y / 2, VOL.z / 2);
const stl = new STLLoader();
const geomCache = new Map();
function loadGeom(path) {
  if (!geomCache.has(path)) {
    geomCache.set(path, new Promise((res, rej) => stl.load(mediaUrl(path), (g) => { g.computeVertexNormals(); res(g); }, undefined, rej))
      .catch((e) => { geomCache.delete(path); throw e; }));
  }
  return geomCache.get(path);
}

/** Region centre (volume coords), from its surface mesh. */
export async function regionCenter(id) {
  const path = db.regions[id]?.visualization_data?._3d?.mesh_file;
  if (!path) return null;
  const g = await loadGeom(path);
  g.computeBoundingBox();
  const c = g.boundingBox.getCenter(new THREE.Vector3());
  // nudge toward an actual vertex so non-convex regions land inside tissue
  const pos = g.attributes.position;
  let best = Infinity, bi = 0;
  for (let i = 0; i < pos.count; i += 7) {
    const d = (pos.getX(i) - c.x) ** 2 + (pos.getY(i) - c.y) ** 2 + (pos.getZ(i) - c.z) ** 2;
    if (d < best) { best = d; bi = i; }
  }
  const v = new THREE.Vector3(pos.getX(bi), pos.getY(bi), pos.getZ(bi));
  return { x: (v.x + c.x) / 2, y: (v.y + c.y) / 2, z: (v.z + c.z) / 2, size: g.boundingBox.getSize(new THREE.Vector3()) };
}

export function initThree(el) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  el.append(renderer.domElement);
  const scene = new THREE.Scene();
  let bg = "#000000";
  scene.background = new THREE.Color(bg);
  const camera = new THREE.PerspectiveCamera(35, 1, 1, 10000);
  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const head = new THREE.DirectionalLight(0xffffff, 1.6);
  camera.add(head); head.position.set(0.3, 0.5, 1);
  scene.add(camera);

  const world = new THREE.Group();          // atlas coordinates, centred
  world.position.copy(CENTER).multiplyScalar(-1);
  scene.add(world);
  const shellGroup = new THREE.Group(), regionGroup = new THREE.Group(), neuronGroup = new THREE.Group(), planeGroup = new THREE.Group(), cursorGroup = new THREE.Group();
  world.add(shellGroup, regionGroup, neuronGroup, planeGroup, cursorGroup);

  const controls = new TrackballControls(camera, renderer.domElement);
  controls.rotateSpeed = 3; controls.zoomSpeed = 1.6; controls.panSpeed = 0.8;
  controls.dynamicDampingFactor = 0.18;

  el.insertAdjacentHTML("beforeend", `
    <div class="pane-label">3D<span class="status3d"></span></div>
    <div class="pane-tools">
      <button data-act="max" title="Maximise">⤢</button>
      <button data-act="shot" title="Save PNG">PNG</button>
    </div>
    <div class="three-hud">
      <button data-cam="dorsal" title="View from above">Dorsal</button>
      <button data-cam="ventral">Ventral</button>
      <button data-cam="side+">Side +x</button>
      <button data-cam="side-">Side −x</button>
      <button data-cam="anterior">Anterior</button>
      <button data-tog="outline" class="on" title="Brain outline surface">Outline</button>
      <button data-tog="cell_bodies" title="Cell-body surface (large download)">Cell bodies</button>
      <button data-tog="fibers" title="Neuropil surface (large download)">Neuropil</button>
      <button data-tog="planes" class="on" title="Show current slices as textured planes">Slice planes</button>
      <button data-tog="spin">Spin</button>
      <button data-tog="bg">Bg</button>
    </div>
    <div class="loading-veil" hidden><span><span class="spinner"></span> <span class="lv-text">loading meshes…</span></span></div>`);
  const status = el.querySelector(".status3d");
  const veil = el.querySelector(".loading-veil");
  let busy = 0;
  const work = async (label, p) => {
    busy++; veil.hidden = false; veil.querySelector(".lv-text").textContent = label;
    try { return await p; } finally { if (--busy === 0) veil.hidden = true; }
  };

  /* ---------- brain shells ---------- */
  const shells = {};
  async function toggleShell(key, on_) {
    const info = db.brain.threeD[key];
    if (!info) return;
    if (!shells[key]) {
      const g = await work(`loading ${key.replace("_", " ")} surface…`, loadGeom(info.visualization_data._3d.mesh_file));
      const m = new THREE.Mesh(g, new THREE.MeshPhongMaterial({
        color: key === "outline" ? 0x9aa3b5 : key === "fibers" ? 0xd9c38a : 0x9ad1c6,
        transparent: true, opacity: key === "outline" ? 0.09 : 0.14, depthWrite: false, side: THREE.DoubleSide, shininess: 10,
      }));
      m.renderOrder = -1;
      shells[key] = m;
    }
    if (on_) shellGroup.add(shells[key]); else shellGroup.remove(shells[key]);
    request();
  }

  /* ---------- regions ---------- */
  const regionMeshes = new Map();
  async function syncRegions() {
    for (const [id, m] of regionMeshes) if (!state.regions.has(id)) { regionGroup.remove(m); regionMeshes.delete(id); }
    const todo = [...state.regions.values()].filter((r) => !regionMeshes.has(r.id));
    await Promise.all(todo.map(async (it) => {
      const r = db.regions[it.id];
      const path = r.visualization_data?._3d?.mesh_file;
      if (!path) return;
      regionMeshes.set(it.id, null);
      try {
        const g = await work("loading region meshes…", loadGeom(path));
        if (!state.regions.has(it.id)) { regionMeshes.delete(it.id); return; }
        const mesh = new THREE.Mesh(g, new THREE.MeshPhongMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, shininess: 30 }));
        mesh.userData = { kind: "region", id: it.id };
        regionMeshes.set(it.id, mesh); regionGroup.add(mesh);
      } catch { regionMeshes.delete(it.id); }
    }));
    styleRegions();
  }
  function styleRegions() {
    const op = state.group.regions.opacity;
    for (const [id, m] of regionMeshes) {
      if (!m) continue;
      const it = state.regions.get(id);
      const focused = state.focus?.kind === "region" && state.focus.id === id;
      m.material.color.set(it.color);
      // double-sided transparent meshes stack two layers, so keep the base alpha low
      m.material.opacity = Math.min(0.9, Math.max(0.08, op * (focused ? 1.5 : 0.55)));
      m.material.emissive.set(focused ? it.color : "#000").multiplyScalar(focused ? 0.35 : 0);
      m.visible = it.visible && state.group.regions.visible;
    }
    request();
  }

  /* ---------- neurons ---------- */
  const neuronObjs = new Map();
  const somaGeo = new THREE.SphereGeometry(1, 14, 10);
  function syncNeurons() {
    for (const [id, o] of neuronObjs) if (!state.neurons.has(id)) { neuronGroup.remove(o); o.traverse((c) => c.geometry !== somaGeo && c.geometry?.dispose()); neuronObjs.delete(id); }
    for (const n of state.neurons.values()) {
      if (neuronObjs.has(n.id) || !n.swc) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(n.swc.seg, 3));
      const line = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ transparent: true }));
      line.userData = { kind: "neuron", id: n.id };
      const grp = new THREE.Group(); grp.add(line);
      if (n.swc.soma) {
        const s = new THREE.Mesh(somaGeo, new THREE.MeshPhongMaterial());
        s.scale.setScalar(Math.max(2.5, n.swc.soma.r));
        s.position.set(n.swc.soma.x, n.swc.soma.y, n.swc.soma.z);
        s.userData = { kind: "neuron", id: n.id };
        grp.add(s);
      }
      neuronObjs.set(n.id, grp); neuronGroup.add(grp);
    }
    styleNeurons();
  }
  function styleNeurons() {
    const fid = state.focus?.kind === "neuron" ? state.focus.id : null;
    for (const [id, grp] of neuronObjs) {
      const n = state.neurons.get(id);
      grp.visible = n.visible && state.group.neurons.visible;
      grp.children.forEach((c) => {
        c.material.color.set(id === fid ? "#ffffff" : n.color);
        c.material.opacity = state.group.neurons.opacity * (fid && id !== fid ? 0.45 : 1);
        c.material.transparent = true;
      });
    }
    request();
  }

  /* ---------- textured slice planes ---------- */
  const planes = {};
  let planesOn = true;
  function makePlane(view) {
    const canvas = document.createElement("canvas");
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, opacity: 0.95 });
    let geo;
    if (view === "dorsal") geo = new THREE.PlaneGeometry(VOL.x, VOL.y);
    else if (view === "sagittal") geo = new THREE.PlaneGeometry(VOL.y, VOL.z);
    else geo = new THREE.PlaneGeometry(VOL.x, VOL.z);
    const mesh = new THREE.Mesh(geo, mat);
    // Orient so that image (u right, v down) lands on the right volume axes.
    if (view === "dorsal") { mesh.scale.y = -1; }                                     // u→+x, v→+y
    // plane-local +x = image right, +y = image up
    const basis = (ux, uy) => mesh.setRotationFromMatrix(new THREE.Matrix4().makeBasis(ux, uy, ux.clone().cross(uy)));
    if (view === "sagittal") basis(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)); // u→+y, up→+z
    if (view === "coronal") basis(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1));  // u→+x, up→+z
    planeGroup.add(mesh);
    planes[view] = { mesh, canvas, tex, last: "" };
  }
  ["dorsal", "sagittal", "coronal"].forEach(makePlane);
  let planeTimer = 0;
  function syncPlanes() {
    planeGroup.visible = planesOn;
    const c = state.cursor;
    planes.dorsal.mesh.position.set(VOL.x / 2, VOL.y / 2, c.z);
    planes.sagittal.mesh.position.set(c.x, VOL.y / 2, VOL.z / 2);
    planes.coronal.mesh.position.set(VOL.x / 2, c.y, VOL.z / 2);
    cursorDot.position.set(c.x, c.y, c.z);
    request();
    if (!planesOn) return;
    clearTimeout(planeTimer);
    planeTimer = setTimeout(async () => {
      for (const view of ["dorsal", "sagittal", "coronal"]) {
        const p = planes[view];
        const slice = view === "dorsal" ? c.z : view === "sagittal" ? c.x : c.y;
        await composeSlice(view, slice, p.canvas);
        p.tex.needsUpdate = true;
      }
      request();
    }, 120);
  }
  const cursorDot = new THREE.Mesh(new THREE.SphereGeometry(3, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffd23f }));
  cursorGroup.add(cursorDot);

  /* ---------- camera ---------- */
  function setCam(kind) {
    const d = 1500;
    const pos = {
      dorsal: [0, 0, d], ventral: [0, 0, -d], "side+": [d, 0, 0], "side-": [-d, 0, 0], anterior: [0, -d, 0],
    }[kind];
    const up = kind === "dorsal" || kind === "ventral" ? [0, -1, 0] : [0, 0, 1];
    camera.position.set(...pos); camera.up.set(...up); controls.target.set(0, 0, 0);
    camera.lookAt(0, 0, 0); controls.update(); request();
  }

  /* ---------- render loop ---------- */
  let needs = true, spin = false;
  function request() { needs = true; }
  controls.addEventListener("change", request);
  function loop() {
    requestAnimationFrame(loop);
    controls.update();
    if (spin) { world.parent.rotation.z += 0.004; needs = true; }
    if (needs) { needs = false; renderer.render(scene, camera); }
  }
  const spinner = new THREE.Group(); scene.remove(world); spinner.add(world); scene.add(spinner);

  function resize() {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    renderer.setSize(r.width, r.height, false);
    renderer.domElement.style.width = "100%"; renderer.domElement.style.height = "100%";
    camera.aspect = r.width / r.height; camera.updateProjectionMatrix();
    controls.handleResize(); request();
  }
  new ResizeObserver(resize).observe(el);

  /* ---------- picking ---------- */
  const ray = new THREE.Raycaster(); ray.params.Line.threshold = 3;
  let downAt = null;
  renderer.domElement.addEventListener("pointerdown", (e) => (downAt = [e.clientX, e.clientY]));
  renderer.domElement.addEventListener("pointerup", (e) => {
    if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return;
    const r = renderer.domElement.getBoundingClientRect();
    const m = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(m, camera);
    const targets = [...neuronGroup.children.filter((g) => g.visible), ...regionGroup.children.filter((g) => g.visible)];
    const hit = ray.intersectObjects(targets, true).find((h) => h.object.userData.kind);
    if (hit) {
      setFocus(hit.object.userData.kind, hit.object.userData.id);
      if (e.shiftKey || e.altKey) { // move crosshair to the picked point
        const p = world.worldToLocal(hit.point.clone());
        setCursor({ x: p.x, y: p.y, z: p.z }, "3d");
      }
    }
  });

  /* ---------- HUD ---------- */
  el.querySelectorAll("[data-cam]").forEach((b) => (b.onclick = () => setCam(b.dataset.cam)));
  el.querySelectorAll("[data-tog]").forEach((b) => (b.onclick = async () => {
    const k = b.dataset.tog;
    b.classList.toggle("on");
    const onNow = b.classList.contains("on");
    if (k === "planes") { planesOn = onNow; syncPlanes(); }
    else if (k === "spin") spin = onNow;
    else if (k === "bg") { bg = onNow ? "#ffffff" : "#000000"; scene.background.set(bg); planeGroup.children.forEach((m) => (m.material.blending = onNow ? THREE.NormalBlending : THREE.AdditiveBlending)); request(); }
    else toggleShell(k, onNow);
  }));
  el.querySelector('[data-act="max"]').onclick = () => {
    const grid = el.parentElement, isMax = el.classList.contains("max");
    grid.querySelectorAll(".pane").forEach((p) => p.classList.remove("max"));
    grid.classList.toggle("maximized", !isMax); if (!isMax) el.classList.add("max");
  };
  el.querySelector('[data-act="shot"]').onclick = () => {
    renderer.render(scene, camera);
    const a = document.createElement("a"); a.download = "zebrafish_3d.png"; a.href = renderer.domElement.toDataURL("image/png"); a.click();
  };

  /* ---------- wiring ---------- */
  const updStatus = () => { status.textContent = `${regionMeshes.size} regions · ${neuronObjs.size} neurons`; };
  on("layers", async () => { await syncRegions(); syncNeurons(); syncPlanes(); updStatus(); });
  on("neuron-loaded", () => { syncNeurons(); updStatus(); });
  on("render", () => { styleRegions(); styleNeurons(); syncPlanes(); });
  on("focus", () => { styleRegions(); styleNeurons(); });
  on("cursor", syncPlanes);

  setCam("dorsal");
  resize(); loop();
  toggleShell("outline", true);
  syncPlanes();
  return { setCam, request, resize };
}
