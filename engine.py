#!/usr/bin/env python3
"""SALT & SIGNAL — reference rules engine (Python).

This is the canonical, tested implementation of the rules. A byte-identical
port lives in engine.js for the browser. Both are checked against the same
fixture file (test/fixtures.json) so the two implementations cannot drift.

Rules (one paragraph):
On a 5x5 salt chart every cell holds 1-3 salt; each player starts owning one
harbour corner. On your turn you take exactly ONE action: CLAIM an unowned
cell orthogonally adjacent to your territory, FORTIFY one of your own cells
(+2 salt, once per cell), or RAID an enemy cell adjacent to your territory
(-2 salt, floor 1). Every cell gets 8 turns; when the turns run out the
player with the highest total salt (own cells + plunder) wins.
"""
from __future__ import annotations

W = H = 5
CELLS = W * H
TURNS_PER_PLAYER = 8
FORTIFY_GAIN = 2
RAID_LOSS = 2
RAID_PLUNDER = 0  # raiding denies value, it does not create it
HARBORS = {2: [0, 24], 3: [0, 4, 24], 4: [0, 4, 20, 24]}


def mulberry32(seed: int):
    """Same PRNG as engine.js (mulberry32), integer-exact across languages."""
    a = seed & 0xFFFFFFFF

    def nxt() -> float:
        nonlocal a
        a = (a + 0x6D2B79F5) & 0xFFFFFFFF
        t = a
        t = (t ^ (t >> 15)) * (1 | t) & 0xFFFFFFFF
        t = (t + ((t ^ (t >> 7)) * (61 | t) & 0xFFFFFFFF)) & 0xFFFFFFFF
        t = t ^ (t >> 14)
        return (t & 0xFFFFFFFF) / 4294967296.0

    return nxt


def neighbors(i: int):
    x, y = i % W, i // W
    out = []
    if x > 0:
        out.append(i - 1)
    if x < W - 1:
        out.append(i + 1)
    if y > 0:
        out.append(i - W)
    if y < H - 1:
        out.append(i + W)
    return out


def new_game(seed: int, n: int) -> dict:
    assert n in (2, 3, 4)
    rng = mulberry32(seed)
    salt = []
    for _ in range(CELLS):
        r = rng()
        salt.append(3 if r < 0.15 else (2 if r < 0.50 else 1))
    owner = [-1] * CELLS
    for p, c in enumerate(HARBORS[n]):
        owner[c] = p
    return {
        "seed": seed,
        "n": n,
        "salt": salt,
        "owner": owner,
        "fortified": [False] * CELLS,
        "plunder": [0] * n,
        "turn": 0,
        "turnsTaken": 0,
        "turnsPerPlayer": TURNS_PER_PLAYER,
        "over": False,
        "winner": None,
        "log": [],
    }


def territory(s: dict, p: int):
    return [i for i in range(CELLS) if s["owner"][i] == p]


def is_adjacent_to(s: dict, p: int, i: int) -> bool:
    return any(s["owner"][j] == p for j in neighbors(i))


def legal(s: dict, p: int | None = None) -> dict:
    """All legal actions for player p (default: the player to move)."""
    if s["over"]:
        return {"claim": [], "fortify": [], "raid": [], "rest": False}
    p = s["turn"] if p is None else p
    claim = [i for i in range(CELLS) if s["owner"][i] == -1 and is_adjacent_to(s, p, i)]
    fortify = [i for i in range(CELLS) if s["owner"][i] == p and not s["fortified"][i]]
    raid = [
        i
        for i in range(CELLS)
        if s["owner"][i] not in (-1, p) and is_adjacent_to(s, p, i)
    ]
    # Guard against a dead end: if nothing else is possible you may rest.
    rest = not (claim or fortify or raid)
    return {"claim": claim, "fortify": fortify, "raid": raid, "rest": rest}


def apply(s: dict, action: str, cell: int) -> dict:
    """Apply one action for the player to move. Raises ValueError if illegal."""
    if s["over"]:
        raise ValueError("game over")
    p = s["turn"]
    lg = legal(s)
    if action == "claim":
        if cell not in lg["claim"]:
            raise ValueError("illegal claim")
        s["owner"][cell] = p
    elif action == "fortify":
        if cell not in lg["fortify"]:
            raise ValueError("illegal fortify")
        s["salt"][cell] += FORTIFY_GAIN
        s["fortified"][cell] = True
    elif action == "raid":
        if cell not in lg["raid"]:
            raise ValueError("illegal raid")
        before = s["salt"][cell]
        s["salt"][cell] = max(1, before - RAID_LOSS)
        s["plunder"][p] += min(RAID_LOSS, before - s["salt"][cell])
    elif action == "rest":
        if not lg["rest"]:
            raise ValueError("illegal rest")
    else:
        raise ValueError("unknown action")
    s["log"].append({"turn": s["turnsTaken"], "player": p, "action": action, "cell": cell})
    s["turnsTaken"] += 1
    total = s["turnsPerPlayer"] * s["n"]
    if s["turnsTaken"] >= total:
        finish(s)
    else:
        s["turn"] = (s["turn"] + 1) % s["n"]
    return s


def score(s: dict, p: int) -> int:
    return sum(s["salt"][i] for i in range(CELLS) if s["owner"][i] == p) + s["plunder"][p]


def finish(s: dict) -> None:
    s["over"] = True
    n = s["n"]
    sc = [score(s, p) for p in range(n)]
    cells = [len(territory(s, p)) for p in range(n)]
    best = max(range(n), key=lambda p: (sc[p], cells[p], -p))
    s["scores"] = sc
    s["winner"] = best


def final_scores(s: dict):
    n = s["n"]
    return [score(s, p) for p in range(n)]
