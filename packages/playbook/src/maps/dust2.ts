/**
 * Dust 2 — hand-authored top-down layout.
 *
 * Provenance
 * ----------
 * Every coordinate in this file was authored by hand. No Valve asset, radar image, `.bsp`,
 * decompiled brush set or extracted `.vmf` was used, and none may be added: this repository
 * ships original assets only (see README "Legal"). What is reproduced here is the *layout
 * relationships and the community callout vocabulary* — that Long Doors opens onto a long
 * corridor, that Catwalk drops into A Cross, that Xbox sits just short of Mid Doors — which
 * is what a coach needs in order to transcribe a real play.
 *
 * The consequence, stated plainly: distances are approximate. Proportions and connectivity
 * are right, so a Long push takes about as long here as it does in game, but this is not a
 * metrically exact tracing and should not be treated as one. Refine the numbers below
 * against your own in-game measurements (`getpos` in a local server) if a specific timing
 * matters — the geometry editor in the app writes back into exactly this shape.
 *
 * Frame of reference
 * -----------------
 *   +x is east  -> screen right -> A side
 *   -x is west  -> screen left  -> B side
 *   +z is south -> screen down  -> T side
 *   -z is north -> screen up    -> CT side
 *
 * Units are sim units (~1 inch; a player is 72 tall, 32 wide). `floorY` values are the
 * approximate elevation of each area, which is what drives the upper/lower tunnel and A
 * plateau layering rather than any exact height.
 */

import { rectRing } from '../geometry.js'
import type { Bombsite, Callout, Layer, MapDef, Region, RegionKind, SpawnPoint, Vec2 } from '../types.js'

/** Terse constructor for the axis-aligned boxes that most of the map is made of. */
function box(
  id: string,
  kind: RegionKind,
  layer: Layer,
  floorY: number,
  height: number,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
  label?: string,
): Region {
  return {
    id,
    kind,
    layer,
    floorY,
    height,
    points: rectRing(minX, minZ, maxX, maxZ),
    ...(label === undefined ? {} : { label }),
  }
}

/** Constructor for the handful of areas that genuinely are not rectangles. */
function poly(
  id: string,
  kind: RegionKind,
  layer: Layer,
  floorY: number,
  height: number,
  points: readonly Vec2[],
  label?: string,
): Region {
  return { id, kind, layer, floorY, height, points, ...(label === undefined ? {} : { label }) }
}

function at(x: number, z: number): Vec2 {
  return { x, z }
}

/** Standing player height, the default for cover that fully blocks sight. */
const TALL = 128
/** Waist-high cover: crates and cars you shoot over and jump onto. */
const SHORT = 72

// ─────────────────────────────────────────────────────────────────────────────
// Floors
//
// Ordered CT side -> A side -> mid -> B side -> T side, which is roughly how a
// coach walks a new player through the map.
// ─────────────────────────────────────────────────────────────────────────────

const FLOORS: readonly Region[] = [
  // ── CT half ───────────────────────────────────────────────────────────────
  box('ct-spawn', 'spawn', 'ground', 64, 0, -820, -2350, 700, -1800),
  // The junction every CT rotation passes through. Called "CT crossroads" or just
  // "spawn exit"; it is the single most contested rotate in the map.
  box('ct-crossroads', 'floor', 'ground', 64, 0, -300, -1800, 520, -1550),

  // ── A side ────────────────────────────────────────────────────────────────
  box('a-ramp', 'floor', 'ground', 48, 0, 520, -1800, 1250, -1500),
  box('a-site', 'site', 'ground', 96, 0, 1250, -1900, 2450, -1150, 'A'),
  box('a-cross', 'floor', 'ground', 64, 0, 1150, -1150, 2000, -880),
  box('catwalk', 'floor', 'ground', 40, 0, 780, -1020, 1250, -860),
  box('short-stairs', 'floor', 'ground', 16, 0, 600, -880, 820, -560),
  box('long', 'floor', 'ground', 0, 0, 1830, -1150, 2450, 820),
  // Deep Pit is genuinely below Long, which is why an AWP holding Pit is invisible
  // from Long Doors until you are most of the way down.
  box('pit', 'floor', 'lower', -64, 0, 2130, -350, 2470, 300),
  box('long-doors', 'choke', 'ground', 0, 0, 1830, 820, 2200, 980),
  // Extends east to meet the full width of Long Doors. The doorway is wide, and a narrow
  // sliver of overlap here would put the standard Long-push route through solid void.
  box('outside-long', 'floor', 'ground', 32, 0, 950, 980, 2250, 1480),

  // ── Mid ───────────────────────────────────────────────────────────────────
  box('top-mid', 'floor', 'ground', 16, 0, 380, -900, 820, -560),
  box('mid', 'floor', 'ground', 0, 0, 380, -560, 760, 980),
  box('mid-doors', 'choke', 'ground', 0, 0, 380, 120, 760, 280),
  box('suicide', 'floor', 'ground', 16, 0, 60, -760, 380, -560),
  box('ct-mid', 'floor', 'ground', 32, 0, 60, -1550, 520, -760),
  box('t-mid-connector', 'floor', 'ground', 16, 0, 380, 980, 760, 1520),

  // ── B side ────────────────────────────────────────────────────────────────
  box('b-site', 'site', 'ground', 64, 0, -2450, -1950, -1300, -1150, 'B'),
  box('b-doors', 'choke', 'ground', 64, 0, -1300, -1800, -1080, -1650),
  box('b-window', 'floor', 'ground', 88, 0, -1290, -1500, -1080, -1340),
  box('ct-tunnel', 'floor', 'ground', 64, 0, -1080, -1800, -760, -1200),
  box('upper-tunnels', 'floor', 'upper', 64, 0, -2050, -1150, -1450, -620),
  // Spans the full width where Upper meets Lower. Two people go up these side by side.
  box('tunnel-stairs', 'floor', 'upper', 16, 0, -2050, -620, -1500, -380),
  box('lower-tunnels', 'floor', 'lower', -32, 0, -2050, -380, -1200, 300),
  box('b-tunnels', 'floor', 'ground', 0, 0, -1560, 300, -1000, 900),
  box('outside-tunnels', 'floor', 'ground', 16, 0, -1000, 900, -380, 1480),

  // ── T half ────────────────────────────────────────────────────────────────
  box('t-spawn', 'spawn', 'ground', 32, 0, -700, 1480, 900, 2200),
  box('t-ramp', 'floor', 'ground', 32, 0, 760, 1180, 1250, 1620),
]

