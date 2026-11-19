// Collision primitives: swept player hull vs box world, bullet rays, grenade bounces.
//
// A "world" is { boxes, dyn }: `boxes` is the static map, `dyn` (optional) holds boxes
// for other players so that players block each other.
import { NADE } from './constants.js'

export const EPS = 0.03125
const TOL = 0.05

/**
 * Sweep a hull (feet at p, half-width hw, height h) along d.
 * Writes out.frac (0..1, already backed off from the surface), out.hit and the normal.
 */
export function traceHull(world, px, py, pz, dx, dy, dz, hw, h, out) {
  const sb = world.boxes, db = world.dyn
  const ns = sb.length, total = ns + (db ? db.length : 0)
  let best = 1
  let hit = false
  let nx = 0, ny = 0, nz = 0
  for (let i = 0; i < total; i++) {
    const b = i < ns ? sb[i] : db[i - ns]
    const lox = b.x0 - hw, hix = b.x1 + hw
    const loy = b.y0 - h, hiy = b.y1
    const loz = b.z0 - hw, hiz = b.z1 + hw
    let tE = -Infinity, tX = Infinity, axis = -1

    // x
    if (dx === 0) { if (px <= lox + TOL || px >= hix - TOL) continue } else {
      let t0 = (lox - px) / dx, t1 = (hix - px) / dx
      if (t0 > t1) { const t = t0; t0 = t1; t1 = t }
      if (t0 > tE) { tE = t0; axis = 0 }
      if (t1 < tX) tX = t1
    }
    // y
    if (dy === 0) { if (py <= loy + TOL || py >= hiy - TOL) continue } else {
      let t0 = (loy - py) / dy, t1 = (hiy - py) / dy
      if (t0 > t1) { const t = t0; t0 = t1; t1 = t }
      if (t0 > tE) { tE = t0; axis = 1 }
      if (t1 < tX) tX = t1
    }
    // z
    if (dz === 0) { if (pz <= loz + TOL || pz >= hiz - TOL) continue } else {
      let t0 = (loz - pz) / dz, t1 = (hiz - pz) / dz
      if (t0 > t1) { const t = t0; t0 = t1; t1 = t }
      if (t0 > tE) { tE = t0; axis = 2 }
      if (t1 < tX) tX = t1
    }
    if (tE >= tX || tX <= 0 || tE >= best) continue

    if (tE < 0) {
      // Already touching / marginally inside. Find the shallowest axis and only
      // block movement that pushes further in along it.
      const penX = Math.min(px - lox, hix - px)
      const penY = Math.min(py - loy, hiy - py)
      const penZ = Math.min(pz - loz, hiz - pz)
      const pen = Math.min(penX, penY, penZ)
      if (pen >= TOL) continue // genuinely inside: let the player escape
      let into
      if (pen === penX) { axis = 0; into = (px - lox < hix - px) ? dx > 0 : dx < 0 }
      else if (pen === penY) { axis = 1; into = (py - loy < hiy - py) ? dy > 0 : dy < 0 }
      else { axis = 2; into = (pz - loz < hiz - pz) ? dz > 0 : dz < 0 }
      if (!into) continue
      tE = 0
    }
    const da = axis === 0 ? dx : axis === 1 ? dy : dz
    let f = tE - EPS / Math.abs(da)
    if (f < 0) f = 0
    if (f < best || !hit) {
      best = f; hit = true
      nx = 0; ny = 0; nz = 0
      if (axis === 0) nx = dx > 0 ? -1 : 1
      else if (axis === 1) ny = dy > 0 ? -1 : 1
      else nz = dz > 0 ? -1 : 1
    }
  }
  out.frac = best; out.hit = hit; out.nx = nx; out.ny = ny; out.nz = nz
  return out
}

/** True if a hull at this position overlaps any box. */
export function hullBlocked(world, px, py, pz, hw, h) {
  const sb = world.boxes, db = world.dyn
  const ns = sb.length, total = ns + (db ? db.length : 0)
  for (let i = 0; i < total; i++) {
    const b = i < ns ? sb[i] : db[i - ns]
    if (px > b.x0 - hw + TOL && px < b.x1 + hw - TOL &&
        py > b.y0 - h + TOL && py < b.y1 - TOL &&
        pz > b.z0 - hw + TOL && pz < b.z1 + hw - TOL) return true
  }
  return false
}

