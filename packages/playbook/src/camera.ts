/**
 * Camera: the transform between map space (sim units) and screen space (CSS pixels).
 *
 * Lives in the core rather than next to the canvas so the round-trip is unit-tested. A
 * zoom-at-cursor that drifts by a pixel per wheel notch is the kind of bug that makes an
 * editor feel cheap, and it is trivially testable as pure arithmetic.
 *
 * Screen mapping, with `scale` in pixels per unit:
 *     sx = (x - center.x) * scale + width / 2
 *     sy = (z - center.z) * scale + height / 2
 *
 * +z is south, so it draws downward and north on the map is up on the screen. No axis flip.
 */

import type { Bounds, Vec2 } from './types.js'

export interface Camera {
  /** Map-space point at the centre of the viewport. */
  readonly center: Vec2
  /** Screen pixels per map unit. */
  readonly scale: number
}

export interface Viewport {
  readonly width: number
  readonly height: number
}

/** Widest and tightest zoom. A whole map fits at ~0.08; 1.0 is nose-on-the-crate. */
export const MIN_SCALE = 0.02
export const MAX_SCALE = 1.2

export function clampScale(scale: number): number {
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale))
}

export function worldToScreen(cam: Camera, vp: Viewport, p: Vec2): Vec2 {
  return {
    x: (p.x - cam.center.x) * cam.scale + vp.width / 2,
    z: (p.z - cam.center.z) * cam.scale + vp.height / 2,
  }
}

export function screenToWorld(cam: Camera, vp: Viewport, s: Vec2): Vec2 {
  return {
    x: (s.x - vp.width / 2) / cam.scale + cam.center.x,
    z: (s.z - vp.height / 2) / cam.scale + cam.center.z,
  }
}

/** Screen-pixel length back to map units. Used to keep grab handles a constant size. */
export function screenToWorldSize(cam: Camera, pixels: number): number {
  return pixels / cam.scale
}

/**
 * Zooms by `factor` while holding the map point under `anchor` (a screen position) still.
 *
 * This is the whole reason the camera is testable: "wheel over Long Doors zooms into Long
 * Doors" is a one-line assertion here and a guessing game if it lives in an event handler.
 */
export function zoomAt(cam: Camera, vp: Viewport, anchor: Vec2, factor: number): Camera {
  const before = screenToWorld(cam, vp, anchor)
  const scale = clampScale(cam.scale * factor)
  const after = screenToWorld({ center: cam.center, scale }, vp, anchor)
  return {
    scale,
    center: {
      x: cam.center.x + (before.x - after.x),
      z: cam.center.z + (before.z - after.z),
    },
  }
}

/** Pans by a screen-space delta. */
export function panBy(cam: Camera, dxPixels: number, dzPixels: number): Camera {
  return {
    scale: cam.scale,
    center: { x: cam.center.x - dxPixels / cam.scale, z: cam.center.z - dzPixels / cam.scale },
  }
}

/** Fits `bounds` into the viewport with `pad` pixels of margin on the tighter axis. */
export function fitBounds(bounds: Bounds, vp: Viewport, pad = 24): Camera {
  const w = Math.max(1, bounds.maxX - bounds.minX)
  const h = Math.max(1, bounds.maxZ - bounds.minZ)
  const usableW = Math.max(1, vp.width - pad * 2)
  const usableH = Math.max(1, vp.height - pad * 2)
  return {
    center: { x: (bounds.minX + bounds.maxX) / 2, z: (bounds.minZ + bounds.maxZ) / 2 },
    scale: clampScale(Math.min(usableW / w, usableH / h)),
  }
}

/** Map-space rectangle currently visible. Lets the renderer skip off-screen geometry. */
export function visibleBounds(cam: Camera, vp: Viewport): Bounds {
  const halfW = vp.width / 2 / cam.scale
  const halfH = vp.height / 2 / cam.scale
  return {
    minX: cam.center.x - halfW,
    maxX: cam.center.x + halfW,
    minZ: cam.center.z - halfH,
    maxZ: cam.center.z + halfH,
  }
}
