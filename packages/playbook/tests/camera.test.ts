import { describe, expect, it } from 'vitest'
import {
  MAX_SCALE,
  MIN_SCALE,
  fitBounds,
  panBy,
  screenToWorld,
  screenToWorldSize,
  visibleBounds,
  worldToScreen,
  zoomAt,
} from '../src/camera.js'

const vp = { width: 800, height: 600 }
const cam = { center: { x: 100, z: -200 }, scale: 0.25 }

describe('worldToScreen / screenToWorld', () => {
  it('puts the camera centre at the middle of the viewport', () => {
    expect(worldToScreen(cam, vp, cam.center)).toEqual({ x: 400, z: 300 })
  })

  it('draws +z downward, so north on the map is up on screen', () => {
    const north = worldToScreen(cam, vp, { x: 100, z: -1200 })
    expect(north.z).toBeLessThan(300)
  })

  it('round-trips at several zoom levels', () => {
    for (const scale of [0.03, 0.1, 0.25, 0.8, 1.2]) {
      const c = { center: { x: -450, z: 900 }, scale }
      const world = { x: 1234.5, z: -678.25 }
      const back = screenToWorld(c, vp, worldToScreen(c, vp, world))
      expect(back.x).toBeCloseTo(world.x, 6)
      expect(back.z).toBeCloseTo(world.z, 6)
    }
  })

  it('converts a pixel length into map units', () => {
    expect(screenToWorldSize(cam, 10)).toBe(40)
  })
})

describe('zoomAt', () => {
  it('holds the map point under the cursor still', () => {
    const anchor = { x: 620, z: 140 }
    const before = screenToWorld(cam, vp, anchor)
    const zoomed = zoomAt(cam, vp, anchor, 1.6)
    const after = screenToWorld(zoomed, vp, anchor)
    expect(after.x).toBeCloseTo(before.x, 6)
    expect(after.z).toBeCloseTo(before.z, 6)
  })

  it('still holds the anchor when zooming out', () => {
    const anchor = { x: 30, z: 570 }
    const before = screenToWorld(cam, vp, anchor)
    const zoomed = zoomAt(cam, vp, anchor, 0.4)
    const after = screenToWorld(zoomed, vp, anchor)
    expect(after.x).toBeCloseTo(before.x, 6)
    expect(after.z).toBeCloseTo(before.z, 6)
  })

  it('clamps to the zoom limits', () => {
    expect(zoomAt(cam, vp, { x: 400, z: 300 }, 1000).scale).toBe(MAX_SCALE)
    expect(zoomAt(cam, vp, { x: 400, z: 300 }, 0.0001).scale).toBe(MIN_SCALE)
  })
})

describe('panBy', () => {
  it('moves the world with the cursor', () => {
    // Dragging right by 100px should move the camera centre left in world space.
    const panned = panBy(cam, 100, 0)
    expect(panned.center.x).toBeLessThan(cam.center.x)
  })

  it('is scale-aware, so panning feels the same at every zoom', () => {
    const tight = panBy({ ...cam, scale: 1 }, 100, 0)
    const wide = panBy({ ...cam, scale: 0.1 }, 100, 0)
    expect(Math.abs(wide.center.x - cam.center.x)).toBeGreaterThan(
      Math.abs(tight.center.x - cam.center.x),
    )
  })
})

describe('fitBounds', () => {
  const bounds = { minX: -2600, minZ: -2500, maxX: 2600, maxZ: 2350 }

  it('centres on the bounds', () => {
    const fit = fitBounds(bounds, vp)
    expect(fit.center.x).toBeCloseTo(0)
    expect(fit.center.z).toBeCloseTo(-75)
  })

  it('fits the whole map inside the viewport', () => {
    const fit = fitBounds(bounds, vp)
    const view = visibleBounds(fit, vp)
    expect(view.minX).toBeLessThanOrEqual(bounds.minX)
    expect(view.maxX).toBeGreaterThanOrEqual(bounds.maxX)
    expect(view.minZ).toBeLessThanOrEqual(bounds.minZ)
    expect(view.maxZ).toBeGreaterThanOrEqual(bounds.maxZ)
  })

  it('does not divide by zero on degenerate bounds', () => {
    const fit = fitBounds({ minX: 0, minZ: 0, maxX: 0, maxZ: 0 }, vp)
    expect(Number.isFinite(fit.scale)).toBe(true)
  })
})
