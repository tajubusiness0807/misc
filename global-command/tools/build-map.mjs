// Generates js/mapdata.js: a hex-grid world map rasterised from Natural Earth
// land polygons (world-atlas TopoJSON) plus hand-placed terrain features.
//
//   curl -o land-50m.json https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/land-50m.json
//   node tools/build-map.mjs land-50m.json > js/mapdata.js
//
// Hex layout: pointy-top, "odd-r" offset rows, wrapping east-west.
import { readFileSync } from 'node:fs';

const W = 96;
const LON_STEP = 360 / W;
const LAT_STEP = LON_STEP * Math.sqrt(3) / 2;
const LAT_TOP = 80;
const H = 42;
const LON_LEFT = -180;

const topo = JSON.parse(readFileSync(process.argv[2], 'utf8'));

// ---- TopoJSON decoding -------------------------------------------------
const [sx, sy] = topo.transform.scale;
const [tx, ty] = topo.transform.translate;
const arcs = topo.arcs.map(arc => {
  let x = 0, y = 0;
  return arc.map(([dx, dy]) => { x += dx; y += dy; return [x * sx + tx, y * sy + ty]; });
});
function ringCoords(idxs) {
  const out = [];
  for (const i of idxs) {
    const a = i >= 0 ? arcs[i] : arcs[~i].slice().reverse();
    for (let k = out.length ? 1 : 0; k < a.length; k++) out.push(a[k]);
  }
  return out;
}
const rings = [];
for (const g of topo.objects.land.geometries) {
  const polys = g.type === 'Polygon' ? [g.arcs] : g.arcs;
  for (const p of polys) for (const r of p) {
    const pts = ringCoords(r);
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (const [x, y] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    rings.push({ pts, x0, x1, y0, y1 });
  }
}
function isLand(lon, lat) {
  lon = ((lon + 540) % 360) - 180;
  let inside = false;
  for (const r of rings) {
    if (lon < r.x0 || lon > r.x1 || lat < r.y0 || lat > r.y1) continue;
    const p = r.pts;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
      const [xi, yi] = p[i], [xj, yj] = p[j];
      if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

// ---- Hex geometry -------------------------------------------------------
const center = (c, r) => [LON_LEFT + (c + 0.5 + (r & 1) * 0.5) * LON_STEP, LAT_TOP - (r + 0.5) * LAT_STEP];
// Sample points: centre + two rings, in units of the hex's circumradius.
const samples = [[0, 0]];
for (let k = 0; k < 6; k++) {
  const a = Math.PI / 6 + k * Math.PI / 3;
  samples.push([0.45 * Math.cos(a), 0.45 * Math.sin(a)]);
  const b = k * Math.PI / 3;
  samples.push([0.8 * Math.cos(b), 0.8 * Math.sin(b)]);
}
const RAD_LON = LON_STEP / Math.sqrt(3); // circumradius in degrees (lon axis)

// ---- Terrain features ---------------------------------------------------
// [lat, lon] polylines for mountain (m) and hill (h) ranges.
const ranges = [
  ['m', [[62, -142], [58, -130], [52, -120], [47, -114], [43, -110], [39, -106], [35, -106], [31, -108]]],
  ['h', [[28, -106], [22, -103], [18, -98], [16, -93]]],
  ['m', [[10, -73], [5, -76], [0, -78], [-8, -77], [-15, -72], [-22, -67], [-30, -69], [-40, -71], [-50, -73]]],
  ['m', [[45.5, 6], [46.5, 10], [47, 14]]],
  ['h', [[42.7, -1], [42.5, 2]]],
  ['m', [[43.5, 40], [42, 46]]],
  ['m', [[35, 72], [32, 78], [28.5, 85], [27.5, 92]]],
  ['m', [[36, 68], [38.5, 73], [40.5, 77]]],
  ['m', [[42, 76], [43, 85]]],
  ['h', [[67, 64], [62, 59], [56, 58], [51, 58]]],
  ['m', [[36, 45], [32, 49], [29, 53], [27, 57]]],
  ['h', [[31, -8], [33.5, -2], [35.5, 4], [36, 8]]],
  ['h', [[69, 18], [65, 14], [62, 9], [59, 7]]],
  ['h', [[-15, 145], [-22, 148], [-29, 152], [-37, 148]]],
  ['h', [[34, -85], [37, -81], [40, -78], [44, -72]]],
  ['h', [[62, 130], [65, 140], [66, 155], [62, 160]]],
  ['m', [[49, 86], [50, 92]]],
  ['h', [[-27, 29], [-31, 27]]],
  ['h', [[-3, 36], [-10, 34], [-16, 35]]],
  ['m', [[-42, 171], [-45, 168]]],
  ['h', [[36, 137], [38, 140], [43, 143]]],
  ['h', [[52, 108], [56, 116]]],
];
// Ellipses: [type, lat, lon, rLat, rLon]
const blobs = [
  ['d', 23, 8, 7, 18], ['d', 21, 25, 6, 8], ['d', 23, 47, 6, 8], ['d', 31, 57, 3.5, 6], ['d', 27, 71, 3, 3],
  ['d', 39, 83, 2.5, 7], ['d', 43, 104, 3.5, 10], ['d', -23, 19, 5, 5], ['d', -25, 130, 7, 13],
  ['d', -22, -69, 5, 2], ['d', 34, -113, 3.5, 4.5], ['d', 41, 62, 4, 7], ['d', 17, 0, 3, 14],
  ['h', 33, 88, 4, 10], ['m', 32, 86, 2.2, 6], ['h', 9, 39, 4, 3], ['h', -18, -46, 6, 6], ['h', 38, -110, 3, 4],
  ['f', -4, -62, 9, 14], ['f', 1, 21, 5, 10], ['f', 14, 102, 7, 8], ['f', -2, 113, 4, 14], ['f', 60, 100, 6, 40],
  ['f', 55, -95, 5, 30], ['f', 37, -85, 5, 8], ['f', 52, 25, 4, 12], ['f', 62, 22, 4, 8], ['f', 26, 110, 4, 7],
  ['f', 15, -88, 4, 5], ['f', 7, -6, 3, 8], ['f', -6, 145, 4, 6], ['f', 48, -123, 4, 4], ['f', 58, 45, 4, 12],
  ['f', -19, 47, 4, 2], ['f', 24, 80, 4, 6], ['f', 11, 76, 3, 2],
];
function segDist(lat, lon, [a1, o1], [a2, o2]) {
  const px = lon - o1, py = lat - a1, dx = o2 - o1, dy = a2 - a1;
  const t = Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - t * dx, py - t * dy);
}
function hash(c, r, s) {
  let h = (c * 374761393 + r * 668265263 + s * 2147483647) | 0;
  h = (h ^ (h >>> 13)) * 1274126177 | 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function terrainAt(c, r, lon, lat) {
  if (lat > 66 || (lon > -56 && lon < -22 && lat > 61)) {
    if (lon > -56 && lon < -22 && lat > 62) return 'i';
    return lat > 74 ? 'i' : 't';
  }
  for (const [t, line] of ranges) {
    for (let i = 0; i + 1 < line.length; i++) {
      if (segDist(lat, lon, line[i], line[i + 1]) < LON_STEP * 0.62) return t;
    }
  }
  let best = null;
  for (const [t, la, lo, rla, rlo] of blobs) {
    const d = ((lat - la) / rla) ** 2 + ((lon - lo) / rlo) ** 2;
    if (d < 1 && (!best || d < best[1])) best = [t, d];
  }
  if (best) return best[0];
  if (lat > 60) return 't';
  const n = hash(c, r, 7);
  if (n < 0.1) return 'h';
  if (n < 0.24) return 'f';
  return 'p';
}

// Manual overrides that open straits the coarse grid would otherwise close.
// [col, row, char]
const overrides = [
  [46, 13, '.'], [47, 13, '.'], [48, 13, '.'], [49, 13, '.'], // Gibraltar
  [55, 12, '.'],                                              // Bosporus
  [59, 20, '.'],                                              // Bab-el-Mandeb
  [62, 16, '.'], [62, 17, '.'],                               // Hormuz
  [27, 5, '.'], [28, 5, '.'],                                 // Hudson Strait
  [5, 18, 'h'], [86, 20, 'h'], [95, 30, 'f'],                 // Hawaii, Guam, Fiji
];

const grid = [];
for (let r = 0; r < H; r++) {
  let row = '';
  for (let c = 0; c < W; c++) {
    const [lon, lat] = center(c, r);
    let hits = 0;
    for (const [ux, uy] of samples) if (isLand(lon + ux * RAD_LON, lat + uy * RAD_LON * 0.866)) hits++;
    const land = isLand(lon, lat) ? hits >= 4 : hits >= 6;
    if (!land) row += lat > 73 ? 'x' : '.';
    else row += terrainAt(c, r, lon, lat);
  }
  grid.push(row.split(''));
}
for (const [c, r, ch] of overrides) grid[r][c] = ch;
const rows = grid.map(r => r.join(''));
if (process.env.ASCII) { console.error(rows.map((r, i) => String(i).padStart(2) + ' ' + r).join('\n')); }
process.stdout.write(`// Generated by tools/build-map.mjs from Natural Earth land polygons. Do not edit by hand.
// Legend: . ocean, x pack ice (impassable), p plains, f forest, h hills, m mountains, d desert, t tundra, i ice sheet
window.WG_MAP = {
  W: ${W}, H: ${H}, lonLeft: ${LON_LEFT}, latTop: ${LAT_TOP}, lonStep: ${LON_STEP}, latStep: ${LAT_STEP},
  rows: [
${rows.map(r => `    '${r}',`).join('\n')}
  ]
};
`);
