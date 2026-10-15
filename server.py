#!/usr/bin/env python3
"""SALT & SIGNAL — reference game server (stdlib only, no dependencies).

Serves:
  * the game itself at  /            (index.html, humans play in the browser)
  * the HTTP/JSON agent API at /api/*  (agents read state and submit moves)

Run:      python3 server.py [--port 8788] [--players 2] [--seed 0]
Open:     http://127.0.0.1:8788/            (human, seat 0)
Agent:    see README.md and sample_bot.py

API (all JSON; CORS enabled for every /api/* route):
  GET  /api/state                 full board + whose turn + legal action lists
  GET  /api/legal?player=N        legal actions for a player
  POST /api/move                  {"action":"claim|fortify|raid|rest","cell":N[,"player":N]}
  POST /api/new                   {"players":2-4[,"seed":N][,"autobots":true]}
  GET  /api/rules                 the rules text as JSON

The server is the authority for one match (id "main"); the browser page opened at
/?server=1 talks to this same match, so a human and an agent share one board.
Empty seats can be filled by the built-in bot (see Bot below / autobots).
"""
from __future__ import annotations

import argparse
import json
import os
import random
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Optional
from urllib.parse import urlparse, parse_qs

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from engine import CELLS, TURNS_PER_PLAYER, apply as eng_apply, legal, new_game, neighbors, score  # noqa: E402

RULES_TEXT = (
    "On a 5x5 salt chart each cell holds 1-3 salt. Every captain starts owning one "
    "harbour corner. On your turn you take exactly ONE action: CLAIM an unowned cell "
    "orthogonally adjacent to your territory, FORTIFY one of your own cells (+2 salt, "
    "once per cell), or RAID an enemy cell adjacent to your territory (-2 salt, never "
    "below 1; the salt is destroyed, not stolen). Every cell gets 8 turns; when the "
    "turns run out, the highest total salt (cells you own + plunder) wins. Ties break "
    "on most cells owned."
)

# --------------------------------------------------------------------------- bot
def _front(s, p, i):
    return sum(1 for j in neighbors(i) if s["owner"][j] == p)


def bot_choose(s):
    """Heuristic captain: light 1-ply lookahead. Same shape as the client's Bot."""
    p = s["turn"]
    lg = legal(s)

    def val(after, act):
        mine = 0
        frontier = 0
        threat = 0
        for i in range(CELLS):
            if after["owner"][i] == p:
                mine += after["salt"][i]
                if any(after["owner"][j] == -1 for j in neighbors(i)):
                    frontier += 1
            elif after["owner"][i] != -1:
                for j in neighbors(i):
                    if after["owner"][j] == p:
                        threat = max(threat, after["salt"][i])
        tie = {"claim": 3, "fortify": 2, "raid": 1, "rest": 0}[act]
        return mine + 0.6 * frontier - 0.5 * threat + tie * 0.001

    opts = [("claim", i) for i in lg["claim"]] + [("fortify", i) for i in lg["fortify"]] + [("raid", i) for i in lg["raid"]]
    if not opts:
        return ("rest", -1)
    best, bestv = None, -1e18
    for a, c in opts:
        snap = {k: (v[:] if isinstance(v, list) else v) for k, v in s.items() if k != "log"}
        snap["log"] = list(s["log"])
        try:
            eng_apply(s, a, c)
            v = val(s, a)
        except Exception:
            v = -1e18
        s.update(snap)
        if v > bestv:
            bestv, best = v, (a, c)
    return best


