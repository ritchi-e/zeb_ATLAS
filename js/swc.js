// SWC morphology loader. Coordinates are already in reference-brain voxel space.
const cache = new Map();

export function loadSwc(url) {
  if (!cache.has(url)) {
    cache.set(url, fetch(url).then((r) => {
      if (!r.ok) throw new Error(`SWC HTTP ${r.status}`);
      return r.text();
    }).then(parseSwc).catch((e) => { cache.delete(url); throw e; }));
  }
  return cache.get(url);
}

/**
 * Returns { seg: Float32Array [x1,y1,z1,x2,y2,z2,...], soma: {x,y,z,r}, bbox, length, nodes, branchPoints, tips, terminals }
 */
export function parseSwc(text) {
  const byId = new Map();
  const order = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t[0] === "#") continue;
    const p = t.split(/\s+/).map(Number);
    if (p.length < 7) continue;
    const n = { id: p[0], type: p[1], x: p[2], y: p[3], z: p[4], r: p[5], parent: p[6], kids: 0 };
    byId.set(n.id, n);
    order.push(n);
  }
  const segs = [];
  let length = 0, soma = null;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const n of order) {
    min[0] = Math.min(min[0], n.x); min[1] = Math.min(min[1], n.y); min[2] = Math.min(min[2], n.z);
    max[0] = Math.max(max[0], n.x); max[1] = Math.max(max[1], n.y); max[2] = Math.max(max[2], n.z);
    if (n.type === 1 && !soma) soma = n;
    const par = byId.get(n.parent);
    if (par) {
      par.kids++;
      segs.push(par.x, par.y, par.z, n.x, n.y, n.z);
      length += Math.hypot(n.x - par.x, n.y - par.y, n.z - par.z);
    }
  }
  if (!soma) soma = order.find((n) => n.parent === -1) || order[0];
  const tips = order.filter((n) => n.kids === 0 && n !== soma);
  return {
    seg: new Float32Array(segs),
    soma: soma ? { x: soma.x, y: soma.y, z: soma.z, r: Math.max(2, soma.r || 3) } : null,
    bbox: { min, max },
    length,
    nodes: order.length,
    branchPoints: order.filter((n) => n.kids > 1).length,
    tips: tips.length,
    terminals: tips.map((n) => [n.x, n.y, n.z]),
  };
}
