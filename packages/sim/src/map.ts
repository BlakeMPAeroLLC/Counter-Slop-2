/**
 * Map data and the M0 test arena.
 *
 * M0 geometry is axis-aligned boxes ("brushes") only. That is a deliberate
 * simplification, not a placeholder that needs apologising for: AABB-vs-AABB sweeps
 * reduce to a ray-vs-slab test after a Minkowski expansion, which is exact, branch-light
 * and trivially deterministic. It gets the movement solver correct before triangle
 * soup is introduced.
 *
 * M2 replaces this with `tools/mapc` compiling Blender `.glb` output into a triangle
 * BVH. `MapData` is the seam: the solver only ever asks the map for sweeps and traces,
 * so swapping the backing representation does not touch movement code.
 */

import { MATERIAL } from './constants.js'
import { PI } from './math.js'

export interface Spawn {
  readonly x: number
  readonly y: number
  readonly z: number
  readonly yaw: number
}

export interface MapBounds {
  readonly minX: number
  readonly minY: number
  readonly minZ: number
  readonly maxX: number
  readonly maxY: number
  readonly maxZ: number
}

export interface MapData {
  readonly name: string
  /** Six doubles per brush: minX, minY, minZ, maxX, maxY, maxZ. */
  readonly brushes: Float64Array
  readonly brushCount: number
  /** One entry per brush, indexes into `MATERIAL`. */
  readonly materials: Uint8Array
  /** Spawn points indexed by team id. */
  readonly spawns: readonly (readonly Spawn[])[]
  readonly bounds: MapBounds
}

class MapBuilder {
  private readonly verts: number[] = []
  private readonly mats: number[] = []
  private readonly spawnsByTeam: Spawn[][] = [[], []]

  /** Adds a brush from opposite corners, normalising the ordering. */
  brush(
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
    material: number = MATERIAL.CONCRETE,
  ): this {
    this.verts.push(
      Math.min(x0, x1),
      Math.min(y0, y1),
      Math.min(z0, z1),
      Math.max(x0, x1),
      Math.max(y0, y1),
      Math.max(z0, z1),
    )
    this.mats.push(material)
    return this
  }

  /** Adds a brush by XZ centre, footprint and height. Reads better for props. */
  box(
    cx: number,
    cz: number,
    width: number,
    depth: number,
    height: number,
    baseY = 0,
    material: number = MATERIAL.CONCRETE,
  ): this {
    const hw = width * 0.5
    const hd = depth * 0.5
    return this.brush(cx - hw, baseY, cz - hd, cx + hw, baseY + height, cz + hd, material)
  }

  spawn(team: number, x: number, y: number, z: number, yaw: number): this {
    this.spawnsByTeam[team]?.push({ x, y, z, yaw })
    return this
  }

  build(name: string): MapData {
    const brushCount = this.mats.length
    const brushes = new Float64Array(this.verts)

    let minX = Infinity
    let minY = Infinity
    let minZ = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    let maxZ = -Infinity
    for (let i = 0; i < brushCount; i++) {
      const o = i * 6
      if (brushes[o]! < minX) minX = brushes[o]!
      if (brushes[o + 1]! < minY) minY = brushes[o + 1]!
      if (brushes[o + 2]! < minZ) minZ = brushes[o + 2]!
      if (brushes[o + 3]! > maxX) maxX = brushes[o + 3]!
      if (brushes[o + 4]! > maxY) maxY = brushes[o + 4]!
      if (brushes[o + 5]! > maxZ) maxZ = brushes[o + 5]!
    }

    return {
      name,
      brushes,
      brushCount,
      materials: new Uint8Array(this.mats),
      spawns: this.spawnsByTeam.map((s) => Object.freeze(s.slice())),
      bounds: { minX, minY, minZ, maxX, maxY, maxZ },
    }
  }
}

/**
 * `flat` — an empty floor with distant walls.
 *
 * Two jobs:
 *
 *  1. Kinematics tests (acceleration, friction, counter-strafing, air-strafing, jump arcs)
 *     measure only the solver and cannot accidentally collide with scenery. A tuning
 *     assertion that silently passes because the test player walked into a crate is worse
 *     than no assertion.
 *
 *  2. Network integration tests get GUARANTEED line of sight between spawns. `dm_box` has an
 *     L-shaped wall through the middle by design, so whether two spawns can see each other
 *     there depends on which spawn the RNG picked — a genuinely nasty source of flakiness in
 *     a hit-registration test.
 */
