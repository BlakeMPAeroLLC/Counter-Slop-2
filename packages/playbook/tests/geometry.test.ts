import { describe, expect, it } from 'vitest'
import {
  angleDelta,
  boundsOf,
  distanceToSegment,
  expandBounds,
  heading,
  lerpAngle,
  normalize,
  pointAlongPolyline,
  pointInBounds,
  pointInPolygon,
  polylineLength,
  rectRing,
} from '../src/geometry.js'

const v = (x: number, z: number) => ({ x, z })

describe('polylineLength', () => {
  it('sums the segments', () => {
    expect(polylineLength([v(0, 0), v(3, 4), v(3, 14)])).toBe(15)
  })

  it('is zero for fewer than two points', () => {
    expect(polylineLength([])).toBe(0)
    expect(polylineLength([v(5, 5)])).toBe(0)
  })
})

describe('pointAlongPolyline', () => {
  const line = [v(0, 0), v(100, 0), v(100, 100)]

  it('walks into the second segment', () => {
    expect(pointAlongPolyline(line, 150)).toEqual(v(100, 50))
  })

  it('clamps at the start', () => {
    expect(pointAlongPolyline(line, -50)).toEqual(v(0, 0))
  })

  it('clamps at the end rather than extrapolating off the map', () => {
    expect(pointAlongPolyline(line, 9999)).toEqual(v(100, 100))
  })

  it('survives a duplicated vertex', () => {
    expect(pointAlongPolyline([v(0, 0), v(0, 0), v(10, 0)], 5)).toEqual(v(5, 0))
  })
})

describe('normalize', () => {
  it('returns a unit vector', () => {
    const n = normalize(v(3, 4))
    expect(n.x).toBeCloseTo(0.6)
    expect(n.z).toBeCloseTo(0.8)
  })

  it('returns zero rather than NaN for a zero-length input', () => {
    expect(normalize(v(0, 0))).toEqual(v(0, 0))
  })
})

describe('heading', () => {
  it('points +x at zero radians, so screen-right is zero', () => {
    expect(heading(v(0, 0), v(10, 0))).toBeCloseTo(0)
  })

  it('increases towards +z, which is screen-down', () => {
    expect(heading(v(0, 0), v(0, 10))).toBeCloseTo(Math.PI / 2)
  })
})

describe('angleDelta / lerpAngle', () => {
  it('takes the short way round the wrap', () => {
    expect(angleDelta(3.0, -3.0)).toBeCloseTo(Math.PI * 2 - 6, 5)
    expect(Math.abs(angleDelta(3.0, -3.0))).toBeLessThan(Math.PI)
  })

  it('interpolates across the wrap without spinning the long way', () => {
    const mid = lerpAngle(3.1, -3.1, 0.5)
    // Halfway between 3.1 and -3.1 the short way is just past PI, not near 0.
    expect(Math.abs(mid)).toBeGreaterThan(3.1)
  })
})

describe('distanceToSegment', () => {
  it('measures perpendicular distance inside the segment', () => {
    expect(distanceToSegment(v(50, 30), v(0, 0), v(100, 0))).toBeCloseTo(30)
  })

  it('measures to the nearest endpoint past the ends', () => {
    expect(distanceToSegment(v(-40, 0), v(0, 0), v(100, 0))).toBeCloseTo(40)
  })

  it('handles a degenerate segment', () => {
    expect(distanceToSegment(v(3, 4), v(0, 0), v(0, 0))).toBeCloseTo(5)
  })
})

describe('pointInPolygon', () => {
  const square = rectRing(0, 0, 100, 100)

  it('accepts an interior point', () => {
    expect(pointInPolygon(v(50, 50), square)).toBe(true)
  })

  it('rejects an exterior point', () => {
    expect(pointInPolygon(v(150, 50), square)).toBe(false)
  })

  it('handles a concave ring', () => {
    // An L shape: the notch must read as outside.
    const l = [v(0, 0), v(100, 0), v(100, 40), v(40, 40), v(40, 100), v(0, 100)]
    expect(pointInPolygon(v(20, 80), l)).toBe(true)
    expect(pointInPolygon(v(80, 80), l)).toBe(false)
  })
})

describe('bounds helpers', () => {
  it('computes a bounding box', () => {
    expect(boundsOf([v(-10, 5), v(30, -20), v(0, 0)])).toEqual({
      minX: -10,
      maxX: 30,
      minZ: -20,
      maxZ: 5,
    })
  })

  it('returns an empty box for no points rather than Infinity', () => {
    expect(boundsOf([])).toEqual({ minX: 0, minZ: 0, maxX: 0, maxZ: 0 })
  })

  it('expands on every side', () => {
    expect(expandBounds({ minX: 0, minZ: 0, maxX: 10, maxZ: 10 }, 5)).toEqual({
      minX: -5,
      minZ: -5,
      maxX: 15,
      maxZ: 15,
    })
  })

  it('tests containment inclusively at the edge', () => {
    expect(pointInBounds(v(10, 10), { minX: 0, minZ: 0, maxX: 10, maxZ: 10 })).toBe(true)
  })
})