# ------------------------------------------------------------------------ state
class Match:
    def __init__(self, players=2, seed=None, autobots=True):
        self.lock = threading.Lock()
        self.reset(players, seed, autobots)

    def reset(self, players=2, seed=None, autobots=True):
        if seed is None:
            seed = random.randrange(1, 2 ** 31)
        self.seed = int(seed)
        self.players = int(players)
        self.autobots = bool(autobots)
        self.state = new_game(self.seed, self.players)
        self.bot_seats: set = set()
        self._run_bots()

    def _run_bots(self):
        """Play out consecutive bot seats so a match never stalls on them."""
        if not self.autobots:
            return
        guard = 0
        while not self.state["over"] and self.state["turn"] in self.bot_seats and guard < 100:
            a, c = bot_choose(self.state)
            eng_apply(self.state, a, c if c >= 0 else 0)
            guard += 1

    def view(self):
        s = self.state
        lg = legal(s, s["turn"]) if not s["over"] else {"claim": [], "fortify": [], "raid": [], "rest": False}
        return {
            "seed": self.seed,
            "players": s["n"],
            "turn": s["turn"],
            "turnsTaken": s["turnsTaken"],
            "turnsTotal": s["turnsPerPlayer"] * s["n"],
            "over": s["over"],
            "winner": s.get("winner"),
            "scores": [score(s, p) for p in range(s["n"])],
            "salt": s["salt"],
            "owner": s["owner"],
            "fortified": s["fortified"],
            "plunder": s["plunder"],
            "legal": lg,
            "botSeats": sorted(self.bot_seats),
            "moves": s["log"],
            "rules": RULES_TEXT,
        }

    def move(self, action, cell, player=None):
        with self.lock:
            s = self.state
            if s["over"]:
                return 409, {"error": "game over", "state": self.view()}
            if player is not None and int(player) != s["turn"]:
                return 409, {"error": "not your turn", "expected": s["turn"], "state": self.view()}
            try:
                eng_apply(s, action, int(cell))
            except Exception as e:
                return 400, {"error": str(e), "legal": legal(s, s["turn"])}
            self._run_bots()
            return 200, self.view()


# ---------------------------------------------------------------------- handler
class Handler(BaseHTTPRequestHandler):
    server_version = "SaltSignal/1.0"
    match: Optional["Match"] = None

    def log_message(self, format, *args):  # quiet, but keep a thin trace
        if os.environ.get("SALT_VERBOSE"):
            sys.stderr.write("%s - %s\n" % (self.address_string(), format % args))

    def _send(self, code, payload, ctype="application/json"):
        body = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_OPTIONS(self):
        self._send(204, b"")

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path in ("/", "/index.html"):
            with open(os.path.join(HERE, "index.html"), "rb") as fh:
                return self._send(200, fh.read(), "text/html; charset=utf-8")
        if u.path == "/api/rules":
            return self._send(200, {"rules": RULES_TEXT, "playersAllowed": [2, 3, 4],
                                    "turnsPerPlayer": TURNS_PER_PLAYER, "cells": CELLS})
        if u.path == "/api/legal":
            st = self.match.state
            p = int(q.get("player", [st["turn"]])[0])
            return self._send(200, {"player": p, "legal": legal(st, p) if not st["over"] else {"claim": [], "fortify": [], "raid": [], "rest": False}})
        if u.path == "/api/state":
            return self._send(200, self.match.view())
        return self._send(404, {"error": "not found", "path": u.path})

    def do_POST(self):
        u = urlparse(self.path)
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b"{}"
        try:
            body = json.loads(raw or b"{}")
        except Exception:
            return self._send(400, {"error": "invalid JSON body"})
        if u.path == "/api/move":
            action = body.get("action")
            cell = body.get("cell", -1)
            if action not in ("claim", "fortify", "raid", "rest"):
                return self._send(400, {"error": "action must be claim|fortify|raid|rest"})
            code, payload = self.match.move(action, cell, body.get("player"))
            return self._send(code, payload)
        if u.path == "/api/new":
            players = int(body.get("players", 2))
            if players not in (2, 3, 4):
                return self._send(400, {"error": "players must be 2, 3 or 4"})
            bots = body.get("botSeats", body.get("bots"))
            self.match.reset(players, body.get("seed"), body.get("autobots", True))
            if bots:
                self.match.bot_seats = set(int(x) for x in bots)
                self.match._run_bots()
            return self._send(200, self.match.view())
        return self._send(404, {"error": "not found", "path": u.path})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8788)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--players", type=int, default=2)
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--no-autobots", action="store_true")
    args = ap.parse_args()
    Handler.match = Match(args.players, args.seed, autobots=not args.no_autobots)
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"SALT & SIGNAL on http://{args.host}:{args.port}/  (human seat 0)")
    print(f"agent API: GET /api/state  POST /api/move   (players={args.players} seed={Handler.match.seed})")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()


if __name__ == "__main__":
    main()
