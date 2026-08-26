import { describe, expect, it } from 'vitest'
import {
  formatGetPos,
  fromRadarFraction,
  fromRadarPixel,
  fromWorld,
  radarBounds,
  toRadarPixel,
  toWorld,
} from '../src/world.js'
import { DUST2 } from '../src/maps/dust2.js'
import { pointInBounds } from '../src/geometry.js'
import type { RadarCalibration } from '../src/types.js'

/** The published de_dust2 overview constants, restated so the test does not read the map. */
const DUST2_RADAR: RadarCalibration = {
  posX: -2476,
  posY: 3239,
  scale: 4.4,
  imageSize: 1024,
  source: 'test fixture',
}

describe('fromWorld / toWorld', () => {
  it('negates only the north axis', () => {
    expect(fromWorld({ x: 500, y: 1200 })).toEqual({ x: 500, z: -1200 })
    expect(toWorld({ x: 500, z: -1200 })).toEqual({ x: 500, y: 1200 })
  })

  it('puts the T side at positive z, so south draws downward', () => {
    // T spawn is at negative world Y; it must land at positive z (screen-down).
    expect(fromWorld({ x: -719, y: -861 }).z).toBeGreaterThan(0)
    // CT spawn is at positive world Y; negative z (screen-up).
    expect(fromWorld({ x: 318, y: 2293 }).z).toBeLessThan(0)
  })

  it('round-trips', () => {
    for (const p of [
      { x: 0, y: 0 },
      { x: -2476, y: 3239 },
      { x: 1128.5, y: -861.25 },
    ]) {
      expect(toWorld(fromWorld(p))).toEqual(p)
    }
  })

  /**
   * Regression: negating a zero gives `-0`, which `JSON.stringify` writes as `"0"` while
   * `Object.is(-0, 0)` is false. Before this was normalised, every point on the Y axis — and
   * the whole Mid corridor sits near it — failed to survive a save and reload.
   */
  it('never produces a negative zero', () => {
    const a = fromWorld({ x: 0, y: 0 })
    expect(Object.is(a.x, 0)).toBe(true)
    expect(Object.is(a.z, 0)).toBe(true)

    const b = fromWorld({ x: -0, y: -0 })
    expect(Object.is(b.x, 0)).toBe(true)
    expect(Object.is(b.z, 0)).toBe(true)

    const c = toWorld({ x: 0, z: 0 })
    expect(Object.is(c.x, 0)).toBe(true)
    expect(Object.is(c.y, 0)).toBe(true)
  })
})

describe('radarBounds', () => {
  it('derives the published Dust 2 extent from the overview constants', () => {
    const b = radarBounds(DUST2_RADAR)
    // pos_x is the upper-left world X; the image is 1024 px at 4.4 units per px.
    expect(b.minX).toBe(-2476)
    expect(b.maxX).toBeCloseTo(-2476 + 1024 * 4.4, 6)
    // pos_y is the *northern* edge, which is the most negative z in this frame.
    expect(b.minZ).toBe(-3239)
    expect(b.maxZ).toBeCloseTo(-(3239 - 1024 * 4.4), 6)
  })

  it('produces a square map, as a square radar implies', () => {
    const b = radarBounds(DUST2_RADAR)
    expect(b.maxX - b.minX).toBeCloseTo(b.maxZ - b.minZ, 6)
  })
})

describe('radar pixel transform', () => {
  it('maps the image corners to the world corners', () => {
    expect(fromRadarPixel(DUST2_RADAR, { x: 0, z: 0 })).toEqual({ x: -2476, z: -3239 })
    const br = fromRadarPixel(DUST2_RADAR, { x: 1024, z: 1024 })
    expect(br.x).toBeCloseTo(2029.6, 4)
    expect(br.z).toBeCloseTo(1266.6, 4)
  })

  it('round-trips', () => {
    for (const px of [
      { x: 0, z: 0 },
      { x: 512, z: 512 },
      { x: 831.25, z: 44.5 },
    ]) {
      const back = toRadarPixel(DUST2_RADAR, fromRadarPixel(DUST2_RADAR, px))
      expect(back.x).toBeCloseTo(px.x, 6)
      expect(back.z).toBeCloseTo(px.z, 6)
    }
  })
})

/**
 * The calibration claim.
 *
 * `maps/dust2.ts` states that its geometry is fitted to four anchor positions taken from the
 * published overview constants. These assertions are what stop that from becoming a comment
 * that used to be true: if someone nudges a spawn line or a bombsite, the map stops agreeing
 * with the game's own coordinates and this fails.
 */