export function buildFlatMap(): MapData {
  const b = new MapBuilder()
  const R = 8192
  b.brush(-R, -64, -R, R, 0, R, MATERIAL.CONCRETE)
  b.brush(-R - 32, 0, -R - 32, R + 32, 512, -R, MATERIAL.CONCRETE)
  b.brush(-R - 32, 0, R, R + 32, 512, R + 32, MATERIAL.CONCRETE)
  b.brush(-R - 32, 0, -R - 32, -R, 512, R + 32, MATERIAL.CONCRETE)
  b.brush(R, 0, -R - 32, R + 32, 512, R + 32, MATERIAL.CONCRETE)

  // Facing rows 512 apart. Spread on X so several players do not stack on one point, and
  // since the map is empty every pairing has clear line of sight regardless of RNG.
  for (const x of [0, -128, 128, -256, 256]) {
    b.spawn(0, x, 0, -256, PI)
    b.spawn(1, x, 0, 256, 0)
  }
  return b.build('flat')
}

/**
 * `dm_box` — the M0 test arena.
 *
 * Exists to exercise every case the movement solver has to get right, and nothing else:
 *   - a large open floor, for acceleration / friction / counter-strafe tuning
 *   - perimeter walls, for slide-along-surface
 *   - an L-shaped interior wall whose inside corner is where naive solvers stick
 *   - free-standing crates, for corner clipping and jumping onto things
 *   - a 4-step staircase at 16 units per rise (under STEP_HEIGHT) that must be walkable
 *   - a 24-unit ledge (over STEP_HEIGHT) that must NOT be walkable, only jumpable
 *   - a 60-unit-high overhang, which you can only pass crouched
 */
export function buildTestArena(): MapData {
  const b = new MapBuilder()
  const R = 768 // arena half-extent
  const WALL_H = 288
  const T = 32 // wall thickness

  // Floor slab, given real depth so a fast fall can never tunnel through it.
  b.brush(-R, -64, -R, R, 0, R, MATERIAL.CONCRETE)

  // Perimeter walls, overlapping at the corners so there is no seam to snag on.
  b.brush(-R - T, 0, -R - T, R + T, WALL_H, -R, MATERIAL.CONCRETE)
  b.brush(-R - T, 0, R, R + T, WALL_H, R + T, MATERIAL.CONCRETE)
  b.brush(-R - T, 0, -R - T, -R, WALL_H, R + T, MATERIAL.CONCRETE)
  b.brush(R, 0, -R - T, R + T, WALL_H, R + T, MATERIAL.CONCRETE)

  // L-shaped interior wall. The inside corner at (-224, -64) is the sticking test.
  b.brush(-256, 0, -64, -224, 160, 288, MATERIAL.CONCRETE)
  b.brush(-256, 0, -96, 64, 160, -64, MATERIAL.CONCRETE)

  // Free-standing crates: jump targets and corner-clip tests.
  b.box(0, 0, 64, 64, 64, 0, MATERIAL.WOOD)
  b.box(96, 64, 64, 64, 64, 0, MATERIAL.WOOD)
  b.box(96, 64, 64, 64, 64, 64, MATERIAL.WOOD) // stacked, so 128 total
  b.box(-448, -448, 96, 96, 48, 0, MATERIAL.METAL)
  b.box(448, 448, 128, 128, 80, 0, MATERIAL.METAL)

  // Staircase rising in +X, 16 units per step. Solid boxes so you cannot fall inside.
  for (let i = 0; i < 4; i++) {
    const x0 = 300 + i * 48
    b.brush(x0, 0, -320, x0 + 48, (i + 1) * 16, -80, MATERIAL.CONCRETE)
  }
  // Platform the staircase arrives at.
  b.brush(492, 0, -320, 700, 64, -80, MATERIAL.CONCRETE)

  // A 24-unit ledge. STEP_HEIGHT is 18, so walking into this must stop you.
  b.brush(-640, 0, 288, -384, 24, 512, MATERIAL.DIRT)

  // Overhang with a 60-unit gap beneath: standing hull (72) blocked, crouched (54) fits.
  b.brush(-128, 60, 384, 128, WALL_H, 544, MATERIAL.METAL)

  // Spawns. Yaw 0 looks down -Z, so the two teams face each other across the arena.
  b.spawn(0, -192, 0, -640, PI)
  b.spawn(0, 0, 0, -640, PI)
  b.spawn(0, 192, 0, -640, PI)
  b.spawn(0, 384, 0, -640, PI)
  b.spawn(0, -384, 0, -640, PI)

  b.spawn(1, -192, 0, 640, 0)
  b.spawn(1, 0, 0, 640, 0)
  b.spawn(1, 192, 0, 640, 0)
  b.spawn(1, 384, 0, 640, 0)
  b.spawn(1, -384, 0, 640, 0)

  return b.build('dm_box')
}
