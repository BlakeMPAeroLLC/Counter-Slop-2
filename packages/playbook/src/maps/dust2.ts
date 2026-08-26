/**
 * Dust 2 — hand-authored top-down layout, calibrated to real world coordinates.
 *
 * Provenance
 * ----------
 * Every polygon in this file was authored by hand. No Valve map file, radar image, `.bsp`,
 * decompiled `.vmf` or nav mesh was used, traced, or committed, and none may be added: this
 * repository ships original assets only (see README "Legal" and `ASSETS.md`).
 *
 * What *is* taken from the game is a short list of published factual constants — the radar
 * overview calibration and four normalised anchor positions, from the `resource/overviews/
 * de_dust2.txt` config that ships with the game and is widely republished. Those are
 * measurements, not artwork, and they are what let this file speak the same coordinates the
 * game does:
 *
 *     pos_x -2476   pos_y 3239   scale 4.4   (1024 px radar)
 *     -> world X in [-2476, 2030], world Y in [-1267, 3239]
 *
 *     CT spawn  (0.62, 0.21) -> world ( 317.5, 2292.8)
 *     T spawn   (0.39, 0.91) -> world (-718.8, -861.1)
 *     Bombsite A(0.80, 0.16) -> world (1128.5, 2518.1)
 *     Bombsite B(0.21, 0.12) -> world (-1529.8, 2698.3)
 *
 * The geometry below is fitted to those four anchors and that extent. Two things the anchors
 * corrected, which an eyeballed layout gets wrong and which change how plays read:
 *
 *   - **Both bombsites are north of CT spawn.** A sits at Y 2518 and B at Y 2698, with CT
 *     spawn at 2293 between and below them. CT spawn is not "at the top of the map"; it is
 *     the hub you climb out of into either site.
 *   - **The spawns are not aligned.** T spawn sits west of centre (X -719) and CT spawn east
 *     of it (X +318), which is why the CT rotate to A is shorter than the rotate to B, and
 *     why T's reach Tunnels sooner than they reach Long.
 *
 * Accuracy, stated plainly
 * ------------------------
 * The extent, the four anchors and therefore the overall scale are right. Everything between
 * them is hand-placed: connectivity and proportion are right, individual corridor widths and
 * corner positions are approximate. So a Long push takes about as long here as it does in
 * game, and a specific 40-unit lineup does not transfer. Fix a coordinate by walking it in a
 * local server and reading `getpos` — `world.ts` has `formatGetPos` for the reverse trip.
 *
 * Frame of reference
 * -----------------
 * Regions are authored in the *game's* frame, X east and Y north, because that is what
 * `getpos` prints and what makes the numbers above checkable. `box()` negates Y on the way in
 * to reach this tool's +z-is-south ground plane. Read every `minY`/`maxY` below as a real
 * world Y.
 */

import type { Bombsite, Callout, Layer, MapDef, RadarCalibration, Region, RegionKind, SpawnPoint, Vec2 } from '../types.js'
import { fromWorld, radarBounds } from '../world.js'

/**
 * The game's own overview calibration.
 *
 * `rotate` and `zoom` from that file are omitted deliberately: they describe how the loading
 * screen presents the image, not the coordinate mapping, and every radar tool ignores them
 * for exactly that reason.
 */
const RADAR: RadarCalibration = {
  posX: -2476,
  posY: 3239,
  scale: 4.4,
  imageSize: 1024,
  source: 'de_dust2 overview config shipped with the game (pos_x/pos_y/scale). Constants only.',
}

/**
 * Terse constructor for the axis-aligned boxes most of the map is made of.
 *
 * `minY`/`maxY` are world Y — north-positive — and are negated here. Authoring in the game's
 * frame is worth the one negation: it means a coordinate in this file can be pasted into a
 * console and checked.
 */
function box(
  id: string,
  kind: RegionKind,
  layer: Layer,
  floorY: number,
  height: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  label?: string,
): Region {
  const points: Vec2[] = [
    fromWorld({ x: minX, y: maxY }),
    fromWorld({ x: maxX, y: maxY }),
    fromWorld({ x: maxX, y: minY }),
    fromWorld({ x: minX, y: minY }),
  ]
  return { id, kind, layer, floorY, height, points, ...(label === undefined ? {} : { label }) }
}

