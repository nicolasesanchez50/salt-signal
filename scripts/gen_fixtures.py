#!/usr/bin/env python3
"""Generate test/fixtures.json from the Python engine (the reference).

Each fixture is a seed, a player count, a scripted action list and the full
resulting state after every action. test/test_engine.js replays the same script
through engine.js and asserts byte-identical salt/owner/plunder/turn/score.
Run: python3 scripts/gen_fixtures.py
"""
import json
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
from engine import CELLS, apply, legal, new_game, score  # noqa: E402

OUT = os.path.join(ROOT, "test", "fixtures.json")


def make(seed, n, rng):
    s = new_game(seed, n)
    states = [snapshot(s)]
    actions = []
    while not s["over"]:
        p = s["turn"]
        lg = legal(s)
        opts = [("claim", i) for i in lg["claim"]] + [("fortify", i) for i in lg["fortify"]] + [("raid", i) for i in lg["raid"]]
        act, cell = rng.choice(opts)
        apply(s, act, cell)
        actions.append({"player": p, "action": act, "cell": cell})
        states.append(snapshot(s))
    return {"seed": seed, "players": n, "actions": actions, "states": states}


def snapshot(s):
    return {
        "salt": list(s["salt"]),
        "owner": list(s["owner"]),
        "fortified": list(s["fortified"]),
        "plunder": list(s["plunder"]),
        "turn": s["turn"],
        "turnsTaken": s["turnsTaken"],
        "over": s["over"],
        "winner": s.get("winner"),
        "scores": [score(s, p) for p in range(s["n"])],
    }


def main():
    rng = random.Random(20261015)
    fixtures = []
    for seed in range(1, 41):
        for n in (2, 3, 4):
            fixtures.append(make(seed, n, rng))
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as fh:
        json.dump({"engine": "salt-signal", "version": 1, "fixtures": fixtures}, fh)
    print(f"wrote {OUT}: {len(fixtures)} fixtures, "
          f"{sum(len(f['actions']) for f in fixtures)} actions")


if __name__ == "__main__":
    main()
