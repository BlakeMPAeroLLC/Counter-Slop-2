# M0 — implementation notes

What was actually built, where it deviates from [PLAN.md](PLAN.md), and what the exit gate
measured. Read this before judging how the build feels.

---

## What M0 deliberately does not do

The plan's M0 is the **netcode spike**: prove the simulation and measure the loop before
building anything on top of it. Two things are missing on purpose, and both are M1's job:

| Missing | Symptom you will see | Fixed by |
|---|---|---|
| Client-side prediction | Your own movement lags by roughly the RTT | M1 prediction + rollback |
| Entity interpolation | Other players step at 32 Hz instead of moving smoothly | M1 interpolation buffer |

View angles **are** local and immediate — mouse look never waits for a round trip. That
isolates the problem: aiming feels instant while movement does not, which is exactly the gap
prediction closes. The net panel in the top-left is the instrument, and it exists *before* the
fix so the fix can be judged against a number rather than a memory.

Fixing this by feel now, before the measurement existed, is how projects end up with netcode
nobody understands.

---

## Deviations from the plan

Five, all deliberate. Each is a case where writing the code revealed the plan was slightly
wrong, or under-specified.

### 1. Player collision uses an AABB hull, not a capsule

PLAN.md §3 says "swept capsule". The implementation uses an axis-aligned box (32 × 72 × 32).

This is **more** faithful, not less: Source uses an AABB hull for player movement collision and
reserves capsules for hitboxes. It is also exact — an AABB-vs-AABB sweep reduces to a
ray-vs-slab test after a Minkowski expansion, with no iterative solver and no tolerance
parameter to tune. A capsule sweep against box geometry needs closest-point-on-segment work
that buys nothing here.

Capsules still arrive for **hitboxes** in M2, where the eight-capsule skeleton-driven set
replaces M0's two-box model.

### 2. The sim needed its own `pow`, `exp2` and `log2`

Not in the plan, but forced by it. The determinism lint bans the implementation-approximated
`Math` functions, and two gameplay formulas the plan specifies need exponents:

- damage falloff — `falloff ^ (distance / 500)`
- movement inaccuracy — `speedRatio ^ 1.35`

Without deterministic replacements, the first person to implement either formula either reaches
for `Math.pow` (reintroducing cross-engine divergence) or disables the lint rule protecting the
whole prediction system. So `math.ts` supplies `dexp2`/`dlog2`/`dpow` built only from
exactly-specified operations, tested against the native functions to ~1e-12 relative.

### 3. `step()` mutates the world instead of returning a new one

PLAN.md §4 specifies `step(world, inputs) → world`. The implementation is
`step(world, cmds): void`.

Purity was only ever a proxy for the property that actually matters, which is determinism.
Allocating a fresh world per tick would hand the GC ~64 objects per second per player for no
benefit, and the plan's own §13 risk #4 warns specifically about GC pauses during a spray.
Rollback is served by `saveSnapshot`/`loadSnapshot` — byte copies into a preallocated buffer —
which is both faster and what M1 actually needs.

### 4. A second map, `flat`, exists for tests

`dm_box` has an L-shaped wall through the middle by design. That makes it the right map for
testing the movement solver and the wrong map for testing hit registration: whether two spawns
can see each other depends on which spawn the RNG picked, so a hitscan test becomes a coin
flip on level geometry.

`buildFlatMap()` is an empty floor with facing spawn rows. Kinematics tests and network
integration tests both use it. Rooms take a map factory, which M5 needs anyway for map
selection.

### 5. `tsx` runs the server; bundling is deferred

Node's `--experimental-strip-types` resolves `./server.js` literally and cannot find
`server.ts`, and the workspace packages export TypeScript source (which Vite consumes directly).
`tsx` handles both. A proper bundled artifact for the Docker image is an M6 deploy concern.

---

## Bugs the tests caught

Worth recording, because each one is a class of bug rather than a one-off.

**Fall damage could never trigger.** `clipVelocity` removes the velocity component into a
surface, so by the time the ground check ran, vertical speed was already ~0. Landing at
1050 u/s reported an impact speed of 6.25. Impact is now captured inside the slide, at the
collision, before clipping. *Class: reading a value after the thing that destroys it.*

**Half of all game events were silently discarded.** The world clears its event list every
tick, but snapshots go out every *other* tick, and the snapshot writer read `world.events`
directly. Every shot, hit and death landing on a non-snapshot tick was destroyed before any
client saw it. The room now accumulates events across the gap. *Class: two components with
different clocks sharing a buffer.*

**The sin/cos polynomials were four terms too short.** The comment claimed 1e-12; the actual
truncation error was ~2e-9 — larger than a weapon's base spread cone (6e-4 rad at 1 unit).
Extended to x^15/x^16, plus Cody-Waite range reduction so accuracy holds at large accumulated
yaw. *Class: a comment asserting a bound nobody checked.*

**A missed-event race in the test client.** Both clients were constructed before either was
awaited, so the second socket had already fired `'open'` and `once('open')` waited forever.
Every two-client test hung. The open promise is now captured synchronously with construction.
*Class: subscribing to an event that already happened.*

---

## Measured numbers

From the integration suite (`packages/server/tests/integration.test.ts`), 6 clients all moving
and firing in one room, on this container:

| Metric | Value | Budget |
|---|---|---|
| Tick time p99 | < 5 ms (asserted) | 15.625 ms |
| Snapshot rate | 32/s ±  | 32/s |
| Determinism, 10k ticks × 6 players | bit-identical | must be exact |
| Client bundle | 138 KB gzipped | — |

`input→pixel` is measured live in the client and shown in the net panel. It is not asserted in
CI because it depends on the network between two real machines — that is what the M1 gate
(100 ms simulated RTT, 3% loss) exists to pin down.

---

## Test coverage

59 tests, all passing.

| Suite | Count | What it protects |
|---|---|---|
| `sim/tests/determinism` | 7 | Bit-identical replay, snapshot round-trip, no NaN, never escapes the map |
| `sim/tests/math` | 16 | The deterministic trig/exp/log replacements, against native `Math` |
| `sim/tests/movement` | 23 | Run speed, counter-strafe timing, air-strafe gain, stairs, crease corners, crouch ceiling |
| `server/tests/integration` | 13 | Handshake, garbage input, hit registration, kill credit, room isolation, tick budget |

The two highest-value ones are worth calling out:

- **Determinism** asserts two independent 10,000-tick runs hash identically, *and* that the
  hash varies with input (otherwise the first assertion is vacuous).
- **`does not climb the 24-unit ledge`** is the inverse test that keeps `STEP_HEIGHT` honest.
  If step-up silently became more permissive, level design would quietly lose the ability to
  gate movement with a knee-high ledge, and nothing else would fail.

---

## Next: M1

The M1 gate, from PLAN.md §11:

> At a simulated 100 ms RTT with 3% loss, shots land where the crosshair was and local movement
> has zero perceptible input delay. Divergence graph reads flat.

The groundwork is already in place: `saveSnapshot`/`loadSnapshot` for rollback, `lastCmdSeq`
acks flowing to the client, the command-history ring for replay, `subFrac` captured on every
command, and the latency panel to judge it with.
