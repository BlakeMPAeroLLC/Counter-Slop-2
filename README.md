# Counter-Slop 2

A stylized, browser-native tactical shooter in the Counter-Strike lineage — built so you and your friends can be in a match 20 seconds after someone shares a link.

Round-based bomb defusal. Punishing movement. Precise hitscan. Server-authoritative netcode with prediction and lag compensation. Low-poly flat-shaded art that reads instantly. No installs, no accounts, no patch day.

## Status

**M0 complete** — the netcode spike. Two players can connect from separate browsers, move around a test arena, and shoot each other with server-authoritative hitscan and headshots. 59 tests passing.

Alongside the game there is a **playbook**: a 2D play simulator for drawing and rehearsing rounds. See below.

M0 deliberately ships **without** client-side prediction or entity interpolation: your own movement lags by roughly the RTT, and other players step at 32 Hz. Both are M1's job, and the latency panel in the corner exists so the fix can be judged against a measured number rather than a memory. See [docs/M0-NOTES.md](docs/M0-NOTES.md).

## Run it

```bash
pnpm install
pnpm dev          # game server on :8080, client on :5173
```

Open <http://localhost:5173> in two browser windows and connect both. Vite proxies the WebSocket to the server, so there is one origin and nothing to configure.

```bash
pnpm check        # typecheck + lint + all tests
pnpm test         # tests only
pnpm build        # production client bundle
pnpm start        # server, serving the built client from :8080
```

Rooms: add `?room=CODE` to the URL, or type a code in the connect panel. Health and per-room tick metrics are at `/health`.

**Controls** — `WASD` move · `Space` jump · `Ctrl` crouch · `Shift` walk quietly · `Click` shoot · `R` reload · `Tab` scores · `Esc` release mouse

## Layout

```
packages/
  sim/           THE CORE. Deterministic simulation, runs identically on client and server.
  protocol/      Wire format and snapshot encoding.
  server/        Authoritative room host, 64 Hz fixed-step loop.
  client/        Three.js renderer, input capture, HUD, latency instrumentation.
  playbook/      2D play simulator core — map data, play model, playback engine. DOM-free.
  playbook-app/  The playbook's canvas UI: strat editor and timeline.
docs/
  PLAN.md       Full plan: pillars, netcode design, roadmap, risks, budget.
  M0-NOTES.md   What M0 built, where it deviates from the plan, bugs the tests caught.
  PLAYBOOK.md   The 2D play simulator: data model, timing model, shortcuts, non-goals.
```

`packages/sim` is the only package that is not replaceable. It runs unchanged on both ends, and prediction works by comparing the two — so determinism is enforced rather than hoped for:

- eslint bans `Date`, `performance`, `Math.random`, DOM globals, and the implementation-approximated `Math` functions inside `packages/sim`
- `sim/math.ts` supplies exact replacements built only from operations the ECMAScript spec pins down — polynomial `dsin`/`dcos` with Cody-Waite range reduction, plus `dexp2`/`dlog2`/`dpow`
- CI asserts two independent 10,000-tick runs hash identically, that the hash actually varies with input, and that a snapshot/replay round trip reproduces state exactly

`Math.sin` and friends are only *approximated* by the spec, so V8 and SpiderMonkey may return different last bits. That would desync a Firefox client from a Node server and present as rubber-banding — a genuinely expensive bug to trace from the symptom.

## Playbook — the 2D play simulator

A top-down strat board for drawing a round and watching it execute at real speed. Place ten
players, draw where they walk, add the utility with its timings, then scrub and see whether the
smoke is actually up when the entry crosses Long Doors.

```bash
pnpm dev:playbook     # http://localhost:5174
```

Ships with three worked Dust 2 plays. `V` select · `P` draw a path · `S F M H D` smoke, flash,
molotov, HE, decoy · `K` measure a distance and how long it takes to walk · `Space` play ·
`[ ]` playback speed down to 0.1× · `E` presentation mode · `?` for the full list.

Legs are timed from their length at the real `MOVE.RUN` / `WALK` / `CROUCH` speeds, so a drawn
path takes as long as it would take to walk; pin a waypoint's arrival time when a beat has to
be exact, and the tool flags a pin that demands more speed than a player has. Plays export as
`.play.json` or as a self-contained `#p=` share link.

It is a separate tool that shares the game's units and coordinate frame but deliberately does
**not** run `packages/sim` — see [docs/PLAYBOOK.md](docs/PLAYBOOK.md) for why, and for what is
deliberately absent (no line-of-sight, no collision).

The Dust 2 layout is hand-authored original geometry with community callout names, calibrated
against the game's published radar constants so that playbook positions *are* real world
positions — the inspector hands you a `setpos` for any spot you select, so a coordinate you
doubt can be checked by walking it. The extent and the four spawn/bombsite anchors are exact;
what sits between them is hand-placed and approximate. Provenance, and the sources deliberately
rejected, are in [ASSETS.md](ASSETS.md).

## Stack

| | |
|---|---|
| Client | TypeScript · Three.js · Vite · DOM HUD |
| Server | Node 22 · one authoritative room per process · 64 Hz fixed-step sim |
| Netcode | Server-authoritative now; prediction + rollback + lag comp in M1 |
| Transport | WebSocket today; WebTransport datagrams with WS fallback in M1 |
| Collision | Hand-written swept-AABB solver — not a physics engine, deliberately |

## Roadmap

M0 ✅ netcode spike · **M1 netcode spine** (prediction, rollback, lag comp, bit-packed protocol) · M2 feel pass · M3 rounds and economy · M4 audio and feedback · M5 content and bots · M6 ship to the group chat

Each milestone has a hard, playable exit gate. See §11 of the plan.

## Legal

Not affiliated with or endorsed by Valve. No Valve assets, maps, models, sounds, or trademarks are used or will be. All content is original; asset provenance is tracked in [ASSETS.md](ASSETS.md). See §2 of the plan.

The playbook's Dust 2 layout is hand-authored original geometry reproducing layout relationships and community callout names — no Valve file was consulted, extracted, decompiled or traced. "Dust II" and "Counter-Strike" are Valve trademarks; the naming question that applies if the playbook is ever published is recorded in [ASSETS.md](ASSETS.md).
