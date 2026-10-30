// Linked orthogonal slice viewer (dorsal / sagittal / coronal).
// Layers: reference brain → marker expression (additive) → region masks → neuron skeletons → crosshair.
import { db, VIEWS, VOL, toPixel, toVolume, sliceUrl, esc } from "./data.js";
import { state, on, setCursor, emit } from "./state.js";

/* ---------------- image cache ---------------- */
const imgCache = new Map();          // url → Promise<HTMLImageElement|null>
const imgReady = new Map();          // url → HTMLImageElement|null (settled)
function loadImg(url) {
  if (!imgCache.has(url)) {
    imgCache.set(url, new Promise((res) => {
      const im = new Image();
      im.crossOrigin = "anonymous";
      im.decoding = "async";
      im.onload = () => { imgReady.set(url, im); res(im); };
      im.onerror = () => { imgReady.set(url, null); res(null); };
      im.src = url;
    }));
    if (imgCache.size > 1500) {        // simple LRU-ish trim
      const k = imgCache.keys().next().value; imgCache.delete(k); imgReady.delete(k); tintCache.delete(k);
    }
  }
  return imgCache.get(url);
}

// Tinted copies: white-on-black masks/expression × colour (GPU 'multiply'), cached per url+colour.
const tintCache = new Map();
function tinted(url, color) {
  const im = imgReady.get(url);
  if (!im) return null;
  let per = tintCache.get(url);
  if (!per) tintCache.set(url, (per = new Map()));
  if (per.has(color)) return per.get(color);
  const c = document.createElement("canvas");
  c.width = im.naturalWidth; c.height = im.naturalHeight;
  const x = c.getContext("2d");
  x.drawImage(im, 0, 0);
  x.globalCompositeOperation = "multiply";
  x.fillStyle = color; x.fillRect(0, 0, c.width, c.height);
  per.set(color, c);
  return c;
}

// Base brain with brightness gain (LUT), cached per url+gain.
const baseCache = new Map();
function gained(url, gain) {
  const im = imgReady.get(url);
  if (!im) return null;
  const key = url + "|" + gain;
  if (baseCache.has(key)) return baseCache.get(key);
  const c = document.createElement("canvas");
  c.width = im.naturalWidth; c.height = im.naturalHeight;
  const x = c.getContext("2d", { willReadFrequently: true });
  x.drawImage(im, 0, 0);
  if (gain !== 1) {
    try {
      const d = x.getImageData(0, 0, c.width, c.height), p = d.data;
      const lut = new Uint8ClampedArray(256);
      // linear gain with a mild gamma lift so dim structure stays visible
      for (let i = 0; i < 256; i++) lut[i] = 255 * Math.pow(Math.min(1, (i / 255) * gain), 0.9);
      for (let i = 0; i < p.length; i += 4) { p[i] = lut[p[i]]; p[i + 1] = lut[p[i + 1]]; p[i + 2] = lut[p[i + 2]]; }
      x.putImageData(d, 0, 0);
    } catch { /* tainted canvas: draw ungained */ }
  }
  if (baseCache.size > 60) baseCache.delete(baseCache.keys().next().value);
  baseCache.set(key, c);
  return c;
}

// Raw single-channel mask lookup for hover-identification of visible regions.
const maskCache = new Map();
function maskValue(url, u, v) {
  const im = imgReady.get(url);
  if (!im) return 0;
  let m = maskCache.get(url);
  if (!m) {
    const c = document.createElement("canvas");
    c.width = im.naturalWidth; c.height = im.naturalHeight;
    const x = c.getContext("2d", { willReadFrequently: true });
    x.drawImage(im, 0, 0);
    try { m = { w: c.width, d: x.getImageData(0, 0, c.width, c.height).data }; } catch { m = { w: 0, d: null }; }
    if (maskCache.size > 200) maskCache.delete(maskCache.keys().next().value);
    maskCache.set(url, m);
  }
  if (!m.d) return 0;
  return m.d[(Math.floor(v) * m.w + Math.floor(u)) * 4];
}

