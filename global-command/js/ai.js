// Computer opponents. Each AI turn: launch missiles, move/attack with every unit, then build.
// The AI is omniscient (ignores fog of war) but otherwise plays by the same rules.
WG.AI = (function () {
  const Gm = WG.Game, Hx = WG.Hex, U = WG.UNITS, R = WG.RULES, T = WG.TERRAIN;
  const N = Hx.N;
  const value = u => U[u.type].cost * (u.hp / R.maxHp);

  // Multi-source Dijkstra from target tiles; field[i] ~ movement points from i to the nearest goal.
  function field(sources, edgeCost) {
    const d = new Float32Array(N).fill(Infinity);
    const heap = new Gm.MinHeap();
    for (const [i, c] of sources) if (c < d[i]) { d[i] = c; heap.push(c, i); }
    while (heap.size) {
      const [c, b] = heap.pop();
      if (c > d[b]) continue;
      for (const a of Hx.NB[b]) {
        if (a < 0) continue;
        const e = edgeCost(a, b);
        if (e === Infinity) continue;
        const nc = c + e;
        if (nc < d[a]) { d[a] = nc; heap.push(nc, a); }
      }
    }
    return d;
  }

  // The runaway leader (if any) draws extra attention from everyone else.
  function leaderOf() {
    const G = Gm.G;
    const counts = G.order.map(f => [f, Gm.citiesOf(f).length]).sort((a, b) => b[1] - a[1]);
    return counts.length > 1 && counts[0][1] > 12 && counts[0][1] > counts[1][1] * 1.3 ? counts[0][0] : -9;
  }

  function landField(f) {
    const G = Gm.G;
    const src = [];
    const leader = leaderOf();
    for (const c of G.cities) {
      if (c.owner === f) continue;
      let guard = 0;
      for (const t of Hx.within(c.i, 1)) { const s = Gm.surfAt(t); if (s && s.owner === c.owner) guard += s.hp / R.maxHp; }
      let off = guard * 1.5 - c.size;
      if (c.capitalOf >= 0 && c.owner >= 0) off -= 2;
      if (c.owner === leader) off -= 3;
      src.push([c.i, Math.max(0, off + 4)]);
    }
    return field(src, (a, b) => {
      if (Gm.isImpassable(b)) return Infinity;
      const wa = Gm.isWater(a), wb = Gm.isWater(b);
      if (wb) return wa ? 0.8 : 5;
      if (wa) return 5;
      return Gm.cityAt(b) ? 1 : T[Gm.terr[b]].cost.foot;
    });
  }

  function seaField(f) {
    const G = Gm.G;
    const src = [];
    for (const u of G.units) {
      if (u.owner === f || u.owner < 0) continue;
      if (Gm.isWater(u.i)) src.push([u.i, U[u.type].domain === 'sea' ? 0 : 1]);
    }
    for (const c of G.cities) {
      if (c.owner === f || !c.coastal) continue;
      for (const n of Hx.neighbors(c.i)) if (Gm.isWater(n)) src.push([n, 4]);
    }
    return field(src, (a, b) => {
      if (Gm.isImpassable(a)) return Infinity;
      if (Gm.isWater(a)) return 1;
      const c = Gm.cityAt(a);
      return c && c.owner === f ? 1 : Infinity;
    });
  }

  function baseField(f) {
    const G = Gm.G;
    const src = [];
    for (const c of G.cities) if (c.owner === f) src.push([c.i, 0]);
    for (const u of G.units) if (u.owner === f && U[u.type].airbase) src.push([u.i, 0]);
    return field(src, () => 1);
  }

  // th: general striking power that can reach each tile; sea: power against ships and embarked troops.
  function threatMap(f) {
    const th = new Float32Array(N), sea = new Float32Array(N);
    for (const e of Gm.G.units) {
      if (e.owner === f) continue;
      const t = U[e.type];
      const power = Math.max(t.atk.L, t.atk.S) * e.hp / R.maxHp;
      if (!power) continue;
      let r;
      if (e.owner < 0) r = t.rmax;
      else if (t.domain === 'air') r = Math.floor(t.mv / 2) + 1;
      else r = Math.min(t.mv, 4) + t.rmax;
      const navalPower = t.atk.S * e.hp / R.maxHp;
      for (const i of Hx.within(e.i, r)) {
        th[i] += power;
        if (navalPower && e.owner >= 0 && t.domain !== 'land') sea[i] += navalPower;
      }
    }
    return { th, sea };
  }

  function isBaseFor(u, i) {
    const c = Gm.cityAt(i);
    const s = Gm.surfAt(i);
    const a = Gm.airAt(i);
    if (a && a !== u) return false;
    return (c && c.owner === u.owner) || (s && s.owner === u.owner && U[s.type].airbase);
  }

  // ------------------------------------------------------------ attacks
  function bestAttack(u, res, ctx) {
    if (!Gm.canAttackNow(u)) return null;
    const t = U[u.type];
    const tiles = t.indirect ? [u.i] : [...res.keys()].filter(i => res.get(i).stop);
    let best = null;
    const myVal = value(u);
    for (const tile of tiles) {
      if (t.domain === 'air' && res.get(tile).c + ctx.base[tile] > u.mv) continue;
      for (const tg of Gm.targetsFrom(u, tile, null)) {
        const fc = Gm.forecast(u, tg, tile);
        const tv = U[tg.type].cost;
        let score = (fc.dealt / tg.hp) * value(tg) + fc.killChance * tv * 0.6
          - (fc.counter / R.maxHp) * U[u.type].cost * 1.1 - (fc.coverDmg / R.maxHp) * U[u.type].cost;
        if (Gm.cityAt(tg.i)) score += fc.killChance * 6 + 1;
        if (tg.owner < 0) score *= 0.8;
        if (t.domain === 'land') score += Gm.defenseBonus(u, tile) * 2 - ctx.threat[tile] * 0.04 * (tile !== u.i);
        if (!best || score > best.score) best = { tile, target: tg, score };
      }
    }
    if (best && best.score > Math.max(1, 0.06 * myVal)) return best;
    return null;
  }

  async function tryAttackHere(u, ctx, act) {
    if (u.dead || !Gm.canAttackNow(u)) return false;
    const res = new Map([[u.i, { c: 0, prev: -1, stop: true }]]);
    const a = bestAttack(u, res, ctx);
    if (!a) return false;
    await act.attack(u, a.target);
    return true;
  }

  // ------------------------------------------------------------ unit turn
  async function actUnit(u, ctx, act) {
    const f = u.owner, t = U[u.type];
    let res = Gm.reach(u, null);

    // Capture an undefended city in reach.
    if (t.capture && !u.embarked) {
      let cap = null;
      for (const [i, node] of res) {
        const c = Gm.cityAt(i);
        if (!c || c.owner === f || !node.stop || Gm.surfAt(i)) continue;
        const score = c.size * 10 + (c.capitalOf >= 0 ? 20 : 0) - node.c;
        if (!cap || score > cap.score) cap = { i, score };
      }
      if (cap) {
        await act.move(u, Gm.pathTo(res, cap.i));
        await tryAttackHere(u, ctx, act);
        return;
      }
    }

    // Strike.
    const atk = bestAttack(u, res, ctx);
    if (atk) {
      if (atk.tile !== u.i) await act.move(u, Gm.pathTo(res, atk.tile));
      if (!u.dead && !atk.target.dead && Gm.targetsFrom(u, u.i, null).includes(atk.target)) await act.attack(u, atk.target);
      if (u.dead) return;
      if (t.domain !== 'air') return;
      res = Gm.reach(u, null);
    }

    // Aircraft: return to (or reposition between) bases.
    if (t.domain === 'air') {
      let best = null;
      for (const [i, node] of res) {
        if (!node.stop || !isBaseFor(u, i)) continue;
        const score = ctx.land[i] + node.c * 0.05;
        if (!best || score < best.score) best = { i, score };
      }
      if (best && best.i !== u.i) await act.move(u, Gm.pathTo(res, best.i));
      else if (!best) {
        let near = null;
        for (const [i, node] of res) if (node.stop && (!near || ctx.base[i] < ctx.base[near])) near = i;
        if (near != null && near !== u.i) await act.move(u, Gm.pathTo(res, near));
      }
      return;
    }

    // Hold a threatened city if we are its only defender.
    const here = Gm.cityAt(u.i);
    if (here && here.owner === f && t.domain === 'land' && ctx.threat[u.i] > 2) {
      await tryAttackHere(u, ctx, act);
      return;
    }

    // Damaged units fall back to the nearest friendly city to repair.
    if (u.hp <= 4 && t.domain !== 'air') {
      let best = null;
      for (const [i, node] of res) {
        const c = Gm.cityAt(i);
        if (node.stop && c && c.owner === f && (t.domain !== 'sea' || c.coastal)) {
          if (!best || node.c < best.c) best = { i, c: node.c };
        }
      }
      if (best) {
        if (best.i !== u.i) await act.move(u, Gm.pathTo(res, best.i));
        return;
      }
    }

    // Advance along the strategic goal field.
    const fld = t.domain === 'sea' ? ctx.sea : ctx.land;
    const scoreTile = (i, node) => {
      let s = fld[i];
      if (s === Infinity) s = 1e6;
      const danger = ctx.threat[i];
      if (t.domain === 'land') {
        s -= Gm.defenseBonus(u, i) * 1.5;
        if (Gm.isWater(i)) s += ctx.seaThreat[i] * 0.35;
        if (t.indirect) s += danger * 0.15;
      } else if (t.domain === 'sea') {
        s += danger * (U[u.type].airbase ? 0.3 : 0.05);
      }
      if (u.hp <= 5) s += danger * 0.2;
      return s + node.c * 0.01;
    };
    let best = { i: u.i, s: scoreTile(u.i, res.get(u.i)) - 0.5 };
    for (const [i, node] of res) {
      if (!node.stop || i === u.i) continue;
      const s = scoreTile(i, node);
      if (s < best.s) best = { i, s };
    }
    if (best.i !== u.i) await act.move(u, Gm.pathTo(res, best.i));
    if (!u.dead) await tryAttackHere(u, ctx, act);
  }

  // Send the nearest available land unit into each threatened empty city.
  async function garrison(f, ctx, act, busy) {
    for (const c of Gm.citiesOf(f)) {
      if (ctx.threat[c.i] < 3 || Gm.surfAt(c.i)) continue;
      let best = null;
      for (const u of Gm.unitsOf(f)) {
        if (busy.has(u) || U[u.type].domain !== 'land' || u.embarked || Hx.dist(u.i, c.i) > 6) continue;
        const res = Gm.reach(u, null);
        const node = res.get(c.i);
        if (node && node.stop && (!best || node.c < best.c)) best = { u, res, c: node.c };
      }
      if (best) {
        busy.add(best.u);
        await act.move(best.u, Gm.pathTo(best.res, c.i));
        await tryAttackHere(best.u, ctx, act);
      }
    }
  }

  // ------------------------------------------------------------ missiles
  async function missiles(f, act) {
    const G = Gm.G;
    for (const c of Gm.citiesOf(f)) {
      if (c.missiles <= 0 || c.launched) continue;
      let best = null;
      const tried = new Set();
      for (const e of G.units) {
        if (e.owner === f || e.owner < 0 || tried.has(e.i) || !Gm.missileTargetsOk(c, e.i)) continue;
        tried.add(e.i);
        let v = 0;
        for (const t of Hx.within(e.i, 1)) {
          const dmg = t === e.i ? R.missileDmg : R.missileSplash;
          for (const u of [Gm.surfAt(t), Gm.airAt(t)]) {
            if (!u) continue;
            const hit = Math.min(dmg, u.hp) / R.maxHp * U[u.type].cost + (dmg >= u.hp ? U[u.type].cost * 0.5 : 0);
            v += u.owner === f ? -1.5 * hit : u.owner < 0 ? 0.3 * hit : hit;
          }
        }
        let aa = 0;
        for (const t of Hx.within(e.i, R.missileInterceptRange)) {
          const s = Gm.surfAt(t);
          if (s && s.owner !== f && s.owner >= 0 && U[s.type].aa) aa++;
        }
        v *= Math.pow(1 - R.missileIntercept, aa);
        if (!best || v > best.v) best = { i: e.i, v };
      }
      if (best && best.v > 24) await act.launch(c, best.i);
    }
  }

  // ------------------------------------------------------------ production
  const MIX = { infantry: 0.28, armor: 0.22, artillery: 0.12, aa: 0.08, fighter: 0.08, bomber: 0.07, destroyer: 0.06, submarine: 0.03, battleship: 0.03, carrier: 0.02 };

  function produce(f, ctx, act) {
    const G = Gm.G;
    const fac = G.factions[f];
    const counts = {};
    for (const k of WG.UNIT_ORDER) counts[k] = 0;
    const mine = Gm.unitsOf(f);
    for (const u of mine) counts[u.type]++;
    const total = mine.length + 1;
    const enemyNavy = G.units.filter(u => u.owner !== f && u.owner >= 0 && U[u.type].domain === 'sea').length;
    const enemyAir = G.units.filter(u => u.owner !== f && u.owner >= 0 && U[u.type].domain === 'air').length;
    const cities = Gm.citiesOf(f).sort((a, b) => ctx.threat[b.i] - ctx.threat[a.i]);
    for (const c of cities) {
      if (c.built || fac.credits < 6) continue;
      const threat = ctx.threat[c.i];
      if (threat > 3 && !Gm.surfAt(c.i)) {
        const pick = ['armor', 'infantry'].find(k => !Gm.canBuild(c, k));
        if (pick) { act.build(c, pick); counts[pick]++; continue; }
      }
      if (fac.credits > 75 && c.missiles === 0 && Math.random() < 0.3 && !Gm.canBuild(c, 'missile')) { act.build(c, 'missile'); continue; }
      let best = null;
      for (const k of WG.UNIT_ORDER) {
        if (Gm.canBuild(c, k)) continue;
        let want = MIX[k];
        if (U[k].domain === 'sea') want *= (c.coastal ? 1.6 : 0) * (enemyNavy > 4 ? 1.4 : 1);
        if (k === 'aa' || k === 'fighter') want *= enemyAir > 3 ? 1.6 : 1;
        if (k === 'carrier' && counts.fighter + counts.bomber <= counts.carrier) want *= 0.2;
        if (threat > 3 && U[k].domain !== 'land') want *= 0.4;
        const deficit = want * total - counts[k] + Math.random() * 0.6;
        if (!best || deficit > best.d) best = { k, d: deficit };
      }
      // Occasionally save up rather than spam the cheapest unit.
      if (best && best.k === 'infantry' && counts.infantry > total * 0.35 && fac.credits < 25 && threat < 2) continue;
      if (best) { act.build(c, best.k); counts[best.k]++; }
    }
  }

  // ------------------------------------------------------------ main
  const PRIORITY = { artillery: 0, battleship: 1, bomber: 2, fighter: 3, submarine: 4, destroyer: 5, armor: 6, aa: 7, infantry: 8, carrier: 9 };

  async function takeTurn(f, act) {
    const tm = threatMap(f);
    const ctx = { f, threat: tm.th, seaThreat: tm.sea, land: landField(f), sea: seaField(f), base: baseField(f) };
    await missiles(f, act);
    const busy = new Set();
    await garrison(f, ctx, act, busy);
    const units = Gm.unitsOf(f).filter(u => !busy.has(u)).sort((a, b) => PRIORITY[a.type] - PRIORITY[b.type]);
    for (const u of units) {
      if (u.dead || Gm.G.over) continue;
      await actUnit(u, ctx, act);
      if (act.yield) await act.yield();
    }
    if (!Gm.G.over && Gm.G.factions[f].alive) produce(f, ctx, act);
  }

  return { takeTurn };
})();
