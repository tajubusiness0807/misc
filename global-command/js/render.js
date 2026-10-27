// Canvas renderer: hex map, territory, cities, units, highlights, effects and minimap.
WG.Render = (function () {
  const Hx = WG.Hex, Gm = WG.Game, U = WG.UNITS, R = WG.RULES;
  const N = Hx.N, SQ3 = Hx.SQ3;
  const BASE = 22;

  let canvas, ctx, mini, mctx, dpr = 1, vw = 0, vh = 0;
  const cam = { x: 0, y: 0, zoom: 1 };
  let dirty = true, miniDirty = true, staticDirty = true;
  let bg, bgctx;                 // cached terrain/territory/fog layer
  const effects = [];
  const overrides = new Map();   // unit id -> [wx, wy] while animating
  let ghosts = [];               // destroyed units drawn until their explosion plays
  let shake = 0;

  // View state supplied by the UI each frame.
  const view = { V: null, sel: null, reach: null, attack: null, path: null, hover: -1, missile: null, viewer: -1 };

  // ------------------------------------------------------------ colours
  const TCOL = { p: [111, 143, 78], f: [56, 102, 58], h: [138, 132, 85], m: [128, 120, 110], d: [201, 178, 122], t: [128, 146, 136], i: [214, 226, 234] };
  const hash = i => { let h = (i * 2654435761) >>> 0; h ^= h >>> 15; h = Math.imul(h, 2246822519) >>> 0; return (h >>> 0) / 4294967296; };
  const depth = new Uint8Array(N).fill(9);
  const tileFill = new Array(N);
  function precompute() {
    let frontier = [];
    for (let i = 0; i < N; i++) if (!Gm.isWater(i)) { depth[i] = 0; frontier.push(i); }
    for (let d = 1; d <= 4; d++) {
      const next = [];
      for (const t of frontier) for (const n of Hx.NB[t]) if (n >= 0 && depth[n] === 9) { depth[n] = d; next.push(n); }
      frontier = next;
    }
    for (let i = 0; i < N; i++) {
      const ch = Gm.terr[i];
      const j = 0.92 + hash(i) * 0.16;
      let c;
      if (ch === 'x') c = [168, 190, 205];
      else if (ch === '.') {
        const d = Math.min(depth[i], 5);
        c = [[0, 0, 0], [26, 78, 120], [19, 62, 102], [14, 50, 88], [11, 42, 76], [9, 36, 66]][d];
      } else c = TCOL[ch];
      tileFill[i] = `rgb(${c.map(v => Math.round(v * j)).join(',')})`;
    }
  }

  const hexToRgba = (hex, a) => {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
  };
  const factionColor = f => (f >= 0 ? Gm.G.factions[f].color : '#9aa3ad');
  let terrFill = {}, borderCol = {};
  function factionStyles() {
    terrFill = { '-1': 'rgba(160,170,180,0.07)' };
    borderCol = { '-1': 'rgba(200,210,220,0.35)' };
    for (const f of Gm.G.factions) { terrFill[f.id] = hexToRgba(f.color, 0.2); borderCol[f.id] = hexToRgba(f.color, 0.95); }
  }

  // ------------------------------------------------------------ camera
  const size = () => BASE * cam.zoom;
  const worldW = () => Hx.W * SQ3 * size();
  const worldH = () => (Hx.H * 1.5 + 0.5) * size();
  function clampCam() {
    const ww = worldW();
    cam.x = ((cam.x % ww) + ww) % ww;
    const wh = worldH();
    if (wh <= vh) cam.y = (wh - vh) / 2;
    else cam.y = Math.max(-40, Math.min(wh - vh + 40, cam.y));
  }
  function minZoom() { return Math.max(0.3, vh / ((Hx.H * 1.5 + 0.5) * BASE) * 0.85); }
  function setZoom(z, sx, sy) {
    if (sx == null) { sx = vw / 2; sy = vh / 2; }
    const old = size();
    const wx = cam.x + sx, wy = cam.y + sy;
    cam.zoom = Math.max(minZoom(), Math.min(2.8, z));
    const k = size() / old;
    cam.x = wx * k - sx;
    cam.y = wy * k - sy;
    clampCam();
    dirty = miniDirty = staticDirty = true;
  }
  function pan(dx, dy) { cam.x += dx; cam.y += dy; clampCam(); dirty = miniDirty = staticDirty = true; }
  function centerOn(i) {
    const [x, y] = Hx.center(i, size());
    cam.x = x - vw / 2;
    cam.y = y - vh / 2;
    clampCam();
    dirty = miniDirty = staticDirty = true;
  }
  function tileAtScreen(sx, sy) { return Hx.fromPixel(cam.x + sx, cam.y + sy, size()); }
  // Screen position of a world point, choosing the wrapped copy nearest the viewport centre.
  function toScreen(wx, wy) {
    const ww = worldW();
    let x = wx - cam.x;
    x = ((x % ww) + ww) % ww;
    if (x > vw / 2 + ww / 2) x -= ww;
    return [x, wy - cam.y];
  }
  function tileScreen(i) { const [x, y] = Hx.center(i, size()); return toScreen(x, y); }
  function isOnScreen(i, margin = 40) {
    const [x, y] = tileScreen(i);
    return x > -margin && y > -margin && x < vw + margin && y < vh + margin;
  }

  // ------------------------------------------------------------ primitives
  function hexPath(x, y, s) {
    const C = Hx.CORNERS;
    ctx.beginPath();
    ctx.moveTo(x + C[0][0] * s, y + C[0][1] * s);
    for (let k = 1; k < 6; k++) ctx.lineTo(x + C[k][0] * s, y + C[k][1] * s);
    ctx.closePath();
  }
  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function star(x, y, r, n = 5) {
    ctx.beginPath();
    for (let k = 0; k < n * 2; k++) {
      const a = -Math.PI / 2 + k * Math.PI / n;
      const rr = k % 2 ? r * 0.45 : r;
      ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    }
    ctx.closePath();
  }

  function terrainDecor(ch, x, y, s, i) {
    const h = hash(i * 7 + 3);
    if (ch === 'm') {
      ctx.fillStyle = 'rgba(70,62,55,0.85)';
      ctx.beginPath(); ctx.moveTo(x - s * 0.55, y + s * 0.35); ctx.lineTo(x - s * 0.1, y - s * 0.45); ctx.lineTo(x + s * 0.35, y + s * 0.35); ctx.fill();
      ctx.fillStyle = 'rgba(95,86,78,0.9)';
      ctx.beginPath(); ctx.moveTo(x - s * 0.05, y + s * 0.35); ctx.lineTo(x + s * 0.3, y - s * 0.2); ctx.lineTo(x + s * 0.62, y + s * 0.35); ctx.fill();
      ctx.fillStyle = 'rgba(240,244,248,0.9)';
      ctx.beginPath(); ctx.moveTo(x - s * 0.22, y - s * 0.22); ctx.lineTo(x - s * 0.1, y - s * 0.45); ctx.lineTo(x + s * 0.02, y - s * 0.22); ctx.fill();
    } else if (ch === 'f') {
      ctx.fillStyle = 'rgba(25,60,32,0.75)';
      for (let k = 0; k < 3; k++) {
        const ox = (k - 1) * s * 0.36 + (h - 0.5) * s * 0.15, oy = (k === 1 ? -s * 0.18 : s * 0.12);
        ctx.beginPath(); ctx.moveTo(x + ox, y + oy - s * 0.3); ctx.lineTo(x + ox + s * 0.17, y + oy + s * 0.12); ctx.lineTo(x + ox - s * 0.17, y + oy + s * 0.12); ctx.fill();
      }
    } else if (ch === 'h') {
      ctx.strokeStyle = 'rgba(80,70,40,0.7)';
      ctx.lineWidth = Math.max(1, s * 0.08);
      ctx.beginPath(); ctx.arc(x - s * 0.22, y + s * 0.2, s * 0.25, Math.PI * 1.1, Math.PI * 1.9); ctx.stroke();
      ctx.beginPath(); ctx.arc(x + s * 0.22, y + s * 0.05, s * 0.25, Math.PI * 1.1, Math.PI * 1.9); ctx.stroke();
    } else if (ch === 'd') {
      ctx.fillStyle = 'rgba(150,120,70,0.5)';
      for (let k = 0; k < 4; k++) {
        const a = h * 6.28 + k * 1.7;
        ctx.fillRect(x + Math.cos(a) * s * 0.4, y + Math.sin(a) * s * 0.35, Math.max(1, s * 0.07), Math.max(1, s * 0.07));
      }
    } else if (ch === 't') {
      ctx.fillStyle = 'rgba(230,240,245,0.35)';
      ctx.fillRect(x - s * 0.3, y - s * 0.1, s * 0.25, Math.max(1, s * 0.06));
      ctx.fillRect(x + s * 0.05, y + s * 0.15, s * 0.3, Math.max(1, s * 0.06));
    }
  }

  // ------------------------------------------------------------ unit glyphs
  function unitToken(u, x, y, s, opts = {}) {
    const t = U[u.type];
    const col = factionColor(u.owner);
    const scale = opts.scale || 1;
    const w = s * 1.12 * scale, h = s * 0.74 * scale;
    ctx.save();
    if (opts.dim) ctx.globalAlpha = 0.55;
    if (u.embarked) {
      ctx.fillStyle = '#5b4632';
      ctx.beginPath();
      ctx.moveTo(x - w * 0.62, y + h * 0.15); ctx.lineTo(x + w * 0.62, y + h * 0.15);
      ctx.lineTo(x + w * 0.42, y + h * 0.62); ctx.lineTo(x - w * 0.42, y + h * 0.62); ctx.closePath(); ctx.fill();
    }
    // frame shape by domain
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = s * 0.25;
    ctx.fillStyle = col;
    ctx.strokeStyle = opts.selected ? '#ffffff' : 'rgba(10,15,25,0.9)';
    ctx.lineWidth = opts.selected ? Math.max(2, s * 0.12) : Math.max(1, s * 0.07);
    if (t.domain === 'air') { ctx.beginPath(); ctx.arc(x, y, h * 0.62, 0, Math.PI * 2); }
    else if (t.domain === 'sea') { roundRect(x - w * 0.55, y - h * 0.42, w * 1.1, h * 0.84, h * 0.42); }
    else roundRect(x - w / 2, y - h / 2, w, h, s * 0.1);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.stroke();
    // glyph
    ctx.strokeStyle = ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.lineWidth = Math.max(1, s * 0.075 * scale);
    ctx.lineCap = 'round';
    const gw = w * 0.36, gh = h * 0.3;
    ctx.beginPath();
    switch (u.type) {
      case 'infantry':
        ctx.moveTo(x - gw, y - gh); ctx.lineTo(x + gw, y + gh); ctx.moveTo(x + gw, y - gh); ctx.lineTo(x - gw, y + gh); ctx.stroke(); break;
      case 'armor':
        roundRect(x - gw, y - gh * 0.75, gw * 2, gh * 1.5, gh * 0.75); ctx.stroke(); break;
      case 'artillery':
        ctx.arc(x, y, gh * 0.55, 0, Math.PI * 2); ctx.fill(); break;
      case 'aa':
        ctx.arc(x, y + gh * 0.6, gw * 0.75, Math.PI, 0); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x, y + gh * 0.6); ctx.lineTo(x, y - gh * 0.9); ctx.stroke(); break;
      case 'fighter': {
        const r = h * 0.42;
        ctx.moveTo(x, y - r); ctx.lineTo(x + r * 0.85, y + r * 0.6); ctx.lineTo(x, y + r * 0.25); ctx.lineTo(x - r * 0.85, y + r * 0.6); ctx.closePath(); ctx.fill(); break;
      }
      case 'bomber': {
        const r = h * 0.42;
        ctx.moveTo(x, y - r); ctx.lineTo(x + r * 0.15, y - r * 0.1); ctx.lineTo(x + r, y + r * 0.2); ctx.lineTo(x + r, y + r * 0.45);
        ctx.lineTo(x + r * 0.15, y + r * 0.25); ctx.lineTo(x + r * 0.12, y + r * 0.75); ctx.lineTo(x - r * 0.12, y + r * 0.75);
        ctx.lineTo(x - r * 0.15, y + r * 0.25); ctx.lineTo(x - r, y + r * 0.45); ctx.lineTo(x - r, y + r * 0.2); ctx.lineTo(x - r * 0.15, y - r * 0.1);
        ctx.closePath(); ctx.fill(); break;
      }
      case 'destroyer':
        ctx.moveTo(x - gw * 1.2, y); ctx.lineTo(x + gw * 1.2, y); ctx.lineTo(x + gw * 0.8, y + gh * 0.7); ctx.lineTo(x - gw * 0.9, y + gh * 0.7); ctx.closePath(); ctx.fill();
        ctx.fillRect(x - gw * 0.2, y - gh * 0.7, gw * 0.4, gh * 0.7); break;
      case 'submarine':
        roundRect(x - gw * 1.2, y - gh * 0.1, gw * 2.4, gh * 0.8, gh * 0.4); ctx.fill();
        ctx.fillRect(x - gw * 0.15, y - gh * 0.75, gw * 0.4, gh * 0.7); break;
      case 'battleship':
        ctx.moveTo(x - gw * 1.3, y); ctx.lineTo(x + gw * 1.3, y); ctx.lineTo(x + gw, y + gh * 0.75); ctx.lineTo(x - gw, y + gh * 0.75); ctx.closePath(); ctx.fill();
        ctx.fillRect(x - gw * 0.85, y - gh * 0.55, gw * 0.45, gh * 0.55); ctx.fillRect(x + gw * 0.35, y - gh * 0.55, gw * 0.45, gh * 0.55);
        ctx.fillRect(x - gw * 0.15, y - gh * 0.95, gw * 0.3, gh * 0.95); break;
      case 'carrier':
        ctx.moveTo(x - gw * 1.3, y - gh * 0.3); ctx.lineTo(x + gw * 1.3, y - gh * 0.3); ctx.lineTo(x + gw, y + gh * 0.7); ctx.lineTo(x - gw, y + gh * 0.7); ctx.closePath(); ctx.fill();
        ctx.fillRect(x + gw * 0.5, y - gh * 0.95, gw * 0.35, gh * 0.65); break;
    }
    // HP bar
    if (u.hp < R.maxHp) {
      const bw = w * 0.9, bh = Math.max(2, s * 0.11);
      const bx = x - bw / 2, by = y + h * 0.55;
      ctx.fillStyle = 'rgba(0,0,0,0.75)';
      ctx.fillRect(bx - 1, by - 1, bw + 2, bh + 2);
      ctx.fillStyle = u.hp > 6 ? '#4ade80' : u.hp > 3 ? '#facc15' : '#f87171';
      ctx.fillRect(bx, by, bw * u.hp / R.maxHp, bh);
      if (s * scale > 18) {
        ctx.font = `bold ${Math.round(s * 0.42 * scale)}px system-ui, sans-serif`;
        ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
        ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.85)';
        ctx.strokeText(u.hp, x + w * 0.62, y - h * 0.18);
        ctx.fillStyle = '#fff'; ctx.fillText(u.hp, x + w * 0.62, y - h * 0.18);
      }
    }
    if (u.entrenched && s > 12) {
      const sx = x - w * 0.5, sy = y - h * 0.5;
      ctx.fillStyle = '#e2e8f0';
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(sx - s * 0.12, sy - s * 0.12); ctx.lineTo(sx + s * 0.12, sy - s * 0.12); ctx.lineTo(sx + s * 0.12, sy + s * 0.04); ctx.lineTo(sx, sy + s * 0.15); ctx.lineTo(sx - s * 0.12, sy + s * 0.04); ctx.closePath(); ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  }

  // ------------------------------------------------------------ main draw
  function draw(now) {
    const G = Gm.G;
    if (!G) return;
    const s = size();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    let ox = 0, oy = 0;
    if (shake > 0) { ox = (Math.random() - 0.5) * shake; oy = (Math.random() - 0.5) * shake; shake *= 0.9; if (shake < 0.5) shake = 0; }
    ctx.fillStyle = '#071526';
    ctx.fillRect(0, 0, vw, vh);

    const colW = SQ3 * s, rowH = 1.5 * s;
    const r0 = Math.max(0, Math.floor((cam.y - s) / rowH));
    const r1 = Math.min(Hx.H - 1, Math.ceil((cam.y + vh + s) / rowH));
    const c0 = Math.floor(cam.x / colW) - 1, c1 = Math.ceil((cam.x + vw) / colW) + 1;
    const V = view.V;
    const tiles = [];
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const i = Hx.idx(c, r);
        const x = colW * (c + 0.5 * (r & 1) + 0.5) - cam.x;
        const y = s * (1.5 * r + 1) - cam.y;
        tiles.push(i, x, y);
      }
    }
    if (staticDirty) {
      const saved = ctx;
      ctx = bgctx;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawStatic(tiles, s, V);
      ctx = saved;
      staticDirty = false;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(bg, ox * dpr, oy * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.translate(ox, oy);
    drawDynamic(tiles, s, V, now);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  function drawStatic(tiles, s, V) {
    ctx.fillStyle = '#071526';
    ctx.fillRect(0, 0, vw, vh);
    const pad = s * 1.03;
    // terrain
    for (let k = 0; k < tiles.length; k += 3) {
      const i = tiles[k], x = tiles[k + 1], y = tiles[k + 2];
      hexPath(x, y, pad);
      ctx.fillStyle = tileFill[i];
      ctx.fill();
    }
    if (s >= 11) {
      for (let k = 0; k < tiles.length; k += 3) {
        const i = tiles[k], ch = Gm.terr[i];
        if (ch !== '.' && ch !== 'x' && ch !== 'p') terrainDecor(ch, tiles[k + 1], tiles[k + 2], s, i);
      }
    }
    // territory tint + grid
    for (let k = 0; k < tiles.length; k += 3) {
      const i = tiles[k], o = Gm.territoryAt(i);
      if (o === -2) continue;
      hexPath(tiles[k + 1], tiles[k + 2], s);
      ctx.fillStyle = terrFill[o];
      ctx.fill();
    }
    if (s >= 9) {
      ctx.strokeStyle = 'rgba(0,0,0,0.13)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let k = 0; k < tiles.length; k += 3) {
        if (Gm.isWater(tiles[k])) continue;
        const x = tiles[k + 1], y = tiles[k + 2], C = Hx.CORNERS;
        ctx.moveTo(x + C[0][0] * s, y + C[0][1] * s);
        for (let j = 1; j < 6; j++) ctx.lineTo(x + C[j][0] * s, y + C[j][1] * s);
        ctx.closePath();
      }
      ctx.stroke();
    }
    // fog
    if (V) {
      ctx.fillStyle = 'rgba(2,6,16,0.42)';
      for (let k = 0; k < tiles.length; k += 3) {
        if (V.vis[tiles[k]]) continue;
        hexPath(tiles[k + 1], tiles[k + 2], pad);
        ctx.fill();
      }
    }
    // borders
    ctx.lineWidth = Math.max(1.5, s * 0.13);
    ctx.lineCap = 'round';
    for (let k = 0; k < tiles.length; k += 3) {
      const i = tiles[k], o = Gm.territoryAt(i);
      if (o === -2) continue;
      const x = tiles[k + 1], y = tiles[k + 2];
      for (let d = 0; d < 6; d++) {
        const n = Hx.NB[i][d];
        if (n >= 0 && Gm.territoryAt(n) === o) continue;
        const [a, b] = Hx.EDGE[d], C = Hx.CORNERS;
        ctx.strokeStyle = borderCol[o];
        ctx.beginPath();
        ctx.moveTo(x + C[a][0] * s * 0.93, y + C[a][1] * s * 0.93);
        ctx.lineTo(x + C[b][0] * s * 0.93, y + C[b][1] * s * 0.93);
        ctx.stroke();
      }
    }
  }

  function drawDynamic(tiles, s, V, now) {
    // highlights
    const pulse = 0.5 + 0.5 * Math.sin(now / 220);
    if (view.missile) {
      const { city, hover } = view.missile;
      ctx.fillStyle = 'rgba(255,140,40,0.10)';
      for (let k = 0; k < tiles.length; k += 3) {
        if (Hx.dist(city.i, tiles[k]) <= R.missileRange) { hexPath(tiles[k + 1], tiles[k + 2], s); ctx.fill(); }
      }
      if (hover >= 0 && Hx.dist(city.i, hover) <= R.missileRange) {
        for (const t of Hx.within(hover, 1)) {
          const [x, y] = tileScreen(t);
          hexPath(x, y, s * 0.95);
          ctx.fillStyle = t === hover ? `rgba(255,60,30,${0.35 + 0.25 * pulse})` : `rgba(255,120,40,${0.2 + 0.15 * pulse})`;
          ctx.fill();
        }
      }
    }
    if (view.reach) {
      for (const [i, node] of view.reach) {
        if (!node.stop || (view.sel && i === view.sel.i)) continue;
        const [x, y] = tileScreen(i);
        if (x < -s || y < -s || x > vw + s || y > vh + s) continue;
        hexPath(x, y, s * 0.92);
        ctx.fillStyle = 'rgba(200,235,255,0.16)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(200,235,255,0.35)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
    if (view.attack) {
      for (const [i] of view.attack) {
        const [x, y] = tileScreen(i);
        hexPath(x, y, s * 0.92);
        ctx.fillStyle = `rgba(255,70,70,${0.18 + 0.15 * pulse})`;
        ctx.fill();
        ctx.strokeStyle = `rgba(255,90,90,${0.6 + 0.4 * pulse})`;
        ctx.lineWidth = Math.max(1.5, s * 0.1);
        ctx.stroke();
      }
    }
    if (view.hover >= 0) {
      const [x, y] = tileScreen(view.hover);
      hexPath(x, y, s * 0.96);
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    if (view.path && view.path.length > 1) {
      ctx.strokeStyle = 'rgba(110,231,255,0.9)';
      ctx.lineWidth = Math.max(2, s * 0.14);
      ctx.lineJoin = 'round';
      ctx.setLineDash([s * 0.3, s * 0.18]);
      ctx.beginPath();
      let prev = null;
      for (const i of view.path) {
        let [x, y] = tileScreen(i);
        if (prev && Math.abs(x - prev[0]) > vw / 2) x += x < prev[0] ? worldW() : -worldW();
        if (!prev) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        prev = [x, y];
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(110,231,255,0.95)';
      ctx.beginPath(); ctx.arc(prev[0], prev[1], s * 0.18, 0, Math.PI * 2); ctx.fill();
    }

    // cities
    const fontPx = Math.max(9, Math.min(15, s * 0.52));
    for (let k = 0; k < tiles.length; k += 3) {
      const c = Gm.cityAt(tiles[k]);
      if (c) drawCity(c, tiles[k + 1], tiles[k + 2], s, fontPx, now);
    }
    // units
    for (let k = 0; k < tiles.length; k += 3) {
      const i = tiles[k], x = tiles[k + 1], y = tiles[k + 2];
      const su = Gm.surfAt(i), au = Gm.airAt(i);
      if (su && !overrides.has(su.id) && Gm.canSee(V, su)) unitToken(su, x, y, s, tokenOpts(su));
      if (au && !overrides.has(au.id) && Gm.canSee(V, au)) {
        const stacked = !!(su && Gm.canSee(V, su)) || !!Gm.cityAt(i);
        unitToken(au, stacked ? x + s * 0.45 : x, stacked ? y - s * 0.42 : y, s, { ...tokenOpts(au), scale: stacked ? 0.72 : 1 });
      }
    }
    for (const g of ghosts) { const [x, y] = toScreen(g.x, g.y); unitToken(g.u, x, y, s, {}); }
    for (const [id, [wx, wy]] of overrides) {
      const u = overrideUnits.get(id);
      if (!u) continue;
      const [x, y] = toScreen(wx, wy);
      unitToken(u, x, y, s, { scale: U[u.type].domain === 'air' ? 0.9 : 1 });
    }
    // selection ring
    if (view.sel) {
      const u = view.sel;
      const [x, y] = tileScreen(u.i);
      hexPath(x, y, s * (0.98 + 0.04 * pulse));
      ctx.strokeStyle = `rgba(110,231,255,${0.6 + 0.4 * pulse})`;
      ctx.lineWidth = Math.max(2, s * 0.14);
      ctx.stroke();
    } else if (view.selCity) {
      const [x, y] = tileScreen(view.selCity.i);
      hexPath(x, y, s * (0.98 + 0.04 * pulse));
      ctx.strokeStyle = `rgba(255,230,120,${0.6 + 0.4 * pulse})`;
      ctx.lineWidth = Math.max(2, s * 0.14);
      ctx.stroke();
    }
    // effects
    for (let k = effects.length - 1; k >= 0; k--) {
      const e = effects[k];
      const t = (now - e.t0) / e.dur;
      if (t >= 1) { effects.splice(k, 1); if (e.done) e.done(); continue; }
      if (t >= 0) e.draw(t, s);
    }
  }

  function tokenOpts(u) {
    const G = Gm.G;
    const mine = u.owner === view.viewer && G.order[G.cur] === view.viewer && !G.factions[u.owner].ai;
    const spent = mine && (u.done || ((u.mv <= 0 || u.embarked && u.mv <= 0) && !Gm.canAttackNow(u)) || (u.mv <= 0 && u.acted));
    return { dim: spent, selected: view.sel === u };
  }

  function drawCity(c, x, y, s, fontPx, now) {
    const col = factionColor(c.owner);
    const r = s * (0.3 + 0.07 * c.size);
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = s * 0.3;
    ctx.fillStyle = '#0d1522';
    ctx.beginPath(); ctx.arc(x, y, r * 1.25, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = col;
    if (c.capitalOf >= 0) { star(x, y, r * 1.2); ctx.fill(); }
    else { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = '#0d1522';
    ctx.beginPath(); ctx.arc(x, y, r * 0.35, 0, Math.PI * 2); ctx.fill();
    if (c.damaged > 0) {
      ctx.strokeStyle = `rgba(255,120,30,${0.5 + 0.5 * Math.sin(now / 150)})`;
      ctx.lineWidth = Math.max(1.5, s * 0.1);
      ctx.beginPath(); ctx.arc(x, y, r * 1.5, 0, Math.PI * 2); ctx.stroke();
    }
    if (c.missiles > 0 && s > 10) {
      ctx.fillStyle = '#ff5a3c';
      for (let k = 0; k < c.missiles; k++) {
        const mx = x - r * 1.1 + k * s * 0.22, my = y - r * 1.6;
        ctx.beginPath(); ctx.moveTo(mx, my - s * 0.18); ctx.lineTo(mx + s * 0.08, my + s * 0.1); ctx.lineTo(mx - s * 0.08, my + s * 0.1); ctx.fill();
      }
    }
    const showLabel = s >= 13 || (s >= 9 && c.size >= 2) || c.size === 3 || c.capitalOf >= 0;
    if (showLabel) {
      ctx.font = `600 ${c.size === 3 ? fontPx * 1.05 : fontPx * 0.92}px "Rajdhani", system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const ly = y + s * 0.52;
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = 'rgba(4,10,20,0.9)';
      ctx.strokeText(c.name, x, ly);
      ctx.fillStyle = c.owner >= 0 ? '#f1f5f9' : '#cbd5e1';
      ctx.fillText(c.name, x, ly);
    }
    ctx.restore();
  }

  // ------------------------------------------------------------ minimap
  let miniBase = null;
  function buildMiniBase() {
    miniBase = document.createElement('canvas');
    miniBase.width = Hx.W * 3; miniBase.height = Hx.H * 3;
    const m = miniBase.getContext('2d');
    for (let i = 0; i < N; i++) {
      m.fillStyle = tileFill[i];
      m.fillRect(Hx.col(i) * 3 + (Hx.row(i) & 1) * 1.5, Hx.row(i) * 3, 3, 3);
    }
  }
  function drawMini() {
    if (!mctx || !Gm.G) return;
    const w = mini.width, h = mini.height;
    mctx.imageSmoothingEnabled = false;
    mctx.drawImage(miniBase, 0, 0, w, h);
    const sx = w / (Hx.W * 3), sy = h / (Hx.H * 3);
    for (let i = 0; i < N; i++) {
      const o = Gm.territoryAt(i);
      if (o < 0) continue;
      mctx.fillStyle = hexToRgba(factionColor(o), 0.55);
      mctx.fillRect((Hx.col(i) * 3 + (Hx.row(i) & 1) * 1.5) * sx, Hx.row(i) * 3 * sy, 3 * sx + 0.5, 3 * sy + 0.5);
    }
    for (const c of Gm.G.cities) {
      mctx.fillStyle = c.capitalOf >= 0 ? '#ffffff' : factionColor(c.owner);
      const x = (Hx.col(c.i) * 3 + (Hx.row(c.i) & 1) * 1.5 + 1.5) * sx, y = (Hx.row(c.i) * 3 + 1.5) * sy;
      mctx.fillRect(x - 1.5, y - 1.5, 3, 3);
    }
    for (const u of Gm.G.units) {
      if (u.owner < 0 || !Gm.canSee(view.V, u)) continue;
      mctx.fillStyle = factionColor(u.owner);
      const x = (Hx.col(u.i) * 3 + (Hx.row(u.i) & 1) * 1.5 + 1.5) * sx, y = (Hx.row(u.i) * 3 + 1.5) * sy;
      mctx.fillRect(x - 1, y - 1, 2, 2);
    }
    // viewport
    const ww = worldW(), wh = worldH();
    const vx = cam.x / ww * w, vy = cam.y / wh * h, vwid = vw / ww * w, vhei = vh / wh * h;
    mctx.strokeStyle = 'rgba(255,255,255,0.9)';
    mctx.lineWidth = 1.5;
    mctx.strokeRect(vx, vy, vwid, vhei);
    if (vx + vwid > w) mctx.strokeRect(vx - w, vy, vwid, vhei);
  }
  function miniClick(mx, my) {
    const fx = mx / mini.clientWidth, fy = my / mini.clientHeight;
    cam.x = fx * worldW() - vw / 2;
    cam.y = fy * worldH() - vh / 2;
    clampCam();
    dirty = miniDirty = staticDirty = true;
  }

  // ------------------------------------------------------------ effects API
  const overrideUnits = new Map();
  const later = ms => new Promise(r => setTimeout(r, ms));
  function addEffect(dur, drawFn, delay = 0) {
    return new Promise(resolve => effects.push({ t0: performance.now() + delay, dur, draw: drawFn, done: resolve }));
  }
  function worldOf(i) { return Hx.center(i, size()); }
  function wrapNear(a, b) {
    // Returns world x of b shifted by a world width so that it is nearest to a.
    const ww = worldW();
    let x = b;
    while (x - a > ww / 2) x -= ww;
    while (a - x > ww / 2) x += ww;
    return x;
  }

  async function animateMove(u, tiles, stepMs) {
    if (tiles.length < 2) return;
    overrideUnits.set(u.id, u);
    for (let k = 1; k < tiles.length; k++) {
      const z = size();
      const [ax, ay] = Hx.center(tiles[k - 1], z);
      let [bx, by] = Hx.center(tiles[k], z);
      bx = wrapNear(ax, bx);
      const t0 = performance.now();
      await new Promise(resolve => {
        const tick = () => {
          const t = Math.min(1, (performance.now() - t0) / stepMs);
          const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
          const k2 = size() / z;
          overrides.set(u.id, [(ax + (bx - ax) * e) * k2, (ay + (by - ay) * e) * k2]);
          dirty = true;
          if (t < 1) requestAnimationFrame(tick); else resolve();
        };
        tick();
      });
    }
    overrides.delete(u.id);
    overrideUnits.delete(u.id);
    dirty = miniDirty = true;
  }

  function tracer(fromI, toI, color, dur) {
    return addEffect(dur, t => {
      const z = size();
      let [ax, ay] = Hx.center(fromI, z), [bx, by] = Hx.center(toI, z);
      bx = wrapNear(ax, bx);
      const [sx, sy] = toScreen(ax, ay);
      const ex = sx + (bx - ax), ey = sy + (by - ay);
      const hx = sx + (ex - sx) * t, hy = sy + (ey - sy) * t;
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1.5, z * 0.1);
      ctx.beginPath();
      ctx.moveTo(sx + (ex - sx) * Math.max(0, t - 0.35), sy + (ey - sy) * Math.max(0, t - 0.35));
      ctx.lineTo(hx, hy);
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(hx, hy, z * 0.12, 0, Math.PI * 2); ctx.fill();
    });
  }
  function explosion(i, big, delay = 0) {
    const parts = [];
    const n = big ? 34 : 14;
    for (let k = 0; k < n; k++) parts.push([Math.random() * Math.PI * 2, 0.3 + Math.random() * 0.9, Math.random()]);
    if (big) setTimeout(() => { shake = 18; }, delay);
    return addEffect(big ? 1100 : 550, (t, z) => {
      const [x, y] = tileScreen(i);
      const R0 = z * (big ? 2.4 : 0.9);
      const g = ctx.createRadialGradient(x, y, 0, x, y, R0 * (0.3 + t));
      g.addColorStop(0, `rgba(255,250,220,${1 - t})`);
      g.addColorStop(0.35, `rgba(255,170,60,${0.9 * (1 - t)})`);
      g.addColorStop(1, 'rgba(255,60,20,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, R0 * (0.3 + t), 0, Math.PI * 2); ctx.fill();
      if (big) {
        ctx.strokeStyle = `rgba(255,220,180,${0.8 * (1 - t)})`;
        ctx.lineWidth = z * 0.15;
        ctx.beginPath(); ctx.arc(x, y, R0 * 1.6 * t, 0, Math.PI * 2); ctx.stroke();
      }
      for (const [a, sp, c] of parts) {
        const d = R0 * sp * t * 1.2;
        ctx.fillStyle = c > 0.5 ? `rgba(255,200,90,${1 - t})` : `rgba(60,55,50,${0.8 * (1 - t)})`;
        ctx.fillRect(x + Math.cos(a) * d, y + Math.sin(a) * d - t * z * 0.3, z * 0.1, z * 0.1);
      }
    }, delay);
  }
  function floatText(i, text, color, delay = 0) {
    return addEffect(1000, (t, z) => {
      const [x, y] = tileScreen(i);
      ctx.font = `800 ${Math.max(12, z * 0.7)}px "Rajdhani", system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.globalAlpha = 1 - t * t;
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.strokeText(text, x, y - z * 0.6 - t * z * 0.9);
      ctx.fillStyle = color;
      ctx.fillText(text, x, y - z * 0.6 - t * z * 0.9);
      ctx.globalAlpha = 1;
    }, delay);
  }
  function missileArc(fromI, toI, dur, interceptAt) {
    return addEffect(dur, (t, z) => {
      const [ax, ay] = Hx.center(fromI, z);
      let [bx, by] = Hx.center(toI, z);
      bx = wrapNear(ax, bx);
      const [sx, sy] = toScreen(ax, ay);
      const ex = sx + (bx - ax), ey = sy + (by - ay);
      const len = Math.hypot(ex - sx, ey - sy);
      const cx = (sx + ex) / 2, cy = (sy + ey) / 2 - Math.max(60, len * 0.45);
      const end = interceptAt ? Math.min(t, 0.86) : t;
      const pt = u => [(1 - u) * (1 - u) * sx + 2 * (1 - u) * u * cx + u * u * ex, (1 - u) * (1 - u) * sy + 2 * (1 - u) * u * cy + u * u * ey];
      ctx.lineWidth = Math.max(2, z * 0.12);
      for (let k = 0; k < 24; k++) {
        const u0 = Math.max(0, end - 0.3 + k * 0.0125), u1 = Math.max(0, end - 0.3 + (k + 1) * 0.0125);
        const [x0, y0] = pt(u0), [x1, y1] = pt(u1);
        ctx.strokeStyle = `rgba(255,${150 + k * 4},90,${k / 24})`;
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      }
      const [hx, hy] = pt(end);
      ctx.fillStyle = '#fff';
      ctx.shadowColor = '#ff7a3c'; ctx.shadowBlur = 16;
      ctx.beginPath(); ctx.arc(hx, hy, Math.max(3, z * 0.18), 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
      if (interceptAt && t > 0.86) {
        const k = (t - 0.86) / 0.14;
        ctx.fillStyle = `rgba(255,220,150,${1 - k})`;
        ctx.beginPath(); ctx.arc(hx, hy, z * 1.2 * k, 0, Math.PI * 2); ctx.fill();
      }
    });
  }
  // Draws a unit glyph into a small standalone canvas (used by the HTML panels).
  function icon(el, type, owner, px) {
    const d = Math.round(px * Math.min(window.devicePixelRatio || 1, 2));
    el.width = el.height = d;
    el.style.width = el.style.height = px + 'px';
    const saved = ctx;
    ctx = el.getContext('2d');
    unitToken({ type, owner, hp: R.maxHp }, d / 2, d / 2, d * 0.62);
    ctx = saved;
  }
  function addGhost(u, i) { const [x, y] = worldOf(i); const g = { u, x, y }; ghosts.push(g); return () => { ghosts = ghosts.filter(z => z !== g); dirty = true; }; }

  // ------------------------------------------------------------ init/resize
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    vw = canvas.clientWidth; vh = canvas.clientHeight;
    canvas.width = Math.round(vw * dpr); canvas.height = Math.round(vh * dpr);
    if (mini) { mini.width = mini.clientWidth * dpr; mini.height = mini.clientHeight * dpr; }
    bg.width = canvas.width; bg.height = canvas.height;
    if (cam.zoom < minZoom()) cam.zoom = minZoom();
    clampCam();
    dirty = miniDirty = staticDirty = true;
  }
  function init(cv, mv) {
    canvas = cv; ctx = cv.getContext('2d');
    bg = document.createElement('canvas'); bgctx = bg.getContext('2d');
    mini = mv; mctx = mv.getContext('2d');
    precompute();
    buildMiniBase();
    resize();
    window.addEventListener('resize', resize);
    let lastMini = 0;
    const loop = now => {
      const animating = effects.length || overrides.size || shake || view.sel || view.selCity || view.attack || view.missile;
      if (dirty || animating) { draw(now); dirty = false; }
      if (miniDirty && now - lastMini > 200) { drawMini(); miniDirty = false; lastMini = now; }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  return {
    init, cam, view, setZoom, pan, centerOn, tileAtScreen, tileScreen, isOnScreen, miniClick, factionStyles, resize,
    invalidate() { dirty = miniDirty = staticDirty = true; },
    animateMove, tracer, explosion, floatText, missileArc, addGhost, later, icon,
    get zoom() { return cam.zoom; },
  };
})();