// ─────────────────────────────────────────────────────────────────────────────
// Cover
//
// Only the cover that changes how a play is written: things you hide behind, jump
// onto, or have to smoke off. Decorative clutter is deliberately omitted — it makes
// the drawing noisier without changing any decision.
// ─────────────────────────────────────────────────────────────────────────────

const COVER: readonly Region[] = [
  // A site
  poly(
    'goose',
    'cover',
    'ground',
    96,
    TALL,
    [at(1330, -1360), at(1580, -1360), at(1580, -1150), at(1470, -1150), at(1470, -1240), at(1330, -1240)],
  ),
  box('a-default-crates', 'cover', 'ground', 96, SHORT, 1760, -1570, 1910, -1410),
  box('a-ninja-crate', 'cover', 'ground', 96, TALL, 1290, -1830, 1450, -1650),
  box('a-elevator', 'cover', 'ground', 96, TALL, 2150, -1840, 2330, -1660),
  box('a-barrels', 'cover', 'ground', 96, SHORT, 2040, -1300, 2140, -1200),

  // Long
  box('long-barrels', 'cover', 'ground', 0, SHORT, 1900, 500, 2010, 610),
  box('blue-container', 'cover', 'ground', 0, TALL, 1860, -420, 1990, -220),

  // Mid
  box('xbox', 'cover', 'ground', 0, SHORT, 560, -280, 700, -140),
  box('mid-crate', 'cover', 'ground', 0, SHORT, 400, 560, 520, 680),

  // B site
  box('b-car', 'cover', 'ground', 64, SHORT, -1900, -1500, -1690, -1300),
  box('b-plat', 'cover', 'ground', 112, TALL, -1560, -1950, -1330, -1770),
  box('b-back-plat', 'cover', 'ground', 112, TALL, -2450, -1950, -2130, -1620),
  box('b-barrels', 'cover', 'ground', 64, SHORT, -2200, -1330, -2090, -1220),

  // Tunnels
  box('tunnel-crate', 'cover', 'lower', -32, SHORT, -1420, -180, -1300, -60),

  // T spawn
  box('t-spawn-crates', 'cover', 'ground', 32, TALL, -180, 1760, 60, 1960),
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
  x: number,
  z: number,
  layer: Layer = 'ground',
  short?: string,
  minScale?: number,
): Callout {
  return {
    id,
    name,
    at: at(x, z),
    layer,
    ...(short === undefined ? {} : { short }),
    ...(minScale === undefined ? {} : { minScale }),
  }
}

