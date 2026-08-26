/**
 * Conversion between this tool's coordinates and Counter-Strike's world coordinates.
 *
 * The two frames differ by exactly one thing. Counter-Strike is Z-up, so its ground plane is
 * (X, Y) with +Y pointing north. This tool is Y-up (matching the game engine in
 * `packages/sim`), so its ground plane is (x, z) with +z pointing *south* — which is what
 * makes a top-down draw need no axis flip, since screen-down is +z.
 *
 *     x = X          z = -Y
 *
 * Same units, same origin, one negated axis. That is deliberate: it means a position in this
 * tool and a `getpos` readout in game are the same number up to that sign, so a timing
 * argument can be settled by walking it.
 */

import type { RadarCalibration, Vec2 } from './types.js'

/** A point in Counter-Strike's ground plane: X east, Y north. */
export interface WorldXY {
  readonly x: number
  readonly y: number
}

/**
 * Counter-Strike world (X, Y) -> this tool's (x, z).
 *
 * The `|| 0` is load-bearing, not defensive noise: negating a zero in IEEE-754 gives `-0`,
 * `JSON.stringify(-0)` writes `"0"`, and `Object.is(-0, 0)` is false — so a point anywhere on
 * the Y axis would fail to survive a save and reload. Normalising here kills it at the source.
 */
export function fromWorld(p: WorldXY): Vec2 {
  return { x: p.x || 0, z: -p.y || 0 }
}

/** This tool's (x, z) -> Counter-Strike world (X, Y). Same zero normalisation. */
export function toWorld(p: Vec2): WorldXY {
  return { x: p.x || 0, y: -p.z || 0 }
}

/**
 * Formats a position the way the game's `getpos` does, so it can be pasted into a console.
 *
 * Height is not modelled here, so it is reported as 0 rather than guessed at.
 */
export function formatGetPos(p: Vec2): string {
  const w = toWorld(p)
  return `setpos ${w.x.toFixed(1)} ${w.y.toFixed(1)} 0`
}

/**
 * World extent implied by a radar calibration.
 *
 * The overview file gives the upper-left corner and the units per pixel; the image is square,
 * so the rest follows. Returned in this tool's frame, ready to use as `MapDef.bounds`.
 */
export function radarBounds(cal: RadarCalibration): {
  minX: number
  minZ: number
  maxX: number
  maxZ: number
} {
  const span = cal.imageSize * cal.scale
  return {
    minX: cal.posX,
    maxX: cal.posX + span,
    // posY is the *top* of the image, i.e. the most northerly point — which is the most
    // negative z in this frame.
    minZ: -cal.posY,
    maxZ: -(cal.posY - span),
  }
}

/**
 * Position on the radar image, in pixels, for a point in this tool's frame.
 *
 * This is the transform every radar and demo-analysis tool uses. It exists here so that
 * aligning against a radar image, or importing positions from a demo, is arithmetic rather
 * than reverse engineering.
 */
export function toRadarPixel(cal: RadarCalibration, p: Vec2): Vec2 {
  const w = toWorld(p)
  return { x: (w.x - cal.posX) / cal.scale, z: (cal.posY - w.y) / cal.scale }
}

/** Inverse of `toRadarPixel`. */
export function fromRadarPixel(cal: RadarCalibration, px: Vec2): Vec2 {
  return fromWorld({ x: cal.posX + px.x * cal.scale, y: cal.posY - px.z * cal.scale })
}

/**
 * Converts a normalised (0..1) radar position into this tool's frame.
 *
 * The overview file states spawn and bombsite positions this way, and those four points are
 * the anchors the hand-authored geometry is fitted to.
 */
export function fromRadarFraction(cal: RadarCalibration, fx: number, fy: number): Vec2 {
  return fromRadarPixel(cal, { x: fx * cal.imageSize, z: fy * cal.imageSize })
}
