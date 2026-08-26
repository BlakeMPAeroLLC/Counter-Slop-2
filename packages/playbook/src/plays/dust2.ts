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
 */

import { makeUtility, makeWaypoint, newId, s } from '../play.js'
import type { Actor, Layer, MoveMode, Play, Team, Vec2, Waypoint } from '../types.js'

/** Terse leg spec, so a play reads as a route rather than as a wall of object literals. */
interface Leg {
  readonly at: Vec2
  readonly mode?: MoveMode
  readonly layer?: Layer
  readonly hold?: number
  readonly arrive?: number
  readonly note?: string
}

function route(legs: readonly Leg[]): Waypoint[] {
  return legs.map((l) =>
    makeWaypoint(l.at, {
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

// ─────────────────────────────────────────────────────────────────────────────
// A split: two through Long, two through Short, one lurking Mid
// ─────────────────────────────────────────────────────────────────────────────

const A_SPLIT: Play = (() => {
  const entry = actor('T', 'Entry (Long)', T1, 0, [
    { at: { x: 380, z: 1900 } },
    { at: { x: 1100, z: 1300 }, note: 'Straight out to Outside Long — no reason to be quiet yet.' },
    { at: { x: 1950, z: 1050 } },
    { at: { x: 1980, z: 880 }, mode: 'walk', hold: s(3), note: 'Hold inside Long Doors until the smoke is up.' },
    { at: { x: 2100, z: 300 }, note: 'Cross the Pit line fast — this is the AWP window.' },
    { at: { x: 2120, z: -600 } },
    { at: { x: 2000, z: -1060 }, mode: 'walk', hold: s(1), note: 'Clear Long Corner before stepping onto site.' },
    { at: { x: 2050, z: -1400 }, note: 'On site. Barrels side.' },
  ])

  const support = actor('T', 'Support (Long)', T2, s(1), [
    { at: { x: 190, z: 1900 } },
    { at: { x: 1050, z: 1350 } },
    { at: { x: 1900, z: 1100 } },
    { at: { x: 1900, z: 900 }, mode: 'walk', hold: s(4), note: 'Second man through Doors — trade the entry, do not lead.' },
    { at: { x: 2050, z: 250 } },
    { at: { x: 2200, z: -700 } },
    { at: { x: 2280, z: -1300 }, note: 'Take Elevator side and watch CT ramp.' },
  ])

  const igl = actor('T', 'IGL (Short)', T3, 0, [
    { at: { x: 0, z: 1900 } },
    { at: { x: 560, z: 1200 } },
    { at: { x: 570, z: 400 } },
    { at: { x: 570, z: 200 }, mode: 'walk', hold: s(2), note: 'Wait at Mid Doors for the Xbox smoke.' },
    { at: { x: 620, z: -400 } },
    { at: { x: 700, z: -800 }, note: 'Top Mid.' },
    { at: { x: 1000, z: -930 }, mode: 'walk', note: 'Onto Catwalk quietly — CT Mid can hear you.' },
    { at: { x: 1400, z: -1000 }, arrive: s(29), note: 'Hit A Cross with the Long pair, not before.' },
    { at: { x: 1600, z: -1350 } },
  ])

  const awp = actor('T', 'AWP (Short)', T4, s(2), [
    { at: { x: -190, z: 1900 } },
    { at: { x: 500, z: 1250 } },
    { at: { x: 560, z: 300 } },
    { at: { x: 640, z: -180 }, mode: 'walk', hold: s(5), note: 'Hold Xbox and watch Top Mid for a CT push.' },
    { at: { x: 700, z: -750 } },
    { at: { x: 1050, z: -940 }, mode: 'walk' },
    { at: { x: 1350, z: -980 }, arrive: s(31), note: 'Hold A Cross from Catwalk — do not enter site.' },
  ])

  const lurk = actor('T', 'Lurk (Mid)', T5, s(12), [
    { at: { x: -380, z: 1900 } },
    { at: { x: -200, z: 1550 }, mode: 'walk' },
    { at: { x: -700, z: 1150 }, mode: 'walk', note: 'Late so the CTs commit to the A read first.' },
    { at: { x: -1200, z: 700 }, mode: 'walk' },
    { at: { x: -1450, z: 200 }, mode: 'walk', layer: 'lower', hold: s(6), note: 'Sit in Lower Tunnels and listen for the B rotate.' },
    { at: { x: -1700, z: -500 }, mode: 'walk', layer: 'upper' },
    { at: { x: -1750, z: -1000 }, mode: 'crouch', layer: 'upper', note: 'Punish the rotator crossing back through B.' },
  ])

  const cts: Actor[] = [
    actor('CT', 'A Anchor', C1, 0, [
      { at: { x: 190, z: -2080 } },
      { at: { x: 900, z: -1650 } },
      { at: { x: 1850, z: -1300 }, note: 'Default plant position, watching Long and Cross.' },
      { at: { x: 2050, z: -1250 }, mode: 'walk', hold: s(6) },
      { at: { x: 1780, z: -1500 }, mode: 'walk', note: 'Fall back behind Default once Long opens up.' },
    ]),
    actor('CT', 'A Support', C2, 0, [
      { at: { x: 380, z: -2080 } },
      { at: { x: 1000, z: -1600 } },
      { at: { x: 1450, z: -1250 }, mode: 'walk', hold: s(10), note: 'Goose. Crossfire with the anchor.' },
      { at: { x: 1350, z: -1750 }, mode: 'walk' },
    ]),
    actor('CT', 'AWP (Mid)', C3, 0, [
      { at: { x: 0, z: -2080 } },
      { at: { x: 300, z: -1400 } },
      { at: { x: 420, z: -800 }, mode: 'walk', hold: s(12), note: 'CT Mid. Hold Mid Doors until the smoke lands.' },
      { at: { x: 250, z: -1300 }, note: 'Rotate off Mid once you cannot see through it.' },
      { at: { x: 900, z: -1680 } },
    ]),
    actor('CT', 'B Anchor', C4, 0, [
      { at: { x: -190, z: -2080 } },
      { at: { x: -900, z: -1700 } },
      { at: { x: -1750, z: -1400 }, note: 'Behind Car, watching Tunnels.' },
      { at: { x: -1800, z: -1500 }, mode: 'walk', hold: s(20) },
    ]),
    actor('CT', 'Rotator', C5, 0, [
      { at: { x: -380, z: -2080 } },
      { at: { x: -900, z: -1500 } },
      { at: { x: -1180, z: -1420 }, mode: 'walk', hold: s(8), note: 'B Window — cheap info, quick rotate.' },
      { at: { x: 100, z: -1650 }, arrive: s(34), note: 'Rotate to A through Crossroads on the call.' },
      { at: { x: 1000, z: -1620 } },
      { at: { x: 1400, z: -1700 } },
    ]),
  ]

  return {
    id: 'example-dust2-a-split',
    name: 'Dust 2 — A Split (Long + Short)',
    mapId: 'dust2',
    side: 'T' as Team,
    description:
      'Two through Long behind a CT-spawn smoke, two through Short behind an Xbox smoke, one lurking ' +
      'Mid into Tunnels. The whole play hangs on the two pairs arriving in A Cross together — the ' +
      'pinned arrival times on the Short pair are what enforce that. Watch it at 0.25x around 0:28.',
    durationTicks: s(45),
    actors: [entry, support, igl, awp, lurk, ...cts],
    utility: [
      makeUtility('smoke', { x: 1980, z: 700 }, { x: 1050, z: -1620 }, s(14), {
        actorId: entry.id,
        note: 'CT spawn / A ramp smoke — cuts the rotate and the cross.',
      }),
      makeUtility('smoke', { x: 570, z: 350 }, { x: 640, z: -200 }, s(10), {
        actorId: awp.id,
        note: 'Xbox smoke so Short can step out of Mid Doors.',
      }),
      makeUtility('flash', { x: 1990, z: 400 }, { x: 2100, z: -900 }, s(24), {
        actorId: entry.id,
        note: 'Pop flash over Long Corner before the entry crosses.',
      }),
      makeUtility('molotov', { x: 1200, z: -980 }, { x: 1460, z: -1270 }, s(27), {
        actorId: igl.id,
        note: 'Burn Goose off before Catwalk drops into Cross.',
      }),
      makeUtility('flash', { x: 1450, z: -1010 }, { x: 1900, z: -1450 }, s(30), {
        actorId: igl.id,
        note: 'Flash for the site entry.',
      }),
      makeUtility('he', { x: 2100, z: -400 }, { x: 2300, z: -30 }, s(20), {
        note: 'Optional Pit nade — throw it if you hear an AWP down there.',
      }),
    ],
    annotations: [
      {
        id: newId('note'),
        kind: 'text' as const,
        points: [{ x: 1560, z: -1015 }],
        layer: 'ground' as const,
        text: 'Both pairs hit HERE together',
        color: '#f2f2f2',
        fromTick: s(26),
        untilTick: s(34),
      },
      {
        id: newId('note'),
        kind: 'arrow' as const,
        points: [
          { x: 2000, z: -900 },
          { x: 1900, z: -1400 },
        ],
        layer: 'ground' as const,
        text: '',
        color: T1,
        fromTick: s(28),
        untilTick: s(36),
      },
    ],
    plant: { at: { x: 1840, z: -1490 }, tick: s(36) },
  }
})()

// ─────────────────────────────────────────────────────────────────────────────
// B rush through Tunnels
// ─────────────────────────────────────────────────────────────────────────────

const B_RUSH: Play = (() => {
  const lead = actor('T', 'Entry', T1, 0, [
    { at: { x: -380, z: 1900 } },
    { at: { x: -700, z: 1200 } },
    { at: { x: -1300, z: 700 } },
    { at: { x: -1600, z: 100 }, layer: 'lower' },
    { at: { x: -1850, z: -450 }, layer: 'upper', note: 'Up the stairs first — do not stack in Lower.' },
    { at: { x: -1800, z: -1100 }, layer: 'upper' },
    { at: { x: -1800, z: -1400 }, note: 'Car. Clear Back Plat.' },
  ])

  const second = actor('T', 'Second', T2, s(1), [
    { at: { x: -190, z: 1900 } },
    { at: { x: -650, z: 1250 } },
    { at: { x: -1250, z: 750 } },
    { at: { x: -1550, z: 150 }, layer: 'lower' },
    { at: { x: -1820, z: -420 }, layer: 'upper' },
    { at: { x: -1750, z: -1150 }, layer: 'upper' },
    { at: { x: -2200, z: -1300 }, note: 'Swing wide to Back Plat.' },
  ])

  const rest: Actor[] = [
    actor('T', 'Third', T3, s(2), [
      { at: { x: 0, z: 1900 } },
      { at: { x: -600, z: 1300 } },
      { at: { x: -1200, z: 800 } },
      { at: { x: -1500, z: 200 }, layer: 'lower' },
      { at: { x: -1900, z: -400 }, layer: 'upper' },
      { at: { x: -1700, z: -1200 }, layer: 'upper' },
      { at: { x: -1450, z: -1850 }, note: 'Take Platform and hold B Doors.' },
    ]),
    actor('T', 'Fourth', T4, s(3), [
      { at: { x: 190, z: 1900 } },
      { at: { x: -550, z: 1350 } },
      { at: { x: -1150, z: 820 } },
      { at: { x: -1450, z: 250 }, layer: 'lower' },
      { at: { x: -1500, z: -300 }, layer: 'lower', mode: 'walk', hold: s(4), note: 'Stay low as the back-up; do not run into the trade.' },
      { at: { x: -1850, z: -500 }, layer: 'upper' },
      { at: { x: -1900, z: -1250 }, layer: 'upper' },
    ]),
    actor('T', 'Mid hold', T5, 0, [
      { at: { x: 380, z: 1900 } },
      { at: { x: 570, z: 1200 } },
      { at: { x: 570, z: 400 }, mode: 'walk' },
      { at: { x: 570, z: 220 }, mode: 'walk', hold: s(18), note: 'Hold Mid Doors so CT Mid cannot cut the rotate off.' },
      { at: { x: 570, z: 900 }, mode: 'walk', note: 'Fall back once B is taken.' },
    ]),
  ]

  const cts: Actor[] = [
    actor('CT', 'B Anchor', C1, 0, [
      { at: { x: -190, z: -2080 } },
      { at: { x: -900, z: -1700 } },
      { at: { x: -1800, z: -1420 }, mode: 'walk', hold: s(14), note: 'Car. First contact.' },
      { at: { x: -2250, z: -1780 }, mode: 'walk', note: 'Back Plat if Car gets burnt.' },
    ]),
    actor('CT', 'B Support', C2, 0, [
      { at: { x: -380, z: -2080 } },
      { at: { x: -1000, z: -1600 } },
      { at: { x: -1180, z: -1420 }, mode: 'walk', hold: s(16), note: 'B Window. Retreat to Doors on contact.' },
    ]),
    actor('CT', 'AWP (Mid)', C3, 0, [
      { at: { x: 0, z: -2080 } },
      { at: { x: 300, z: -1300 } },
      { at: { x: 450, z: -820 }, mode: 'walk', hold: s(10), note: 'CT Mid.' },
      { at: { x: 100, z: -1600 }, arrive: s(22), note: 'Rotate B through Crossroads.' },
      { at: { x: -900, z: -1650 } },
      { at: { x: -1200, z: -1700 } },
    ]),
    actor('CT', 'A Anchor', C4, 0, [
      { at: { x: 190, z: -2080 } },
      { at: { x: 1000, z: -1620 } },
      { at: { x: 1850, z: -1350 }, mode: 'walk', hold: s(30), note: 'Do not rotate. A is a real option for them here.' },
    ]),
    actor('CT', 'Rotator', C5, 0, [
      { at: { x: 380, z: -2080 } },
      { at: { x: 900, z: -1650 } },
      { at: { x: 1500, z: -1200 }, mode: 'walk', hold: s(8), note: 'A Cross for info.' },
      { at: { x: 100, z: -1680 }, arrive: s(26) },
      { at: { x: -1150, z: -1720 }, note: 'Retake through B Doors with the AWP.' },
    ]),
  ]

  return {
    id: 'example-dust2-b-rush',
    name: 'Dust 2 — B Rush (Tunnels)',
    mapId: 'dust2',
    side: 'T' as Team,
    description:
      'Four through Tunnels on a one-second stagger with one holding Mid Doors to delay the rotate. ' +
      'The layer switches on the tunnel legs are the interesting part — flip the layer filter to ' +
      'Upper and Lower to see who is actually stacked on top of whom.',
    durationTicks: s(40),
    actors: [lead, second, ...rest, ...cts],
    utility: [
      makeUtility('flash', { x: -1800, z: -1050 }, { x: -1900, z: -1600 }, s(15), {
        actorId: lead.id,
        note: 'Over the wall into site as the entry steps out.',
      }),
      makeUtility('molotov', { x: -1780, z: -1120 }, { x: -1790, z: -1400 }, s(14), {
        actorId: second.id,
        note: 'Burn Car so the anchor cannot hold it.',
      }),
      makeUtility('smoke', { x: -1750, z: -1150 }, { x: -1200, z: -1720 }, s(16), {
        actorId: second.id,
        note: 'B Doors smoke — blocks the retake and the AWP rotate.',
      }),
      makeUtility('flash', { x: -1700, z: -1200 }, { x: -2250, z: -1780 }, s(18), {
        actorId: lead.id,
        note: 'Second flash for Back Plat.',
      }),
    ],
    annotations: [
      {
        id: newId('note'),
        kind: 'text' as const,
        points: [{ x: -1280, z: 600 }],
        layer: 'ground' as const,
        text: 'One second apart — no stacking',
        color: '#f2f2f2',
        fromTick: 0,
        untilTick: s(12),
      },
    ],
    plant: { at: { x: -1780, z: -1600 }, tick: s(24) },
  }
})()

// ─────────────────────────────────────────────────────────────────────────────
// CT default setup
// ─────────────────────────────────────────────────────────────────────────────

const CT_DEFAULT: Play = (() => {
  const cts: Actor[] = [
    actor('CT', 'A Anchor', C1, 0, [
      { at: { x: 190, z: -2080 } },
      { at: { x: 1000, z: -1650 } },
      { at: { x: 1900, z: -1300 }, note: 'Long from Barrels.' },
      { at: { x: 2060, z: -1250 }, mode: 'walk', hold: s(25) },
    ]),
    actor('CT', 'A Support', C2, 0, [
      { at: { x: 380, z: -2080 } },
      { at: { x: 1100, z: -1560 } },
      { at: { x: 1460, z: -1270 }, mode: 'walk', hold: s(25), note: 'Goose. Watches Cross and Catwalk.' },
    ]),
    actor('CT', 'AWP (Mid)', C3, 0, [
      { at: { x: 0, z: -2080 } },
      { at: { x: 300, z: -1300 } },
      { at: { x: 430, z: -700 }, mode: 'walk' },
      { at: { x: 600, z: -600 }, mode: 'walk', hold: s(6), note: 'Top Mid peek for the early info.' },
      { at: { x: 400, z: -900 }, mode: 'walk', hold: s(20), note: 'Back off to CT Mid — do not hold the peek.' },
    ]),
    actor('CT', 'B Anchor', C4, 0, [
      { at: { x: -190, z: -2080 } },
      { at: { x: -900, z: -1700 } },
      { at: { x: -1790, z: -1420 }, mode: 'walk', hold: s(25), note: 'Car, angled at Tunnels.' },
    ]),
    actor('CT', 'Rotator', C5, 0, [
      { at: { x: -380, z: -2080 } },
      { at: { x: -950, z: -1550 } },
      { at: { x: -1180, z: -1420 }, mode: 'walk', hold: s(12), note: 'B Window: watches B, rotates anywhere.' },
      { at: { x: -900, z: -1700 }, mode: 'walk' },
      { at: { x: 100, z: -1680 }, mode: 'walk', hold: s(10), note: 'Crossroads — the fastest rotate to either site.' },
    ]),
  ]

  const ts: Actor[] = [
    actor('T', 'T pressure', T1, 0, [
      { at: { x: 380, z: 1900 } },
      { at: { x: 1400, z: 1200 } },
      { at: { x: 1990, z: 900 }, mode: 'walk', hold: s(8), note: 'Typical Long Doors timing to check against.' },
      { at: { x: 2100, z: 100 } },
    ]),
    actor('T', 'T mid', T3, 0, [
      { at: { x: 0, z: 1900 } },
      { at: { x: 570, z: 1000 } },
      { at: { x: 570, z: 230 }, mode: 'walk', hold: s(10) },
      { at: { x: 640, z: -300 }, mode: 'walk' },
    ]),
    actor('T', 'T tunnels', T5, 0, [
      { at: { x: -380, z: 1900 } },
      { at: { x: -800, z: 1150 } },
      { at: { x: -1400, z: 500 } },
      { at: { x: -1550, z: 0 }, layer: 'lower', mode: 'walk', hold: s(10), note: 'Lower Tunnels hold — the usual B feint.' },
    ]),
  ]

  return {
    id: 'example-dust2-ct-default',
    name: 'Dust 2 — CT Default Setup',
    mapId: 'dust2',
    side: 'CT' as Team,
    description:
      'A 2-1-2 with the rotator floating from B Window to Crossroads. Three T actors are included ' +
      'purely as a clock: they walk the standard timings so you can see when each CT position ' +
      'actually gets tested. Scrub to 0:12 to see the Top Mid peek relative to the mid T.',
    durationTicks: s(35),
    actors: [...cts, ...ts],
    utility: [
      makeUtility('he', { x: 430, z: -750 }, { x: 600, z: -180 }, s(11), {
        note: 'Standard Xbox nade off the Top Mid peek.',
      }),
    ],
    annotations: [
      {
        id: newId('note'),
        kind: 'zone' as const,
        points: [
          { x: -300, z: -1800 },
          { x: 520, z: -1800 },
          { x: 520, z: -1550 },
          { x: -300, z: -1550 },
        ],
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
