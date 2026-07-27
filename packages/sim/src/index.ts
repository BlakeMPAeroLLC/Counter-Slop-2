/**
 * @cs2/sim — the deterministic game simulation.
 *
 * This package is the only one in the repo that is not replaceable. It runs unchanged on
 * the client and the server, and its output must be bit-identical on both, because client
 * prediction works by comparing the two. See docs/PLAN.md §4 and §5.
 *
 * Hard constraints, enforced by eslint in `eslint.config.js`:
 *   - no wall-clock time (`Date`, `performance`) — the sim advances by tick count only
 *   - no `Math.random` — draw from the world's xorshift stream instead
 *   - no DOM or Node globals — it must run headless
 *   - no implementation-approximated `Math` functions — use `dsin`/`dcos`/`dpow` from math.ts
 */

export * from './collision.js'
export * from './command.js'
export * from './constants.js'
export * from './hitscan.js'
export * from './map.js'
export * from './math.js'
export * from './movement.js'
export * from './tick.js'
export * from './weapons.js'
export * from './world.js'
