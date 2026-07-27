/**
 * Deterministic math for the simulation.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * ECMAScript specifies `Math.sin`, `Math.cos`, `Math.pow`, `Math.exp` and friends as
 * *implementation-approximated*: an engine may return any value within an
 * implementation-defined tolerance. V8 (Chrome, Node), SpiderMonkey (Firefox) and
 * JavaScriptCore (Safari) genuinely disagree in the last bits.
 *
 * Client-side prediction works by running the identical simulation on both ends and
 * comparing results. A one-ULP difference in `Math.sin` compounds over replayed ticks
 * into visible rubber-banding that looks exactly like a netcode bug and is miserable
 * to trace. So the sim uses the polynomial `dsin`/`dcos` below, which are built from
 * nothing but `+`, `-`, `*`, `/` and `Math.floor` — all of which ARE exactly specified.
 *
 * `Math.sqrt` is also safe: IEEE-754 requires it to be correctly rounded, and the
 * ECMAScript spec defers to IEEE-754 for it.
 *
 * The eslint config enforces this by banning the unsafe `Math` members inside
 * `packages/sim/src`.
 */

export const PI = 3.141592653589793
export const TWO_PI = 6.283185307179586
export const HALF_PI = 1.5707963267948966
export const QUARTER_PI = 0.7853981633974483
export const INV_TWO_PI = 0.15915494309189535
export const DEG2RAD = 0.017453292519943295
export const RAD2DEG = 57.29577951308232

/**
 * Taylor series for sin on [0, PI/4], truncated after x^15.
 *
 * The term count is set by the interval: at x = PI/4 the first dropped term (x^17/17!) is
 * about 5e-17, i.e. below one ULP of the result. Truncating earlier is tempting and wrong —
 * stopping at x^9 leaves an error near 2e-9, which is larger than several gameplay
 * quantities this feeds (spread cones are ~6e-4 rad).
 */
function sinPoly(x: number): number {
  const x2 = x * x
  return (
    x *
    (1 +
      x2 *
        (-0.16666666666666666 +
          x2 *
            (0.008333333333333333 +
              x2 *
                (-0.0001984126984126984 +
                  x2 *
                    (0.0000027557319223985893 +
                      x2 *
                        (-2.505210838544172e-8 +
                          x2 * (1.6059043836821613e-10 + x2 * -7.647163731819816e-13)))))))
  )
}

/** Taylor series for cos on [0, PI/4], truncated after x^16. Same accuracy argument. */
function cosPoly(x: number): number {
  const x2 = x * x
  return (
    1 +
    x2 *
      (-0.5 +
        x2 *
          (0.041666666666666664 +
            x2 *
              (-0.001388888888888889 +
                x2 *
                  (0.0000248015873015873 +
                    x2 *
                      (-2.755731922398589e-7 +
                        x2 *
                          (2.08767569878681e-9 +
                            x2 * (-1.1470745597729725e-11 + x2 * 4.779477332387385e-14)))))))
  )
}

/**
 * 2*PI split into a head with only 8 significant bits and the remaining tail.
 *
 * Reducing with a single `a - n*TWO_PI` loses precision through cancellation once `a` is
 * large: a yaw that has accumulated to 30 rad reduces to ~0.3 and drops two decimal
 * digits in the process. Subtracting the head first (exact, because `n * PI2_HI` needs no
 * rounding for any `n` a game will ever see) and the tail second — the Cody-Waite trick —
 * keeps the full precision of the result.
 */
const PI2_HI = 6.28125
/** Nearest double to (true 2*PI - PI2_HI); PI2_HI + PI2_LO reproduces 2*PI exactly. */
const PI2_LO = 0.001935307179586477

/**
 * Deterministic sine. Range-reduces the argument into [0, PI/4] where the polynomials
 * above are accurate, using only exactly-specified operations.
 */
export function dsin(a: number): number {
  const n = Math.floor(a * INV_TWO_PI)
  let x = a - n * PI2_HI - n * PI2_LO

  // The two-step reduction can land a hair outside the interval; nudge it back.
  if (x < 0) x += TWO_PI
  else if (x >= TWO_PI) x -= TWO_PI

  let sign = 1
  if (x >= PI) {
    x -= PI
    sign = -1
  }
  // sin is symmetric about PI/2 on [0, PI].
  if (x > HALF_PI) x = PI - x

  return sign * (x <= QUARTER_PI ? sinPoly(x) : cosPoly(HALF_PI - x))
}

/** Deterministic cosine, expressed via `dsin` so there is only one reduction path. */
export function dcos(a: number): number {
  return dsin(a + HALF_PI)
}

/** IEEE-754 correctly rounded, therefore deterministic. Aliased for intent. */
export const dsqrt: (x: number) => number = Math.sqrt

