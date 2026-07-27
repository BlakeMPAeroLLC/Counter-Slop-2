import { describe, expect, it } from 'vitest'
import {
  angleDelta,
  dcos,
  dexp2,
  dlog2,
  dpow,
  dsin,
  PI,
  rngNext,
  rngUnit,
  TWO_PI,
} from '../src/math.js'

/**
 * These tests do two jobs:
 *  1. Confirm the deterministic replacements are actually *correct* (compared against the
 *     native Math functions, which are accurate even though they are not portable).
 *  2. Confirm they are self-consistent, which is the property the netcode depends on.
 */

describe('deterministic trig', () => {
  it('matches Math.sin across several periods', () => {
    for (let i = -2000; i <= 2000; i++) {
      const a = i * 0.0157
      expect(dsin(a)).toBeCloseTo(Math.sin(a), 13)
    }
  })

  it('matches Math.cos across several periods', () => {
    for (let i = -2000; i <= 2000; i++) {
      const a = i * 0.0157
      expect(dcos(a)).toBeCloseTo(Math.cos(a), 13)
    }
  })

  it('is exact at the quadrant boundaries', () => {
    expect(dsin(0)).toBeCloseTo(0, 12)
    expect(dsin(PI / 2)).toBeCloseTo(1, 12)
    expect(dsin(PI)).toBeCloseTo(0, 12)
    expect(dsin(-PI / 2)).toBeCloseTo(-1, 12)
    expect(dcos(0)).toBeCloseTo(1, 12)
    expect(dcos(PI)).toBeCloseTo(-1, 12)
  })

  it('handles large arguments without losing the plot', () => {
    // Range reduction should keep working far from the origin, which is where naive
    // implementations start returning garbage.
    for (const a of [1000, -1000, 12345.6789, TWO_PI * 500 + 0.3]) {
      expect(dsin(a)).toBeCloseTo(Math.sin(a), 6)
    }
  })

  it('produces identical results on repeated calls', () => {
    const a = 3.7
    expect(dsin(a)).toBe(dsin(a))
    expect(dcos(a)).toBe(dcos(a))
  })
})

/**
 * `toBeCloseTo` compares absolute difference, which is meaningless for a function whose
 * output spans many orders of magnitude — 1e-12 relative error on 2^22 is an absolute
 * error of 5e-6. Exponentials are checked on relative error instead.
 */
function expectRelClose(actual: number, expected: number, maxRel: number): void {
  const denom = Math.abs(expected) > 0 ? Math.abs(expected) : 1
  expect(Math.abs(actual - expected) / denom).toBeLessThan(maxRel)
}

describe('deterministic exp2 / log2 / pow', () => {
  it('dexp2 matches 2**x to 1e-12 relative across a wide range', () => {
    for (let i = -60; i <= 60; i++) {
      const x = i * 0.37
      expectRelClose(dexp2(x), 2 ** x, 1e-12)
    }
  })

  it('dexp2 is exact on integer inputs', () => {
    // Powers of two are exactly representable, so there is no excuse for drift here.
    for (let k = -60; k <= 60; k++) {
      expect(dexp2(k)).toBe(2 ** k)
    }
  })

  it('dlog2 matches Math.log2 over a wide range', () => {
    for (const x of [1e-6, 0.001, 0.5, 0.97, 1, 1.5, 2, 7, 100, 4096, 1e9]) {
      expect(dlog2(x)).toBeCloseTo(Math.log2(x), 12)
    }
    // Sweep the mantissa range, including either side of the sqrt(2) fold.
    for (let i = 1; i <= 400; i++) {
      const x = 1 + i * 0.0025
      expect(dlog2(x)).toBeCloseTo(Math.log2(x), 12)
    }
  })

  it('dlog2 is exact on powers of two', () => {
    for (let k = -60; k <= 60; k++) {
      expect(dlog2(2 ** k)).toBe(k)
    }
  })

  it('dlog2 handles subnormals', () => {
    expect(dlog2(5e-320)).toBeCloseTo(Math.log2(5e-320), 6)
  })

  it('dpow matches ** for the cases gameplay uses', () => {
    // Damage falloff: 0.97 ^ (distance / 500)
    for (let d = 0; d <= 8192; d += 137) {
      expect(dpow(0.97, d / 500)).toBeCloseTo(0.97 ** (d / 500), 10)
    }
    // Movement inaccuracy: speedRatio ^ 1.35
    for (let i = 0; i <= 100; i++) {
      const r = i / 100
      expect(dpow(r, 1.35)).toBeCloseTo(r ** 1.35, 10)
    }
  })

  it('dpow handles the degenerate inputs gameplay can actually hit', () => {
    expect(dpow(0, 1.35)).toBe(0)
    expect(dpow(1, 999)).toBe(1)
    expect(dpow(0.5, 0)).toBe(1)
  })
})

describe('rng', () => {
  it('is a pure function of its state', () => {
    expect(rngNext(12345)).toBe(rngNext(12345))
  })

  it('never gets stuck at zero', () => {
    let s = 0
    for (let i = 0; i < 10; i++) {
      s = rngNext(s)
      expect(s).not.toBe(0)
    }
  })

  it('produces values in [0, 1) and covers the range', () => {
    let s = 1
    let min = 1
    let max = 0
    const buckets = new Array<number>(10).fill(0)
    for (let i = 0; i < 100_000; i++) {
      s = rngNext(s)
      const u = rngUnit(s)
      expect(u).toBeGreaterThanOrEqual(0)
      expect(u).toBeLessThan(1)
      if (u < min) min = u
      if (u > max) max = u
      buckets[Math.floor(u * 10)]! += 1
    }
    expect(min).toBeLessThan(0.001)
    expect(max).toBeGreaterThan(0.999)
    // Rough uniformity: no decile should be wildly off 10%.
    for (const b of buckets) {
      expect(b).toBeGreaterThan(7000)
      expect(b).toBeLessThan(13000)
    }
  })
})

describe('angleDelta', () => {
  it('takes the short way around', () => {
    expect(angleDelta(0, 0.5)).toBeCloseTo(0.5, 12)
    expect(angleDelta(0.5, 0)).toBeCloseTo(-0.5, 12)
    // Crossing the wrap point should be a small delta, not nearly a full turn.
    expect(angleDelta(-3.0, 3.0)).toBeCloseTo(6.0 - TWO_PI, 12)
    expect(Math.abs(angleDelta(-3.1, 3.1))).toBeLessThan(0.1)
  })
})
