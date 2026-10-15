#!/usr/bin/env node
/* End-to-end UI test for SALT & SIGNAL.
 *
 * 1. solo: loads index.html from file://, plays a full 2-player match to a
 *    decided winner by driving real DOM clicks on legal cells, and asserts the
 *    board/log/score DOM agrees with the engine.
 * 2. controls: action switching, replay scrubbing, rules dialog, illegal clicks
 *    being rejected.
 * 3. live relay: hosts an online match, and a real agent seat plays it over the
 *    documented HTTP/JSON API (ntfy.sh), proving an agent can join and move.
 *
 * Run: node test/test_ui.js
 */
'use strict';
const path = require('path');
const PW = require(path.join('/home/nicolas/.hermes/node/lib/node_modules/playwright'));
const URL_FILE = 'file://' + path.join(__dirname, '..', 'index.html');
const RELAY = 'https://ntfy.sh';

let fails = [];
function check(cond, msg) { if (!cond) { fails.push(msg); console.log('  FAIL ' + msg); } else { console.log('  ok   ' + msg); } }

async function soloGame(browser) {
  console.log('\n== 1. solo match driven through real DOM clicks ==');
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(URL_FILE);
  await page.waitForFunction(() => window.SaltApp && window.SaltApp.state);

  // force a clean deterministic solo match, seat 0 of 2
  await page.evaluate(() => {
    const A = window.SaltApp;
    A.mode = 'local'; A.players = 2; A.mySeat = 0; A.seed = 12345;
    A.moves = []; A.scrub = null; A.agentSeats = [];
    A.state = window.SaltSignal.newGame(12345, 2);
    window.SaltApp.render();
  });
  await page.waitForTimeout(200);

  check(errors.length === 0, 'no page errors on load');
  const cells = await page.$$eval('.cell', (n) => n.length);
  check(cells === 25, '25 board cells rendered');

  // play until the match ends, always clicking a legal cell for the chosen action
  let guard = 0, humanTurns = 0;
  while (guard++ < 80) {
    const st = await page.evaluate(() => {
      const A = window.SaltApp, s = A.state;
      return { over: s.over, turn: s.turn, mine: s.turn === A.mySeat, turnsTaken: s.turnsTaken,
        legal: window.SaltSignal.legal(s, s.turn) };
    });
    if (st.over) break;
    if (st.mine) {
      // cycle claim -> fortify -> raid so the run exercises every action type
      const order = ['claim', 'fortify', 'raid'];
      let act = null, cell = -1;
      for (let k = 0; k < 3; k++) {
        const a = order[(humanTurns + k) % 3];
        if (st.legal[a].length) { act = a; cell = st.legal[a][0]; break; }
      }
      if (!act) { await page.evaluate(() => { const A = window.SaltApp; window.SaltSignal.apply(A.state, 'rest', 0); A.moves.push({ action: 'rest', cell: -1, player: A.state.turn }); A.afterMove(); }); continue; }
      await page.click('#actions button[data-act="' + act + '"]');
      const sel = '.cell[data-cell="' + cell + '"].legal';
      const n = await page.$$eval(sel, (e) => e.length);
      check(n === 1, 'action ' + act + ' marks exactly its legal targets (turn ' + st.turnsTaken + ')');
      await page.click(sel);
      humanTurns++;
      await page.waitForTimeout(520); // let bots reply
    } else {
      await page.waitForTimeout(520);
    }
  }
  const fin = await page.evaluate(() => {
    const s = window.SaltApp.state;
    return { over: s.over, winner: s.winner, scores: s.scores, turnsTaken: s.turnsTaken,
      logLen: window.SaltApp.moves.length,
      domScores: Array.from(document.querySelectorAll('.score .v')).map((e) => +e.textContent),
      domLog: document.querySelectorAll('#log div').length,
      banner: document.getElementById('turntext').textContent };
  });
  check(fin.over === true, 'match reached a decided end state');
  check(fin.turnsTaken === 16, 'exactly 16 actions consumed (8 per player), got ' + fin.turnsTaken);
  check(fin.winner != null && fin.winner >= 0, 'a winner was declared (seat ' + fin.winner + ')');
  check(JSON.stringify(fin.domScores) === JSON.stringify(fin.scores), 'DOM scores match engine scores ' + JSON.stringify(fin.scores));
  check(fin.domLog === fin.logLen, 'DOM log rows match recorded moves (' + fin.logLen + ')');
  check(/wins|You win/.test(fin.banner), 'banner announces the result: "' + fin.banner + '"');
  const distinctPlayers = await page.evaluate(() => new Set(window.SaltApp.moves.map((m) => m.player)).size);
  check(distinctPlayers === 2, 'both seats actually moved');
  const actionsUsed = await page.evaluate(() => Array.from(new Set(window.SaltApp.moves.map((m) => m.action))).sort());
  check(actionsUsed.length >= 2, 'multiple action types exercised: ' + actionsUsed.join(','));

  // replay scrubber must reproduce the past, not mutate the live game
  await page.click('#repFirst');
  const scrubbed = await page.evaluate(() => ({ scrub: window.SaltApp.scrub, domLog: document.querySelectorAll('#log div').length, live: window.SaltApp.state.turnsTaken }));
  check(scrubbed.scrub === 0 && scrubbed.domLog === 0, 'replay scrubbed to start (0 log rows)');
  check(scrubbed.live === fin.turnsTaken, 'scrubbing did not mutate the live game');
  await page.click('#repLive');
  const back = await page.evaluate(() => ({ scrub: window.SaltApp.scrub, domLog: document.querySelectorAll('#log div').length }));
  check(back.scrub === null && back.domLog === fin.logLen, 'returned to live view');

  // illegal click must be rejected: click a cell that is not legal for the action
  await page.evaluate(() => {
    const A = window.SaltApp;
    A.seed = 999; A.players = 2; A.mySeat = 0; A.moves = []; A.scrub = null;
    A.state = window.SaltSignal.newGame(999, 2); A.render();
  });
  await page.evaluate(() => { window.SaltApp.action = 'raid'; window.SaltApp.render(); });
  const raidLegal = await page.$$eval('.cell.legal', (e) => e.length);
  check(raidLegal === 0, 'no legal raid on turn 1 (nothing to raid yet)');
  const disabled = await page.$eval('#actRaid', (b) => b.disabled);
  check(disabled === true, 'Raid button is disabled when it has no legal target');
  await page.evaluate(() => { window.SaltApp.action = 'claim'; window.SaltApp.render(); });
  await page.evaluate(() => { const c = document.querySelector('.cell[data-cell="7"]'); if (c) c.click(); });
  const untouched = await page.evaluate(() => ({ t: window.SaltApp.state.turnsTaken, owner: window.SaltApp.state.owner[7] }));
  check(untouched.t === 0 && untouched.owner === -1, 'clicking an illegal cell changed nothing');

  // rules dialog present and openable
  await page.click('#btnRules');
  const dlgOpen = await page.$eval('#dlgRules', (d) => d.open);
  const rulesLen = await page.$eval('#rulesP', (p) => p.textContent.length);
  check(dlgOpen === true && rulesLen > 200, 'rules dialog opens with the full rules paragraph');
  await page.click('#dlgOk');

  await page.screenshot({ path: path.join(__dirname, 'shot-solo.png'), fullPage: true });
  await page.close();
  return null;
}