const CALLOUTS: readonly Callout[] = [
  // CT half
  callout('co-ct-spawn', 'CT Spawn', -60, -2080, 'ground', 'CT'),
  callout('co-ct-crossroads', 'Crossroads', 110, -1680, 'ground', 'Cross', 0.05),
  callout('co-ct-mid', 'CT Mid', 290, -1180),
  callout('co-suicide', 'Suicide', 220, -660, 'ground', 'Suic', 0.05),

  // A side
  callout('co-a-ramp', 'A Ramp', 880, -1660, 'ground', 'Ramp'),
  callout('co-a-site', 'A Site', 1980, -1500, 'ground', 'A'),
  callout('co-a-default', 'Default', 1835, -1490, 'ground', 'Def', 0.09),
  callout('co-goose', 'Goose', 1455, -1305, 'ground', undefined, 0.05),
  callout('co-ninja', 'Ninja', 1370, -1740, 'ground', undefined, 0.09),
  callout('co-elevator', 'Elevator', 2240, -1750, 'ground', 'Elev', 0.09),
  callout('co-a-cross', 'A Cross', 1560, -1015, 'ground', 'Cross'),
  callout('co-catwalk', 'Catwalk', 1015, -940, 'ground', 'Cat'),
  callout('co-short-stairs', 'Short Stairs', 710, -720, 'ground', 'Short'),
  callout('co-long-corner', 'Long Corner', 2010, -1050, 'ground', 'Corner', 0.05),
  callout('co-long', 'Long A', 2140, -520, 'ground', 'Long'),
  callout('co-pit', 'Deep Pit', 2300, -25, 'lower', 'Pit'),
  callout('co-blue', 'Blue', 1925, -320, 'ground', undefined, 0.09),
  callout('co-long-doors', 'Long Doors', 2015, 900, 'ground', 'Doors'),
  callout('co-outside-long', 'Outside Long', 1425, 1230, 'ground', 'Outside'),
  callout('co-t-ramp', 'T Ramp', 1005, 1400, 'ground', 'Ramp', 0.05),

  // Mid
  callout('co-top-mid', 'Top Mid', 600, -730, 'ground', 'Top'),
  callout('co-xbox', 'Xbox', 630, -210, 'ground', undefined, 0.05),
  callout('co-mid', 'Mid', 570, -100),
  callout('co-mid-doors', 'Mid Doors', 570, 200, 'ground', 'Doors'),
  callout('co-lower-mid', 'Lower Mid', 570, 700, 'ground', 'Lower', 0.05),

  // B side
  callout('co-b-site', 'B Site', -1800, -1650, 'ground', 'B'),
  callout('co-b-plat', 'B Platform', -1445, -1860, 'ground', 'Plat', 0.05),
  callout('co-b-back-plat', 'Back Plat', -2290, -1785, 'ground', 'Back', 0.05),
  callout('co-b-car', 'Car', -1795, -1400, 'ground', undefined, 0.05),
  callout('co-b-doors', 'B Doors', -1190, -1725, 'ground', 'Doors'),
  callout('co-b-window', 'B Window', -1185, -1420, 'ground', 'Window', 0.05),
  callout('co-ct-tunnel', 'CT Tunnel', -920, -1500, 'ground', 'CT Tun'),
  callout('co-upper-tunnels', 'Upper Tunnels', -1750, -885, 'upper', 'Upper'),
  callout('co-tunnel-stairs', 'Tunnel Stairs', -1915, -500, 'upper', 'Stairs', 0.05),
  callout('co-lower-tunnels', 'Lower Tunnels', -1625, -40, 'lower', 'Lower'),
  callout('co-b-tunnels', 'B Tunnels', -1280, 600, 'ground', 'Tunnels'),
  callout('co-outside-tunnels', 'Outside Tunnels', -690, 1190, 'ground', 'Outside'),

  // T half
  callout('co-t-spawn', 'T Spawn', 300, 1840, 'ground', 'T'),
]

// ─────────────────────────────────────────────────────────────────────────────
// Spawns and sites
// ─────────────────────────────────────────────────────────────────────────────

/** Facing north (towards CT spawn). */
const NORTH = -Math.PI / 2
/** Facing south (towards T spawn). */
const SOUTH = Math.PI / 2

const SPAWNS: readonly SpawnPoint[] = [
  { team: 'T', at: at(-380, 1900), facing: NORTH },
  { team: 'T', at: at(-190, 1900), facing: NORTH },
  { team: 'T', at: at(0, 1900), facing: NORTH },
  { team: 'T', at: at(190, 1900), facing: NORTH },
  { team: 'T', at: at(380, 1900), facing: NORTH },

  { team: 'CT', at: at(-380, -2080), facing: SOUTH },
  { team: 'CT', at: at(-190, -2080), facing: SOUTH },
  { team: 'CT', at: at(0, -2080), facing: SOUTH },
  { team: 'CT', at: at(190, -2080), facing: SOUTH },
  { team: 'CT', at: at(380, -2080), facing: SOUTH },
]

const BOMBSITES: readonly Bombsite[] = [
  { id: 'A', name: 'A Site', layer: 'ground', bounds: { minX: 1300, minZ: -1850, maxX: 2400, maxZ: -1200 } },
  { id: 'B', name: 'B Site', layer: 'ground', bounds: { minX: -2400, minZ: -1900, maxX: -1350, maxZ: -1200 } },
]

export const DUST2: MapDef = {
  id: 'dust2',
  name: 'Dust 2',
  notes:
    'Hand-authored original geometry. Layout relationships and community callout names are ' +
    'reproduced; distances are approximate, not a metric tracing. No Valve assets used.',
  bounds: { minX: -2600, minZ: -2500, maxX: 2600, maxZ: 2350 },
  regions: [...FLOORS, ...COVER],
  callouts: CALLOUTS,
  spawns: SPAWNS,
  bombsites: BOMBSITES,
}
