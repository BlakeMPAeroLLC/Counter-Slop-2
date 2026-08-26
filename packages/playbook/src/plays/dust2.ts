/**
 * Bundled example plays for Dust 2.
 *
 * These exist to be *read*, not just watched. Each one is a worked example of how the data
 * model expresses a real idea: staggered `startTick` for a delayed lurk, `arriveTick` pins
 * where a timing has to be exact, `mode: 'walk'` where being quiet is the point, and notes
 * on the legs where a player needs to know why.
 *
 * They are also the smoke test for the whole pipeline — if the timeline, renderer and
 * serializer all work, these three plays look right the moment the app opens.
 *
 * Coordinates are authored in the game's frame (X east, Y north) to match `maps/dust2.ts`
 * and `getpos`. `route()` negates Y on the way in.
 */

import { makeUtility, makeWaypoint, newId, s } from '../play.js'
import { fromWorld } from '../world.js'
import type { Actor, Layer, MoveMode, Play, Team, Vec2, Waypoint } from '../types.js'

/** Terse leg spec, so a play reads as a route rather than as a wall of object literals. */
interface Leg {
  /** World position, `[X east, Y north]`. */
  readonly at: readonly [number, number]
  readonly mode?: MoveMode
  readonly layer?: Layer
  readonly hold?: number
  readonly arrive?: number
  readonly note?: string
}

function w(at: readonly [number, number]): Vec2 {
  return fromWorld({ x: at[0], y: at[1] })
}

function route(legs: readonly Leg[]): Waypoint[] {
  return legs.map((l) =>
    makeWaypoint(w(l.at), {
      mode: l.mode ?? 'run',
      layer: l.layer ?? 'ground',
      ...(l.hold === undefined ? {} : { holdTicks: l.hold }),
      ...(l.arrive === undefined ? {} : { arriveTick: l.arrive }),
      ...(l.note === undefined ? {} : { note: l.note }),
    }),
  )
}

function actor(team: Team, name: string, color: string, startTick: number, legs: readonly Leg[]): Actor {
  return { id: newId('actor'), team, name, color, startTick, path: route(legs) }
}

const T1 = '#f0b64a'
const T2 = '#e59a2e'
const T3 = '#d4801c'
const T4 = '#f5cf7a'
const T5 = '#c26a15'
const C1 = '#6fb6ee'
const C2 = '#4a9bdb'
const C3 = '#3080c4'
const C4 = '#9ad0f5'
const C5 = '#2569a8'

/** Spawn positions, matching the calibrated spawn lines in `maps/dust2.ts`. */
const T_SPAWN: readonly (readonly [number, number])[] = [
  [-939, -861],
  [-829, -861],
  [-719, -861],
  [-609, -861],
  [-499, -861],
]
const CT_SPAWN: readonly (readonly [number, number])[] = [
  [98, 2293],
  [208, 2293],
  [318, 2293],
  [428, 2293],
  [538, 2293],
]

// ─────────────────────────────────────────────────────────────────────────────
// A split: two through Long, two through Short, one lurking Mid
// ─────────────────────────────────────────────────────────────────────────────