/** Constructor for the handful of areas that genuinely are not rectangles. */
function poly(
  id: string,
  kind: RegionKind,
  layer: Layer,
  floorY: number,
  height: number,
  worldPoints: readonly (readonly [number, number])[],
  label?: string,
): Region {
  return {
    id,
    kind,
    layer,
    floorY,
    height,
    points: worldPoints.map(([x, y]) => fromWorld({ x, y })),
    ...(label === undefined ? {} : { label }),
  }
}

/** Standing height: cover that fully blocks sight. */
const TALL = 128
/** Waist high: crates and cars you shoot over and jump onto. */
const SHORT = 72

// ─────────────────────────────────────────────────────────────────────────────
// Floors
//
// Ordered T half -> Long -> Mid -> Tunnels -> CT hub -> sites, which is roughly the
// order a round unfolds in.
// ─────────────────────────────────────────────────────────────────────────────

const FLOORS: readonly Region[] = [
  // ── T half ────────────────────────────────────────────────────────────────
  box('t-spawn', 'spawn', 'ground', -100, 0, -1450, -1250, 280, -520),

  // ── East: Long ────────────────────────────────────────────────────────────
  box('t-ramp', 'floor', 'ground', -80, 0, 180, -1010, 700, -600),
  box('outside-long', 'floor', 'ground', -40, 0, 550, -820, 1860, -300),
  box('long-doors', 'choke', 'ground', 0, 0, 1450, -330, 1800, -150),
  box('long', 'floor', 'ground', 20, 0, 1450, -300, 1850, 2250),
  // Deep Pit really is below Long, which is why an AWP down there is invisible from the
  // Doors until you are most of the way across.
  box('pit', 'floor', 'lower', -70, 0, 1780, 620, 2024, 1150),

  // ── Mid ───────────────────────────────────────────────────────────────────
  box('t-mid-connector', 'floor', 'ground', -60, 0, -350, -560, -50, 210),
  box('mid', 'floor', 'ground', 0, 0, -350, 200, -50, 1460),
  box('mid-doors', 'choke', 'ground', 0, 0, -350, 760, -50, 880),
  box('top-mid', 'floor', 'ground', 40, 0, -400, 1450, -40, 1780),
  box('short-stairs', 'floor', 'ground', 60, 0, -120, 1480, 260, 1800),
  box('catwalk', 'floor', 'ground', 90, 0, 180, 1750, 700, 1950),
  box('suicide', 'floor', 'ground', 60, 0, -660, 1500, -360, 1770),
  box('ct-mid', 'floor', 'ground', 80, 0, -460, 1750, -40, 2100),

  // ── West: Tunnels ─────────────────────────────────────────────────────────
  box('outside-tunnels', 'floor', 'ground', -60, 0, -1500, -1060, -880, -560),
  box('b-tunnels', 'floor', 'ground', -20, 0, -1900, -620, -1350, 60),
  box('lower-tunnels', 'floor', 'lower', -20, 0, -2100, 0, -1450, 760),
  box('tunnel-stairs', 'floor', 'upper', 40, 0, -2100, 740, -1620, 1010),
  box('upper-tunnels', 'floor', 'upper', 100, 0, -2100, 1000, -1550, 2420),

  // ── CT hub ────────────────────────────────────────────────────────────────
  box('ct-spawn', 'spawn', 'ground', 110, 0, -450, 2050, 750, 2550),
  // The junction every CT rotation passes through: south to Mid, east to A, west to B.
  box('ct-crossroads', 'floor', 'ground', 100, 0, -250, 1880, 500, 2080),
  box('ct-tunnel', 'floor', 'ground', 110, 0, -960, 2300, -380, 2650),
  box('b-window', 'floor', 'ground', 130, 0, -1100, 2150, -900, 2330),
  box('b-doors', 'choke', 'ground', 120, 0, -1200, 2450, -900, 2620),
  box('a-ramp', 'floor', 'ground', 120, 0, 500, 2250, 900, 2600),

  // ── Sites ─────────────────────────────────────────────────────────────────
  box('a-cross', 'floor', 'ground', 110, 0, 620, 1950, 1600, 2200),
  box('a-site', 'site', 'ground', 140, 0, 620, 2150, 1700, 2900, 'A'),
  box('b-site', 'site', 'ground', 120, 0, -2150, 2350, -1100, 3050, 'B'),
]