// ── Deterministic exp2 / log2 / pow ─────────────────────────────────────────
//
// `Math.pow` is implementation-approximated like the trig functions, but damage falloff
// (`falloff ^ (distance/500)`) and the movement-inaccuracy curve (`speedRatio ^ 1.35`)
// both need it. So it is rebuilt here from exactly-specified parts.
//
// Without this, the first time gameplay needs an exponent someone reaches for `Math.pow`
// and quietly reintroduces cross-engine divergence, or disables the lint rule that is
// protecting the whole prediction system.

const LN2 = 0.6931471805599453
const INV_LN2 = 1.4426950408889634
const SQRT2 = 1.4142135623730951

const bits = new DataView(new ArrayBuffer(8))

/**
 * Exact 2^k for integer k, by repeated squaring. Every intermediate is a power of two and
 * therefore exactly representable, so there is no rounding anywhere in here.
 */
function scalb2(k: number): number {
  let n = k < 0 ? -k : k
  let base = k < 0 ? 0.5 : 2
  let r = 1
  while (n > 0) {
    if ((n & 1) === 1) r *= base
    base *= base
    n >>= 1
  }
  return r
}

/**
 * Taylor series for e^y. Callers keep |y| <= LN2/2 (~0.347), where truncating after the
 * y^11 term leaves a relative error near 1e-13.
 */
function expSmall(y: number): number {
  return (
    1 +
    y *
      (1 +
        y *
          (0.5 +
            y *
              (0.16666666666666666 +
                y *
                  (0.041666666666666664 +
                    y *
                      (0.008333333333333333 +
                        y *
                          (0.001388888888888889 +
                            y *
                              (0.0001984126984126984 +
                                y *
                                  (0.0000248015873015873 +
                                    y *
                                      (0.0000027557319223985893 +
                                        y * 2.755731922398589e-7)))))))))
  )
}

/**
 * Deterministic 2^x.
 *
 * Reduction uses `round` rather than `floor` so the fractional part lands in [-0.5, 0.5]
 * instead of [0, 1). That halves the range the series has to cover, which buys three
 * decimal digits of accuracy for free.
 */
export function dexp2(x: number): number {
  if (x !== x) return NaN
  if (x > 1023) return Infinity
  if (x < -1074) return 0

  const k = Math.round(x)
  const f = x - k
  return scalb2(k) * expSmall(f * LN2)
}

/**
 * Deterministic log2(x) for x > 0.
 *
 * Splits x into mantissa and exponent via its IEEE-754 bits (exactly specified by
 * DataView), then evaluates log on the mantissa's narrow [1, 2) range where the
 * atanh series converges in a handful of terms.
 */
export function dlog2(x: number): number {
  if (x !== x || x < 0) return NaN
  if (x === 0) return -Infinity
  if (x === Infinity) return Infinity

  bits.setFloat64(0, x)
  const hi = bits.getUint32(0)
  let e = ((hi >>> 20) & 0x7ff) - 1023

  if (e === -1023) {
    // Subnormal: scale into the normal range and correct afterwards.
    return dlog2(x * 4503599627370496) - 52
  }

  // Force the exponent field to 0 so the value becomes the mantissa in [1, 2).
  bits.setUint32(0, (hi & 0x800fffff) | (1023 << 20))
  let m = bits.getFloat64(0)

  // Re-centre the mantissa on 1 by folding [sqrt2, 2) down to [sqrt2/2, 1). Halving is
  // exact, and it shrinks |t| below from 0.33 to 0.18 — worth roughly four decimal digits
  // for the cost of one comparison.
  if (m > SQRT2) {
    m *= 0.5
    e += 1
  }

  // ln(m) = 2 * atanh(t) with t = (m-1)/(m+1); |t| <= 0.1716 so this converges quickly.
  const t = (m - 1) / (m + 1)
  const t2 = t * t
  const ln =
    2 *
    t *
    (1 +
      t2 *
        (0.3333333333333333 +
          t2 *
            (0.2 +
              t2 *
                (0.14285714285714285 +
                  t2 *
                    (0.1111111111111111 +
                      t2 *
                        (0.09090909090909091 +
                          t2 * (0.07692307692307693 + t2 * 0.06666666666666667)))))))

  return e + ln * INV_LN2
}

/**
 * Deterministic a^b. Only the positive-base case gameplay actually needs; negative bases
 * return NaN rather than pretending to handle integer exponents.
 */
