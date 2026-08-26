/**
 * `@cs2/playbook` — the DOM-free core of the 2D play simulator.
 *
 * Everything here is pure data and pure functions: map definitions, the play model, the
 * kinematic playback engine, the edit reducer, and the file/share codecs. Nothing touches
 * `window` or `document`, which is what lets it be unit-tested under Vitest's `node`
 * environment and, later, reused by the game client for an in-game minimap or round review.
 */

export * from './types.js'
export * from './units.js'
export * from './geometry.js'
export * from './world.js'
export * from './camera.js'
export * from './timeline.js'
export * from './clock.js'
export * from './play.js'
export * from './edits.js'
export * from './serialize.js'
export * from './share.js'
export * from './validate.js'
export * from './maps/index.js'
export * from './plays/index.js'
