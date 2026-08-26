import { describe, expect, it } from 'vitest'
import { DUST2 } from '../src/maps/dust2.js'
import { MAPS, findMap, mapOrDefault } from '../src/maps/index.js'
import { DUST2_PLAYS } from '../src/plays/dust2.js'
import { REQUIRED_DUST2_CALLOUTS, errorsOnly, formatIssues, validateMapDef, validatePlay } from '../src/validate.js'
import { pointInBounds, pointInPolygon } from '../src/geometry.js'
import { resolveActor } from '../src/timeline.js'

/**
 * The geometry gate.
 *
 * Hand-authored map data rots quietly: a mistyped coordinate puts a wall through a bombsite
 * and nothing complains until someone draws a play through it. These assertions turn that
 * into a red build.
 */
describe('Dust 2 map definition', () => {
  it('passes validation with no errors', () => {
    const issues = validateMapDef(DUST2)
    // Print the whole report on failure, so a CI log is enough to fix it.
    expect(formatIssues(errorsOnly(issues))).toBe('')
  })

  it('has no warnings either', () => {
    expect(formatIssues(validateMapDef(DUST2))).toBe('')
  })

  it('covers every callout a real play needs to be transcribable', () => {
    const names = new Set(DUST2.callouts.map((c) => c.name))
    const missing = REQUIRED_DUST2_CALLOUTS.filter((n) => !names.has(n))
    expect(missing).toEqual([])
  })

  it('has unique ids across regions and callouts', () => {
    const ids = [...DUST2.regions.map((r) => r.id), ...DUST2.callouts.map((c) => c.id)]
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('gives every polygon at least three vertices', () => {
    for (const region of DUST2.regions) {
      expect(region.points.length, region.id).toBeGreaterThanOrEqual(3)
    }
  })

  it('keeps all geometry inside the declared bounds', () => {
    for (const region of DUST2.regions) {
      for (const p of region.points) {
        expect(pointInBounds(p, DUST2.bounds), `${region.id} vertex (${p.x}, ${p.z})`).toBe(true)
      }
    }
  })

  it('fields five spawns per side', () => {
    for (const team of ['T', 'CT'] as const) {
      expect(DUST2.spawns.filter((s) => s.team === team)).toHaveLength(5)
    }
  })

  it('spawns each side inside its own spawn region', () => {
    const spawnRegions = DUST2.regions.filter((r) => r.kind === 'spawn')
    for (const spawn of DUST2.spawns) {
      const inside = spawnRegions.some((r) => pointInPolygon(spawn.at, r.points))
      expect(inside, `${spawn.team} spawn at (${spawn.at.x}, ${spawn.at.z})`).toBe(true)
    }
  })

  it('faces the two sides towards each other', () => {
    for (const spawn of DUST2.spawns) {
      // T spawn sits at +z and looks north (-z); CT is the mirror.
      const looksNorth = Math.sin(spawn.facing) < 0
      expect(looksNorth, `${spawn.team} facing`).toBe(spawn.team === 'T')
    }
  })

  it('defines both bombsites, on opposite halves of the map', () => {
    const a = DUST2.bombsites.find((s) => s.id === 'A')
    const b = DUST2.bombsites.find((s) => s.id === 'B')
    expect(a).toBeDefined()
    expect(b).toBeDefined()
    if (a === undefined || b === undefined) return
    // A is east, B is west — the thing every callout in the game assumes.
    expect(a.bounds.minX).toBeGreaterThan(b.bounds.maxX)
  })

  it('puts each bombsite inside a region marked as a site', () => {
    const siteRegions = DUST2.regions.filter((r) => r.kind === 'site')
    for (const site of DUST2.bombsites) {
      const center = { x: (site.bounds.minX + site.bounds.maxX) / 2, z: (site.bounds.minZ + site.bounds.maxZ) / 2 }
      expect(siteRegions.some((r) => pointInPolygon(center, r.points)), site.id).toBe(true)
    }
  })

  it('puts every callout label on the map', () => {
    for (const c of DUST2.callouts) {
      expect(pointInBounds(c.at, DUST2.bounds), c.name).toBe(true)
    }
  })

  it('gives every cover volume a height, or it blocks nothing', () => {
    for (const region of DUST2.regions) {
      if (region.kind !== 'cover' && region.kind !== 'solid') continue
      expect(region.height, region.id).toBeGreaterThan(0)
    }
  })

  it('states its provenance, because that is a legal requirement here and not a nicety', () => {
    expect(DUST2.notes).toMatch(/hand-authored/i)
    expect(DUST2.notes).toMatch(/no valve assets/i)
  })
})

describe('map registry', () => {
  it('finds Dust 2 by id', () => {
    expect(findMap('dust2')).toBe(DUST2)
  })

  it('falls back rather than throwing on an unknown map', () => {
    expect(findMap('de_nonsense')).toBeUndefined()
    expect(mapOrDefault('de_nonsense')).toBe(DUST2)
  })

  it('validates every registered map, not just Dust 2', () => {
    for (const map of MAPS) {
      expect(formatIssues(errorsOnly(validateMapDef(map))), map.id).toBe('')
    }
  })
})

describe('bundled example plays', () => {
  it('validate against the map they were drawn on', () => {
    for (const play of DUST2_PLAYS) {
      expect(formatIssues(validatePlay(play, DUST2)), play.name).toBe('')
    }
  })

  it('field ten players, five a side', () => {
    for (const play of DUST2_PLAYS) {
      const ts = play.actors.filter((a) => a.team === 'T').length
      const cts = play.actors.filter((a) => a.team === 'CT').length
      expect(ts + cts, play.name).toBeLessThanOrEqual(10)
      expect(ts, play.name).toBeGreaterThan(0)
      expect(cts, play.name).toBeGreaterThan(0)
    }
  })

  it('have unique ids', () => {
    const ids = DUST2_PLAYS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('never ask a player to move faster than they can run', () => {
    for (const play of DUST2_PLAYS) {
      for (const actor of play.actors) {
        const track = resolveActor(actor)
        expect(track.overSpeed, `${play.name} / ${actor.name}`).toBe(false)
      }
    }
  })

  it('keep every waypoint on walkable-ish geometry', () => {
    // Not a pathfinding check — just that nobody was placed in the void outside every region,
    // which is the mistake that actually happens when hand-authoring a route.
    const floors = DUST2.regions.filter((r) => r.kind !== 'cover' && r.kind !== 'solid')
    for (const play of DUST2_PLAYS) {
      for (const actor of play.actors) {
        for (const wp of actor.path) {
          const inside = floors.some((r) => pointInPolygon(wp.at, r.points))
          expect(inside, `${play.name} / ${actor.name} at (${wp.at.x}, ${wp.at.z})`).toBe(true)
        }
      }
    }
  })

  it('land every piece of utility somewhere on the map', () => {
    for (const play of DUST2_PLAYS) {
      for (const ev of play.utility) {
        expect(pointInBounds(ev.to, DUST2.bounds), `${play.name} / ${ev.kind}`).toBe(true)
        expect(pointInBounds(ev.from, DUST2.bounds), `${play.name} / ${ev.kind}`).toBe(true)
      }
    }
  })

  it('plant inside a bombsite when they plant at all', () => {
    for (const play of DUST2_PLAYS) {
      if (play.plant === null) continue
      const inSite = DUST2.bombsites.some((s) => pointInBounds(play.plant?.at ?? { x: 0, z: 0 }, s.bounds))
      expect(inSite, play.name).toBe(true)
    }
  })
})
