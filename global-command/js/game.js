// Game state and rules: setup, movement, combat, production, missiles, turns.
WG.Game = (function () {
  const Hx = WG.Hex, R = WG.RULES, U = WG.UNITS, T = WG.TERRAIN, MAP = window.WG_MAP;
  const N = Hx.N;

  const terr = new Array(N);
  for (let i = 0; i < N; i++) terr[i] = MAP.rows[Hx.row(i)][Hx.col(i)];
  const isWater = i => !!T[terr[i]].water;
  const isImpassable = i => !!T[terr[i]].impassable;

  let G = null;
  let surf, air, cityAt, territory;
  const listeners = [];

  function emit(ev) { for (const fn of listeners) fn(ev); }
  function log(f, msg, kind) {
    G.log.push({ turn: G.turn, f, msg, kind: kind || 'info' });
    if (G.log.length > 150) G.log.shift();
    emit({ type: 'log' });
  }

  // ---------------------------------------------------------------- setup
  function placeCities() {
    const out = [];
    WG.CITY_DATA.forEach(([name, lat, lon, size, region, ov], id) => {
      let i = ov ? Hx.idx(ov[0], ov[1]) : Hx.fromLonLat(lon, lat);
      if (isWater(i)) {
        let best = -1, bd = Infinity;
        for (const n of Hx.within(i, 2)) {
          if (isWater(n)) continue;
          const [lo, la] = Hx.lonLat(n);
          const d = Math.hypot(lo - lon, la - lat);
          if (d < bd) { bd = d; best = n; }
        }
        i = best;
      }
      const coastal = Hx.neighbors(i).some(n => isWater(n) && !isImpassable(n));
      out.push({ id, name, i, size, region, coastal, owner: -1, capitalOf: -1, missiles: 0, built: false, launched: false, damaged: 0 });
    });
    return out;
  }

  function newGame(opts) {
    const diff = opts.difficulty || 'normal';
    G = {
      ver: 1, turn: 1, cur: 0, order: [], factions: [], cities: placeCities(), units: [], nextId: 1, log: [],
      settings: { human: opts.human, fog: opts.fog !== false, difficulty: diff }, over: false, winner: -1,
    };
    const dm = R.difficulty[diff];
    WG.FACTIONS.forEach((fd, id) => {
      const active = !!opts.active[id];
      const ai = id !== opts.human;
      G.factions.push({
        id, name: fd.name, short: fd.short, color: fd.color, ai, active, alive: active,
        credits: Math.round(R.startCredits * (ai && opts.human >= 0 ? dm.aiStart : 1)), lastIncome: 0, capital: -1,
      });
      if (!active) return;
      G.order.push(id);
      for (const name of fd.start) {
        const c = G.cities.find(c => c.name === name);
        c.owner = id;
        if (name === fd.capital) { c.capitalOf = id; G.factions[id].capital = c.id; }
      }
    });
    rebuild();
    // Starting forces.
    for (const f of G.order) {
      const fd = WG.FACTIONS[f];
      for (const name of fd.start) {
        const c = G.cities.find(c => c.name === name);
        const isCap = name === fd.capital;
        const kit = isCap ? ['infantry', 'armor', 'artillery', 'aa', 'infantry', 'fighter'] : ['infantry', 'armor'];
        if (c.coastal) kit.push('destroyer');
        if (isCap && c.coastal) kit.push('submarine');
        for (const type of kit) { const at = spawnTileFor(c, type); if (at >= 0) spawn(type, f, at); }
      }
    }
    // Neutral garrisons.
    for (const c of G.cities) {
      if (c.owner !== -1) continue;
      const kit = c.size === 3 ? ['infantry', 'infantry', 'artillery'] : c.size === 2 ? ['infantry', 'infantry'] : ['infantry'];
      for (const type of kit) {
        const at = spawnTileFor(c, type);
        if (at >= 0) { const u = spawn(type, -1, at); u.entrenched = true; }
      }
    }
    for (const u of G.units) u.mv = 0;
    G.cur = 0;
    startTurn(G.order[0]);
    log(-1, 'War has broken out across the continents.', 'big');
    return G;
  }

  function rebuild() {
    surf = new Array(N).fill(null);
    air = new Array(N).fill(null);
    cityAt = new Array(N).fill(null);
    for (const c of G.cities) cityAt[c.i] = c;
    for (const u of G.units) (U[u.type].domain === 'air' ? air : surf)[u.i] = u;
    computeTerritory();
  }

  function computeTerritory() {
    territory = new Int8Array(N).fill(-2);
    const dist = new Int16Array(N).fill(99);
    let frontier = [];
    for (const c of G.cities) { territory[c.i] = c.owner; dist[c.i] = 0; frontier.push(c.i); }
    for (let d = 1; d <= 2; d++) {
      const next = [];
      for (const t of frontier) for (const n of Hx.NB[t]) {
        if (n < 0 || dist[n] <= d) continue;
        if (isWater(n) && d > 1) continue;
        if (dist[n] === 99) { dist[n] = d; territory[n] = territory[t]; next.push(n); }
      }
      frontier = next;
    }
  }

  function spawn(type, owner, i) {
    const u = { id: G.nextId++, type, owner, i, hp: R.maxHp, mv: 0, moved: false, acted: true, rested: false, entrenched: false, embarked: false };
    G.units.push(u);
    (U[type].domain === 'air' ? air : surf)[i] = u;
    return u;
  }

  // ---------------------------------------------------------------- queries
  const layerOf = u => U[u.type].domain === 'air' ? air : surf;
  const isEnemy = (a, b) => a !== b;
  const unitsOf = f => G.units.filter(u => u.owner === f);
  const citiesOf = f => G.cities.filter(c => c.owner === f);

  function onBase(u) {
    const c = cityAt[u.i];
    if (c && c.owner === u.owner) return true;
    const s = surf[u.i];
    return !!(s && s.owner === u.owner && U[s.type].airbase);
  }

  // Visibility context for a viewer faction. null/observer => omniscient.
  function visibility(f) {
    if (f == null || f < 0 || !G.settings.fog) return null;
    const vis = new Uint8Array(N), near = new Uint8Array(N);
    for (const u of G.units) {
      if (u.owner !== f) continue;
      for (const t of Hx.within(u.i, U[u.type].vis)) vis[t] = 1;
      for (const t of Hx.within(u.i, 1)) near[t] = 1;
    }
    for (const c of G.cities) {
      if (c.owner !== f) continue;
      for (const t of Hx.within(c.i, 2)) vis[t] = 1;
      for (const t of Hx.within(c.i, 1)) near[t] = 1;
    }
    return { f, vis, near };
  }
  function canSee(V, u) {
    if (!V || u.owner === V.f) return true;
    if (!V.vis[u.i]) return false;
    return !U[u.type].stealth || !!V.near[u.i];
  }
  const seen = (V, u) => !!u && canSee(V, u);

  function zoc(i, owner, V) {
    for (const n of Hx.NB[i]) {
      if (n < 0) continue;
      const e = surf[n];
      if (e && e.owner !== owner && U[e.type].domain === 'land' && !e.embarked && seen(V, e)) return true;
    }
    return false;
  }

  // Cost of a single step; null if impossible. consume: uses all remaining moves. halt: may not continue.
  function stepCost(u, from, to, V) {
    if (isImpassable(to)) return null;
    const t = U[u.type];
    const es = surf[to], ea = air[to];
    const enemySurf = es && es.owner !== u.owner && seen(V, es);
    const enemyAir = ea && ea.owner !== u.owner && seen(V, ea);
    if (t.domain === 'air') {
      if (enemyAir) return null;
      return { cost: 1, halt: false };
    }
    if (enemySurf || enemyAir) return null;
    const c = cityAt[to];
    if (t.domain === 'sea') {
      if (isWater(to)) return { cost: 1, halt: false };
      if (c && c.owner === u.owner) return { cost: 1, halt: false };
      return null;
    }
    // land
    if (u.embarked) {
      if (isWater(to)) return { cost: 1, halt: false };
      return { consume: true, halt: true };
    }
    if (isWater(to)) {
      if (es || (c && c.owner !== u.owner)) return null;
      return { consume: true, halt: true };
    }
    const cost = c ? 1 : T[terr[to]].cost[t.move];
    const halt = (c && c.owner !== u.owner) || zoc(to, u.owner, V);
    return { cost, halt };
  }

  function canStop(u, i, V) {
    if (i === u.i) return true;
    const layer = layerOf(u);
    const occ = layer[i];
    if (occ && occ !== u) return false;
    if (U[u.type].domain === 'air') {
      const s = surf[i];
      if (s && s.owner !== u.owner && seen(V, s)) return false;
      const c = cityAt[i];
      if (c && c.owner !== u.owner) return false;
    }
    if (U[u.type].domain === 'land' && !U[u.type].capture) {
      const c = cityAt[i];
      if (c && c.owner !== u.owner) return false;
    }
    return true;
  }

  // Dijkstra over this turn's movement. Returns Map tile -> {c, prev, stop}.
  function reach(u, V) {
    const res = new Map();
    res.set(u.i, { c: 0, prev: -1, halt: false, stop: true });
    if (u.mv <= 0) return res;
    const budget = u.mv;
    const heap = new MinHeap();
    heap.push(0, u.i);
    while (heap.size) {
      const [c, i] = heap.pop();
      const node = res.get(i);
      if (c > node.c || node.halt) continue;
      for (const n of Hx.NB[i]) {
        if (n < 0) continue;
        const s = stepCost(u, i, n, V);
        if (!s) continue;
        const nc = s.consume ? budget : c + s.cost;
        if (nc > budget || (s.consume && c >= budget)) continue;
        const old = res.get(n);
        if (old && old.c <= nc) continue;
        res.set(n, { c: nc, prev: i, halt: !!s.halt || nc >= budget });
        heap.push(nc, n);
      }
    }
    for (const [i, node] of res) node.stop = canStop(u, i, V);
    return res;
  }
  function pathTo(res, dest) {
    const path = [];
    let i = dest;
    while (i >= 0 && res.has(i)) { path.push(i); i = res.get(i).prev; }
    path.reverse();
    path.shift();
    return path;
  }

  // ---------------------------------------------------------------- combat
  function defenseBonus(u, i) {
    if (U[u.type].domain === 'air' || u.embarked) return 0;
    const c = cityAt[i];
    let b;
    if (c) b = U[u.type].domain === 'sea' ? R.portDef : (c.capitalOf >= 0 ? R.capitalDef : R.cityDef);
    else b = isWater(i) ? 0 : T[terr[i]].def;
    if (u.entrenched) b += R.entrenchBonus;
    return b;
  }
  function rawDamage(att, attHp, def, mult) {
    const a = U[att.type].atk[U[def.type].cls];
    if (!a || att.embarked) return 0;
    const d = def.embarked ? R.embarkDef : U[def.type].def;
    return 3.2 * a * (attHp / R.maxHp) / (d * (1 + defenseBonus(def, def.i))) * (mult || 1);
  }
  const roll = x => x * (0.85 + Math.random() * 0.3);
  const toInt = (x, cap) => Math.max(0, Math.min(cap, Math.floor(x + Math.random())));

  function canHit(att, def) { return U[att.type].atk[U[def.type].cls] > 0; }
  function canCounter(def, att) {
    const t = U[def.type];
    return !def.embarked && t.rmin === 1 && canHit(def, att) && Hx.dist(def.i, att.i) === 1;
  }
  function canAttackNow(u) {
    const t = U[u.type];
    if (u.acted || u.embarked) return false;
    if (t.indirect && u.moved) return false;
    return Object.values(t.atk).some(v => v > 0);
  }
  function rangeOf(u) { const t = U[u.type]; return [t.rmin, t.rmax]; }

  // The enemy unit at tile i that `att` would strike, or null.
  function pickTarget(att, i, V) {
    const s = surf[i], a = air[i];
    const okS = s && isEnemy(att.owner, s.owner) && seen(V, s) && canHit(att, s) ? s : null;
    const okA = a && isEnemy(att.owner, a.owner) && seen(V, a) && canHit(att, a) ? a : null;
    if (okS && okA) {
      if (U[att.type].domain === 'air') return okA;
      return rawDamage(att, att.hp, okA) > rawDamage(att, att.hp, okS) ? okA : okS;
    }
    return okS || okA;
  }
  function targetsFrom(u, from, V) {
    const [lo, hi] = rangeOf(u);
    const out = [];
    for (const t of Hx.within(from, hi)) {
      const d = Hx.dist(from, t);
      if (d < lo) continue;
      const tg = pickTarget(u, t, V);
      if (tg) out.push(tg);
    }
    return out;
  }

  function aaCover(att, def) {
    if (U[att.type].domain !== 'air' || U[def.type].aa) return null;
    let best = null;
    for (const n of Hx.NB[def.i]) {
      if (n < 0) continue;
      const s = surf[n];
      if (s && s.owner === def.owner && U[s.type].aa && (!best || s.hp > best.hp)) best = s;
    }
    return best;
  }

  // Expected outcome for UI and AI (`from` is the attacker's position when striking).
  function forecast(att, def, from) {
    const saved = att.i;
    att.i = from;
    const cover = aaCover(att, def);
    let attHp = att.hp, coverDmg = 0;
    if (cover) { coverDmg = Math.min(attHp, rawDamage(cover, cover.hp, att, R.aaCoverFactor)); attHp -= coverDmg; }
    const mean = rawDamage(att, attHp, def);
    const dmgLo = Math.min(def.hp, Math.floor(mean * 0.85)), dmgHi = Math.min(def.hp, Math.ceil(mean * 1.15));
    const dealt = Math.min(def.hp, mean);
    let counter = 0;
    if (canCounter(def, att) && def.hp - dealt > 0) counter = Math.min(attHp, rawDamage(def, def.hp - dealt, att));
    att.i = saved;
    let kill = 0;
    for (let k = 0; k < 20; k++) kill += Math.max(0, Math.min(1, mean * (0.85 + 0.3 * (k + 0.5) / 20) - def.hp + 1));
    return { dealt, dmgLo, dmgHi, killChance: kill / 20, counter, coverDmg, cover };
  }

  function attack(att, def) {
    const ev = { att, def, from: att.i, to: def.i, steps: [] };
    const cover = aaCover(att, def);
    if (cover) {
      const d = toInt(roll(rawDamage(cover, cover.hp, att, R.aaCoverFactor)), att.hp);
      att.hp -= d;
      ev.steps.push({ kind: 'cover', src: cover, dst: att, dmg: d, killed: att.hp <= 0 });
      if (att.hp <= 0) { killUnit(att, `${uname(att)} was shot down by covering anti-air fire`); finishAttack(att); return ev; }
    }
    const d = toInt(roll(rawDamage(att, att.hp, def)), def.hp);
    def.hp -= d;
    ev.steps.push({ kind: 'hit', src: att, dst: def, dmg: d, killed: def.hp <= 0 });
    if (def.hp <= 0) {
      killUnit(def, `${uname(att)} destroyed ${uname(def)}`);
    } else if (canCounter(def, att)) {
      const c = toInt(roll(rawDamage(def, def.hp, att)), att.hp);
      att.hp -= c;
      ev.steps.push({ kind: 'counter', src: def, dst: att, dmg: c, killed: att.hp <= 0 });
      if (att.hp <= 0) killUnit(att, `${uname(att)} was destroyed by ${uname(def)}'s counter-attack`);
    }
    finishAttack(att);
    return ev;
  }
  function finishAttack(att) {
    att.acted = true;
    att.entrenched = false;
    if (!U[att.type].strikeAndReturn) att.mv = 0;
  }

  function uname(u) {
    const who = u.owner >= 0 ? G.factions[u.owner].short : 'Neutral';
    return `${who} ${U[u.type].name}`;
  }

  function killUnit(u, msg) {
    const layer = layerOf(u);
    if (layer[u.i] === u) layer[u.i] = null;
    u.hp = 0;
    u.dead = true;
    G.units = G.units.filter(x => x !== u);
    if (msg) log(u.owner, msg, 'combat');
    emit({ type: 'death', unit: u });
  }

  // ---------------------------------------------------------------- movement
  // Moves along a path one step at a time; stops early on ambush or zone of control.
  // onStep(from, to) is called for each successful step (used for animation).
  function moveAlong(u, path, onStep) {
    const visited = [u.i];
    let ambush = null;
    for (const to of path) {
      const from = u.i;
      const s = stepCost(u, from, to, null);
      if (!s) {
        const es = surf[to], ea = air[to];
        ambush = es && es.owner !== u.owner ? es : ea && ea.owner !== u.owner ? ea : null;
        break;
      }
      const cost = s.consume ? u.mv : s.cost;
      if (cost > u.mv) break;
      setPos(u, to);
      u.mv -= cost;
      u.moved = true;
      u.entrenched = false;
      visited.push(to);
      if (onStep) onStep(from, to);
      const t = U[u.type];
      if (t.domain === 'land') {
        if (!u.embarked && isWater(to)) { u.embarked = true; u.mv = 0; }
        else if (u.embarked && !isWater(to)) { u.embarked = false; u.mv = 0; }
        const c = cityAt[to];
        if (c && c.owner !== u.owner && !u.embarked) { capture(c, u.owner); u.mv = 0; }
        if (!u.embarked && zoc(to, u.owner, null)) u.mv = 0;
      }
      if (u.mv <= 0) break;
    }
    // Never end stacked on a friendly unit: step back to the last free tile.
    while (layerOf(u)[u.i] !== u && visited.length > 1) {
      visited.pop();
      setPos(u, visited[visited.length - 1]);
    }
    if (ambush) {
      log(u.owner, `${uname(u)} ran into a hidden ${uname(ambush)}!`, 'combat');
      u.mv = 0;
    }
    return { ambush };
  }

  function setPos(u, to) {
    const layer = layerOf(u);
    const from = u.i;
    if (layer[from] === u) layer[from] = null;
    // Carriers bring a parked friendly aircraft along.
    if (U[u.type].airbase) {
      const a = air[from];
      if (a && a.owner === u.owner && !air[to]) { air[from] = null; a.i = to; air[to] = a; }
    }
    u.i = to;
    if (!layer[to]) layer[to] = u;
  }

  function capture(c, f) {
    const prev = c.owner;
    c.owner = f;
    c.built = true;
    c.unrest = R.unrestTurns;
    const a = air[c.i];
    if (a && a.owner !== f) killUnit(a, `${uname(a)} was destroyed on the ground at ${c.name}`);
    const pname = prev >= 0 ? G.factions[prev].name : 'neutral forces';
    log(f, `${G.factions[f].name} captured ${c.name} from ${pname}${c.capitalOf === prev && prev >= 0 ? ' — their capital has fallen!' : ''}`, c.capitalOf >= 0 ? 'big' : 'capture');
    computeTerritory();
    emit({ type: 'capture', city: c, prev });
    if (prev >= 0 && citiesOf(prev).length === 0) eliminate(prev, f);
    checkVictory();
  }

  function eliminate(f, by) {
    const fac = G.factions[f];
    if (!fac.alive) return;
    fac.alive = false;
    for (const u of unitsOf(f)) killUnit(u);
    log(f, `${fac.name} has been eliminated${by >= 0 ? ' by ' + G.factions[by].name : ''}.`, 'big');
    emit({ type: 'eliminated', f });
  }

  function checkVictory() {
    if (G.over) return;
    const alive = G.order.filter(f => G.factions[f].alive);
    const capitals = G.cities.filter(c => c.capitalOf >= 0);
    let winner = -1;
    if (alive.length === 1) winner = alive[0];
    else for (const f of alive) {
      if (capitals.every(c => c.owner === f) || citiesOf(f).length >= G.cities.length * R.dominationShare) winner = f;
    }
    const h = G.settings.human;
    if (winner >= 0) { G.over = true; G.winner = winner; emit({ type: 'over', winner }); }
    else if (h >= 0 && !G.factions[h].alive) { G.over = true; G.winner = -1; emit({ type: 'over', winner: -1 }); }
  }

  // ---------------------------------------------------------------- production
  function spawnTileFor(c, type) {
    const d = U[type].domain;
    if (d === 'air') return air[c.i] ? -1 : c.i;
    if (d === 'sea') {
      if (!c.coastal) return -1;
      if (!surf[c.i]) return c.i;
      for (const n of Hx.neighbors(c.i)) if (isWater(n) && !isImpassable(n) && !surf[n] && !air[n]) return n;
      return -1;
    }
    if (!surf[c.i]) return c.i;
    for (const n of Hx.neighbors(c.i)) {
      if (isWater(n) || surf[n] || cityAt[n]) continue;
      if (air[n] && air[n].owner !== c.owner) continue;
      return n;
    }
    return -1;
  }
  function canBuild(c, type) {
    const f = G.factions[c.owner];
    if (!f || c.built) return c.unrest > 0 ? 'City in unrest' : 'Already built this turn';
    if (c.unrest > 0) return 'City in unrest';
    if (type === 'missile') {
      if (c.missiles >= R.missileMax) return 'Silo full';
      return f.credits < R.missileCost ? 'Not enough credits' : null;
    }
    if (U[type].domain === 'sea' && !c.coastal) return 'Not a port';
    if (f.credits < U[type].cost) return 'Not enough credits';
    if (spawnTileFor(c, type) < 0) return 'No room to deploy';
    return null;
  }
  function build(c, type) {
    if (canBuild(c, type)) return null;
    const f = G.factions[c.owner];
    c.built = true;
    if (type === 'missile') { f.credits -= R.missileCost; c.missiles++; emit({ type: 'build', city: c }); return 'missile'; }
    f.credits -= U[type].cost;
    const u = spawn(type, c.owner, spawnTileFor(c, type));
    emit({ type: 'build', city: c, unit: u });
    return u;
  }

  // ---------------------------------------------------------------- missiles
  function missileTargetsOk(c, i) { return Hx.dist(c.i, i) <= R.missileRange; }
  function launch(c, target) {
    if (c.missiles <= 0 || c.launched || !missileTargetsOk(c, target)) return null;
    c.missiles--;
    c.launched = true;
    const f = c.owner;
    const res = { city: c, from: c.i, to: target, intercepted: null, hits: [] };
    for (const t of Hx.within(target, R.missileInterceptRange)) {
      const s = surf[t];
      if (s && s.owner !== f && s.owner >= 0 && U[s.type].aa && Math.random() < R.missileIntercept) { res.intercepted = s; break; }
    }
    const tc = cityAt[target];
    if (res.intercepted) {
      log(f, `${G.factions[f].name} ICBM from ${c.name} was intercepted by ${uname(res.intercepted)}`, 'big');
      return res;
    }
    log(f, `${G.factions[f].name} launched an ICBM from ${c.name}${tc ? ' at ' + tc.name : ''}!`, 'big');
    for (const t of Hx.within(target, 1)) {
      const dmgBase = t === target ? R.missileDmg : R.missileSplash;
      for (const u of [surf[t], air[t]]) {
        if (!u) continue;
        const d = Math.min(u.hp, dmgBase);
        u.hp -= d;
        res.hits.push({ unit: u, dmg: d, killed: u.hp <= 0 });
        if (u.hp <= 0) killUnit(u, `${uname(u)} was vaporised by the strike`);
      }
    }
    if (tc) tc.damaged = 3;
    return res;
  }

  // ---------------------------------------------------------------- economy & turns
  function income(f) {
    let inc = 0;
    const regions = {};
    for (const c of G.cities) {
      regions[c.region] = regions[c.region] || { all: 0, mine: 0 };
      regions[c.region].all++;
      if (c.owner !== f) continue;
      regions[c.region].mine++;
      let v = R.cityIncome[c.size] + (c.capitalOf === f ? R.capitalIncome : 0);
      if (c.damaged > 0) v = Math.floor(v / 2);
      if (c.unrest > 0) v = 0;
      inc += v;
    }
    const held = [];
    for (const [k, r] of Object.entries(regions)) if (r.mine === r.all) { inc += WG.REGIONS[k].bonus; held.push(k); }
    const fac = G.factions[f];
    if (fac.ai && G.settings.human >= 0) inc *= R.difficulty[G.settings.difficulty].aiIncome;
    const gross = Math.round(inc);
    const units = G.units.reduce((n, u) => n + (u.owner === f), 0);
    const free = R.upkeepFree + R.upkeepPerCity * citiesOf(f).length;
    const upkeep = Math.floor(Math.max(0, units - free) * R.upkeepRate);
    return { total: Math.max(0, gross - upkeep), gross, upkeep, held };
  }
  function regionControl() {
    const out = {};
    for (const k of Object.keys(WG.REGIONS)) {
      const cs = G.cities.filter(c => c.region === k);
      const owners = new Set(cs.map(c => c.owner));
      out[k] = { count: cs.length, owner: owners.size === 1 ? cs[0].owner : -2, byFaction: cs.reduce((m, c) => (m[c.owner] = (m[c.owner] || 0) + 1, m), {}) };
    }
    return out;
  }

  function startTurn(f) {
    const fac = G.factions[f];
    for (const u of unitsOf(f)) {
      const t = U[u.type];
      if (u.rested || (t.domain === 'air' && onBase(u))) {
        const c = cityAt[u.i];
        const heal = (c && c.owner === f) || (t.domain === 'air' && onBase(u)) ? R.healCity : R.healField;
        u.hp = Math.min(R.maxHp, u.hp + heal);
      }
      u.entrenched = u.rested && t.domain === 'land' && !u.embarked;
      u.mv = u.embarked ? R.embarkMv : t.mv;
      u.moved = false;
      u.acted = false;
      u.done = false;
    }
    for (const c of citiesOf(f)) { c.built = false; c.launched = false; if (c.damaged > 0) c.damaged--; }
    const inc = income(f);
    fac.lastIncome = inc.total;
    fac.credits += inc.total;
    for (const c of citiesOf(f)) if (c.unrest > 0) c.unrest--;
    emit({ type: 'turnStart', f });
  }

  function endTurn(f) {
    for (const u of unitsOf(f)) {
      u.rested = !u.moved && !u.acted;
      if (U[u.type].domain === 'air' && !onBase(u)) {
        u.hp -= R.airAttrition;
        if (u.hp <= 0) killUnit(u, `${uname(u)} ran out of fuel and crashed`);
      }
    }
  }

  function advance() {
    endTurn(G.order[G.cur]);
    let guard = 0;
    do {
      G.cur++;
      if (G.cur >= G.order.length) { G.cur = 0; G.turn++; }
    } while (!G.factions[G.order[G.cur]].alive && ++guard < 20);
    startTurn(G.order[G.cur]);
    return G.order[G.cur];
  }

  // ---------------------------------------------------------------- persistence
  function serialize() {
    return JSON.stringify(G, (k, v) => (k === 'dead' ? undefined : v));
  }
  function load(json) {
    const g = JSON.parse(json);
    if (!g || g.ver !== 1) throw new Error('Unsupported save');
    G = g;
    rebuild();
    return G;
  }

  // ---------------------------------------------------------------- utils
  class MinHeap {
    constructor() { this.k = []; this.v = []; }
    get size() { return this.k.length; }
    push(key, val) {
      const k = this.k, v = this.v;
      let i = k.length;
      k.push(key); v.push(val);
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (k[p] <= key) break;
        k[i] = k[p]; v[i] = v[p]; i = p;
      }
      k[i] = key; v[i] = val;
    }
    pop() {
      const k = this.k, v = this.v;
      const top = [k[0], v[0]];
      const lk = k.pop(), lv = v.pop();
      if (k.length) {
        let i = 0;
        for (;;) {
          let c = 2 * i + 1;
          if (c >= k.length) break;
          if (c + 1 < k.length && k[c + 1] < k[c]) c++;
          if (k[c] >= lk) break;
          k[i] = k[c]; v[i] = v[c]; i = c;
        }
        k[i] = lk; v[i] = lv;
      }
      return top;
    }
  }

  return {
    get G() { return G; },
    terr, isWater, isImpassable, MinHeap,
    surfAt: i => surf[i], airAt: i => air[i], cityAt: i => cityAt[i], territoryAt: i => territory[i],
    newGame, load, serialize, rebuild,
    on: fn => listeners.push(fn), log,
    unitsOf, citiesOf, onBase, uname,
    visibility, canSee, zoc, stepCost, reach, pathTo, canStop,
    defenseBonus, rawDamage, forecast, attack, pickTarget, targetsFrom, canAttackNow, canHit, rangeOf,
    moveAlong, killUnit,
    spawnTileFor, canBuild, build, launch, missileTargetsOk,
    income, regionControl, startTurn, endTurn, advance, checkVictory,
  };
})();
