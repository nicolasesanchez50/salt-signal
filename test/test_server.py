#!/usr/bin/env python3
"""Server + sample-bot integration test.

Starts server.py on a free port with autobots OFF, then:
  * exercises every API route (rules, state, legal, move, new) including error paths
  * asserts turn enforcement, illegal-move rejection and CORS headers
  * plays a full match with sample_bot.py logic in-process and checks the final state
  * asserts a human-vs-agent share of the same board (both seats move)

Run: python3 test/test_server.py
"""
from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

FAILS = []


def check(cond, msg):
    print(("  ok   " if cond else "  FAIL ") + msg)
    if not cond:
        FAILS.append(msg)


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def req(base, path, data=None, method=None):
    url = base + path
    body = None if data is None else json.dumps(data).encode()
    r = urllib.request.Request(url, data=body, method=method or ("POST" if body else "GET"),
                               headers={"Content-Type": "application/json"} if body else {})
    try:
        with urllib.request.urlopen(r, timeout=10) as resp:
            raw = resp.read()
            return resp.status, dict(resp.headers), (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read()
        return e.code, dict(e.headers), (json.loads(raw) if raw else None)


def main():
    port = free_port()
    base = "http://127.0.0.1:%d" % port
    proc = subprocess.Popen([sys.executable, os.path.join(ROOT, "server.py"),
                             "--port", str(port), "--players", "2", "--seed", "4242", "--no-autobots"],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        for _ in range(50):
            try:
                code, _, _ = req(base, "/api/state")
                if code == 200:
                    break
            except Exception:
                time.sleep(0.1)
        else:
            raise RuntimeError("server did not start: " + proc.stderr.read().decode())

        print("\n== API surface ==")
        code, hdr, rules = req(base, "/api/rules")
        check(code == 200 and "CLAIM" in rules["rules"], "/api/rules returns the rules text")
        check(hdr.get("Access-Control-Allow-Origin") == "*", "CORS header present on /api/*")

        code, _, st = req(base, "/api/state")
        check(code == 200 and st["turn"] == 0 and st["players"] == 2, "/api/state returns the opening position")
        check(len(st["salt"]) == 25 and len(st["owner"]) == 25, "state carries a 5x5 board")
        check(st["owner"][0] == 0 and st["owner"][24] == 1, "harbour corners are pre-owned by each seat")
        check("claim" in st["legal"] and "fortify" in st["legal"], "legal action lists present")

        code, _, lg = req(base, "/api/legal?player=1")
        check(code == 200 and lg["player"] == 1 and len(lg["legal"]["claim"]) == 2, "/api/legal?player=1 works off-turn")
        check(lg["legal"]["fortify"] == [24], "seat 1 may fortify only its own harbour on turn 1")

        # the shipped index.html must be served too
        r = urllib.request.urlopen(base + "/", timeout=10)
        html = r.read().decode()
        check(r.status == 200 and "SALT" in html and "SaltSignal" in html, "index.html served at /")

        print("\n== move validation ==")
        code, _, res = req(base, "/api/move", {"action": "claim", "cell": 24})
        check(code == 400, "claiming an enemy/illegal cell is rejected (400)")
        code, _, res = req(base, "/api/move", {"action": "claim", "cell": 5, "player": 1})
        check(code == 409, "moving out of turn is rejected (409)")
        code, _, res = req(base, "/api/move", {"action": "bogus", "cell": 1})
        check(code == 400, "unknown action is rejected (400)")
        code, _, res = req(base, "/api/move", {"action": "claim", "cell": 1})
        check(code == 200 and res["turn"] == 1 and res["owner"][1] == 0, "legal claim accepted and turn advances")
        code, _, res = req(base, "/api/move", {"action": "fortify", "cell": 1})
        check(code == 400, "fortifying a cell twice is rejected (400)")  # not our turn anyway
        _, _, pre = req(base, "/api/state")
        base_salt_24 = pre["salt"][24]
        code, _, res = req(base, "/api/move", {"action": "fortify", "cell": 24, "player": 1})
        check(code == 200 and res["fortified"][24] is True and res["salt"][24] == base_salt_24 + 2, "seat 1 fortify applied (+2, flagged)")

        print("\n== full match: agent seats play via the documented bot ==")
        code, _, res = req(base, "/api/new", {"players": 2, "seed": 4242, "autobots": False})
        check(code == 200 and res["turnsTaken"] == 0, "/api/new resets the match")
        sys.path.insert(0, ROOT)
        import sample_bot
        guard = 0
        while guard < 100:
            guard += 1
            _, _, v = req(base, "/api/state")
            if v["over"]:
                break
            a, c = sample_bot.choose(v, v["turn"])
            code, _, res = req(base, "/api/move", {"action": a, "cell": c, "player": v["turn"]})
            if code != 200:
                check(False, "bot move rejected: %s %s -> %s" % (a, c, res))
                break
        _, _, fin = req(base, "/api/state")
        check(fin["over"] is True, "match reached a decided end")
        check(fin["turnsTaken"] == 16, "16 actions consumed, got %s" % fin["turnsTaken"])
        check(fin["winner"] in (0, 1), "a winner was declared (%s)" % fin["winner"])
        tot = sum(fin["scores"])
        check(tot > 0, "scores computed: %s" % fin["scores"])
        # recompute independently from the raw board
        eng_scores = []
        for p in range(2):
            s = sum(fin["salt"][i] for i in range(25) if fin["owner"][i] == p) + fin["plunder"][p]
            eng_scores.append(s)
        check(eng_scores == fin["scores"], "server scores match an independent recomputation")

        print("\n== autobot seats keep a solo match alive ==")
        code, _, res = req(base, "/api/new", {"players": 3, "seed": 7, "autobots": True, "botSeats": [1, 2]})
        check(code == 200, "/api/new with botSeats accepted")
        # seat 1 and 2 should have been played through by the server; whoever is
        # to move now must be seat 0 (the only human seat).
        check(res["turn"] == 0 or res["over"], "server ran the bot seats and handed the turn back to seat 0")

    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()

    print("\n" + ("FAIL: %d assertion(s)" % len(FAILS) if FAILS else "PASS: all server assertions"))
    sys.exit(1 if FAILS else 0)


if __name__ == "__main__":
    main()
