#!/usr/bin/env node
/* Verify the PUBLIC deployed URL end-to-end (what the requester will test):
 *   - page loads with no console/page errors
 *   - a solo match is playable via DOM clicks and reaches a winner
 *   - a relay match can be hosted from the public URL and an agent joins it
 * Usage: node test/test_live_url.js [baseUrl]
 */
'use strict';
const path = require('path');
const PW = require(path.join('/home/nicolas/.hermes/node/lib/node_modules/playwright'));
const EXE = process.env.PW_CHROME || '/home/nicolas/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const BASE = process.argv[2] || 'https://nicolasesanchez50.github.io/salt-signal/';
const RELAY = 'https://ntfy.sh';

let fails = [];
const check = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails.push(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await PW.chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    console.log('\n== live URL solo play: ' + BASE + ' ==');
    let page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    page.on('requestfailed', (r) => { if (!/favicon/.test(r.url())) errors.push('reqfail ' + r.url()); });
    const resp = await page.goto(BASE, { waitUntil: 'load' });
    check(resp && resp.status() === 200, 'page responds 200');
    await page.waitForFunction(() => window.SaltApp && window.SaltApp.state);
    check(errors.length === 0, 'no load errors (' + errors.join('; ') + ')');
    check((await page.$$eval('.cell', (n) => n.length)) === 25, '25-cell board rendered on the live URL');

    let guard = 0;
    while (guard++ < 80) {
      const s = await page.evaluate(() => { const A = window.SaltApp, g = A.state; return { over: g.over, mine: g.turn === A.mySeat, legal: window.SaltSignal.legal(g, g.turn) }; });
      if (s.over) break;
      if (s.mine) {
        let act = 'claim', cell = -1;
        for (const a of ['claim', 'fortify', 'raid']) if (s.legal[a].length) { act = a; cell = s.legal[a][0]; break; }
        await page.click('#actions button[data-act="' + act + '"]');
        await page.click('.cell[data-cell="' + cell + '"].legal');
        await sleep(520);
      } else await sleep(520);
    }
    const fin = await page.evaluate(() => { const s = window.SaltApp.state; return { over: s.over, w: s.winner, sc: s.scores, t: s.turnsTaken }; });
    check(fin.over && fin.t === 16, 'live solo match completes (16/16, winner seat ' + fin.w + ')');
    check(errors.length === 0, 'no runtime errors during live play');

    console.log('\n== live URL relay match with an agent seat ==');
    const code = 'L' + Math.random().toString(36).slice(2, 6).toUpperCase();
    // fresh page: a hash-only navigation on the same document does not reload it
    const page2 = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    page2.on('pageerror', (e) => errors.push(String(e)));
    await page2.goto(BASE + '#code=' + code + '&seat=0&players=2');
    await page2.waitForFunction((c) => window.SaltApp && window.SaltApp.code === c, code);
    page = page2; // reassign for the rest of this block
    const hello = await fetch(RELAY + '/saltsignal-' + code, { method: 'POST', body: JSON.stringify({ v: 1, code, kind: 'hello', by: 1, at: Date.now() }) });
    check(hello.ok, 'agent announced on the relay for the live URL match');
    await sleep(11500);
    const claimed = await page.evaluate(() => window.SaltApp.agentSeats.slice());
    check(claimed.indexOf(1) !== -1, 'live URL recognised the agent seat');
    // human move
    const s = await page.evaluate(() => { const A = window.SaltApp, g = A.state; return { legal: window.SaltSignal.legal(g, g.turn), mine: g.turn === A.mySeat }; });
    if (s.mine) {
      await page.click('#actions button[data-act="claim"]');
      await page.click('.cell[data-cell="' + s.legal.claim[0] + '"].legal');
    }
    await sleep(6000);
    // agent reads + posts one legal move
    const r = await fetch(RELAY + '/saltsignal-' + code + '/json?poll=1&since=all');
    const lines = (await r.text()).split('\n').filter(Boolean);
    const msgs = lines.map((l) => { try { const j = JSON.parse(l); return Object.assign(JSON.parse(j.message), { _t: j.time }); } catch (e) { return null; } }).filter(Boolean).filter((m) => m.action).sort((a, b) => a._t - b._t);
    const seed = await page.evaluate(() => window.SaltApp.seed);
    const replay = await page.evaluate(([sd, mv]) => {
      const st = window.SaltSignal.newGame(sd, 2); const pool = mv.slice(); let g = 0;
      while (g++ < 200) { const i = pool.findIndex((m) => m.player === st.turn); if (i === -1) break; const m = pool.splice(i, 1)[0]; try { window.SaltSignal.apply(st, m.action, m.cell); } catch (e) {} }
      return { turn: st.turn, legal: window.SaltSignal.legal(st, st.turn) };
    }, [seed, msgs.map((m) => ({ player: m.player, action: m.action, cell: m.cell }))]);
    if (replay.turn === 1 && replay.legal.claim.length) {
      const post = await fetch(RELAY + '/saltsignal-' + code, { method: 'POST', body: JSON.stringify({ v: 1, code, player: 1, action: 'claim', cell: replay.legal.claim[0], at: Date.now() }) });
      check(post.ok, 'agent posted a move against the live URL match');
      await sleep(6000);
      const after = await page.evaluate(() => ({ moves: window.SaltApp.moves.length, by: window.SaltApp.moves.reduce((a, m) => { a[m.player] = (a[m.player] || 0) + 1; return a; }, {}) }));
      check((after.by[1] || 0) > 0, 'live URL accepted the agent move (' + JSON.stringify(after.by) + ')');
    } else {
      check(false, 'could not reach agent turn on live URL (' + JSON.stringify(replay) + ')');
    }
    check(errors.length === 0, 'no errors in live relay match (' + errors.join('; ') + ')');
    await page.screenshot({ path: path.join(__dirname, 'shot-live.png'), fullPage: true });
  } catch (e) {
    fails.push('exception: ' + (e && e.stack ? e.stack : e));
    console.log('EXCEPTION ' + e);
  } finally {
    await browser.close();
  }
  console.log('\n' + (fails.length ? 'FAIL: ' + fails.length + ' assertion(s)' : 'PASS: live URL verified'));
  process.exit(fails.length ? 1 : 0);
})();
