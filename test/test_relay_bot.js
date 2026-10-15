#!/usr/bin/env node
/* End-to-end: a browser hosts a RELAY match, and the shipped sample_bot.py
 * (relay mode) joins seat 1 and plays it to the end over the public relay.
 *
 * Proves the shipped agent entry point — not a bespoke test harness — works
 * against a real hosted browser match. Relay allows roughly 1 request / 5 s,
 * so this test is paced accordingly (a few minutes).
 *
 * Run: node test/test_relay_bot.js
 */
'use strict';
const path = require('path');
const { spawn } = require('child_process');
const PW = require(path.join('/home/nicolas/.hermes/node/lib/node_modules/playwright'));
const EXE = process.env.PW_CHROME || '/home/nicolas/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const ROOT = path.join(__dirname, '..');
const PY = process.env.PY || 'python3';

let fails = [];
const check = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails.push(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const code = 'B' + Math.random().toString(36).slice(2, 6).toUpperCase();
  let browser, bot;
  try {
    console.log('\n== sample_bot.py (shipped) plays a browser-hosted relay match ==');
    browser = await PW.chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto('file://' + path.join(ROOT, 'index.html') + '#code=' + code + '&seat=0&players=2');
    await page.waitForFunction((c) => window.SaltApp && window.SaltApp.code === c, code);
    check(true, 'browser hosted relay match ' + code);
    await page.waitForTimeout(6000);   // let the host send its hello

    bot = spawn(PY, ['-u', path.join(ROOT, 'sample_bot.py'), '--relay', code, '--seat', '1'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let botOut = '';
    bot.stdout.on('data', (d) => { botOut += d; });
    bot.stderr.on('data', (d) => { botOut += d; });
    await sleep(7000);
    check(/seat 1 in relay match/.test(botOut), 'sample_bot.py started in relay mode');

    // drive the human seat; give the bot's 5.2s cadence room each turn
    let guard = 0, human = 0;
    while (guard++ < 60) {
      const s = await page.evaluate(() => { const A = window.SaltApp, g = A.state; return { over: g.over, turn: g.turn, mine: g.turn === A.mySeat, legal: window.SaltSignal.legal(g, g.turn) }; });
      if (s.over) break;
      if (s.mine) {
        let act = 'claim', cell = -1;
        for (const a of ['claim', 'fortify', 'raid']) if (s.legal[a].length) { act = a; cell = s.legal[a][0]; break; }
        await page.click('#actions button[data-act="' + act + '"]');
        await page.click('.cell[data-cell="' + cell + '"].legal');
        human++;
        await sleep(6000);
      } else {
        await sleep(3000);
      }
    }
    const fin = await page.evaluate(() => { const s = window.SaltApp.state; return { over: s.over, moves: window.SaltApp.moves.length, by: window.SaltApp.moves.reduce((a, m) => { a[m.player] = (a[m.player] || 0) + 1; return a; }, {}), scores: s.scores }; });
    check(human > 0, 'human seat played ' + human + ' moves');
    check((fin.by[1] || 0) > 0, 'sample_bot.py (agent) played ' + (fin.by[1] || 0) + ' moves over the relay');
    check(fin.over === true, 'relay match reached a decided end (' + fin.moves + '/16 moves)');
    check(errors.length === 0, 'no page errors (' + errors.join('; ') + ')');
    await page.screenshot({ path: path.join(__dirname, 'shot-relay-bot.png'), fullPage: true });
  } catch (e) {
    fails.push('exception: ' + (e && e.stack ? e.stack : e));
    console.log('EXCEPTION ' + e);
  } finally {
    if (bot) bot.kill('SIGTERM');
    if (browser) await browser.close();
  }
  console.log('\n' + (fails.length ? 'FAIL: ' + fails.length + ' assertion(s)' : 'PASS: all relay-bot assertions'));
  process.exit(fails.length ? 1 : 0);
})();
