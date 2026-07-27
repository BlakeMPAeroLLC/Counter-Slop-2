# Counter-Slop 2

A stylized, browser-native tactical shooter in the Counter-Strike lineage — built so you and your friends can be in a match 20 seconds after someone shares a link.

Round-based bomb defusal. Punishing movement. Precise hitscan. Server-authoritative netcode with prediction and lag compensation. Low-poly flat-shaded art that reads instantly. No installs, no accounts, no patch day.

## Status

**M0 complete** — the netcode spike. Two players can connect from separate browsers, move around a test arena, and shoot each other with server-authoritative hitscan and headshots. 59 tests passing.

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
  sim/        THE CORE. Deterministic simulation, runs identically on client and server.
  protocol/   Wire format and snapshot encoding.
  server/     Authoritative room host, 64 Hz fixed-step loop.
  client/     Three.js renderer, input capture, HUD, latency instrumentation.
docs/
  PLAN.md       Full plan: pillars, netcode design, roadmap, risks, budget.
  M0-NOTES.md   What M0 built, where it deviates from the plan, bugs the tests caught.
```

`packages/sim` is the only package that is not replaceable. It runs unchanged on both ends, and prediction works by comparing the two — so determinism is enforced rather than hoped for:

- eslint bans `Date`, `performance`, `Math.random`, DOM globals, and the implementation-approximated `Math` functions inside `packages/sim`
- `sim/math.ts` supplies exact replacements built only from operations the ECMAScript spec pins down — polynomial `dsin`/`dcos` with Cody-Waite range reduction, plus `dexp2`/`dlog2`/`dpow`
- CI asserts two independent 10,000-tick runs hash identically, that the hash actually varies with input, and that a snapshot/replay round trip reproduces state exactly

`Math.sin` and friends are only *approximated* by the spec, so V8 and SpiderMonkey may return different last bits. That would desync a Firefox client from a Node server and present as rubber-banding — a genuinely expensive bug to trace from the symptom.

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

Not affiliated with or endorsed by Valve. No Valve assets, maps, models, sounds, or trademarks are used or will be. All content is original; asset provenance is tracked in `ASSETS.md`. See §2 of the plan.