export function dpow(a: number, b: number): number {
  if (b === 0) return 1
  if (a === 0) return b > 0 ? 0 : Infinity
  if (a === 1) return 1
  if (a < 0) return NaN
  return dexp2(b * dlog2(a))
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** Shortest signed angular difference b - a, wrapped to (-PI, PI]. */
export function angleDelta(a: number, b: number): number {
  let d = b - a
  d -= Math.floor(d * INV_TWO_PI + 0.5) * TWO_PI
  return d
}

// ── Deterministic RNG ────────────────────────────────────────────────────────
//
// xorshift32. The whole simulation draws from one stream stored in the world, so
// the RNG advances identically on client and server. `Math.random` is banned.

/** Advance an xorshift32 state. Never returns 0 for a non-zero input. */
export function rngNext(state: number): number {
  let s = state | 0
  // A zero state is absorbing for xorshift; steer away from it.
  if (s === 0) s = 0x9e3779b9
  s ^= s << 13
  s = s >>> 0
  s ^= s >>> 17
  s ^= s << 5
  return s >>> 0
}

/** Map an RNG state to a float in [0, 1). */
export function rngUnit(state: number): number {
  return (state >>> 0) / 4294967296
}

/** Map an RNG state to an integer in [0, n). */
export function rngBelow(state: number, n: number): number {
  return Math.floor(rngUnit(state) * n) % n
}

// ── Vectors ─────────────────────────────────────────────────────────────────
//
// The hot path must not allocate: a per-tick, per-player `{x,y,z}` object would
// hand the GC ~640 objects/second per room, and a collection pause during a spray
// transfer is worse than a lower frame rate. So vectors are plain mutable structs
// drawn from module-level scratch. `step()` is not reentrant, which makes this safe.

export interface Vec3 {
  x: number
  y: number
  z: number
}

export function vec3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z }
}

export function vset(o: Vec3, x: number, y: number, z: number): Vec3 {
  o.x = x
  o.y = y
  o.z = z
  return o
}

export function vcopy(o: Vec3, a: Vec3): Vec3 {
  o.x = a.x
  o.y = a.y
  o.z = a.z
  return o
}

export function vlen(a: Vec3): number {
  return dsqrt(a.x * a.x + a.y * a.y + a.z * a.z)
}

export function vlenXZ(a: Vec3): number {
  return dsqrt(a.x * a.x + a.z * a.z)
}

export function vdot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z
}

/** Normalizes in place and returns the original length. */
export function vnorm(o: Vec3): number {
  const len = vlen(o)
  if (len > 0) {
    const inv = 1 / len
    o.x *= inv
    o.y *= inv
    o.z *= inv
  }
  return len
}

/**
 * Horizontal forward and right basis vectors for a given yaw.
 *
 * Convention: yaw 0 looks down -Z (matching a default Three.js camera), and
 * increasing yaw turns left (counter-clockwise seen from above).
 */
export function yawForward(out: Vec3, yaw: number): Vec3 {
  return vset(out, -dsin(yaw), 0, -dcos(yaw))
}

export function yawRight(out: Vec3, yaw: number): Vec3 {
  return vset(out, dcos(yaw), 0, -dsin(yaw))
}

/** Full view direction including pitch. Positive pitch looks up. */
export function viewDir(out: Vec3, yaw: number, pitch: number): Vec3 {
  const cp = dcos(pitch)
  return vset(out, -dsin(yaw) * cp, dsin(pitch), -dcos(yaw) * cp)
}

/**
 * Builds an orthonormal basis around `dir` and offsets it by a random point inside a
 * disc of angular radius `spread`. Uses the sqrt-of-uniform mapping so the
 * distribution over the disc is uniform rather than clustered at the centre.
 *
 * Returns the advanced RNG state; the caller must store it back into the world.
 */
export function spreadDir(out: Vec3, dir: Vec3, spread: number, rngState: number): number {
  if (spread <= 0) {
    vcopy(out, dir)
    return rngState
  }

  const s1 = rngNext(rngState)
  const s2 = rngNext(s1)
  const r = dsqrt(rngUnit(s1)) * spread
  const theta = TWO_PI * rngUnit(s2)

  // Pick the world axis least aligned with `dir` so the cross product is stable.
  let ax = 0
  let ay = 1
  let az = 0
  if (dir.y > 0.9 || dir.y < -0.9) {
    ax = 1
    ay = 0
    az = 0
  }

  // tangent = normalize(cross(dir, a))
  let tx = dir.y * az - dir.z * ay
  let ty = dir.z * ax - dir.x * az
  let tz = dir.x * ay - dir.y * ax
  const tl = dsqrt(tx * tx + ty * ty + tz * tz) || 1
  tx /= tl
  ty /= tl
  tz /= tl

  // bitangent = cross(dir, tangent); already unit since both inputs are unit and orthogonal.
  const bx = dir.y * tz - dir.z * ty
  const by = dir.z * tx - dir.x * tz
  const bz = dir.x * ty - dir.y * tx

  const ox = r * dcos(theta)
  const oy = r * dsin(theta)

  out.x = dir.x + tx * ox + bx * oy
  out.y = dir.y + ty * ox + by * oy
  out.z = dir.z + tz * ox + bz * oy
  vnorm(out)

  return s2
}