const A_SPLIT: Play = (() => {
  const entry = actor('T', 'Entry (Long)', T1, 0, [
    { at: T_SPAWN[3] ?? [-609, -861] },
    { at: [300, -800], note: 'Straight out through T Ramp — no reason to be quiet yet.' },
    { at: [1100, -600] },
    { at: [1620, -250], mode: 'walk', hold: s(3), note: 'Hold inside Long Doors until the CT-spawn smoke is up.' },
    { at: [1650, 500], note: 'Cross the Pit line fast — this is the AWP window.' },
    { at: [1660, 1400] },
    { at: [1650, 2050], mode: 'walk', hold: s(1), note: 'Clear Long Corner before stepping onto site.' },
    { at: [1450, 2450], note: 'On site, Elevator side.' },
  ])

  const support = actor('T', 'Support (Long)', T2, s(1), [
    { at: T_SPAWN[4] ?? [-499, -861] },
    { at: [350, -760] },
    { at: [1150, -650] },
    { at: [1520, -250], mode: 'walk', hold: s(4), note: 'Second man through Doors — trade the entry, do not lead.' },
    { at: [1600, 450] },
    { at: [1680, 1500] },
    { at: [1330, 2250], note: 'Take Barrels and watch A Ramp for the rotate.' },
  ])

  const igl = actor('T', 'IGL (Short)', T3, 0, [
    { at: T_SPAWN[2] ?? [-719, -861] },
    { at: [-200, -450] },
    { at: [-200, 400] },
    { at: [-200, 820], mode: 'walk', hold: s(2), note: 'Wait at Mid Doors for the Xbox smoke.' },
    { at: [-200, 1250] },
    { at: [-210, 1620], note: 'Top Mid.' },
    { at: [120, 1700], mode: 'walk' },
    { at: [500, 1870], mode: 'walk', note: 'Onto Catwalk quietly — CT Mid can hear you.' },
    { at: [950, 2050], arrive: s(30), note: 'Hit A Cross with the Long pair, not before.' },
    { at: [1150, 2400] },
  ])

  const awp = actor('T', 'AWP (Short)', T4, s(2), [
    { at: T_SPAWN[1] ?? [-829, -861] },
    { at: [-250, -400] },
    { at: [-220, 700] },
    { at: [-190, 1220], mode: 'walk', hold: s(5), note: 'Hold Xbox and watch Top Mid for a CT push.' },
    { at: [-150, 1600] },
    { at: [250, 1780], mode: 'walk' },
    { at: [660, 1900], arrive: s(32), note: 'Hold A Cross from Catwalk — do not enter site.' },
  ])

  const lurk = actor('T', 'Lurk (Mid)', T5, s(12), [
    { at: T_SPAWN[0] ?? [-939, -861] },
    { at: [-1100, -800], mode: 'walk', note: 'Late, so the CTs commit to the A read first.' },
    { at: [-1400, -400], mode: 'walk' },
    { at: [-1650, 200], mode: 'walk', layer: 'lower' },
    { at: [-1780, 500], mode: 'walk', layer: 'lower', hold: s(6), note: 'Sit in Lower Tunnels and listen for the B rotate.' },
    { at: [-1860, 900], mode: 'walk', layer: 'upper' },
    { at: [-1820, 1700], mode: 'crouch', layer: 'upper', note: 'Punish the rotator crossing back through B.' },
  ])

  const cts: Actor[] = [
    actor('CT', 'A Anchor', C1, 0, [
      { at: CT_SPAWN[3] ?? [428, 2293] },
      { at: [700, 2400] },
      { at: [1110, 2470], note: 'Default plant position, watching Long and Cross.' },
      { at: [1300, 2350], mode: 'walk', hold: s(6) },
      { at: [1060, 2560], mode: 'walk', note: 'Fall back behind Default once Long opens up.' },
    ]),
    actor('CT', 'A Support', C2, 0, [
      { at: CT_SPAWN[4] ?? [538, 2293] },
      { at: [760, 2380] },
      { at: [790, 2320], mode: 'walk', hold: s(10), note: 'Goose. Crossfire with the anchor.' },
      { at: [700, 2750], mode: 'walk', note: 'Ninja if Goose gets burnt.' },
    ]),
    actor('CT', 'AWP (Mid)', C3, 0, [
      { at: CT_SPAWN[2] ?? [318, 2293] },
      { at: [50, 2000] },
      { at: [-250, 1900], mode: 'walk', hold: s(12), note: 'CT Mid. Hold Mid Doors until the smoke lands.' },
      { at: [100, 1980], note: 'Rotate off Mid once you cannot see through it.' },
      { at: [700, 2400] },
    ]),
    actor('CT', 'B Anchor', C4, 0, [
      { at: CT_SPAWN[0] ?? [98, 2293] },
      { at: [-600, 2450] },
      { at: [-1050, 2530] },
      { at: [-1590, 2600], note: 'Behind Car, watching Tunnels.' },
      { at: [-1620, 2560], mode: 'walk', hold: s(20) },
    ]),
    actor('CT', 'Rotator', C5, 0, [
      { at: CT_SPAWN[1] ?? [208, 2293] },
      { at: [-600, 2420] },
      { at: [-1000, 2240], mode: 'walk', hold: s(8), note: 'B Window — cheap info, quick rotate.' },
      { at: [-500, 2400], mode: 'walk' },
      { at: [120, 1980], arrive: s(35), note: 'Rotate to A through Crossroads on the call.' },
      { at: [700, 2400] },
      { at: [1000, 2500] },
    ]),
  ]

  return {
    id: 'example-dust2-a-split',
    name: 'Dust 2 — A Split (Long + Short)',
    mapId: 'dust2',
    side: 'T' as Team,
    description:
      'Two through Long behind a CT-spawn smoke, two through Short behind an Xbox smoke, one ' +
      'lurking Mid into Tunnels. The whole play hangs on the two pairs arriving in A Cross ' +
      'together — the pinned arrival times on the Short pair are what enforce that. Watch it ' +
      'at 0.25x around 0:30.',
    durationTicks: s(48),
    actors: [entry, support, igl, awp, lurk, ...cts],
    utility: [
      makeUtility('smoke', w([1650, 400]), w([620, 2400]), s(15), {
        actorId: entry.id,
        note: 'A Ramp / CT-spawn smoke — cuts the rotate and the cross.',
      }),
      makeUtility('smoke', w([-200, 600]), w([-190, 1220]), s(10), {
        actorId: awp.id,
        note: 'Xbox smoke so Short can step out of Mid Doors.',
      }),
      makeUtility('flash', w([1660, 1500]), w([1640, 2100]), s(25), {
        actorId: entry.id,
        note: 'Pop flash over Long Corner before the entry crosses.',
      }),
      makeUtility('molotov', w([600, 1900]), w([780, 2320]), s(28), {
        actorId: igl.id,
        note: 'Burn Goose off before Catwalk drops into Cross.',
      }),
      makeUtility('flash', w([980, 2060]), w([1250, 2450]), s(31), {
        actorId: igl.id,
        note: 'Flash for the site entry.',
      }),
      makeUtility('he', w([1660, 400]), w([1900, 880]), s(20), {
        note: 'Optional Pit nade — throw it if you hear an AWP down there.',
      }),
    ],
    annotations: [
      {
        id: newId('note'),
        kind: 'text' as const,
        points: [w([1050, 2050])],
        layer: 'ground' as const,
        text: 'Both pairs hit HERE together',
        color: '#f2f2f2',
        fromTick: s(27),
        untilTick: s(35),
      },
      {
        id: newId('note'),
        kind: 'arrow' as const,
        points: [w([1650, 2100]), w([1420, 2450])],
        layer: 'ground' as const,
        text: '',
        color: T1,
        fromTick: s(29),
        untilTick: s(37),
      },
    ],
    plant: { at: w([1120, 2470]), tick: s(37) },
  }
})()