function regionDir(r, view, kind) {
  const ov = r.visualization_data?._2d?.orthogonal_views?.[view];
  if (!ov) return null;
  return typeof ov === "string" ? ov : ov[kind] || ov.fill;
}
function markerDir(m, view) { return m.visualization_data?._2d?.orthogonal_views?.[view] || null; }
const baseDir = (view) => db.brain.twoD.visualization_data._2d.orthogonal_views[view];

/* ---------------- one pane ---------------- */
class SlicePane {
  constructor(el, view) {
    this.el = el; this.view = view; this.cfg = VIEWS[view];
    this.canvas = document.createElement("canvas");
    this.ctx = this.canvas.getContext("2d");
    el.append(this.canvas);
    el.insertAdjacentHTML("beforeend", `
      <div class="pane-label">${this.cfg.label}<span class="idx"></span></div>
      <div class="pane-tools">
        <button data-act="max" title="Maximise (double-click)">⤢</button>
        <button data-act="shot" title="Save PNG">PNG</button>
      </div>
      ${this.orientLabels()}
      <div class="slice-slider"><input type="range" min="0" max="${this.cfg.n - 1}" step="1"><span></span></div>
      <div class="loading-veil" hidden><span><span class="spinner"></span> loading slice…</span></div>`);
    this.idxEl = el.querySelector(".idx");
    this.slider = el.querySelector(".slice-slider input");
    this.sliderVal = el.querySelector(".slice-slider span");
    this.veil = el.querySelector(".loading-veil");
    this.zoom = 1; this.panX = 0; this.panY = 0;
    this.hover = null;
    this.pending = false;
    this.bind();
    new ResizeObserver(() => this.resize()).observe(el);
  }
  orientLabels() {
    if (this.view === "dorsal") return `<span class="orient t">anterior</span><span class="orient b">posterior</span>`;
    if (this.view === "sagittal") return `<span class="orient l">A</span><span class="orient r">P</span><span class="orient t">dorsal</span><span class="orient b">ventral</span>`;
    return `<span class="orient t">dorsal</span><span class="orient b">ventral</span>`;
  }
  get slice() { return state.cursor[this.cfg.axis]; }

  resize() {
    const r = this.el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const dpr = window.devicePixelRatio || 1;
    this.cssW = r.width; this.cssH = r.height;
    this.canvas.width = Math.round(r.width * dpr); this.canvas.height = Math.round(r.height * dpr);
    this.dpr = dpr;
    this.render();
  }
  // image-pixel → css-pixel transform
  fit() {
    const pad = 36;
    const s = Math.min((this.cssW - 16) / this.cfg.w, (this.cssH - pad * 2) / this.cfg.h);
    const scale = s * this.zoom;
    const ox = (this.cssW - this.cfg.w * scale) / 2 + this.panX;
    const oy = (this.cssH - this.cfg.h * scale) / 2 + this.panY - 6;
    return { scale, ox, oy };
  }
  toImage(cx, cy) { const t = this.fit(); return [(cx - t.ox) / t.scale, (cy - t.oy) / t.scale]; }
  resetView() { this.zoom = 1; this.panX = 0; this.panY = 0; this.render(); }

