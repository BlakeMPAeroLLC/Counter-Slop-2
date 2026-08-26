# The Playbook — 2D play simulator

A top-down strat board for drawing a round and then watching it execute at real speed. Place
ten players, draw where they walk, add the utility with its timings, then scrub the timeline
and see whether the smoke is actually up when the entry crosses Long Doors.

```bash
pnpm dev:playbook     # http://localhost:5174
```

It ships with three worked Dust 2 plays (an A split, a B rush, a CT default) which double as
the smoke test for the whole pipeline.

## Why it is not the game

This is a separate tool that happens to live in the same repository. It shares the game's
**units, coordinate frame and movement speeds** and nothing else:

- It does **not** run `packages/sim`. A strat board answers "where should this player be at
  12.4 seconds", which is a different question from "given these button presses and this brush
  soup, where does the hull end up". Routing a drawn arrow through the real solver would
  require Dust 2 to exist as playable brushes before you could draw anything, and would turn
  every timing tweak into a collision-debugging session.
- It is a **kinematic animator**: straight legs, steady-state speeds. That is enough for the
  thing that matters — a Long push takes about as long here as it does in game — without
  pretending to be a simulation.
- The one number it borrows and must never get wrong is speed. `packages/playbook/src/units.ts`
  mirrors `MOVE.RUN` / `WALK` / `CROUCH` from the sim rather than importing them (so a drawing
  tool does not pull the deterministic simulation into its bundle), and
  `tests/units.test.ts` fails CI if the mirror drifts.

## Packages

| Package | What it is |
|---|---|
| `@cs2/playbook` | DOM-free core: map definitions, the play model, the playback engine, the edit reducer, file and share codecs. All pure functions and plain data, so all of it is unit-tested. |
| `@cs2/playbook-app` | The Vite app: a 2D-canvas renderer, the editor, the timeline. |

eslint bans `window`, `document`, `navigator`, `localStorage`, `fetch` and `CompressionStream`
inside `packages/playbook/src`. That is what keeps the core testable under Vitest's `node`
environment and reusable later by the game client (an in-game minimap is an M3 item).

Note it is *not* the sim's determinism guard: `Date` and `Math.random` are fine here. A strat
board never has to agree bit-for-bit with a server.

## Coordinates

Everything is in **sim units on the sim's XZ ground plane**. 1 unit ≈ 1 inch, a player is 72
tall and 32 wide, running is 250 u/s — so a 1000-unit corridor is four seconds, and those
intuitions transfer straight into the game.

```
+x is east  -> screen right -> A side
+z is south -> screen down  -> T side
```

The engine is Y-up, so a top-down view *is* the XZ plane and there is no conversion anywhere.
That also means a map authored for the playbook could later be extruded into real
`MapBuilder` brushes — `Region.floorY` and `Region.height` are populated with that in mind.
Doing that extrusion is explicitly **not** in scope; the door is just left open.

## Time

Time is **integer ticks at 64 Hz**, matching `SIM.TICK_HZ`. Integers mean a play scrubs to
exactly reproducible frames, a saved file has no `0.30000000000000004` in it, and two people
agree on what "1.42 seconds in" means down to the frame. Seconds appear only in the UI.

Rendering samples at a *fractional* tick, so playback is as smooth as the monitor rather than
strobing at 64 fps.

## The timing model

Each leg's duration is **derived** from its length and its movement mode, cascading from the
actor's `startTick`. Draw a path and it takes as long as it would take to walk.

A waypoint can also **pin** its arrival time (`arriveTick`), and then the leg into it stretches
or squeezes to hit that moment. Pins are how you say "these two pairs hit A Cross together"
rather than hoping. The resolved leg reports `impliedSpeed`, so a pin that demands more than
250 u/s is flagged orange in the inspector and on the timeline instead of quietly lying.

The hybrid matters: pure timestamps make you hand-author forty numbers and produce plays that
lie about how long a rotate takes; pure derivation makes "the smoke lands as the entry crosses"
impossible to express.

