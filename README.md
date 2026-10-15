# SALT & SIGNAL

A small, polished, turn-based multiplayer strategy game playable by **humans in a
browser** and **AI agents over a plain HTTP/JSON API** — in the *same* match.

* **Playable now (no install, no login):** open the page and sail.
* **2–4 captains**, one action per turn, **8 turns each**, a full match runs in
  well under ten minutes.
* **Every turn is a real decision:** expand cheaply, invest in a fortified stack, or
  burn an enemy stack down to deny it. No single dominant strategy (evidence below).

---

## Rules (one paragraph)

On a 5×5 salt chart each cell holds 1–3 salt. Every captain starts owning one
harbour corner. On your turn you take exactly ONE action: **CLAIM** an unowned cell
orthogonally adjacent to your territory, **FORTIFY** one of your own cells (+2 salt,
once per cell), or **RAID** an enemy cell adjacent to your territory (−2 salt, never
below 1; the salt is destroyed, not stolen). Every cell gets 8 turns; when the turns
run out, the highest total salt (cells you own + plunder) wins. Ties break on most
cells owned.

Design intent: claiming is cheap but only pays on a cell you can hold; fortifying
pays permanently but spends a turn that could have grown territory; raiding is
pure denial (it never increases *your* total directly beyond the plunder counter) and
is only worth it against a stacked cell you cannot otherwise reach profitably.
Nothing is random after setup, so losses are legible.

---

## How to run

### 1. Play solo / relay in the browser (no server, no install)

Open `index.html` — locally (`file://`), or from any static host (GitHub Pages).
The whole game, the bot, and both transports are contained in that one file.

* **New solo match** — you against the built-in bots, entirely offline.
* **Host relay match** — creates a 5-letter match code. Anyone (and any agent) who
  knows the code joins the same board over a public relay. No server of yours needed.
* **Join with code** — join an existing relay match from anywhere in the world.

### 2. Play against agents on the bundled game server

For the crispest agent integration (no third-party relay, no rate limits):

```bash
python3 server.py --port 8788 --players 2        # serves the game + the API
# human:  open http://127.0.0.1:8788/?server=1&seat=0
# agent:  python3 sample_bot.py --seat 1
```

`server.py` is the single authority for the match, so a human in a browser and any
number of agents share one board. Stdlib only — no dependencies.

### 3. Agent over the public relay (cross-machine, no server)

If an agent cannot reach your host, it can join a **relay match** through the same
public topic the browser uses. See **[docs/API.md](docs/API.md)** for the exact wire
format and the turn-ordered replay algorithm. `sample_bot.py --relay CODE --seat 1`
does this out of the box.

---

## Repository layout

| Path | What it is |
|------|------------|
| `index.html` | The whole game: UI, rules engine, bots, and both transports in one file. |
| `engine.py` | Reference rules engine (Python). |
| `engine.js` | Byte-compatible JS port of the engine (used by the page). |
| `server.py` | Reference game server + HTTP/JSON agent API (stdlib only). |
| `sample_bot.py` | Reference agent: plays a seat over the API (server or relay). |
| `scripts/simulate.py` | Balance simulation — feeds the "no dominant strategy" claim. |
| `scripts/gen_fixtures.py` | Generates `test/fixtures.json` from the Python engine. |
| `test/test_engine.js` | Python↔JS parity test (20 500+ assertions). |
| `test/test_server.py` | API + server-side integration tests. |
| `test/test_ui.js` | End-to-end browser test: solo match by DOM clicks, then a live relay match with an agent seat. |
| `test/test_human_vs_agent.js` | Browser human (seat 0) vs API agent (seat 1) on one shared match. |
| `docs/API.md` | The HTTP/JSON agent API in full. |

### The two engines cannot drift

`engine.py` is the reference. `scripts/gen_fixtures.py` records every intermediate
state of 120 scripted matches; `test/test_engine.js` replays them through `engine.js`
and asserts byte-identical salt/owner/fortify/plunder/turn/winner after every action.

```bash
python3 scripts/gen_fixtures.py && node test/test_engine.js
# PASS: engine.js parity — 20523 assertions across 120 fixtures
```

---

## Proof it holds up (all commands actually run)

```bash
python3 scripts/simulate.py        # balance: no dominant strategy
python3 test/test_server.py        # API + integration           -> PASS
node    test/test_engine.js        # Python<->JS parity           -> PASS
node    test/test_ui.js            # browser solo + live relay    -> PASS
node    test/test_human_vs_agent.js# human vs API agent           -> PASS
```

### Balance evidence (no single dominant strategy)

Four scripted strategies — `greedy` (take the fattest reachable cell), `turtle`
(fortify first), `expand` (grow frontier fast), `raider` (deny enemy stacks) — run
head-to-head. Over 800 four-player games each strategy seats in every position:

```
turtle  36.4%   greedy  33.2%   expand  24.4%   raider   6.0%
```

Every pure strategy is beatable; the two-player round robin shows no strategy is
unconditionally best (`greedy` beats `turtle` 86–76 but loses ground to `turtle` in
swing seats, `raider` beats `expand` 89–85, `turtle` beats `expand` 135–38). The
winning play is to read the board: take fat cells you can defend, fortify when the
frontier is closed, and raid only to deny a stack you cannot take. That is the
"meaningful decision every turn" the brief asks for.

---

## Fairness & robustness notes

* **Illegal moves cannot desync a match.** Both engines reject any action that is not
  legal for the player to move; the relay client additionally re-applies incoming
  moves in **turn order** through a pending buffer, because a public relay may deliver
  two same-second messages in either order.
* **No dead ends.** If a player has no claim/fortify/raid available, `rest` is legal,
  so a turn can never be lost.
* **Determinism.** A match is fully described by `(seed, players, move list)`; anyone
  can replay it and get the identical board (that is exactly what the parity test and
  the replay button do).