  bind() {
    const c = this.canvas;
    let down = null;
    c.addEventListener("pointerdown", (e) => { down = { x: e.clientX, y: e.clientY, px: this.panX, py: this.panY, moved: false }; c.setPointerCapture(e.pointerId); });
    c.addEventListener("pointermove", (e) => {
      const rect = c.getBoundingClientRect();
      const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
      if (down) {
        const dx = e.clientX - down.x, dy = e.clientY - down.y;
        if (Math.hypot(dx, dy) > 4) down.moved = true;
        if (down.moved) { this.panX = down.px + dx; this.panY = down.py + dy; this.render(); c.style.cursor = "grabbing"; }
      }
      this.onHover(cx, cy);
    });
    c.addEventListener("pointerup", (e) => {
      c.style.cursor = "";
      if (down && !down.moved) {
        const rect = c.getBoundingClientRect();
        const [u, v] = this.toImage(e.clientX - rect.left, e.clientY - rect.top);
        if (u >= 0 && v >= 0 && u < this.cfg.w && v < this.cfg.h) setCursor(toVolume(this.view, u, v, this.slice), this.view);
      }
      down = null;
    });
    c.addEventListener("pointerleave", () => { this.hover = null; emit("hover", null); this.render(); });
    c.addEventListener("wheel", (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const rect = c.getBoundingClientRect();
        const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
        const before = this.toImage(cx, cy);
        this.zoom = Math.max(0.5, Math.min(20, this.zoom * Math.exp(-e.deltaY * 0.01)));
        const t = this.fit();
        this.panX += cx - (before[0] * t.scale + t.ox);
        this.panY += cy - (before[1] * t.scale + t.oy);
        this.render();
      } else {
        this.wheelAcc = (this.wheelAcc || 0) + e.deltaY;
        const step = Math.trunc(this.wheelAcc / 30);
        if (step) { this.wheelAcc -= step * 30; this.step(step * (e.shiftKey ? 10 : 1)); }
      }
    }, { passive: false });
    c.addEventListener("dblclick", () => this.toggleMax());
    this.slider.addEventListener("input", () => {
      setCursor({ ...state.cursor, [this.cfg.axis]: +this.slider.value }, this.view);
    });
    this.el.querySelector('[data-act="max"]').onclick = () => this.toggleMax();
    this.el.querySelector('[data-act="shot"]').onclick = () => this.screenshot();
    this.el.tabIndex = 0;
    this.el.addEventListener("keydown", (e) => {
      if (e.key === "ArrowUp" || e.key === "ArrowRight") { this.step(e.shiftKey ? 10 : 1); e.preventDefault(); }
      if (e.key === "ArrowDown" || e.key === "ArrowLeft") { this.step(e.shiftKey ? -10 : -1); e.preventDefault(); }
    });
    c.addEventListener("pointerenter", () => this.el.focus({ preventScroll: true }));
  }
  step(d) { setCursor({ ...state.cursor, [this.cfg.axis]: this.slice + d }, this.view); }
  toggleMax() {
    const grid = this.el.parentElement;
    const isMax = this.el.classList.contains("max");
    grid.querySelectorAll(".pane").forEach((p) => p.classList.remove("max"));
    grid.classList.toggle("maximized", !isMax);
    if (!isMax) this.el.classList.add("max");
  }
  screenshot() {
    const a = document.createElement("a");
    a.download = `zebrafish_${this.view}_${this.cfg.axis}${this.slice}.png`;
    try { a.href = this.canvas.toDataURL("image/png"); a.click(); } catch { alert("Screenshot blocked by browser security (cross-origin image)."); }
  }

  onHover(cx, cy) {
    const [u, v] = this.toImage(cx, cy);
    if (u < 0 || v < 0 || u >= this.cfg.w || v >= this.cfg.h) { this.hover = null; emit("hover", null); return; }
    const p = toVolume(this.view, u, v, this.slice);
    // which visible region is under the mouse (topmost first)
    let region = null;
    if (state.group.regions.visible) {
      const items = [...state.regions.values()].filter((r) => r.visible).reverse();
      for (const it of items) {
        const dir = regionDir(db.regions[it.id], this.view, "fill");
        if (dir && maskValue(sliceUrl(dir, this.slice), u, v) > 100) { region = db.regions[it.id]; break; }
      }
    }
    // nearest neuron soma / segment within 6 px
    let neuron = null;
    const t = this.fit(), tol = 6 / t.scale;
    let best = tol * tol;
    for (const n of state.neurons.values()) {
      if (!n.visible || !n.swc) continue;
      const s = n.swc.seg;
      const ax = this.cfg.axis === "x" ? 0 : this.cfg.axis === "y" ? 1 : 2;
      for (let i = 0; i < s.length; i += 6) {
        const mid = (s[i + ax] + s[i + 3 + ax]) / 2;
        if (Math.abs(mid - this.slice) > state.slab) continue;
        const [x1, y1] = toPixel(this.view, { x: s[i], y: s[i + 1], z: s[i + 2] });
        const [x2, y2] = toPixel(this.view, { x: s[i + 3], y: s[i + 4], z: s[i + 5] });
        const d = distSeg2(u, v, x1, y1, x2, y2);
        if (d < best) { best = d; neuron = n.id; }
      }
    }
    this.hover = { u, v };
    emit("hover", { p, region, neuron, view: this.view });
    if (state.crosshair) this.render();
  }

  render() {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => { this.pending = false; this.draw(); });
  }

  draw() {
    if (!this.cssW || !db.brain) return;
    const { ctx, dpr } = this;
    const slice = this.slice;
    const t = this.fit();
    this.idxEl.textContent = `${this.cfg.axis} = ${slice} µm`;
    if (document.activeElement !== this.slider) this.slider.value = slice;
    this.sliderVal.textContent = `${slice} / ${this.cfg.n - 1}`;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(dpr * t.scale, 0, 0, dpr * t.scale, dpr * t.ox, dpr * t.oy);
    ctx.imageSmoothingEnabled = t.scale < 2.5;

    const need = [];
    const want = (url) => { if (!imgReady.has(url)) { need.push(loadImg(url)); return null; } return url; };

    // 1. reference brain
    if (state.baseVisible) {
      const url = want(sliceUrl(baseDir(this.view), slice));
      const img = url && gained(url, state.baseGain);
      if (img) ctx.drawImage(img, 0, 0);
    }
    // 2. markers (additive, like fluorescence channels)
    if (state.group.markers.visible) {
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = state.group.markers.opacity;
      for (const it of state.markers.values()) {
        if (!it.visible) continue;
        const dir = markerDir(db.markers[it.id], this.view);
        const url = dir && want(sliceUrl(dir, slice));
        const img = url && tinted(url, it.color);
        if (img) ctx.drawImage(img, 0, 0, this.cfg.w, this.cfg.h);
      }
    }
    // 3. regions
    if (state.group.regions.visible) {
      for (const it of state.regions.values()) {
        if (!it.visible) continue;
        const r = db.regions[it.id];
        const focused = state.focus?.kind === "region" && state.focus.id === it.id;
        if (state.regionStyle !== "outline") {
          const url = want(sliceUrl(regionDir(r, this.view, "fill"), slice));
          const img = url && tinted(url, it.color);
          if (img) {
            ctx.globalCompositeOperation = "screen";
            ctx.globalAlpha = Math.min(1, state.group.regions.opacity * (focused ? 1.6 : 1));
            ctx.drawImage(img, 0, 0, this.cfg.w, this.cfg.h);
          }
        }
        if (state.regionStyle !== "fill" || focused) {
          const od = regionDir(r, this.view, "outline");
          const url = od && want(sliceUrl(od, slice));
          const img = url && tinted(url, focused ? "#ffffff" : it.color);
          if (img) {
            ctx.globalCompositeOperation = "lighter";
            ctx.globalAlpha = 1;
            ctx.drawImage(img, 0, 0, this.cfg.w, this.cfg.h);
          }
        }
      }
    }
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;

    // 4. neurons
    if (state.group.neurons.visible) this.drawNeurons(t);

    // 5. crosshair + hover
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (state.crosshair) {
      const [cu, cv] = toPixel(this.view, state.cursor);
      const X = t.ox + (cu + 0.5) * t.scale, Y = t.oy + (cv + 0.5) * t.scale;
      ctx.strokeStyle = "rgba(255, 210, 63, 0.55)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(X, 0); ctx.lineTo(X, this.cssH); ctx.moveTo(0, Y); ctx.lineTo(this.cssW, Y); ctx.stroke();
      ctx.setLineDash([]);
    }
    // scale bar (100 µm)
    const px100 = 100 * t.scale;
    const sbx = this.cssW - px100 - 14, sby = this.cssH - 44;
    ctx.fillStyle = "rgba(255,255,255,.85)";
    ctx.fillRect(sbx, sby, px100, 2);
    ctx.font = "10.5px Inter, sans-serif"; ctx.textAlign = "center";
    ctx.fillText("100 µm", sbx + px100 / 2, sby - 4);

    this.veil.hidden = !need.length || need.length < 1 || !state.baseVisible || imgReady.has(sliceUrl(baseDir(this.view), slice));
    if (need.length) {
      const at = slice;
      Promise.all(need).then(() => { if (this.slice === at) this.render(); });
    }
    this.prefetch(slice);
  }

  drawNeurons(t) {
    const { ctx } = this;
    const ax = this.cfg.axis === "x" ? 0 : this.cfg.axis === "y" ? 1 : 2;
    const slice = this.slice, slab = state.slab;
    const lw = Math.max(0.6, 1.6 / t.scale);
    const op = state.group.neurons.opacity;
    const focusId = state.focus?.kind === "neuron" ? state.focus.id : null;
    const pt = (s, i) => toPixel(this.view, { x: s[i], y: s[i + 1], z: s[i + 2] });
    for (const n of state.neurons.values()) {
      if (!n.visible || !n.swc) continue;
      const s = n.swc.seg;
      const isF = n.id === focusId;
      // ghost (full projection)
      if (state.ghost) {
        ctx.globalAlpha = (isF ? 0.5 : 0.16) * op;
        ctx.strokeStyle = n.color; ctx.lineWidth = lw;
        ctx.beginPath();
        for (let i = 0; i < s.length; i += 6) {
          const [a, b] = pt(s, i), [c, d] = pt(s, i + 3);
          ctx.moveTo(a, b); ctx.lineTo(c, d);
        }
        ctx.stroke();
      }
      // in-slab
      ctx.globalAlpha = op;
      ctx.strokeStyle = isF ? "#ffffff" : n.color; ctx.lineWidth = lw * (isF ? 2.2 : 1.6);
      ctx.beginPath();
      for (let i = 0; i < s.length; i += 6) {
        const mid = (s[i + ax] + s[i + 3 + ax]) / 2;
        if (Math.abs(mid - slice) > slab) continue;
        const [a, b] = pt(s, i), [c, d] = pt(s, i + 3);
        ctx.moveTo(a, b); ctx.lineTo(c, d);
      }
      ctx.stroke();
      // soma
      if (n.swc.soma) {
        const so = n.swc.soma;
        const [a, b] = toPixel(this.view, so);
        const inSlab = Math.abs(so["xyz"[ax]] - slice) <= slab;
        ctx.beginPath(); ctx.arc(a, b, Math.max(so.r, 3 / t.scale * 2), 0, Math.PI * 2);
        if (inSlab) { ctx.fillStyle = n.color; ctx.fill(); ctx.strokeStyle = "#000"; ctx.lineWidth = lw; ctx.stroke(); }
        else if (state.ghost) { ctx.globalAlpha = 0.35 * op; ctx.strokeStyle = n.color; ctx.lineWidth = lw; ctx.stroke(); }
      }
    }
    ctx.globalAlpha = 1;
  }

  prefetch(slice) {
    clearTimeout(this.pf);
    this.pf = setTimeout(() => {
      for (const d of [1, -1, 2, -2, 3, -3]) {
        const i = slice + d;
        if (i < 0 || i >= this.cfg.n) continue;
        loadImg(sliceUrl(baseDir(this.view), i));
        for (const it of state.regions.values()) if (it.visible) {
          const dir = regionDir(db.regions[it.id], this.view, state.regionStyle === "outline" ? "outline" : "fill");
          if (dir) loadImg(sliceUrl(dir, i));
        }
      }
    }, 150);
  }
}

