// Hex grid math. Pointy-top hexes in "odd-r" offset layout, wrapping east-west.
// Tiles are addressed by a flat index i = row * W + col.
WG.Hex = (function () {
  const M = window.WG_MAP;
  const W = M.W, H = M.H, N = W * H;
  const SQ3 = Math.sqrt(3);
  const EVEN = [[1, 0], [0, -1], [-1, -1], [-1, 0], [-1, 1], [0, 1]];
  const ODD = [[1, 0], [1, -1], [0, -1], [-1, 0], [0, 1], [1, 1]];

  const col = i => i % W;
  const row = i => (i / W) | 0;
  const idx = (c, r) => r * W + ((c % W) + W) % W;

  // Neighbour lists; direction k matches corner pair (k, k+1) used by edgeCorners().
  const NB = new Array(N);
  for (let i = 0; i < N; i++) {
    const c = col(i), r = row(i);
    const offs = (r & 1) ? ODD : EVEN;
    NB[i] = [];
    for (const [dc, dr] of offs) {
      const rr = r + dr;
      NB[i].push(rr < 0 || rr >= H ? -1 : idx(c + dc, rr));
    }
  }
  const neighbors = i => NB[i].filter(n => n >= 0);

  function dist(a, b) {
    const r1 = row(a), r2 = row(b);
    const q1 = col(a) - (r1 - (r1 & 1)) / 2;
    const dr = r2 - r1;
    let best = Infinity;
    for (let k = -1; k <= 1; k++) {
      const q2 = col(b) + k * W - (r2 - (r2 & 1)) / 2;
      const dq = q2 - q1;
      const d = (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
      if (d < best) best = d;
    }
    return best;
  }

  // All tiles within `radius` steps of i (including i).
  function within(i, radius) {
    const seen = new Set([i]);
    let frontier = [i];
    for (let d = 0; d < radius; d++) {
      const next = [];
      for (const t of frontier) for (const n of NB[t]) {
        if (n >= 0 && !seen.has(n)) { seen.add(n); next.push(n); }
      }
      frontier = next;
    }
    return [...seen];
  }

  // World pixel position of a tile centre for hex circumradius `size`.
  function center(i, size) {
    const r = row(i);
    return [size * SQ3 * (col(i) + 0.5 * (r & 1) + 0.5), size * (1.5 * r + 1)];
  }
  function fromPixel(x, y, size) {
    x -= size * SQ3 * 0.5; y -= size;
    const q = (SQ3 / 3 * x - y / 3) / size;
    const r = (2 / 3 * y) / size;
    let rx = Math.round(q), rz = Math.round(r), ry = Math.round(-q - r);
    const dx = Math.abs(rx - q), dz = Math.abs(rz - r), dy = Math.abs(ry + q + r);
    if (dx > dy && dx > dz) rx = -ry - rz; else if (dz > dy) rz = -rx - ry;
    if (rz < 0 || rz >= H) return -1;
    return idx(rx + (rz - (rz & 1)) / 2, rz);
  }
  // Unit-radius hex corners in screen space (y down): UR, LR, B, LL, UL, T.
  const CORNERS = [];
  for (let k = 0; k < 6; k++) {
    const a = (-30 + 60 * k) * Math.PI / 180;
    CORNERS.push([Math.cos(a), Math.sin(a)]);
  }
  // Corner pair forming the edge shared with neighbour direction k (E, NE, NW, W, SW, SE).
  const EDGE = [[0, 1], [5, 0], [4, 5], [3, 4], [2, 3], [1, 2]];

  function lonLat(i) {
    const r = row(i);
    return [M.lonLeft + (col(i) + 0.5 + (r & 1) * 0.5) * M.lonStep, M.latTop - (r + 0.5) * M.latStep];
  }
  function fromLonLat(lon, lat) {
    const r = Math.max(0, Math.min(H - 1, Math.round((M.latTop - lat) / M.latStep - 0.5)));
    const c = Math.round((lon - M.lonLeft) / M.lonStep - 0.5 - (r & 1) * 0.5);
    return idx(c, r);
  }

  return { W, H, N, SQ3, col, row, idx, NB, neighbors, dist, within, center, fromPixel, CORNERS, EDGE, lonLat, fromLonLat };
})();
