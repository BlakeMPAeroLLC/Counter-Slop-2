# Counter-Slop 2

A stylized, browser-native tactical shooter in the Counter-Strike lineage — built so you and your friends can be in a match 20 seconds after someone shares a link.

Round-based bomb defusal. Punishing movement. Precise hitscan. Server-authoritative netcode with prediction and lag compensation. Low-poly flat-shaded art that reads instantly. No installs, no accounts, no patch day.

## Status

Pre-M0. The plan is written; the code is not.

## Start here

**[docs/PLAN.md](docs/PLAN.md)** — the full plan of action: design pillars, stack decision and rejected alternatives, netcode architecture, gameplay specs with real tuning numbers, map pipeline, art direction, infrastructure, a 7-milestone roadmap with hard exit gates, test strategy, risk register, and budget.

## Stack (planned)

| | |
|---|---|
| Client | TypeScript · Three.js · Vite · Preact HUD |
| Server | Node 22 · one authoritative process per room · 64 Hz fixed-step sim |
| Netcode | Client prediction + rollback · entity interpolation · server-side rewind lag comp |
| Transport | WebTransport datagrams → WebSocket fallback |
| Shared | `packages/sim` — one deterministic simulation, run identically on both sides |

## Legal

Not affiliated with or endorsed by Valve. No Valve assets, maps, models, sounds, or trademarks are used or will be. All content is original; asset provenance is tracked in `ASSETS.md`. See §2 of the plan.
