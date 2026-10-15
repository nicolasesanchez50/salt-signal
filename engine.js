/* SALT & SIGNAL — rules engine (browser/JS).
 * Byte-compatible port of engine.py. Both are validated against test/fixtures.json.
 * Rules: on a 5x5 salt chart each cell holds 1-3 salt; each player starts owning
 * one harbour corner. On your turn take exactly ONE action: CLAIM an unowned cell
 * orthogonally adjacent to your territory, FORTIFY one of your own cells (+2 salt,
 * once per cell), or RAID an enemy cell adjacent to your territory (-2 salt, floor
 * 1). Every cell gets 8 turns; highest total salt (own cells + plunder) wins.
 */
(function (root) {
  'use strict';
  const W = 5, H = 5, CELLS = 25;
  const TURNS_PER_PLAYER = 8, FORTIFY_GAIN = 2, RAID_LOSS = 2, RAID_PLUNDER = 0;
  const HARBORS = { 2: [0, 24], 3: [0, 4, 24], 4: [0, 4, 20, 24] };

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), 1 | t) >>> 0;
      t = (t + (Math.imul(t ^ (t >>> 7), 61 | t) >>> 0)) >>> 0;
      t = (t ^ (t >>> 14)) >>> 0;
      return t / 4294967296;
    };
  }

  function neighbors(i) {
    const x = i % W, y = Math.floor(i / W), out = [];
    if (x > 0) out.push(i - 1);
    if (x < W - 1) out.push(i + 1);
    if (y > 0) out.push(i - W);
    if (y < H - 1) out.push(i + W);
    return out;
  }

  function newGame(seed, n) {
    if (n !== 2 && n !== 3 && n !== 4) throw new Error('players must be 2-4');
    const rng = mulberry32(seed);
    const salt = [];
    for (let i = 0; i < CELLS; i++) {
      const r = rng();
      salt.push(r < 0.15 ? 3 : r < 0.5 ? 2 : 1);
    }
    const owner = new Array(CELLS).fill(-1);
    HARBORS[n].forEach((c, p) => { owner[c] = p; });
    return {
      seed, n, salt, owner,
      fortified: new Array(CELLS).fill(false),
      plunder: new Array(n).fill(0),
      turn: 0, turnsTaken: 0, turnsPerPlayer: TURNS_PER_PLAYER,
      over: false, winner: null, log: [],
    };
  }

  function territory(s, p) {
    const out = [];
    for (let i = 0; i < CELLS; i++) if (s.owner[i] === p) out.push(i);
    return out;
  }

  function isAdjacentTo(s, p, i) {
    return neighbors(i).some((j) => s.owner[j] === p);
  }

  function legal(s, p) {
    if (p === undefined || p === null) p = s.turn;
    if (s.over) return { claim: [], fortify: [], raid: [], rest: false };
    const claim = [], fortify = [], raid = [];
    for (let i = 0; i < CELLS; i++) {
      if (s.owner[i] === -1 && isAdjacentTo(s, p, i)) claim.push(i);
      if (s.owner[i] === p && !s.fortified[i]) fortify.push(i);
      if (s.owner[i] !== -1 && s.owner[i] !== p && isAdjacentTo(s, p, i)) raid.push(i);
    }
    // Guard against a dead end: if nothing else is possible you may rest.
    const rest = !(claim.length || fortify.length || raid.length);
    return { claim, fortify, raid, rest };
  }

  function apply(s, action, cell) {
    if (s.over) throw new Error('game over');
    const p = s.turn, lg = legal(s);
    if (action === 'claim') {
      if (lg.claim.indexOf(cell) === -1) throw new Error('illegal claim');
      s.owner[cell] = p;
    } else if (action === 'fortify') {
      if (lg.fortify.indexOf(cell) === -1) throw new Error('illegal fortify');
      s.salt[cell] += FORTIFY_GAIN;
      s.fortified[cell] = true;
    } else if (action === 'raid') {
      if (lg.raid.indexOf(cell) === -1) throw new Error('illegal raid');
      const before = s.salt[cell];
      s.salt[cell] = Math.max(1, before - RAID_LOSS);
      s.plunder[p] += Math.min(RAID_LOSS, before - s.salt[cell]);
    } else if (action === 'rest') {
      if (!lg.rest) throw new Error('illegal rest');
    } else {
      throw new Error('unknown action');
    }
    s.log.push({ turn: s.turnsTaken, player: p, action, cell });
    s.turnsTaken += 1;
    const total = s.turnsPerPlayer * s.n;
    if (s.turnsTaken >= total) finish(s);
    else s.turn = (s.turn + 1) % s.n;
    return s;
  }

  function score(s, p) {
    let t = s.plunder[p];
    for (let i = 0; i < CELLS; i++) if (s.owner[i] === p) t += s.salt[i];
    return t;
  }

  function finish(s) {
    s.over = true;
    const n = s.n;
    const sc = [], cells = [];
    for (let p = 0; p < n; p++) { sc.push(score(s, p)); cells.push(territory(s, p).length); }
    let best = 0;
    for (let p = 1; p < n; p++) {
      if (sc[p] > sc[best] || (sc[p] === sc[best] && cells[p] > cells[best])) best = p;
    }
    s.scores = sc;
    s.winner = best;
  }

  /* --- wire format (shared by the browser client and the agent API) ------- */

  // Rebuild a game from {seed, players, moves:[{player,action,cell}...]}.
  // Moves that are not legal at their point in the sequence are skipped, so a
  // corrupted/injected message cannot desync the match.
  function replay(seed, n, moves) {
    const s = newGame(seed, n);
    const accepted = [];
    for (const m of moves || []) {
      if (s.over) break;
      try {
        apply(s, m.action, m.cell);
        accepted.push({ player: m.player, action: m.action, cell: m.cell });
      } catch (e) { /* ignore illegal move */ }
    }
    return { state: s, accepted };
  }

  const ENG = {
    W, H, CELLS, TURNS_PER_PLAYER, FORTIFY_GAIN, RAID_LOSS, HARBORS,
    mulberry32, neighbors, newGame, territory, isAdjacentTo, legal, apply,
    score, finish, replay,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = ENG;
  root.SaltSignal = ENG;
})(typeof globalThis !== 'undefined' ? globalThis : this);
