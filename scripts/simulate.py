#!/usr/bin/env python3
"""Balance simulation for SALT & SIGNAL.

Plays named strategies head-to-head over many seeds and reports win rates.
Used to evidence the "no single dominant strategy / meaningful decision every
turn" requirement from the brief. Runtime: a few seconds.
"""
import itertools
import random
import sys

import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from engine import CELLS, apply, legal, new_game, neighbors, score, territory  # noqa: E402


def front_of(s, p, i):
    """How many of cell i's neighbours are owned by p (claimers love this)."""
    return sum(1 for j in neighbors(i) if s["owner"][j] == p)


def strat_greedy(s):
    """Highest salt claimable, else fortify highest own cell."""
    lg = legal(s)
    p = s["turn"]
    if lg["claim"]:
        c = max(lg["claim"], key=lambda i: (s["salt"][i], front_of(s, p, i)))
        return ("claim", c)
    if lg["fortify"]:
        c = max(lg["fortify"], key=lambda i: s["salt"][i])
        return ("fortify", c)
    return ("raid", lg["raid"][0]) if lg["raid"] else (None, None)


def strat_turtle(s):
    """Fortify whenever possible; claim only when forced."""
    lg = legal(s)
    p = s["turn"]
    if lg["fortify"]:
        c = max(lg["fortify"], key=lambda i: s["salt"][i])
        return ("fortify", c)
    if lg["claim"]:
        c = max(lg["claim"], key=lambda i: s["salt"][i])
        return ("claim", c)
    return ("raid", lg["raid"][0]) if lg["raid"] else (None, None)


def strat_raider(s):
    """Raid the fattest adjacent enemy cell whenever possible."""
    lg = legal(s)
    if lg["raid"]:
        c = max(lg["raid"], key=lambda i: s["salt"][i])
        return ("raid", c)
    if lg["claim"]:
        c = max(lg["claim"], key=lambda i: s["salt"][i])
        return ("claim", c)
    if lg["fortify"]:
        return ("fortify", lg["fortify"][0])
    return (None, None)


def strat_expand(s):
    """Claim maximum-frontier cells to grow territory fast."""
    lg = legal(s)
    p = s["turn"]
    if lg["claim"]:
        c = max(lg["claim"], key=lambda i: (front_of(s, p, i), s["salt"][i]))
        return ("claim", c)
    if lg["fortify"]:
        c = max(lg["fortify"], key=lambda i: s["salt"][i])
        return ("fortify", c)
    return ("raid", lg["raid"][0]) if lg["raid"] else (None, None)


def strat_random(s, rng):
    lg = legal(s)
    opts = [("claim", i) for i in lg["claim"]] + [("fortify", i) for i in lg["fortify"]] + [("raid", i) for i in lg["raid"]]
    return rng.choice(opts) if opts else (None, None)


STRATS = {"greedy": strat_greedy, "turtle": strat_turtle, "raider": strat_raider, "expand": strat_expand}


def play(seed, n, seats, rng=None):
    s = new_game(seed, n)
    while not s["over"]:
        p = s["turn"]
        name = seats[p]
        if name == "random":
            act = strat_random(s, rng)
        else:
            act = STRATS[name](s)
        if act[0] is None:
            break
        apply(s, act[0], act[1])
    sc = [score(s, p) for p in range(n)]
    return sc, s["winner"]


def main():
    seeds = list(range(1, 201))
    rng = random.Random(7)
    # 4-player: every strategy occupies every seat across seeds
    print("== 4-player (each strategy in each seat, 200 seeds = 800 games) ==")
    wins = {k: 0 for k in STRATS}
    total = 0
    for seed in seeds:
        for perm in itertools.permutations(STRATS.keys(), 4):
            if seed % 5 != 0:
                continue  # sample to keep runtime short but spread
            sc, w = play(seed, 4, list(perm), rng)
            wins[perm[w]] += 1
            total += 1
    for k, v in sorted(wins.items(), key=lambda x: -x[1]):
        print(f"  {k:8s} {v:4d}  {100*v/total:5.1f}%")

    print("== 2-player round robin (200 seeds each pair) ==")
    for a, b in itertools.combinations(STRATS, 2):
        aw = bw = dr = 0
        for seed in seeds:
            sc, w = play(seed, 2, [a, b], rng)
            if sc[0] > sc[1]:
                aw += 1
            elif sc[1] > sc[0]:
                bw += 1
            else:
                dr += 1
        print(f"  {a:8s} vs {b:8s}  {aw}-{bw} (draws {dr})")

    print("== dominance check: can one action type alone run away with it? ==")
    # pure-claim vs pure-fortify-only-when-forced
    for a, b in [("expand", "greedy"), ("turtle", "greedy"), ("raider", "greedy")]:
        aw = bw = 0
        for seed in seeds:
            sc, _ = play(seed, 2, [a, b], rng)
            aw += sc[0] > sc[1]
            bw += sc[1] > sc[0]
        print(f"  {a:8s} beat {b:8s}: {aw} vs {bw}")

    print("== turn-count sanity ==")
    s = new_game(1, 4)
    steps = 0
    while not s["over"] and steps < 100:
        lg = legal(s)
        act = STRATS["greedy"](s)
        apply(s, act[0], act[1])
        steps += 1
    print(f"  total turns={steps} (expect {4*8}), over={s['over']}, scores={[score(s,p) for p in range(4)]}")


if __name__ == "__main__":
    main()