function distSeg2(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const l = dx * dx + dy * dy;
  let t = l ? ((px - x1) * dx + (py - y1) * dy) / l : 0;
  t = Math.max(0, Math.min(1, t));
  const ex = x1 + t * dx - px, ey = y1 + t * dy - py;
  return ex * ex + ey * ey;
}

/* ---------------- public ---------------- */
export const panes = {};
export function initSlices() {
  for (const view of Object.keys(VIEWS)) panes[view] = new SlicePane(document.getElementById(`pane-${view}`), view);
  const all = () => Object.values(panes).forEach((p) => p.render());
  on("cursor", all); on("layers", all); on("render", all); on("neuron-loaded", all); on("focus", all);
  return { renderAll: all, reset: () => Object.values(panes).forEach((p) => p.resetView()) };
}

/** Small static preview (for catalog pages): draws a single orthogonal slice with one overlay. */
export async function drawPreview(canvas, view, slice, overlay) {
  const cfg = VIEWS[view];
  canvas.width = cfg.w; canvas.height = cfg.h;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, cfg.w, cfg.h);
  const bu = sliceUrl(baseDir(view), slice);
  await loadImg(bu);
  const b = gained(bu, 1.2);
  if (b) ctx.drawImage(b, 0, 0);
  if (overlay?.dir) {
    const u = sliceUrl(overlay.dir, slice);
    await loadImg(u);
    const im = tinted(u, overlay.color);
    if (im) { ctx.globalCompositeOperation = overlay.mode || "screen"; ctx.globalAlpha = overlay.alpha ?? 0.8; ctx.drawImage(im, 0, 0, cfg.w, cfg.h); }
  }
  if (overlay?.swc) {
    const s = overlay.swc.seg;
    ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1;
    ctx.strokeStyle = overlay.color; ctx.lineWidth = 1.6; ctx.beginPath();
    for (let i = 0; i < s.length; i += 6) {
      const [a, b2] = toPixel(view, { x: s[i], y: s[i + 1], z: s[i + 2] });
      const [c, d] = toPixel(view, { x: s[i + 3], y: s[i + 4], z: s[i + 5] });
      ctx.moveTo(a, b2); ctx.lineTo(c, d);
    }
    ctx.stroke();
    if (overlay.swc.soma) {
      const [a, b2] = toPixel(view, overlay.swc.soma);
      ctx.fillStyle = overlay.color; ctx.beginPath(); ctx.arc(a, b2, 5, 0, 7); ctx.fill();
    }
  }
}
/**
 * Composite of one slice at native resolution (brain + markers + region fills) for 3D slice-plane textures.
 * Returns {canvas, complete}; call again when images finish loading.
 */