// ─────────────────────────────────────────────────────────────────────────────
// B rush through Tunnels
// ─────────────────────────────────────────────────────────────────────────────

const B_RUSH: Play = (() => {
  const lead = actor('T', 'Entry', T1, 0, [
    { at: T_SPAWN[0] ?? [-939, -861] },
    { at: [-1150, -800] },
    { at: [-1500, -400] },
    { at: [-1700, 200], layer: 'lower' },
    { at: [-1860, 880], layer: 'upper', note: 'Up the stairs first — do not stack in Lower.' },
    { at: [-1820, 1900], layer: 'upper' },
    { at: [-1750, 2400], layer: 'upper' },
    { at: [-1590, 2600], note: 'Car. Clear Back Plat.' },
  ])

  const second = actor('T', 'Second', T2, s(1), [
    { at: T_SPAWN[1] ?? [-829, -861] },
    { at: [-1100, -820] },
    { at: [-1450, -350] },
    { at: [-1650, 250], layer: 'lower' },
    { at: [-1900, 900], layer: 'upper' },
    { at: [-1880, 1950], layer: 'upper' },
    { at: [-1950, 2850], note: 'Swing wide to Back Plat.' },
  ])

  const rest: Actor[] = [
    actor('T', 'Third', T3, s(2), [
      { at: T_SPAWN[2] ?? [-719, -861] },
      { at: [-1050, -840] },
      { at: [-1400, -300] },
      { at: [-1600, 300], layer: 'lower' },
      { at: [-1800, 850], layer: 'upper' },
      { at: [-1780, 2000], layer: 'upper' },
      { at: [-1200, 2900], note: 'Take Platform and hold B Doors.' },
    ]),
    actor('T', 'Fourth', T4, s(3), [
      { at: T_SPAWN[3] ?? [-609, -861] },
      { at: [-1000, -860] },
      { at: [-1400, -200] },
      { at: [-1600, 400], layer: 'lower' },
      { at: [-1700, 380], mode: 'walk', layer: 'lower', hold: s(4), note: 'Stay low as the back-up; do not run into the trade.' },
      { at: [-1900, 900], layer: 'upper' },
      { at: [-1850, 2100], layer: 'upper' },
    ]),
    actor('T', 'Mid hold', T5, 0, [
      { at: T_SPAWN[4] ?? [-499, -861] },
      { at: [-200, -400] },
      { at: [-200, 500], mode: 'walk' },
      { at: [-200, 800], mode: 'walk', hold: s(18), note: 'Hold Mid Doors so CT Mid cannot cut the rotate off.' },
      { at: [-220, 0], mode: 'walk', note: 'Fall back once B is taken.' },
    ]),
  ]

  const cts: Actor[] = [
    actor('CT', 'B Anchor', C1, 0, [
      { at: CT_SPAWN[0] ?? [98, 2293] },
      { at: [-600, 2450] },
      { at: [-1050, 2530] },
      { at: [-1590, 2600], mode: 'walk', hold: s(14), note: 'Car. First contact.' },
      { at: [-1980, 2870], mode: 'walk', note: 'Back Plat if Car gets burnt.' },
    ]),
    actor('CT', 'B Support', C2, 0, [
      { at: CT_SPAWN[1] ?? [208, 2293] },
      { at: [-600, 2400] },
      { at: [-1000, 2240], mode: 'walk', hold: s(16), note: 'B Window. Retreat to Doors on contact.' },
    ]),
    actor('CT', 'AWP (Mid)', C3, 0, [
      { at: CT_SPAWN[2] ?? [318, 2293] },
      { at: [0, 2000] },
      { at: [-260, 1900], mode: 'walk', hold: s(10), note: 'CT Mid.' },
      { at: [-500, 2450], arrive: s(23), note: 'Rotate B through CT Tunnel.' },
      { at: [-1050, 2540] },
      { at: [-1300, 2560] },
    ]),
    actor('CT', 'A Anchor', C4, 0, [
      { at: CT_SPAWN[3] ?? [428, 2293] },
      { at: [750, 2400] },
      { at: [1110, 2470], mode: 'walk', hold: s(30), note: 'Do not rotate. A is a real option for them here.' },
    ]),
    actor('CT', 'Rotator', C5, 0, [
      { at: CT_SPAWN[4] ?? [538, 2293] },
      { at: [800, 2350] },
      { at: [1000, 2100], mode: 'walk', hold: s(8), note: 'A Cross for info.' },
      { at: [120, 1980], arrive: s(27) },
      { at: [-1050, 2530], note: 'Retake through B Doors with the AWP.' },
    ]),
  ]

  return {
    id: 'example-dust2-b-rush',
    name: 'Dust 2 — B Rush (Tunnels)',
    mapId: 'dust2',
    side: 'T' as Team,
    description:
      'Four through Tunnels on a one-second stagger with one holding Mid Doors to delay the ' +
      'rotate. The layer switches on the tunnel legs are the interesting part — flip the ' +
      'layer filter to Upper and Lower to see who is actually stacked on top of whom.',
    durationTicks: s(42),
    actors: [lead, second, ...rest, ...cts],
    utility: [
      makeUtility('flash', w([-1810, 2200]), w([-1650, 2700]), s(16), {
        actorId: lead.id,
        layer: 'upper',
        note: 'Over the wall into site as the entry steps out.',
      }),
      makeUtility('molotov', w([-1800, 2250]), w([-1590, 2600]), s(15), {
        actorId: second.id,
        layer: 'upper',
        note: 'Burn Car so the anchor cannot hold it.',
      }),
      makeUtility('smoke', w([-1780, 2300]), w([-1050, 2535]), s(17), {
        actorId: second.id,
        note: 'B Doors smoke — blocks the retake and the AWP rotate.',
      }),
      makeUtility('flash', w([-1700, 2450]), w([-1980, 2870]), s(19), {
        actorId: lead.id,
        note: 'Second flash for Back Plat.',
      }),
    ],
    annotations: [
      {
        id: newId('note'),
        kind: 'text' as const,
        points: [w([-1625, -280])],
        layer: 'ground' as const,
        text: 'One second apart — no stacking',
        color: '#f2f2f2',
        fromTick: 0,
        untilTick: s(12),
      },
    ],
    plant: { at: w([-1650, 2620]), tick: s(26) },
  }
})()

