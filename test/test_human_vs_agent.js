#!/usr/bin/env node
/* Human-vs-agent integration test on the bundled game server.
 *
 * Boots server.py (2 seats, autobots OFF), opens the real game page against it
 * with a browser, plays seat 0 through DOM clicks, and drives seat 1 over the
 * documented HTTP/JSON API from this process. Asserts that a human in a browser
 * and an agent on the API finish one shared match, and that the two views agree.
 *
 * Run: node test/test_human_vs_agent.js
 */
'use strict';
const path = require('path');
const { spawn } = require('child_process');
const net = require('net');
const PW = require(path.join('/home/nicolas/.hermes/node/lib/node_modules/playwright'));
const EXE = process.env.PW_CHROME || '/home/nicolas/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const ROOT = path.join(__dirname, '..');
const PY = process.env.PY || 'python3';

let fails = [];
const check = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails.push(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() { return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); }); }

async function api(base, path, data) {
  const r = await fetch(base + path, data ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) } : undefined);
  return { status: r.status, body: await r.json().catch(() => null) };
}

(async () => {
  const port = await freePort();
  const base = 'http://127.0.0.1:' + port;
  const srv = spawn(PY, ['-u', path.join(ROOT, 'server.py'), '--port', String(port), '--players', '2', '--seed', '31337', '--no-autobots'], { stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stdout.on('data', () => {});
  srv.stderr.on('data', (d) => process.env.SALT_VERBOSE && process.stderr.write(d));
  let browser;
  try {
    for (let i = 0; i < 60; i++) { try { if ((await api(base, '/api/state')).status === 200) break; } catch (e) {} await sleep(150); }

    browser = await PW.chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

    console.log('\n== human (browser, seat 0) vs agent (HTTP API, seat 1) ==');
    await page.goto(base + '/?server=1&seat=0');
    await page.waitForFunction(() => window.SaltApp && window.SaltApp.transport === 'server');
    await page.waitForFunction(() => window.SaltApp.moves.length >= 0 && document.getElementById('netstatus').textContent.indexOf('server') !== -1, null, { timeout: 15000 });
    const attached = await page.evaluate(() => ({ mode: window.SaltApp.mode, transport: window.SaltApp.transport, seed: window.SaltApp.seed }));
    check(attached.mode === 'online' && attached.transport === 'server', 'browser attached to the game server');
    check(attached.seed === 31337, 'browser picked up the server match seed (' + attached.seed + ')');

    let agentMoves = 0, humanMoves = 0, guard = 0;
    while (guard++ < 90) {
      const v = (await api(base, '/api/state')).body;
      if (v.over) break;
      if (v.turn === 0) {
        // human: click a legal cell in the real board for the current action
        const info = await page.evaluate(() => { const A = window.SaltApp, s = A.state; return { turn: s.turn, legal: window.SaltSignal.legal(s, s.turn) }; });
        if (info.turn !== 0) { await sleep(300); continue; }
        let act = 'claim', cell = -1;
        for (const a of ['claim', 'fortify', 'raid']) if (info.legal[a].length) { act = a; cell = info.legal[a][0]; break; }
        await page.click('#actions button[data-act="' + act + '"]');
        await page.click('.cell[data-cell="' + cell + '"].legal');
        humanMoves++;
        await sleep(900);
      } else {
        // agent: read state, choose, POST /api/move
        const lg = v.legal;
        let act = 'claim', cell = -1;
        if (lg.claim.length) { act = 'claim'; cell = lg.claim.reduce((a, b) => (v.salt[a] >= v.salt[b] ? a : b)); }
        else if (lg.fortify.length) { act = 'fortify'; cell = lg.fortify.reduce((a, b) => (v.salt[a] >= v.salt[b] ? a : b)); }
        else if (lg.raid.length) { act = 'raid'; cell = lg.raid.reduce((a, b) => (v.salt[a] >= v.salt[b] ? a : b)); }
        else { await sleep(400); continue; }
        const res = await api(base, '/api/move', { action: act, cell, player: 1 });
        check(res.status === 200, 'agent move ' + act + ' ' + cell + ' accepted (seat 1)');
        agentMoves++;
        await sleep(500);
      }
    }
    // let the browser's poll interval catch the final move
    for (let i = 0; i < 20; i++) {
      const v = (await api(base, '/api/state')).body;
      const cur = await page.evaluate(() => window.SaltApp.moves.length);
      if (v.over && cur === v.moves.length) break;
      await sleep(400);
    }
    const fin = (await api(base, '/api/state')).body;
    check(fin.over === true, 'human+agent match reached a decided end');
    check(fin.turnsTaken === 16, '16 actions consumed, got ' + fin.turnsTaken);
    check(agentMoves > 0 && humanMoves > 0, 'both a human and an agent actually played (' + humanMoves + ' human / ' + agentMoves + ' agent)');
    const view = await page.evaluate(() => ({ moves: window.SaltApp.moves.length, scores: Array.from(document.querySelectorAll('.score .v')).map((e) => +e.textContent), banner: document.getElementById('turntext').textContent }));
    check(view.moves === fin.moves.length, 'browser move count matches the server (' + view.moves + ')');
    check(JSON.stringify(view.scores) === JSON.stringify(fin.scores), 'browser scores match the server ' + JSON.stringify(fin.scores));
    check(/wins|You win/.test(view.banner), 'browser shows the final result: "' + view.banner + '"');
    check(errors.length === 0, 'no page errors (' + errors.join('; ') + ')');
    await page.screenshot({ path: path.join(__dirname, 'shot-human-vs-agent.png'), fullPage: true });
  } catch (e) {
    fails.push('exception: ' + (e && e.stack ? e.stack : e));
    console.log('EXCEPTION ' + e);
  } finally {
    if (browser) await browser.close();
    srv.kill('SIGTERM');
  }
  console.log('\n' + (fails.length ? 'FAIL: ' + fails.length + ' assertion(s)' : 'PASS: all human-vs-agent assertions'));
  process.exit(fails.length ? 1 : 0);
})();