// ─────────────────────────────────────────────────────────────────────────────
// Cover
//
// Only the cover that changes how a play is written: things you hide behind, jump onto,
// or have to smoke off. Decorative clutter is left out — it makes the drawing noisier
// without changing a single decision.
// ─────────────────────────────────────────────────────────────────────────────

const COVER: readonly Region[] = [
  // A site
  poly(
    'goose',
    'cover',
    'ground',
    140,
    TALL,
    [
      [640, 2400],
      [860, 2400],
      [860, 2160],
      [760, 2160],
      [760, 2290],
      [640, 2290],
    ],
  ),
  box('a-default-crates', 'cover', 'ground', 140, SHORT, 1020, 2380, 1200, 2560),
  box('a-ninja-crate', 'cover', 'ground', 140, TALL, 640, 2680, 800, 2880),
  box('a-elevator', 'cover', 'ground', 140, TALL, 1450, 2650, 1650, 2870),
  box('a-barrels', 'cover', 'ground', 140, SHORT, 1300, 2200, 1400, 2300),

  // Long
  box('blue-container', 'cover', 'ground', 20, TALL, 1500, 1150, 1640, 1350),
  box('long-barrels', 'cover', 'ground', 20, SHORT, 1500, 300, 1600, 400),

  // Mid
  box('xbox', 'cover', 'ground', 0, SHORT, -260, 1150, -120, 1290),
  box('mid-crate', 'cover', 'ground', 0, SHORT, -330, 400, -220, 500),

  // B site
  box('b-car', 'cover', 'ground', 120, SHORT, -1700, 2500, -1480, 2700),
  box('b-plat', 'cover', 'ground', 170, TALL, -1300, 2820, -1110, 3020),
  box('b-back-plat', 'cover', 'ground', 170, TALL, -2140, 2700, -1820, 3040),
  box('b-barrels', 'cover', 'ground', 120, SHORT, -1900, 2400, -1790, 2500),

  // Tunnels
  box('tunnel-crate', 'cover', 'lower', -20, SHORT, -1750, 300, -1630, 420),

  // T spawn
  box('t-spawn-crates', 'cover', 'ground', -100, TALL, -700, -1150, -500, -950),
]

// ─────────────────────────────────────────────────────────────────────────────
// Callouts
//
// The vocabulary. `minScale` hides the fussier names until the view is zoomed in, so a
// whole-map view stays readable while a site-level view names every crate.
// ─────────────────────────────────────────────────────────────────────────────

function callout(
  id: string,
  name: string,
  worldX: number,
  worldY: number,
  layer: Layer = 'ground',
  short?: string,
  minScale?: number,
): Callout {
  return {
    id,
    name,
    at: fromWorld({ x: worldX, y: worldY }),
    layer,
    ...(short === undefined ? {} : { short }),
    ...(minScale === undefined ? {} : { minScale }),
  }
}

