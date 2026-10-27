// User interface: input, selection, panels, turn flow and animated playback of actions.
WG.UI = (function () {
  const Gm = WG.Game, Rn = WG.Render, Hx = WG.Hex, U = WG.UNITS, R = WG.RULES, A = WG.Audio;
  const $ = id => document.getElementById(id);
  const SAVE_KEY = 'gc.save';
  const FACTION_BLURB = [
    'North America. A rich industrial heartland with two oceans to guard.',
    'South America. Isolated and secure, with a whole continent to unite.',
    'Western Europe. Dense, wealthy and surrounded by rivals.',
    'West & Central Africa. A vast neutral continent waiting to be claimed.',
    'Russia. Strategic depth, frozen ports and fronts in every direction.',
    'East Asia. Populous neighbours and island chains ripe for expansion.',
    'South Asia. A crowded subcontinent at the crossroads of three regions.',
  ];

  const S = {
    human: -1, sel: null, selCity: null, reach: null, attack: null, mode: null, hover: -1,
    busy: false, gen: 0, aiSpeed: 'normal', paused: false, V: null,
  };
  const G = () => Gm.G;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fcolor = f => (f >= 0 ? G().factions[f].color : '#9aa3ad');
  const fname = f => (f >= 0 ? G().factions[f].name : 'Neutral');

  function isHumanTurn() {
    const g = G();
    return !!g && !g.over && S.human >= 0 && g.order[g.cur] === S.human && !S.busy;
  }

  // ------------------------------------------------------------ visibility & view sync
  function refreshVis() {
    S.V = S.human >= 0 ? Gm.visibility(S.human) : null;
    Rn.view.V = S.V;
    Rn.view.viewer = S.human;
  }
  function syncView() {
    Rn.view.sel = S.sel;
    Rn.view.selCity = S.sel ? null : S.selCity;
    Rn.view.reach = S.reach;
    Rn.view.attack = S.attack;
    Rn.view.missile = S.mode === 'missile' && S.selCity ? { city: S.selCity, hover: S.hover } : null;
    Rn.view.hover = S.hover;
    Rn.view.path = previewPath();
    Rn.invalidate();
  }
  function previewPath() {
    const u = S.sel;
    if (!u || !S.reach || S.hover < 0) return null;
    let dest = -1;
    const a = S.attack && S.attack.get(S.hover);
    if (a) dest = a.from;
    else if (S.reach.has(S.hover) && S.reach.get(S.hover).stop) dest = S.hover;
    if (dest < 0 || dest === u.i) return null;
    return [u.i, ...Gm.pathTo(S.reach, dest)];
  }

  // ------------------------------------------------------------ selection
  function computeOptions() {
    const u = S.sel;
    S.reach = null; S.attack = null;
    if (!u || u.dead || !isHumanTurn() || u.owner !== S.human || u.done) return syncView();
    S.reach = Gm.reach(u, S.V);
    S.attack = new Map();
    if (Gm.canAttackNow(u)) {
      const froms = U[u.type].indirect ? [u.i] : [...S.reach].filter(([, n]) => n.stop).map(([i]) => i);
      for (const from of froms) {
        for (const tg of Gm.targetsFrom(u, from, S.V)) {
          const score = (from === u.i ? 100 : 0) + Gm.defenseBonus(u, from) * 10 - S.reach.get(from).c;
          const prev = S.attack.get(tg.i);
          if (!prev || score > prev.score) S.attack.set(tg.i, { target: tg, from, score });
        }
      }
    }
    syncView();
  }
  function selectUnit(u, center) {
    S.sel = u; S.selCity = null; S.mode = null;
    computeOptions();
    renderPanel();
    if (center && !Rn.isOnScreen(u.i, -60)) Rn.centerOn(u.i);
  }
  function selectCity(c) {
    S.sel = null; S.selCity = c; S.mode = null; S.reach = null; S.attack = null;
    syncView();
    renderPanel();
  }
  function clearSel() {
    S.sel = null; S.selCity = null; S.mode = null; S.reach = null; S.attack = null;
    syncView();
    renderPanel();
  }
  function hasOrders(u) { return !u.done && (u.mv > 0 || Gm.canAttackNow(u)); }
  function nextUnit() {
    if (!isHumanTurn()) return;
    const list = Gm.unitsOf(S.human).filter(hasOrders).sort((a, b) => a.id - b.id);
    if (!list.length) { toast('All units have orders. Ready to end the turn.'); return; }
    const k = S.sel ? list.findIndex(u => u.id > S.sel.id) : 0;
    const u = list[k < 0 ? 0 : k];
    A.select();
    selectUnit(u, true);
    Rn.centerOn(u.i);
  }

  // ------------------------------------------------------------ actions (human)
  async function onTileClick(i) {
    if (i < 0) return;
    A.unlock();
    if (S.mode === 'missile') {
      const c = S.selCity;
      if (isHumanTurn() && c && Gm.missileTargetsOk(c, i)) {
        S.mode = null;
        syncView();
        S.busy = true;
        await playLaunch(Gm.launch(c, i), true);
        S.busy = false;
        afterAction();
      } else { S.mode = null; syncView(); renderPanel(); }
      return;
    }
    if (isHumanTurn() && S.sel && S.sel.owner === S.human) {
      const a = S.attack && S.attack.get(i);
      if (a) return humanAttack(S.sel, a);
      const node = S.reach && S.reach.get(i);
      if (node && node.stop && i !== S.sel.i) return humanMove(S.sel, Gm.pathTo(S.reach, i));
    }
    const cands = [];
    const su = Gm.surfAt(i), au = Gm.airAt(i), c = Gm.cityAt(i);
    if (su && Gm.canSee(S.V, su)) cands.push({ u: su });
    if (au && Gm.canSee(S.V, au)) cands.push({ u: au });
    if (c) cands.push({ c });
    if (!cands.length) { clearSel(); return; }
    const k = cands.findIndex(x => (x.u && x.u === S.sel) || (x.c && x.c === S.selCity && !S.sel));
    const next = cands[(k + 1) % cands.length];
    A.click();
    if (next.u) selectUnit(next.u); else selectCity(next.c);
  }

  async function humanMove(u, path) {
    S.busy = true;
    S.reach = null; S.attack = null; syncView();
    const res = await animatedMove(u, path, true);
    S.busy = false;
    if (res.ambush) { toast(`Ambush! ${U[res.ambush.type].name} spotted.`, 'alert'); A.alarm(); }
    afterAction();
  }
  async function humanAttack(u, a) {
    S.busy = true;
    S.reach = null; S.attack = null; syncView();
    if (a.from !== u.i) {
      await animatedMove(u, Gm.pathTo(Gm.reach(u, S.V), a.from), true);
      refreshVis();
    }
    if (!u.dead && !a.target.dead && u.i === a.from && Gm.targetsFrom(u, u.i, S.V).includes(a.target)) {
      await playAttack(Gm.attack(u, a.target), true);
    }
    S.busy = false;
    afterAction();
  }
  function afterAction() {
    refreshVis();
    if (G().over) { showEnd(); return; }
    if (S.sel && (S.sel.dead || !hasOrders(S.sel))) {
      const c = S.sel.dead ? null : Gm.cityAt(S.sel.i);
      if (S.sel.dead) S.sel = null;
      if (!S.sel && c) S.selCity = c;
    }
    computeOptions();
    renderPanel();
    updateHUD();
  }

  // ------------------------------------------------------------ playback
  function stepMs() { return S.aiSpeed === 'fast' ? 45 : 95; }
  function tileShown(t, u) {
    if (!S.V) return true;
    return !!S.V.vis[t] && (!U[u.type].stealth || !!S.V.near[t] || u.owner === S.human);
  }
  async function animatedMove(u, path, force) {
    const tiles = [u.i];
    const res = Gm.moveAlong(u, path, (a, b) => tiles.push(b));
    const show = force || (S.aiSpeed !== 'instant' && tiles.some(t => tileShown(t, u)) && tiles.some(t => Rn.isOnScreen(t)));
    if (show && tiles.length > 1) {
      A.move();
      await Rn.animateMove(u, tiles, force ? 85 : stepMs());
    }
    Rn.invalidate();
    return res;
  }
  async function playAttack(ev, force) {
    const show = force || (S.aiSpeed !== 'instant' && (tileShown(ev.from, ev.att) || tileShown(ev.to, ev.def)) && (Rn.isOnScreen(ev.from) || Rn.isOnScreen(ev.to)));
    if (!show) return;
    const fast = !force && S.aiSpeed === 'fast';
    for (const st of ev.steps) {
      const ghost = st.killed ? Rn.addGhost(st.dst, st.dst.i) : null;
      const col = st.kind === 'cover' ? '#9be7ff' : st.kind === 'counter' ? '#ffd27a' : '#fff1b8';
      A.shot();
      await Rn.tracer(st.src.i, st.dst.i, col, fast ? 140 : 240);
      Rn.floatText(st.dst.i, st.dmg ? `-${st.dmg}` : 'MISS', st.dmg ? '#ff8a8a' : '#cbd5e1');
      if (st.killed) {
        A.boom();
        await Rn.explosion(st.dst.i, false);
        if (ghost) ghost();
      } else {
        Rn.explosion(st.dst.i, false);
        await sleep(fast ? 80 : 180);
      }
    }
  }
  async function playLaunch(res, force) {
    if (!res) return;
    const visible = force || Rn.isOnScreen(res.to, 200) || Rn.isOnScreen(res.from, 200);
    const hitsMe = res.hits.some(h => h.unit.owner === S.human) || (Gm.cityAt(res.to) || {}).owner === S.human;
    if (hitsMe && S.human >= 0) { toast(`Incoming ICBM from ${fname(res.city.owner)}!`, 'alert'); A.alarm(); }
    if (!visible || S.aiSpeed === 'instant') return;
    const ghosts = res.hits.filter(h => h.killed).map(h => Rn.addGhost(h.unit, h.unit.i));
    A.launch();
    await Rn.missileArc(res.from, res.to, 1500, !!res.intercepted);
    if (res.intercepted) {
      Rn.floatText(res.to, 'INTERCEPTED', '#9be7ff');
      A.shot();
      await sleep(500);
    } else {
      A.bigBoom();
      for (const h of res.hits) Rn.floatText(h.unit.i, `-${h.dmg}`, '#ff8a8a', 300);
      await Rn.explosion(res.to, true);
    }
    ghosts.forEach(g => g());
  }

  const aiAct = {
    move: (u, path) => animatedMove(u, path, false),
    attack: (u, t) => playAttack(Gm.attack(u, t), false),
    launch: (c, i) => playLaunch(Gm.launch(c, i), false),
    build: (c, k) => Gm.build(c, k),
    _n: 0,
    async yield() { if (++this._n % 6 === 0) await sleep(0); },
  };

  // ------------------------------------------------------------ turn flow
  async function endTurn() {
    if (!isHumanTurn()) return;
    clearSel();
    S.busy = true;
    Gm.advance();
    await runAI();
  }

  async function runAI() {
    const gen = S.gen;
    S.busy = true;
    updateHUD();
    while (G() && !G().over && gen === S.gen) {
      const g = G();
      const f = g.order[g.cur];
      if (!g.factions[f].ai) break;
      if (S.human >= 0 && S.aiSpeed !== 'instant') banner(g.factions[f].name, 'is on the move', g.factions[f].color, true);
      refreshVis();
      updateHUD();
      await WG.AI.takeTurn(f, aiAct);
      if (gen !== S.gen) return;
      Gm.advance();
      updateHUD();
      Rn.invalidate();
      if (S.human < 0) {
        await sleep(S.aiSpeed === 'instant' ? 30 : 250);
        while (S.paused && gen === S.gen) await sleep(150);
      }
    }
    if (gen !== S.gen) return;
    S.busy = false;
    refreshVis();
    if (G().over) { updateHUD(); showEnd(); return; }
    beginHumanTurn();
  }

  function beginHumanTurn() {
    const g = G();
    const f = g.factions[S.human];
    banner('Your turn', `Turn ${g.turn} · +${f.lastIncome} credits`, f.color);
    A.turn();
    autosave();
    updateHUD();
    renderPanel();
    renderLog();
  }

  // ------------------------------------------------------------ HUD
  function updateHUD() {
    const g = G();
    if (!g) return;
    const me = S.human >= 0 ? g.factions[S.human] : null;
    const chip = $('faction-chip');
    if (me) {
      chip.style.setProperty('--fc', me.color);
      chip.innerHTML = `<i></i><span>${esc(me.name)}</span>`;
      $('credits').textContent = me.credits;
      $('income').textContent = `+${Gm.income(S.human).total}`;
    } else {
      chip.style.setProperty('--fc', '#6ee7ff');
      chip.innerHTML = '<i></i><span>Observer</span>';
      $('credits').textContent = '—';
      $('income').textContent = '';
    }
    $('turn').textContent = g.turn;
    const cur = g.factions[g.order[g.cur]];
    const st = $('status-text');
    if (g.over) st.textContent = 'War is over';
    else if (S.human < 0) st.textContent = S.paused ? 'Paused' : `${cur.name} moving…`;
    else if (cur.id === S.human) {
      const left = Gm.unitsOf(S.human).filter(hasOrders).length;
      st.textContent = left ? `${left} unit${left > 1 ? 's' : ''} ready` : 'All orders given';
    } else st.textContent = `${cur.name} moving…`;
    const endBtn = $('btn-end');
    if (S.human < 0) {
      endBtn.innerHTML = S.paused ? 'Resume' : 'Pause';
      endBtn.disabled = g.over;
      $('btn-next').classList.add('hidden');
    } else {
      endBtn.innerHTML = 'End turn <kbd>E</kbd>';
      endBtn.disabled = !isHumanTurn();
      $('btn-next').classList.remove('hidden');
      $('btn-next').disabled = !isHumanTurn();
    }
    renderPowers();
  }

  function renderPowers() {
    const g = G();
    const total = g.cities.length;
    const rows = g.order.map(f => {
      const fac = g.factions[f];
      const cities = Gm.citiesOf(f).length;
      return { fac, cities, units: Gm.unitsOf(f).length };
    }).sort((a, b) => (b.fac.alive - a.fac.alive) || b.cities - a.cities);
    const curF = g.order[g.cur];
    $('powers').innerHTML = `<div class="panel-title">World powers</div>` + rows.map(r => `
      <div class="power${r.fac.alive ? '' : ' dead'}${r.fac.id === curF && !g.over ? ' active-turn' : ''}" style="--fc:${r.fac.color}" title="${esc(r.fac.name)}: ${r.cities} cities, ${r.units} units">
        <i></i><span class="nm${r.fac.id === S.human ? ' me' : ''}">${esc(r.fac.name)}</span>
        <span class="n">${r.cities}&#9679;</span><span class="n">${r.units}&#9632;</span>
        <div class="bar"><b style="width:${(r.cities / total * 100).toFixed(1)}%"></b></div>
      </div>`).join('') + `<div class="power" style="--fc:#9aa3ad"><i></i><span class="nm">Neutral</span><span class="n">${Gm.citiesOf(-1).length}&#9679;</span><span class="n"></span></div>`;
  }

  let logQueued = false;
  function renderLog() {
    if (logQueued) return;
    logQueued = true;
    requestAnimationFrame(() => {
      logQueued = false;
      const g = G();
      if (!g) return;
      const items = g.log.slice(-60).filter(l => {
        if (S.human < 0 || !g.settings.fog) return true;
        return l.kind === 'big' || l.kind === 'capture' || l.f === S.human || l.msg.includes(g.factions[S.human].short + ' ');
      });
      const ul = $('log-list');
      ul.innerHTML = items.map(l => {
        const alert = S.human >= 0 && l.f !== S.human && l.msg.includes(g.factions[S.human].short + ' ');
        return `<li class="${l.kind === 'big' ? 'big' : ''}${alert ? ' alert' : ''}" style="--fc:${l.f >= 0 ? fcolor(l.f) : 'transparent'}"><span class="t">T${l.turn}</span>${esc(l.msg)}</li>`;
      }).join('');
      ul.scrollTop = ul.scrollHeight;
    });
  }

  // ------------------------------------------------------------ panels
  function iconCanvas(type, owner, px) {
    const c = document.createElement('canvas');
    Rn.icon(c, type, owner, px);
    return c;
  }

  function renderPanel() {
    const p = $('panel');
    p.classList.remove('empty');
    if (!G()) { p.innerHTML = ''; return; }
    if (S.sel && !S.sel.dead) return unitPanel(p, S.sel);
    if (S.selCity) return cityPanel(p, S.selCity);
    overviewPanel(p);
  }

  function unitPanel(p, u) {
    const t = U[u.type];
    const mine = u.owner === S.human;
    const hpCls = u.hp > 6 ? '' : u.hp > 3 ? 'mid' : 'low';
    const bonus = Gm.defenseBonus(u, u.i);
    const c = Gm.cityAt(u.i);
    const where = c ? c.name : WG.TERRAIN[Gm.terr[u.i]].name;
    const tags = [];
    if (u.entrenched) tags.push('<span class="good">Entrenched +20%</span>');
    if (u.embarked) tags.push('<span class="bad">Embarked — defence 1</span>');
    if (mine && u.acted) tags.push('<span>Attacked</span>');
    if (mine && t.indirect && u.moved && !u.acted) tags.push('<span>Moved — cannot fire</span>');
    if (t.domain === 'air') tags.push(Gm.onBase(u) ? '<span class="good">At base</span>' : '<span class="bad">Away from base: −3 HP at turn end</span>');
    if (t.stealth) tags.push('<span>Stealth</span>');
    if (u.done) tags.push('<span>Skipped</span>');
    const mvMax = u.embarked ? R.embarkMv : t.mv;
    p.innerHTML = `
      <div class="card-head" style="--fc:${fcolor(u.owner)}"><span id="ph-icon"></span><div><h3>${t.name}</h3><small>${esc(fname(u.owner))}</small></div></div>
      <div class="hpbar"><i class="${hpCls}" style="width:${u.hp * 10}%"></i><span>${u.hp} / ${R.maxHp} HP</span></div>
      <div class="stats">
        <div><label>Move</label><b>${mine ? `${u.mv}/${mvMax}` : mvMax}</b></div>
        <div><label>Defence</label><b>${u.embarked ? R.embarkDef : t.def}</b></div>
        <div><label>Range</label><b>${t.rmin === t.rmax ? t.rmax : t.rmin + '–' + t.rmax}</b></div>
        <div><label>Vision</label><b>${t.vis}</b></div>
      </div>
      <div class="atk-row"><span>Land<b>${t.atk.L}</b></span><span>Air<b>${t.atk.A}</b></span><span>Sea<b>${t.atk.S}</b></span><span>Sub<b>${t.atk.U}</b></span></div>
      <div class="tags">${tags.join('')}</div>
      <p class="desc">${t.desc}</p>
      <dl class="info-rows"><dt>Position</dt><dd>${esc(where)}</dd><dt>Defence bonus</dt><dd>+${Math.round(bonus * 100)}%</dd></dl>
      ${mine && isHumanTurn() ? `<div class="actions">
        <button class="btn" data-act="skip">${u.done ? 'Wake' : 'Skip'} <kbd>S</kbd></button>
        ${c && c.owner === S.human ? '<button class="btn" data-act="city">City</button>' : ''}
        <button class="btn danger" data-act="disband">Disband</button></div>` : ''}`;
    $('ph-icon').appendChild(iconCanvas(u.type, u.owner, 44));
    p.querySelectorAll('[data-act]').forEach(b => b.onclick = () => {
      const act = b.dataset.act;
      if (act === 'skip') { u.done = !u.done; if (u.done) nextUnit(); else selectUnit(u); updateHUD(); }
      if (act === 'city') selectCity(c);
      if (act === 'disband') {
        if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'Confirm disband'; return; }
        Gm.killUnit(u, `${Gm.uname(u)} was disbanded`); S.sel = null; afterAction();
      }
    });
  }

  function cityPanel(p, c) {
    const mine = c.owner === S.human;
    const g = G();
    const inc = R.cityIncome[c.size] + (c.capitalOf === c.owner && c.owner >= 0 ? R.capitalIncome : 0);
    const region = WG.REGIONS[c.region];
    const rc = Gm.regionControl()[c.region];
    const heldByOwner = rc.byFaction[c.owner] || 0;
    const sizeName = ['', 'Town', 'City', 'Metropolis'][c.size];
    const capOf = c.capitalOf >= 0 ? `Capital of ${esc(g.factions[c.capitalOf].name)}` : sizeName;
    let html = `
      <div class="card-head" style="--fc:${fcolor(c.owner)}"><div><h3>${esc(c.name)}</h3><small>${esc(fname(c.owner))} · ${capOf}</small></div></div>
      <dl class="info-rows">
        <dt>Income</dt><dd>${c.unrest ? `none (unrest, ${c.unrest} turn${c.unrest > 1 ? 's' : ''})` : `+${c.damaged ? Math.floor(inc / 2) + ' (damaged)' : inc} / turn`}</dd>
        <dt>Region</dt><dd>${esc(region.name)}</dd>
        <dt>Region control</dt><dd>${heldByOwner}/${rc.count} · bonus +${region.bonus}</dd>
        <dt>Port</dt><dd>${c.coastal ? 'Yes' : 'No'}</dd>
        <dt>ICBMs in silo</dt><dd>${c.missiles}/${R.missileMax}</dd>
      </dl>`;
    if (mine && isHumanTurn()) {
      const credits = g.factions[S.human].credits;
      html += `<div class="section-title">Production ${c.built ? '<span style="color:var(--warn)">· done this turn</span>' : ''}</div><div class="build-grid">`;
      for (const k of WG.UNIT_ORDER) {
        const why = Gm.canBuild(c, k);
        if (U[k].domain === 'sea' && !c.coastal) continue;
        html += `<button class="build" data-build="${k}" ${why ? 'disabled' : ''} title="${esc(why || U[k].desc)}"><span data-icon="${k}"></span><span><span class="bn">${U[k].name}</span><span class="bc">${U[k].cost} cr</span></span></button>`;
      }
      const mwhy = Gm.canBuild(c, 'missile');
      html += `<button class="build" data-build="missile" ${mwhy ? 'disabled' : ''} title="${esc(mwhy || 'Intercontinental ballistic missile. Range ' + R.missileRange + '.')}"><span class="bn" style="color:#ff7a5c;font-size:18px;width:28px;text-align:center">&#9650;</span><span><span class="bn">ICBM</span><span class="bc">${R.missileCost} cr</span></span></button>`;
      html += '</div>';
      if (c.missiles > 0) {
        html += `<div class="actions"><button class="btn danger" data-act="launch" ${c.launched ? 'disabled' : ''}>${S.mode === 'missile' ? 'Cancel launch' : c.launched ? 'Launched this turn' : 'Launch ICBM'}</button></div>`;
        if (S.mode === 'missile') html += `<p class="desc">Select a target within ${R.missileRange} hexes. Right-click to cancel.</p>`;
      }
      html += `<p class="desc">Credits available: <b style="color:var(--warn)">${credits}</b></p>`;
    }
    const su = Gm.surfAt(c.i), au = Gm.airAt(c.i);
    const here = [su, au].filter(u => u && Gm.canSee(S.V, u));
    if (here.length) {
      html += `<div class="section-title">Stationed here</div><div class="actions">` + here.map(u => `<button class="btn" data-unit="${u.id}">${U[u.type].name} (${u.hp})</button>`).join('') + '</div>';
    }
    p.innerHTML = html;
    p.querySelectorAll('[data-icon]').forEach(el => el.appendChild(iconCanvas(el.dataset.icon, c.owner, 28)));
    p.querySelectorAll('[data-build]').forEach(b => b.onclick = () => {
      const r = Gm.build(c, b.dataset.build);
      if (r) { A.build(); toast(`${c.name}: ${r === 'missile' ? 'ICBM' : U[r.type].name} ready${r === 'missile' ? '' : ' next turn'}`); }
      else A.error();
      updateHUD(); renderPanel(); Rn.invalidate();
    });
    p.querySelectorAll('[data-unit]').forEach(b => b.onclick = () => {
      const u = G().units.find(x => x.id === +b.dataset.unit);
      if (u) selectUnit(u);
    });
    const lb = p.querySelector('[data-act="launch"]');
    if (lb) lb.onclick = () => { S.mode = S.mode === 'missile' ? null : 'missile'; syncView(); renderPanel(); };
  }

  function overviewPanel(p) {
    const g = G();
    if (S.human < 0) {
      p.innerHTML = `<div class="panel-title">Observer mode</div><p class="desc">The computer powers are fighting it out. Click any unit or city to inspect it. Use Pause to stop between turns.</p>`;
      return;
    }
    const inc = Gm.income(S.human);
    const mine = Gm.citiesOf(S.human);
    const capitals = g.cities.filter(c => c.capitalOf >= 0);
    const capsHeld = capitals.filter(c => c.owner === S.human).length;
    const need = Math.ceil(g.cities.length * R.dominationShare);
    const rc = Gm.regionControl();
    const ready = Gm.unitsOf(S.human).filter(hasOrders).length;
    p.innerHTML = `
      <div class="panel-title">Command overview</div>
      <div class="overview">
        <p>Income <b style="color:var(--good)">+${inc.total}</b> per turn from ${mine.length} cities${inc.held.length ? ` and ${inc.held.length} region bonus${inc.held.length > 1 ? 'es' : ''}` : ''}.${inc.upkeep ? ` Army upkeep costs <b style="color:var(--danger)">${inc.upkeep}</b> of ${inc.gross}.` : ''}</p>
        <div class="section-title">Victory</div>
        <p>Capitals held: <b>${capsHeld}/${capitals.length}</b></p>
        <div class="progress"><b style="width:${capsHeld / capitals.length * 100}%"></b></div>
        <p>Cities held: <b>${mine.length}/${need}</b> needed for domination</p>
        <div class="progress"><b style="width:${Math.min(100, mine.length / need * 100)}%"></b></div>
        <div class="section-title">Regions</div>
        <div class="region-list">${Object.entries(WG.REGIONS).map(([k, r]) => {
          const mineN = rc[k].byFaction[S.human] || 0;
          const held = mineN === rc[k].count;
          return `<span class="${held ? 'held' : ''}">${esc(r.name)} <small style="color:var(--muted)">+${r.bonus}</small></span><span class="${held ? 'held' : ''}">${mineN}/${rc[k].count}</span>`;
        }).join('')}</div>
        <div class="section-title">Orders</div>
        <p>${ready ? `${ready} unit${ready > 1 ? 's' : ''} awaiting orders — press <kbd>N</kbd>.` : 'All units have orders.'} Click one of your cities to build.</p>
      </div>`;
  }

  // ------------------------------------------------------------ tooltip
  function updateTooltip(sx, sy) {
    const tip = $('tooltip');
    const i = S.hover;
    if (i < 0 || !G() || dragging) { tip.classList.add('hidden'); return; }
    const c = Gm.cityAt(i);
    const su = Gm.surfAt(i), au = Gm.airAt(i);
    const T = WG.TERRAIN[Gm.terr[i]];
    let html = '';
    if (c) html += `<h5 style="color:${fcolor(c.owner)}">${esc(c.name)}</h5><div class="muted">${esc(fname(c.owner))} · +${R.cityIncome[c.size]}${c.capitalOf >= 0 ? ' · Capital' : ''}</div>`;
    else html += `<h5>${T.name}</h5>${T.water ? '' : `<div class="muted">Defence +${Math.round(T.def * 100)}% · Move ${T.cost ? T.cost.foot + '/' + T.cost.tread : '—'}</div>`}`;
    for (const u of [su, au]) {
      if (u && Gm.canSee(S.V, u)) html += `<div><span style="color:${fcolor(u.owner)}">■</span> ${U[u.type].name} <span class="muted">${u.hp}/10${u.embarked ? ' · embarked' : ''}</span></div>`;
    }
    if (S.sel && S.attack && S.attack.has(i)) {
      const a = S.attack.get(i);
      const fc = Gm.forecast(S.sel, a.target, a.from);
      html += `<div class="fc"><span>Damage dealt</span><span class="deal">${fc.dmgLo}–${fc.dmgHi}${fc.killChance > 0.02 ? ` (${Math.round(fc.killChance * 100)}% kill)` : ''}</span>
        <span>Counter-attack</span><span class="take">${fc.counter ? '~' + fc.counter.toFixed(1) : 'none'}</span>
        ${fc.cover ? `<span>AA cover fire</span><span class="take">~${fc.coverDmg.toFixed(1)}</span>` : ''}</div>`;
    } else if (S.sel && S.reach && S.reach.has(i) && S.reach.get(i).stop && i !== S.sel.i) {
      const node = S.reach.get(i);
      html += `<div class="fc"><span>Move cost</span><span>${node.c}</span></div>`;
    } else if (S.mode === 'missile' && S.selCity) {
      html += `<div class="fc"><span>Distance</span><span>${Hx.dist(S.selCity.i, i)} / ${R.missileRange}</span></div>`;
    }
    tip.innerHTML = html;
    tip.classList.remove('hidden');
    const w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = Math.min(window.innerWidth - w - 8, sx + 16) + 'px';
    tip.style.top = Math.min(window.innerHeight - h - 8, sy + 16) + 'px';
  }

  // ------------------------------------------------------------ banner/toasts
  let bannerTimer = 0;
  function banner(title, sub, color, short) {
    const b = $('banner');
    b.style.setProperty('--fc', color || '#6ee7ff');
    b.querySelector('.b-title').textContent = title;
    b.querySelector('.b-sub').textContent = sub || '';
    b.classList.remove('show');
    void b.offsetWidth;
    b.style.animationDuration = short ? '1.1s' : '1.6s';
    b.classList.add('show');
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => b.classList.remove('show'), short ? 1100 : 1600);
  }
  function toast(msg, kind, color) {
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    if (color) el.style.setProperty('--fc', color);
    el.textContent = msg;
    const box = $('toasts');
    box.appendChild(el);
    while (box.children.length > 4) box.firstChild.remove();
    setTimeout(() => el.remove(), 3300);
  }

  // ------------------------------------------------------------ game events
  Gm.on(ev => {
    const g = G();
    if (!g) return;
    if (ev.type === 'log') renderLog();
    if (ev.type === 'capture') {
      if (ev.city.owner === S.human) { A.capture(); toast(`${ev.city.name} captured!`, null, fcolor(S.human)); }
      else if (ev.prev === S.human) { A.alarm(); toast(`${ev.city.name} has fallen to ${fname(ev.city.owner)}!`, 'alert'); }
      Rn.invalidate();
    }
    if (ev.type === 'eliminated') toast(`${g.factions[ev.f].name} has been eliminated`, ev.f === S.human ? 'alert' : null, g.factions[ev.f].color);
  });

  function showEnd() {
    const g = G();
    const won = g.winner >= 0 && g.winner === S.human;
    $('end-title').textContent = S.human < 0 ? 'War over' : won ? 'Victory' : 'Defeat';
    $('end-title').style.color = won ? 'var(--good)' : S.human < 0 ? 'var(--accent)' : 'var(--danger)';
    $('end-text').textContent = g.winner >= 0
      ? (won ? `Turn ${g.turn}: the world answers to the ${g.factions[g.winner].name}.` : `Turn ${g.turn}: the ${g.factions[g.winner].name} has conquered the world.`)
      : `Turn ${g.turn}: your last city has fallen. The ${g.factions[S.human].name} is no more.`;
    const rows = g.order.map(f => ({ f: g.factions[f], c: Gm.citiesOf(f).length, u: Gm.unitsOf(f).length })).sort((a, b) => b.c - a.c);
    $('end-stats').innerHTML = '<span class="h">Power</span><span class="h">Cities</span><span class="h">Units</span>' +
      rows.map(r => `<span style="color:${r.f.color}">${esc(r.f.name)}</span><span>${r.c}</span><span>${r.u}</span>`).join('');
    $('end-modal').classList.remove('hidden');
    try { localStorage.removeItem(SAVE_KEY); } catch (e) { /* ignore */ }
    updateHUD();
  }

  // ------------------------------------------------------------ save/load
  function save(silent) {
    if (!G() || G().over) return;
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify({ when: Date.now(), speed: S.aiSpeed, data: Gm.serialize() }));
      if (!silent) toast('Game saved');
    } catch (e) { if (!silent) toast('Could not save: storage unavailable', 'alert'); }
  }
  function autosave() { save(true); }
  function savedGame() {
    try { const s = localStorage.getItem(SAVE_KEY); return s ? JSON.parse(s) : null; } catch (e) { return null; }
  }
  function loadGame() {
    const s = savedGame();
    if (!s) { toast('No saved game found', 'alert'); return; }
    try {
      S.gen++;
      Gm.load(s.data);
      S.aiSpeed = s.speed || 'normal';
      startUI();
      toast('Game loaded');
    } catch (e) { toast('Saved game is corrupt', 'alert'); }
  }

  // ------------------------------------------------------------ start screen
  const setup = { human: 0, active: WG.FACTIONS.map(() => true), difficulty: 'normal', fog: true, speed: 'normal' };
  function renderStart() {
    const grid = $('faction-grid');
    grid.innerHTML = WG.FACTIONS.map((f, i) => `
      <button class="fcard${setup.human === i ? ' sel' : ''}${setup.active[i] ? '' : ' off'}" data-f="${i}" style="--fc:${f.color}">
        <span class="you">YOU</span>
        <span class="fn">${f.name}</span><span class="fcap">Capital: ${f.capital}</span>
        <span class="fd">${FACTION_BLURB[i]}</span>
        <label class="incl"><input type="checkbox" data-incl="${i}" ${setup.active[i] ? 'checked' : ''}> in the war</label>
      </button>`).join('') + `
      <button class="fcard${setup.human === -1 ? ' sel' : ''}" data-f="-1" style="--fc:#6ee7ff">
        <span class="you">WATCH</span>
        <span class="fn">Observer</span><span class="fcap">No faction</span>
        <span class="fd">Sit back and watch the computer powers fight for the world.</span>
      </button>`;
    grid.querySelectorAll('[data-f]').forEach(b => b.onclick = e => {
      if (e.target.closest('.incl')) return;
      setup.human = +b.dataset.f;
      if (setup.human >= 0) setup.active[setup.human] = true;
      A.click();
      renderStart();
    });
    grid.querySelectorAll('[data-incl]').forEach(cb => cb.onchange = () => { setup.active[+cb.dataset.incl] = cb.checked; renderStart(); });
    $('btn-continue').classList.toggle('hidden', !savedGame());
  }
  function seg(id, key, map) {
    $(id).querySelectorAll('button').forEach(b => b.onclick = () => {
      $(id).querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      setup[key] = map ? map(b.dataset.v) : b.dataset.v;
    });
  }

  function startNewGame() {
    const active = setup.active.slice();
    if (active.filter(Boolean).length < 2) { toast('Pick at least two powers', 'alert'); return; }
    S.gen++;
    Gm.newGame({ human: setup.human, active, difficulty: setup.difficulty, fog: setup.human >= 0 && setup.fog });
    S.aiSpeed = setup.human < 0 && setup.speed === 'normal' ? 'fast' : setup.speed;
    startUI();
  }

  function startUI() {
    const g = G();
    S.human = g.settings.human;
    S.sel = S.selCity = null; S.mode = null; S.reach = S.attack = null; S.busy = false; S.paused = false;
    Rn.factionStyles();
    refreshVis();
    $('start-modal').classList.add('hidden');
    $('end-modal').classList.add('hidden');
    document.body.classList.remove('menu-open');
    $('speed-label').textContent = { normal: 'Normal', fast: 'Fast', instant: 'Instant' }[S.aiSpeed];
    const home = S.human >= 0 ? g.cities[g.factions[S.human].capital] : g.cities.find(c => c.name === 'Cairo');
    Rn.setZoom(S.human >= 0 ? 1 : 0.6);
    Rn.centerOn(home.i);
    updateHUD();
    renderPanel();
    renderLog();
    syncView();
    if (g.over) { showEnd(); return; }
    const f = g.order[g.cur];
    if (g.factions[f].ai) runAI();
    else beginHumanTurn();
  }

  // ------------------------------------------------------------ input
  let down = null, dragging = false;
  const pointers = new Map();
  let pinchDist = 0;
  function bindInput() {
    const cv = $('map');
    cv.addEventListener('contextmenu', e => e.preventDefault());
    cv.addEventListener('pointerdown', e => {
      cv.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, [e.clientX, e.clientY]);
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinchDist = Math.hypot(a[0] - b[0], a[1] - b[1]);
        down = null;
        return;
      }
      down = { x: e.clientX, y: e.clientY, button: e.button };
      dragging = false;
    });
    cv.addEventListener('pointermove', e => {
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, [e.clientX, e.clientY]);
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        if (pinchDist) Rn.setZoom(Rn.zoom * d / pinchDist, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
        pinchDist = d;
        return;
      }
      if (down) {
        const dx = e.clientX - down.x, dy = e.clientY - down.y;
        if (!dragging && Math.hypot(dx, dy) > 6) { dragging = true; cv.style.cursor = 'grabbing'; }
        if (dragging) { Rn.pan(-dx, -dy); down.x = e.clientX; down.y = e.clientY; }
      }
      const i = Rn.tileAtScreen(e.clientX, e.clientY);
      if (i !== S.hover) { S.hover = i; syncView(); }
      updateTooltip(e.clientX, e.clientY);
    });
    const end = e => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinchDist = 0;
      if (!down) return;
      const wasDrag = dragging;
      const btn = down.button;
      down = null; dragging = false; cv.style.cursor = 'default';
      if (wasDrag || e.type === 'pointercancel') return;
      if (btn === 2) { cancel(); return; }
      if (btn === 0) onTileClick(Rn.tileAtScreen(e.clientX, e.clientY));
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('pointerleave', () => { S.hover = -1; syncView(); $('tooltip').classList.add('hidden'); });
    cv.addEventListener('wheel', e => {
      e.preventDefault();
      Rn.setZoom(Rn.zoom * Math.pow(1.0015, -e.deltaY), e.clientX, e.clientY);
      S.hover = Rn.tileAtScreen(e.clientX, e.clientY);
      syncView();
    }, { passive: false });

    const mm = $('minimap');
    let mmDown = false;
    const mmGo = e => { const r = mm.getBoundingClientRect(); Rn.miniClick(e.clientX - r.left, e.clientY - r.top); };
    mm.addEventListener('pointerdown', e => { mmDown = true; mm.setPointerCapture(e.pointerId); mmGo(e); });
    mm.addEventListener('pointermove', e => { if (mmDown) mmGo(e); });
    mm.addEventListener('pointerup', () => { mmDown = false; });

    $('zoom-in').onclick = () => Rn.setZoom(Rn.zoom * 1.25);
    $('zoom-out').onclick = () => Rn.setZoom(Rn.zoom / 1.25);
    $('btn-end').onclick = () => {
      A.unlock();
      if (S.human < 0) { S.paused = !S.paused; updateHUD(); return; }
      endTurn();
    };
    $('btn-next').onclick = nextUnit;
    $('btn-menu').onclick = e => { e.stopPropagation(); $('menu').classList.toggle('hidden'); };
    document.addEventListener('click', e => { if (!e.target.closest('#menu') && !e.target.closest('#btn-menu')) $('menu').classList.add('hidden'); });
    $('menu').querySelectorAll('[data-menu]').forEach(b => b.onclick = () => {
      const m = b.dataset.menu;
      $('menu').classList.add('hidden');
      if (m === 'save') save(false);
      if (m === 'load') loadGame();
      if (m === 'help') $('help-modal').classList.remove('hidden');
      if (m === 'new') showStart();
      if (m === 'sound') $('sound-label').textContent = A.toggle() ? 'Off' : 'On';
      if (m === 'speed') {
        S.aiSpeed = { normal: 'fast', fast: 'instant', instant: 'normal' }[S.aiSpeed];
        $('speed-label').textContent = { normal: 'Normal', fast: 'Fast', instant: 'Instant' }[S.aiSpeed];
      }
    });
    $('sound-label').textContent = A.muted ? 'Off' : 'On';
    document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => b.closest('.modal').classList.add('hidden'));
    $('btn-help2').onclick = () => $('help-modal').classList.remove('hidden');
    $('btn-start').onclick = () => { A.unlock(); startNewGame(); };
    $('btn-continue').onclick = () => { A.unlock(); loadGame(); };
    $('btn-again').onclick = () => { $('end-modal').classList.add('hidden'); showStart(); };
    seg('opt-diff', 'difficulty');
    seg('opt-fog', 'fog', v => v === 'on');
    seg('opt-speed', 'speed');

    const held = new Set();
    window.addEventListener('keydown', e => {
      if (e.target.tagName === 'INPUT') return;
      if (!$('start-modal').classList.contains('hidden')) return;
      const k = e.key.toLowerCase();
      if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'w', 'a', 'd'].includes(k) || (k === 's' && !S.sel)) { held.add(k); e.preventDefault(); return; }
      if (k === 'escape') { cancel(); document.querySelectorAll('.modal:not(#start-modal)').forEach(m => m.classList.add('hidden')); }
      else if (k === 'e') endTurn();
      else if (k === 'n' || k === 'tab') { e.preventDefault(); nextUnit(); }
      else if (k === 's' && S.sel && S.sel.owner === S.human && isHumanTurn()) { S.sel.done = true; nextUnit(); updateHUD(); }
      else if (k === 'c' && S.human >= 0) { const cap = Gm.citiesOf(S.human).find(c => c.capitalOf === S.human) || Gm.citiesOf(S.human)[0]; if (cap) Rn.centerOn(cap.i); }
      else if (k === ' ') { e.preventDefault(); if (S.sel) Rn.centerOn(S.sel.i); else if (S.selCity) Rn.centerOn(S.selCity.i); }
      else if (k === '+' || k === '=') Rn.setZoom(Rn.zoom * 1.2);
      else if (k === '-' || k === '_') Rn.setZoom(Rn.zoom / 1.2);
      else if (k === 'h' || k === '?') $('help-modal').classList.toggle('hidden');
      else if (k === 'm' && S.selCity && S.selCity.owner === S.human && S.selCity.missiles > 0 && !S.selCity.launched && isHumanTurn()) { S.mode = S.mode === 'missile' ? null : 'missile'; syncView(); renderPanel(); }
    });
    window.addEventListener('keyup', e => held.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => held.clear());
    let last = performance.now();
    const panLoop = now => {
      const dt = Math.min(50, now - last); last = now;
      if (held.size) {
        const sp = 0.7 * dt;
        let dx = 0, dy = 0;
        if (held.has('arrowleft') || held.has('a')) dx -= sp;
        if (held.has('arrowright') || held.has('d')) dx += sp;
        if (held.has('arrowup') || held.has('w')) dy -= sp;
        if (held.has('arrowdown') || held.has('s')) dy += sp;
        if (dx || dy) Rn.pan(dx, dy);
      }
      requestAnimationFrame(panLoop);
    };
    requestAnimationFrame(panLoop);
  }
  function showStart() {
    S.gen++;
    S.busy = false;
    clearSel();
    renderStart();
    $('start-modal').classList.remove('hidden');
    document.body.classList.add('menu-open');
  }
  function cancel() {
    if (S.mode) { S.mode = null; syncView(); renderPanel(); return; }
    clearSel();
  }

  // ------------------------------------------------------------ boot
  function boot() {
    Rn.init($('map'), $('minimap'));
    bindInput();
    // Show the world behind the start screen.
    Gm.newGame({ human: -1, active: WG.FACTIONS.map(() => true), difficulty: 'normal', fog: false });
    Rn.factionStyles();
    refreshVis();
    Rn.setZoom(0.55);
    Rn.centerOn(Gm.G.cities.find(c => c.name === 'Cairo').i);
    showStart();
    renderPanel();
    updateHUD();
    if (/[?&]autostart/.test(location.search)) startNewGame();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  return { S, startNewGame, endTurn, setup, get busy() { return S.busy; } };
})();
