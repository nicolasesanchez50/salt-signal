#!/usr/bin/env python3
"""SALT & SIGNAL — sample agent bot (stdlib only).

Plays seat 1 of a match served by server.py. This is the reference for the
HTTP/JSON agent API: read the state, pick a legal action, POST it.

    python3 server.py --port 8788 --players 2 &      # start the match
    python3 sample_bot.py --seat 1                   # an agent takes seat 1

Strategy: exactly the same heuristic shape as the built-in bot (frontier-aware
expansion, fortify the fattest own cell, raid the biggest adjacent enemy stack).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from engine import apply as eng_apply, legal as eng_legal, new_game, score  # noqa: E402

W = 5


def get(base):
    with urllib.request.urlopen(base + "/api/state", timeout=10) as r:
        return json.load(r)


def post(base, path, payload):
    req = urllib.request.Request(base + path, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def neighbors(i):
    x, y = i % W, i // W
    out = []
    if x > 0:
        out.append(i - 1)
    if x < W - 1:
        out.append(i + 1)
    if y > 0:
        out.append(i - W)
    if y < W - 1:
        out.append(i + W)
    return out


def choose(v, seat):
    lg = v["legal"]
    owner, salt = v["owner"], v["salt"]
    p = seat

    def frontier(i):
        return sum(1 for j in neighbors(i) if owner[j] == -1)

    # 1) claim the cell with the most of our own neighbours, then most salt
    if lg["claim"]:
        return "claim", max(lg["claim"], key=lambda i: (frontier(i), salt[i]))
    # 2) fortify the fattest of our cells
    if lg["fortify"]:
        return "fortify", max(lg["fortify"], key=lambda i: salt[i])
    # 3) raid the biggest adjacent enemy stack
    if lg["raid"]:
        return "raid", max(lg["raid"], key=lambda i: salt[i])
    return "rest", 0


RELAY = "https://ntfy.sh"


def relay_state(code, players):
    """Reconstruct the shared board from the relay topic (greedy turn-order)."""
    with urllib.request.urlopen(RELAY + "/saltsignal-" + code.upper() + "/json?poll=1&since=all", timeout=15) as r:
        raw = r.read().decode()
    msgs = []
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            j = json.loads(line)
            if j.get("event") != "message":
                continue
            m = json.loads(j["message"])
        except Exception:
            continue
        if m.get("code", "").upper() not in ("", code.upper()):
            continue
        if m.get("action"):
            msgs.append((int(j["time"]), m))
    msgs.sort(key=lambda t: t[0])
    st = new_game(seed_of(code), players)
    pool = [m for _, m in msgs]
    guard = 0
    while guard < 400:
        guard += 1
        i = next((k for k, m in enumerate(pool) if m.get("player") == st["turn"]), None)
        if i is None:
            break
        m = pool.pop(i)
        try:
            eng_apply(st, m["action"], m["cell"])
        except Exception:
            pass
    return {
        "turn": st["turn"], "over": st["over"], "winner": st.get("winner"),
        "scores": [score(st, p) for p in range(st["n"])],
        "legal": eng_legal(st, st["turn"]) if not st["over"] else {"claim": [], "fortify": [], "raid": [], "rest": False},
        "owner": st["owner"], "salt": st["salt"], "turnsTaken": st["turnsTaken"],
    }


def seed_of(code):
    h = 2166136261
    for ch in ("saltsignal:" + code.upper()).encode():
        h ^= ch
        h = (h * 16777619) & 0xFFFFFFFF
    return h


def relay_post(code, payload):
    req = urllib.request.Request(RELAY + "/saltsignal-" + code.upper(),
                                 data=json.dumps(payload).encode(), method="POST")
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:8788", help="server.py base URL")
    ap.add_argument("--relay", default=None, help="play a relay match code instead of the server")
    ap.add_argument("--seat", type=int, default=1)
    ap.add_argument("--poll", type=float, default=1.0)
    args = ap.parse_args()

    if args.relay:
        code = args.relay.upper()
        print(f"bot: seat {args.seat} in relay match {code} (topic saltsignal-{code})")
        # announce presence so the host marks this seat as agent-controlled
        relay_post(code, {"v": 1, "code": code, "kind": "hello", "by": args.seat, "at": int(time.time())})
        last = 0
        while True:
            time.sleep(max(5.2, args.poll))          # relay allows ~1 req / 5 s
            try:
                v = relay_state(code, 2)
            except Exception as e:
                print("bot: relay unreachable (%s)" % e)
                continue
            if v["over"]:
                print("bot: game over — winner seat %s, scores %s" % (v["winner"], v["scores"]))
                return
            if v["turn"] != args.seat or v["turnsTaken"] == last:
                continue
            action, cell = choose(v, args.seat)
            st = relay_post(code, {"v": 1, "code": code, "player": args.seat,
                                   "action": action, "cell": cell, "at": int(time.time())})
            last = v["turnsTaken"]
            print(f"bot: {action} {cell} ({st})")
        return

    print(f"bot: seat {args.seat} on {args.base}")
    while True:
        try:
            v = get(args.base)
        except Exception as e:
            print("bot: server unreachable (%s)" % e)
            time.sleep(2)
            continue
        if v["over"]:
            print("bot: game over — winner seat %s, scores %s" % (v["winner"], v["scores"]))
            return
        if v["turn"] != args.seat:
            time.sleep(args.poll)
            continue
        action, cell = choose(v, args.seat)
        code2, res = post(args.base, "/api/move", {"action": action, "cell": cell, "player": args.seat})
        if code2 == 200:
            print(f"bot: {action} {cell} -> turn {res['turn']}, my score {res['scores'][args.seat]}")
        else:
            print(f"bot: rejected {action} {cell} ({code2}) {res.get('error')}")
            time.sleep(0.2)


if __name__ == "__main__":
    main()