`holdTicks` inserts a stationary leg. A hold on the *first* waypoint means "wait on spawn",
which is how you delay a lurk without touching `startTick`.

## Utility

`packages/playbook/src/units.ts` holds each grenade's active duration, effect radius, and bloom
and fade ramps. Flight time is derived from throw distance, so a long lineup visibly takes
longer to land than a drop-smoke.

The bloom ramp is not decoration. A smoke that snaps to full opacity the frame it lands reads
as instant cover, and people then write plays that depend on cover they will not have for
another second.

These numbers are our own approximations calibrated to feel right, not extracted values.

## Tools and shortcuts

| Key | Tool |
|---|---|
| `V` | Select — drag handles, drag empty map to pan, Alt-click a path to insert a bend |
| `P` | Path — click to append waypoints to the selected player |
| `S` `F` `M` `H` `D` | Smoke / flash / molotov / HE / decoy — drag lineup → landing spot |
| `A` `T` `O` | Arrow / text / zone annotation |
| `K` | Measure — distance plus run/walk/crouch time. The most-used tool in a timing argument |
| `B` | Bomb plant position, at the playhead |

| Key | |
|---|---|
| `7` `8` `9` | Draw run / walk / crouch |
| `Z` `X` `C` | Draw onto lower / ground / upper layer |
| `Shift` + those | Show or dim that layer |
| `1`–`5` | Select player |
| `Space` | Play / pause |
| `←` `→` | Step one tick (`Shift` for a second) |
| `[` `]` | Playback speed (down to 0.1×) |
| `Home` `End` `0` | Start / end / fit map |
| `L` `R` `G` | Toggle callouts / paths / grid |
| `E` | Presentation mode — hides the editing chrome |
| `Cmd/Ctrl+Z` | Undo (`+Shift` to redo) |

Drag a diamond on a timeline lane to pin that waypoint's arrival time.

## Layers

Dust 2 stacks: upper tunnels sit above lower tunnels, the A plateau above A ramp. Every region
and waypoint declares a layer, and unchecked layers render **dimmed rather than hidden** — you
still see where they are, they just stop competing for attention. It is how the tunnels stay
legible without a 3D view.

## Persistence

| | |
|---|---|
| Autosave | Debounced write to `localStorage`, restored on load. |
| Library | Named saves in `localStorage`; the bundled examples are seeded on first run. |
| Files | `Export` writes `<slug>.play.json`, pretty-printed with stable key order so plays diff cleanly in git. Import via the button or by dropping the file on the window. |
| Share link | `#p=<base64url(deflate-raw(json))>`. No server, and a URL fragment is never sent to the host. A full ten-player play is around 2 KB; anything over 12 KB is refused rather than silently truncated. |

Every `localStorage` access is wrapped — Safari private browsing and quota exhaustion both
throw, and neither should take the editor down. A corrupt autosave is dropped rather than
wedging startup.

## Adding a map

Write one data module exporting a `MapDef` and add it to `MAPS` in
`packages/playbook/src/maps/index.ts`. Nothing in the renderer, the editor or the engine knows
a map by name. `tests/mapdef.test.ts` validates every registered map, so a malformed polygon is
a red build rather than a confusing afternoon.

## Dust 2 accuracy, and the legal position

The layout is hand-authored original geometry with community callout names. **No Valve asset
was used and none may be added.** Distances are approximate — proportions and connectivity are
right, exact measurements are not. Full provenance, and the trademark question that applies if
this is ever published, is in [`ASSETS.md`](../ASSETS.md).

## What is deliberately not here

- **Line of sight.** No raycasting, so a smoke does not actually occlude a view cone and a
  flash does not check whether anyone could see it. Vision cones are a facing indicator only.
- **Collision.** Paths go through walls if you draw them through walls. `mapdef.test.ts`
  checks the bundled plays stay on floor geometry; your own plays are not checked.
- **Brush extrusion.** The geometry is *shaped* to make a future `tools/playbook2brush` pass
  possible. That tool does not exist.