// ─────────────────────────────────────────────────────────────────────────────
// CT default setup
// ─────────────────────────────────────────────────────────────────────────────

const CT_DEFAULT: Play = (() => {
  const cts: Actor[] = [
    actor('CT', 'A Anchor', C1, 0, [
      { at: CT_SPAWN[3] ?? [428, 2293] },
      { at: [750, 2400] },
      { at: [1330, 2350], note: 'Long from Barrels.' },
      { at: [1350, 2260], mode: 'walk', hold: s(25) },
    ]),
    actor('CT', 'A Support', C2, 0, [
      { at: CT_SPAWN[4] ?? [538, 2293] },
      { at: [780, 2380] },
      { at: [790, 2320], mode: 'walk', hold: s(25), note: 'Goose. Watches Cross and Catwalk.' },
    ]),
    actor('CT', 'AWP (Mid)', C3, 0, [
      { at: CT_SPAWN[2] ?? [318, 2293] },
      { at: [50, 2000] },
      { at: [-250, 1900], mode: 'walk' },
      { at: [-220, 1620], mode: 'walk', hold: s(6), note: 'Top Mid peek for the early info.' },
      { at: [-300, 1950], mode: 'walk', hold: s(20), note: 'Back off to CT Mid — do not hold the peek.' },
    ]),
    actor('CT', 'B Anchor', C4, 0, [
      { at: CT_SPAWN[0] ?? [98, 2293] },
      { at: [-600, 2450] },
      { at: [-1050, 2530] },
      { at: [-1600, 2590], mode: 'walk', hold: s(25), note: 'Car, angled at Tunnels.' },
    ]),
    actor('CT', 'Rotator', C5, 0, [
      { at: CT_SPAWN[1] ?? [208, 2293] },
      { at: [-600, 2420] },
      { at: [-1000, 2240], mode: 'walk', hold: s(12), note: 'B Window: watches B, rotates anywhere.' },
      { at: [-500, 2420], mode: 'walk' },
      { at: [120, 1980], mode: 'walk', hold: s(10), note: 'Crossroads — the fastest rotate to either site.' },
    ]),
  ]

  const ts: Actor[] = [
    actor('T', 'T pressure', T1, 0, [
      { at: T_SPAWN[3] ?? [-609, -861] },
      { at: [400, -800] },
      { at: [1620, -250], mode: 'walk', hold: s(8), note: 'Typical Long Doors timing to check against.' },
      { at: [1660, 600] },
    ]),
    actor('T', 'T mid', T3, 0, [
      { at: T_SPAWN[2] ?? [-719, -861] },
      { at: [-200, -300] },
      { at: [-200, 820], mode: 'walk', hold: s(10) },
      { at: [-200, 1200], mode: 'walk' },
    ]),
    actor('T', 'T tunnels', T5, 0, [
      { at: T_SPAWN[0] ?? [-939, -861] },
      { at: [-1200, -800] },
      { at: [-1600, -200] },
      { at: [-1700, 400], layer: 'lower', mode: 'walk', hold: s(10), note: 'Lower Tunnels hold — the usual B feint.' },
    ]),
  ]

  return {
    id: 'example-dust2-ct-default',
    name: 'Dust 2 — CT Default Setup',
    mapId: 'dust2',
    side: 'CT' as Team,
    description:
      'A 2-1-2 with the rotator floating from B Window to Crossroads. Three T actors are ' +
      'included purely as a clock: they walk the standard timings so you can see when each CT ' +
      'position actually gets tested. Scrub to 0:12 to see the Top Mid peek relative to the ' +
      'mid T.',
    durationTicks: s(38),
    actors: [...cts, ...ts],
    utility: [
      makeUtility('he', w([-250, 1880]), w([-190, 1220]), s(11), {
        note: 'Standard Xbox nade off the Top Mid peek.',
      }),
    ],
    annotations: [
      {
        id: newId('note'),
        kind: 'zone' as const,
        points: [w([-250, 2080]), w([500, 2080]), w([500, 1880]), w([-250, 1880])],
        layer: 'ground' as const,
        text: 'Rotator lives here',
        color: C5,
        fromTick: s(20),
        untilTick: -1,
      },
    ],
    plant: null,
  }
})()

export const DUST2_PLAYS: readonly Play[] = [A_SPLIT, B_RUSH, CT_DEFAULT]