async function onlineWithAgent(browser) {
  console.log('\n== 2. live online match with a REAL agent seat (ntfy relay) ==');
  const code = 'T' + Math.random().toString(36).slice(2, 6).toUpperCase();
  const topic = 'saltsignal-' + code;
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(URL_FILE + '#code=' + code + '&seat=0&players=2');
  await page.waitForFunction((c) => window.SaltApp && window.SaltApp.code === c, code);
  await page.waitForTimeout(600);
  const st0 = await page.evaluate(() => ({ code: window.SaltApp.code, mode: window.SaltApp.mode, seat: window.SaltApp.mySeat, seed: window.SaltApp.seed }));
  check(st0.mode === 'online' && st0.code === code, 'hosted online match ' + st0.code + ' (deep link)');
  check(st0.seed > 0, 'match code derives a deterministic seed (' + st0.seed + ')');

  // agent joins seat 1 by announcing itself on the relay (the documented API)
  const hello = await fetch(RELAY + '/' + topic, { method: 'POST', body: JSON.stringify({ v: 1, code, kind: 'hello', by: 1, at: Date.now() }) });
  check(hello.ok, 'agent announced itself on the relay (HTTP ' + hello.status + ')');
  await page.waitForTimeout(11500);   // allow two 5.2s poll cycles to see the hello
  const claimed = await page.evaluate(() => window.SaltApp.agentSeats.slice());
  check(claimed.indexOf(1) !== -1, 'browser recognised seat 1 as an agent seat');

  // the browser plays its own turn, then poll the API and let the agent reply
  let agentMoves = 0, guard = 0;
  while (guard++ < 40) {
    const s = await page.evaluate(() => { const A = window.SaltApp, g = A.state; return { over: g.over, turn: g.turn, mine: g.turn === A.mySeat, legal: window.SaltSignal.legal(g, g.turn) }; });
    if (s.over) break;
    if (s.mine) {
      let act = null, cell = -1;
      for (const a of ['claim', 'fortify', 'raid']) if (s.legal[a].length) { act = a; cell = s.legal[a][0]; break; }
      await page.click('#actions button[data-act="' + act + '"]');
      await page.click('.cell[data-cell="' + cell + '"].legal');
      await page.waitForTimeout(5600);   // relay needs ~1 req/5s pacing
    } else {
      // AGENT ROLE: read the move stream via the HTTP/JSON API, reconstruct the
      // shared board, then post a legal move. The documented algorithm is a greedy
      // turn-ordered replay of ALL moves (the relay can reorder same-second posts).
      await new Promise((res) => setTimeout(res, 5300));   // respect relay rate limit
      const r = await fetch(RELAY + '/' + topic + '/json?poll=1&since=all');
      const lines = (await r.text()).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
      const msgs = lines.filter((j) => j.event === 'message')
        .map((j) => { try { return Object.assign(JSON.parse(j.message), { _t: j.time }); } catch (e) { return null; } })
        .filter(Boolean).sort((a, b) => a._t - b._t);
      const seed = await page.evaluate(() => window.SaltApp.seed);
      const replay = await page.evaluate(([sd, mv]) => {
        // greedy turn-ordered application
        const st = window.SaltSignal.newGame(sd, 2);
        const pool = mv.slice(); let guard = 0;
        while (guard++ < 200) {
          const i = pool.findIndex((m) => m.player === st.turn);
          if (i === -1) break;
          const m = pool.splice(i, 1)[0];
          try { window.SaltSignal.apply(st, m.action, m.cell); } catch (e) {}
        }
        return { turn: st.turn, over: st.over, legal: window.SaltSignal.legal(st, st.turn), turnsTaken: st.turnsTaken };
      }, [seed, msgs.filter((m) => m.action).map((m) => ({ player: m.player, action: m.action, cell: m.cell }))]);
      if (replay.over || replay.turn !== 1) { await page.waitForTimeout(600); continue; }
      const l = replay.legal;
      if (!l.claim.length && !l.fortify.length && !l.raid.length) { await page.waitForTimeout(600); continue; }
      const pick = l.claim.length ? ['claim', l.claim[0]] : l.fortify.length ? ['fortify', l.fortify[0]] : ['raid', l.raid[0]];
      const post = await fetch(RELAY + '/' + topic, { method: 'POST', body: JSON.stringify({ v: 1, code, player: 1, action: pick[0], cell: pick[1], at: Date.now() }) });
      check(post.ok, 'agent posted move ' + pick.join(' ') + ' (HTTP ' + post.status + ')');
      agentMoves++;
      await page.waitForTimeout(5600);   // 1 req/5s + margin
    }
  }
  const fin = await page.evaluate(() => {
    const s = window.SaltApp.state;
    return { over: s.over, turnsTaken: s.turnsTaken, winner: s.winner, scores: s.scores,
      byPlayer: window.SaltApp.moves.reduce((a, m) => { a[m.player] = (a[m.player] || 0) + 1; return a; }, {}),
      domScores: Array.from(document.querySelectorAll('.score .v')).map((e) => +e.textContent),
      actions: Array.from(new Set(window.SaltApp.moves.map((m) => m.action))).sort() };
  });
  check(agentMoves > 0, 'agent seat actually moved in a live relay match (' + agentMoves + ' moves)');
  check((fin.byPlayer[1] || 0) > 0, 'agent moves were accepted into the shared match state');
  check(fin.over === true, 'live relay match reached a decided end');
  check(JSON.stringify(fin.domScores) === JSON.stringify(fin.scores), 'live match DOM scores match engine');
  check(errors.length === 0, 'no page errors during the live match');
  console.log('  info  live match: moves by seat ' + JSON.stringify(fin.byPlayer) + ' actions ' + fin.actions.join(','));
  await page.screenshot({ path: path.join(__dirname, 'shot-online.png'), fullPage: true });
  await page.close();
}

(async () => {
  const EXE = process.env.PW_CHROME || '/home/nicolas/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
  const browser = await PW.chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    await soloGame(browser);
    await onlineWithAgent(browser);
  } catch (e) {
    fails.push('exception: ' + (e && e.stack ? e.stack : e));
    console.log('EXCEPTION ' + e);
  } finally {
    await browser.close();
  }
  console.log('\n' + (fails.length ? 'FAIL: ' + fails.length + ' assertion(s)' : 'PASS: all UI assertions'));
  process.exit(fails.length ? 1 : 0);
})();