export async function composeSlice(view, slice, target) {
  const cfg = VIEWS[view];
  const c = target || document.createElement("canvas");
  if (c.width !== cfg.w || c.height !== cfg.h) { c.width = cfg.w; c.height = cfg.h; }
  const urls = [];
  const bu = sliceUrl(baseDir(view), slice);
  if (state.baseVisible) urls.push(bu);
  const marks = state.group.markers.visible ? [...state.markers.values()].filter((m) => m.visible) : [];
  const regs = state.group.regions.visible ? [...state.regions.values()].filter((r) => r.visible) : [];
  marks.forEach((m) => { const d = markerDir(db.markers[m.id], view); if (d) urls.push(sliceUrl(d, slice)); });
  regs.forEach((r) => { const d = regionDir(db.regions[r.id], view, "fill"); if (d) urls.push(sliceUrl(d, slice)); });
  await Promise.all(urls.map(loadImg));
  const ctx = c.getContext("2d");
  ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1;
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, cfg.w, cfg.h);
  if (state.baseVisible) { const b = gained(bu, state.baseGain); if (b) ctx.drawImage(b, 0, 0); }
  ctx.globalCompositeOperation = "lighter"; ctx.globalAlpha = state.group.markers.opacity;
  for (const m of marks) { const d = markerDir(db.markers[m.id], view); const im = d && tinted(sliceUrl(d, slice), m.color); if (im) ctx.drawImage(im, 0, 0, cfg.w, cfg.h); }
  ctx.globalCompositeOperation = "screen"; ctx.globalAlpha = state.group.regions.opacity;
  for (const r of regs) { const d = regionDir(db.regions[r.id], view, "fill"); const im = d && tinted(sliceUrl(d, slice), r.color); if (im) ctx.drawImage(im, 0, 0, cfg.w, cfg.h); }
  ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1;
  return c;
}
export { regionDir, markerDir, baseDir, loadImg, imgReady };
export const describeHover = (h) => {
  if (!h) return "";
  const parts = [`x ${Math.round(h.p.x)}, y ${Math.round(h.p.y)}, z ${Math.round(h.p.z)}`];
  if (h.region) parts.push(`<b>${esc(h.region.name)}</b>`);
  if (h.neuron) parts.push(`neuron ${h.neuron}`);
  return parts.join(" · ");
};