const CALLOUTS: readonly Callout[] = [
  // T half
  callout('co-t-spawn', 'T Spawn', -719, -861, 'ground', 'T'),

  // Long
  callout('co-t-ramp', 'T Ramp', 440, -810, 'ground', 'Ramp', 0.05),
  callout('co-outside-long', 'Outside Long', 1100, -560, 'ground', 'Outside'),
  callout('co-long-doors', 'Long Doors', 1625, -240, 'ground', 'Doors'),
  callout('co-long', 'Long A', 1650, 700, 'ground', 'Long'),
  callout('co-pit', 'Deep Pit', 1905, 885, 'lower', 'Pit'),
  callout('co-blue', 'Blue', 1570, 1250, 'ground', undefined, 0.09),
  callout('co-long-corner', 'Long Corner', 1650, 2050, 'ground', 'Corner', 0.05),

  // Mid
  callout('co-lower-mid', 'Lower Mid', -200, -180, 'ground', 'Lower', 0.05),
  callout('co-mid', 'Mid', -200, 480),
  callout('co-mid-doors', 'Mid Doors', -200, 820, 'ground', 'Doors'),
  callout('co-xbox', 'Xbox', -190, 1220, 'ground', undefined, 0.05),
  callout('co-top-mid', 'Top Mid', -220, 1620, 'ground', 'Top'),
  callout('co-suicide', 'Suicide', -510, 1640, 'ground', 'Suic', 0.05),
  callout('co-ct-mid', 'CT Mid', -250, 1930),

  // Short / Catwalk
  callout('co-short-stairs', 'Short Stairs', 70, 1580, 'ground', 'Short'),
  callout('co-catwalk', 'Catwalk', 440, 1850, 'ground', 'Cat'),

  // A side
  callout('co-a-cross', 'A Cross', 1050, 2050, 'ground', 'Cross'),
  callout('co-a-site', 'A Site', 1350, 2600, 'ground', 'A'),
  callout('co-a-default', 'Default', 1110, 2470, 'ground', 'Def', 0.09),
  callout('co-goose', 'Goose', 755, 2340, 'ground', undefined, 0.05),
  callout('co-ninja', 'Ninja', 720, 2780, 'ground', undefined, 0.09),
  callout('co-elevator', 'Elevator', 1550, 2760, 'ground', 'Elev', 0.09),
  callout('co-a-ramp', 'A Ramp', 700, 2420, 'ground', 'Ramp'),

  // CT hub
  callout('co-ct-spawn', 'CT Spawn', 318, 2293, 'ground', 'CT'),
  callout('co-ct-crossroads', 'Crossroads', 120, 1980, 'ground', 'Cross', 0.05),
  callout('co-ct-tunnel', 'CT Tunnel', -670, 2475, 'ground', 'CT Tun'),

  // B side
  callout('co-b-doors', 'B Doors', -1050, 2535, 'ground', 'Doors'),
  callout('co-b-window', 'B Window', -1000, 2240, 'ground', 'Window', 0.05),
  callout('co-b-site', 'B Site', -1530, 2698, 'ground', 'B'),
  callout('co-b-car', 'Car', -1590, 2600, 'ground', undefined, 0.05),
  callout('co-b-plat', 'B Platform', -1205, 2920, 'ground', 'Plat', 0.05),
  callout('co-b-back-plat', 'Back Plat', -1980, 2870, 'ground', 'Back', 0.05),

  // Tunnels
  callout('co-upper-tunnels', 'Upper Tunnels', -1825, 1750, 'upper', 'Upper'),
  callout('co-tunnel-stairs', 'Tunnel Stairs', -1860, 875, 'upper', 'Stairs', 0.05),
  callout('co-lower-tunnels', 'Lower Tunnels', -1775, 380, 'lower', 'Lower'),
  callout('co-b-tunnels', 'B Tunnels', -1625, -280, 'ground', 'Tunnels'),
  callout('co-outside-tunnels', 'Outside Tunnels', -1190, -810, 'ground', 'Outside'),
]

// ─────────────────────────────────────────────────────────────────────────────
// Spawns and sites
//
// Placed on the calibrated anchors, spread along X the way a spawn line is.
// ─────────────────────────────────────────────────────────────────────────────

/** Facing north, towards CT spawn. In this frame north is -z. */
const NORTH = -Math.PI / 2
/** Facing south, towards T spawn. */
const SOUTH = Math.PI / 2

function spawnLine(team: SpawnPoint['team'], centerX: number, worldY: number, facing: number): SpawnPoint[] {
  return [-2, -1, 0, 1, 2].map((i) => ({
    team,
    at: fromWorld({ x: centerX + i * 110, y: worldY }),
    facing,
  }))
}

const SPAWNS: readonly SpawnPoint[] = [
  ...spawnLine('T', -719, -861, NORTH),
  ...spawnLine('CT', 318, 2293, SOUTH),
]

/** Plant zones, centred on the calibrated bombsite anchors. */
const BOMBSITES: readonly Bombsite[] = [
  {
    id: 'A',
    name: 'A Site',
    layer: 'ground',
    bounds: { minX: 680, maxX: 1600, minZ: -2850, maxZ: -2200 },
  },
  {
    id: 'B',
    name: 'B Site',
    layer: 'ground',
    bounds: { minX: -2050, maxX: -1100, minZ: -3000, maxZ: -2400 },
  },
]

export const DUST2: MapDef = {
  id: 'dust2',
  name: 'Dust 2',
  notes:
    'Hand-authored original geometry, calibrated to the real map extent and four anchor ' +
    'positions from the published overview constants. Layout relationships and community ' +
    'callout names are reproduced; the overall scale is right, individual corridor widths ' +
    'and corner positions are approximate. No Valve assets used.',
  bounds: radarBounds(RADAR),
  regions: [...FLOORS, ...COVER],
  callouts: CALLOUTS,
  spawns: SPAWNS,
  bombsites: BOMBSITES,
  radar: RADAR,
}