describe('Dust 2 calibration', () => {
  const radar = DUST2.radar
  const anchor = (fx: number, fy: number) => {
    expect(radar).toBeDefined()
    return fromRadarFraction(radar ?? DUST2_RADAR, fx, fy)
  }

  it('records the overview constants on the map', () => {
    expect(radar?.posX).toBe(-2476)
    expect(radar?.posY).toBe(3239)
    expect(radar?.scale).toBe(4.4)
    expect(radar?.imageSize).toBe(1024)
  })

  it('takes its bounds from the calibration rather than from a guess', () => {
    expect(DUST2.bounds).toEqual(radarBounds(radar ?? DUST2_RADAR))
  })

  /** Tolerance is generous: the anchors are two-decimal fractions of a 4506-unit map. */
  const NEAR = 260

  it('centres each spawn line on the published spawn anchor', () => {
    const cases = [
      { team: 'T' as const, at: anchor(0.39, 0.91) },
      { team: 'CT' as const, at: anchor(0.62, 0.21) },
    ]
    for (const c of cases) {
      const line = DUST2.spawns.filter((sp) => sp.team === c.team)
      expect(line).toHaveLength(5)
      const mx = line.reduce((n, sp) => n + sp.at.x, 0) / line.length
      const mz = line.reduce((n, sp) => n + sp.at.z, 0) / line.length
      expect(Math.abs(mx - c.at.x), `${c.team} spawn x`).toBeLessThan(NEAR)
      expect(Math.abs(mz - c.at.z), `${c.team} spawn z`).toBeLessThan(NEAR)
    }
  })

  it('centres each bombsite on the published bomb anchor', () => {
    const cases = [
      { id: 'A', at: anchor(0.8, 0.16) },
      { id: 'B', at: anchor(0.21, 0.12) },
    ]
    for (const c of cases) {
      const site = DUST2.bombsites.find((sp) => sp.id === c.id)
      expect(site, c.id).toBeDefined()
      if (site === undefined) continue
      const cx = (site.bounds.minX + site.bounds.maxX) / 2
      const cz = (site.bounds.minZ + site.bounds.maxZ) / 2
      expect(Math.abs(cx - c.at.x), `site ${c.id} x`).toBeLessThan(NEAR)
      expect(Math.abs(cz - c.at.z), `site ${c.id} z`).toBeLessThan(NEAR)
    }
  })

  /**
   * The structural facts the anchors corrected. An eyeballed Dust 2 gets both of these
   * backwards, and both change how a play reads, so they are asserted rather than trusted.
   */
  it('places both bombsites north of CT spawn', () => {
    const ct = anchor(0.62, 0.21)
    for (const id of ['A', 'B']) {
      const site = DUST2.bombsites.find((sp) => sp.id === id)
      expect(site).toBeDefined()
      if (site === undefined) continue
      const cz = (site.bounds.minZ + site.bounds.maxZ) / 2
      // North is -z, so a site north of CT spawn has the smaller z.
      expect(cz, `site ${id} should be north of CT spawn`).toBeLessThan(ct.z)
    }
  })

  it('offsets the spawns from each other, T west and CT east', () => {
    const tx = DUST2.spawns.filter((s) => s.team === 'T').reduce((n, s) => n + s.at.x, 0) / 5
    const cx = DUST2.spawns.filter((s) => s.team === 'CT').reduce((n, s) => n + s.at.x, 0) / 5
    expect(tx).toBeLessThan(0)
    expect(cx).toBeGreaterThan(0)
    // Roughly a thousand units apart, which is why the CT rotate to A beats the rotate to B.
    expect(cx - tx).toBeGreaterThan(700)
  })

  it('keeps every region inside the calibrated extent', () => {
    for (const region of DUST2.regions) {
      for (const p of region.points) {
        expect(pointInBounds(p, DUST2.bounds), `${region.id} (${p.x}, ${p.z})`).toBe(true)
      }
    }
  })
})

describe('formatGetPos', () => {
  it('emits a console command in the game frame', () => {
    expect(formatGetPos(fromWorld({ x: 1128.5, y: 2518.1 }))).toBe('setpos 1128.5 2518.1 0')
  })

  it('does not print a negative zero', () => {
    expect(formatGetPos({ x: 0, z: 0 })).toBe('setpos 0.0 0.0 0')
  })
})