function rayBox(ox, oy, oz, dx, dy, dz, x0, y0, z0, x1, y1, z1, out) {
  let tE = -Infinity, tX = Infinity, axis = 0
  if (dx === 0) { if (ox < x0 || ox > x1) return Infinity } else {
    let a = (x0 - ox) / dx, b = (x1 - ox) / dx
    if (a > b) { const t = a; a = b; b = t }
    if (a > tE) { tE = a; axis = 0 }
    if (b < tX) tX = b
  }
  if (dy === 0) { if (oy < y0 || oy > y1) return Infinity } else {
    let a = (y0 - oy) / dy, b = (y1 - oy) / dy
    if (a > b) { const t = a; a = b; b = t }
    if (a > tE) { tE = a; axis = 1 }
    if (b < tX) tX = b
  }
  if (dz === 0) { if (oz < z0 || oz > z1) return Infinity } else {
    let a = (z0 - oz) / dz, b = (z1 - oz) / dz
    if (a > b) { const t = a; a = b; b = t }
    if (a > tE) { tE = a; axis = 2 }
    if (b < tX) tX = b
  }
  if (tE > tX || tX < 0) return Infinity
  if (out) { out.axis = axis; out.exit = tX }
  return tE < 0 ? 0 : tE
}

const _rb = { axis: 0, exit: 0 }
/**
 * Bullet vs world. d must be normalised. Returns {t, hit, nx, ny, nz, box, exit}:
 * t === maxDist on a miss; `exit` is where the ray leaves the box it hit (for penetration).
 */
export function rayWorld(boxes, ox, oy, oz, dx, dy, dz, maxDist) {
  let best = maxDist, nx = 0, ny = 0, nz = 0, hit = false, box = null, exit = maxDist
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i]
    const t = rayBox(ox, oy, oz, dx, dy, dz, b.x0, b.y0, b.z0, b.x1, b.y1, b.z1, _rb)
    if (t < best) {
      best = t; hit = true; box = b; exit = _rb.exit
      nx = 0; ny = 0; nz = 0
      if (_rb.axis === 0) nx = dx > 0 ? -1 : 1
      else if (_rb.axis === 1) ny = dy > 0 ? -1 : 1
      else nz = dz > 0 ? -1 : 1
    }
  }
  return { t: best, hit, nx, ny, nz, box, exit }
}

/** True if nothing solid lies between two points. */
export function lineOfSight(boxes, ax, ay, az, bx, by, bz) {
  const dx = bx - ax, dy = by - ay, dz = bz - az
  const d = Math.hypot(dx, dy, dz)
  if (d < 1) return true
  return !rayWorld(boxes, ax, ay, az, dx / d, dy / d, dz / d, d - 0.5).hit
}

/** Bullet vs one player's hitboxes (feet at px,py,pz). Returns null or {t, part}. */
export function rayPlayer(ox, oy, oz, dx, dy, dz, px, py, pz, ducked, maxDist) {
  const h = ducked ? 54 : 72
  let best = maxDist, part = null
  // head sphere
  const cx = px - ox, cy = py + h - 7 - oy, cz = pz - oz
  const proj = cx * dx + cy * dy + cz * dz
  const d2 = cx * cx + cy * cy + cz * cz - proj * proj
  const r = 7
  if (proj > 0 && d2 < r * r) {
    const t = proj - Math.sqrt(r * r - d2)
    if (t < best) { best = Math.max(t, 0); part = 'head' }
  }
  const mid = h * 0.45
  let t = rayBox(ox, oy, oz, dx, dy, dz, px - 11, py + mid, pz - 11, px + 11, py + h - 13, pz + 11, null)
  if (t < best) { best = t; part = 'body' }
  t = rayBox(ox, oy, oz, dx, dy, dz, px - 9, py, pz - 9, px + 9, py + mid, pz + 9, null)
  if (t < best) { best = t; part = 'legs' }
  return part ? { t: best, part } : null
}

const _nt = { frac: 1, hit: false, nx: 0, ny: 0, nz: 0 }
/** Advance a thrown grenade {x,y,z,vx,vy,vz,rest,bounces}. Runs on the server and, for visuals, on clients. */
export function stepNade(n, world, dt) {
  if (n.rest) return
  n.vy -= NADE.GRAVITY * dt
  let tl = dt
  for (let i = 0; i < 3 && tl > 1e-6; i++) {
    const dx = n.vx * tl, dy = n.vy * tl, dz = n.vz * tl
    traceHull(world, n.x, n.y, n.z, dx, dy, dz, 2, 4, _nt)
    n.x += dx * _nt.frac; n.y += dy * _nt.frac; n.z += dz * _nt.frac
    if (!_nt.hit) break
    tl *= 1 - _nt.frac
    if (_nt.nx !== 0) { n.vx = -n.vx * NADE.BOUNCE; n.vy *= 0.9; n.vz *= 0.9 }
    else if (_nt.nz !== 0) { n.vz = -n.vz * NADE.BOUNCE; n.vy *= 0.9; n.vx *= 0.9 }
    else {
      const hard = Math.abs(n.vy) > 60
      n.vy = -n.vy * NADE.BOUNCE; n.vx *= 0.75; n.vz *= 0.75
      if (!hard) {
        n.vy = 0
        if (_nt.ny > 0 && Math.hypot(n.vx, n.vz) < 25) { n.vx = n.vz = 0; n.rest = true; break }
        continue
      }
    }
    n.bounces = (n.bounces || 0) + 1
  }
}
