# SALT & SIGNAL — HTTP/JSON Agent API

An agent plays a seat by reading game state and posting moves as JSON. There are two
ways in; both drive the **same match** a human is looking at.

---

## A. Game server API (`server.py`) — recommended

Start the server and open the page against it:

```bash
python3 server.py --port 8788 --players 2 --seed 31337
# human : open  http://127.0.0.1:8788/?server=1&seat=0
# agent : python3 sample_bot.py --seat 1
```

The server is the single authority for the match, so a human in a browser and any
number of agents share one board with no synchronisation hazards.

### Endpoints

| Method & path | Body / query | Returns |
|---|---|---|
| `GET /api/state` | — | the whole match (below) |
| `GET /api/legal?player=N` | `player` (optional; defaults to the player to move) | `{player, legal}` |
| `GET /api/rules` | — | `{rules, playersAllowed, turnsPerPlayer, cells}` |
| `POST /api/move` | `{"action":"claim\|fortify\|raid\|rest","cell":N,"player":N}` | new state, or an error |
| `POST /api/new` | `{"players":2-4,"seed":N,"autobots":bool,"botSeats":[..]}` | a freshly reset match |

`player` on `POST /api/move` is optional but **should be sent** when several agents
share the host: it is checked against the player to move, and a mismatch returns
`409 {"error":"not your turn","expected":N}`.

### `GET /api/state` response

```json
{
  "seed": 31337,
  "players": 2,
  "turn": 0,
  "turnsTaken": 0,
  "turnsTotal": 16,
  "over": false,
  "winner": null,
  "scores": [4, 3],
  "salt":   [2,1,3, ... 25 values ...],
  "owner":  [0,-1,-1, ... -1 = unowned, 0..3 = seat ...],
  "fortified": [false, false, ...],
  "plunder": [0, 0],
  "legal": { "claim": [1,5], "fortify": [0], "raid": [], "rest": false },
  "botSeats": [],
  "moves": [ {"turn":0,"player":0,"action":"claim","cell":1}, ... ],
  "rules": "On a 5x5 salt chart ..."
}
```

Cell indices are row-major: `index = row * 5 + column`, `0..24`, with `0` = top-left.
`legal` lists exactly the cells that are legal for `turn` to act on right now — post
one of them and you cannot go wrong.

### Errors

| Status | Meaning |
|---|---|
| `400` | illegal action for the player to move, unknown action, bad JSON (body carries `{"error", "legal"}`) |
| `409` | game is over, or `player` is not the player to move (`{"error","expected","state"}`) |
| `404` | unknown path |

Every `/api/*` response carries `Access-Control-Allow-Origin: *`, so a browser page
served from anywhere can call it.

### Minimal agent loop (Python, stdlib only)

```python
import json, time, urllib.request
BASE = "http://127.0.0.1:8788"
SEAT = 1

def get(p):
    with urllib.request.urlopen(BASE + p, timeout=10) as r:
        return json.load(r)

def move(action, cell):
    req = urllib.request.Request(BASE + "/api/move",
        data=json.dumps({"action": action, "cell": cell, "player": SEAT}).encode(),
        headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.load(r)

while True:
    v = get("/api/state")
    if v["over"]:
        print("done, winner seat", v["winner"], v["scores"]); break
    if v["turn"] != SEAT:
        time.sleep(0.5); continue
    lg = v["legal"]
    if lg["claim"]:   action, cell = "claim",   max(lg["claim"],   key=lambda i: v["salt"][i])
    elif lg["fortify"]: action, cell = "fortify", max(lg["fortify"], key=lambda i: v["salt"][i])
    else:             action, cell = "raid",    max(lg["raid"],    key=lambda i: v["salt"][i])
    move(action, cell)
```

`sample_bot.py` is a complete, slightly smarter version of exactly this.

---

## B. Relay API (`ntfy.sh`) — cross-machine, no server of yours

When an agent cannot reach the host, it joins a **relay match** created from the
browser's *Host relay match* button. The match is defined by a 5-letter code; the
topic is `saltsignal-<CODE>`.

### Read: `GET https://ntfy.sh/saltsignal-<CODE>/json?poll=1&since=all`

Returns newline-delimited JSON; each line is a message envelope whose `message` field
is a JSON string. Two message kinds:

```json
{"v":1,"code":"ABC12","kind":"hello","by":1,"at":1712345678}
{"v":1,"code":"ABC12","player":1,"action":"claim","cell":7,"at":1712345678}
```

* `hello` — announces that seat `by` is agent-controlled. The browser stops playing
  that seat as a bot. **Send this first** when you join.
* a move — `player`, `action`, `cell`, and optionally `bot:true`.

### Write: `POST https://ntfy.sh/saltsignal-<CODE>`

Plain-text body = one JSON object, same shapes as above.

### The relay can reorder same-second messages

`ntfy.sh` timestamps are per-second, so two messages posted in the same second may be
returned in either order. **Do not apply moves in arrival order.** Reconstruct the
board with a *greedy turn-ordered replay*:

1. Seed the engine from the code: `seed = fnv1a32("saltsignal:" + code.toUpperCase())`
   (this matches the browser exactly).
2. Collect all `action` messages, sorted by envelope `time`.
3. Repeatedly take the earliest unapplied message whose `player` equals the engine's
   current `turn`; apply it (ignore the action if it is illegal); stop when none fits.

Then post your move — and pace yourself: the public server allows **250 messages/day
and about one request per 5 seconds per IP** (`429` otherwise). A 16-move match fits
comfortably; a polling loop faster than 5 s will trip the limit.

The shipped `sample_bot.py --relay <CODE> --seat 1` implements exactly this.

---

## Match identity & replay

A match is fully described by `(seed, players, ordered move list)`. Any client —
browser, server, or agent — that replays those moves from that seed reaches the
identical board. That is how the relay client, the test suite, and the in-page replay
scrubber all stay in agreement.

* Seed from a code: `fnv1a32("saltsignal:" + CODE.toUpperCase())`.
* Seed on the server: whatever `--seed` / `POST /api/new` set.
