/**
 * Data model for the 2D play simulator.
 *
 * Coordinate system
 * -----------------
 * Everything here lives on the ground plane in *sim units* (1 unit ~ 1 inch, a player is
 * 72 units tall, see packages/sim/src/constants.ts). The engine is Y-up, so the ground
 * plane is XZ:
 *
 *     +x is east  (screen right)
 *     +z is south (screen down)
 *
 * That is deliberate. A top-down play drawn here is already in the same frame the 3D
 * simulation uses, so a map authored for the playbook can later be extruded into real
 * `MapBuilder` brushes without a coordinate conversion pass.
 *
 * Time
 * ----
 * Time is measured in **ticks at 64 Hz**, matching `SIM.TICK_HZ`. Storing integer ticks
 * rather than floating-point seconds means a play scrubs to exactly reproducible frames and
 * two clients agree on what "1.42 seconds in" means down to the frame.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Geometry primitives
// ─────────────────────────────────────────────────────────────────────────────

/** A point on the ground plane, in sim units. */
export interface Vec2 {
  readonly x: number
  readonly z: number
}

/** Axis-aligned bounds on the ground plane. */
export interface Bounds {
  readonly minX: number
  readonly minZ: number
  readonly maxX: number
  readonly maxZ: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Map definition
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Vertical band a region belongs to.
 *
 * Dust 2 stacks geometry: upper tunnels sit above lower tunnels, the A site plateau sits
 * above A ramp. A top-down drawing that ignores this produces nonsense overlaps, so every
 * region declares its band and the renderer dims the bands the selected actor is not on.
 */
export type Layer = 'lower' | 'ground' | 'upper'

/** What a region *is*, which drives how it is drawn. */
export type RegionKind =
  /** Open, walkable floor. */
  | 'floor'
  /** Walkable but a chokepoint worth emphasising (doorways, tunnel mouths). */
  | 'choke'
  /** A bomb site. */
  | 'site'
  /** A team's spawn area. */
  | 'spawn'
  /** Solid, sight-blocking cover you can stand on or behind (crates, cars, platforms). */
  | 'cover'
  /** Solid and not traversable — pure wall filler used to sharpen a silhouette. */
  | 'solid'

/**
 * A convex-or-concave polygon of map geometry.
 *
 * Regions are authored as explicit vertex rings rather than as brushes because the tool
 * only ever needs a silhouette, and a ring survives being hand-tweaked in the editor.
 */
export interface Region {
  readonly id: string
  readonly kind: RegionKind
  readonly layer: Layer
  /** Vertex ring, in order. Winding does not matter. */
  readonly points: readonly Vec2[]
  /** Floor height in sim units, used for ordering and for future brush extrusion. */
  readonly floorY: number
  /** Height of the volume above `floorY`. Cover uses this to decide if it blocks sight. */
  readonly height: number
  /** Optional label drawn on the region itself (e.g. "A", "B"). */
  readonly label?: string
}

/**
 * A named area of the map — the vocabulary players actually speak in.
 *
 * Callouts are separate from regions on purpose: "Long" is one callout that spans several
 * authored polygons, and "Xbox" is a callout that names a single crate. Keeping them apart
 * means the geometry can be refined without renaming anything.
 */
export interface Callout {
  readonly id: string
  /** Display name, e.g. "Long Doors". */
  readonly name: string
  /** Short form for tight zoom levels, e.g. "Doors". */
  readonly short?: string
  /** Where the label is drawn. */
  readonly at: Vec2
  readonly layer: Layer
  /** Hides the label until the user zooms in past this scale (screen px per unit). */
  readonly minScale?: number
}

/** Where a team starts, and which way they face. */
export interface SpawnPoint {
  readonly team: Team
  readonly at: Vec2
  /** Facing in radians, measured from +x towards +z (screen: 0 = right, PI/2 = down). */
  readonly facing: number
}

export interface MapDef {
  readonly id: string
  readonly name: string
  /** Free-text note about provenance and accuracy. */
  readonly notes: string
  readonly bounds: Bounds
  readonly regions: readonly Region[]
  readonly callouts: readonly Callout[]
  readonly spawns: readonly SpawnPoint[]
  /** Plant zones, keyed by site name. Used to snap the bomb and to check plant timings. */
  readonly bombsites: readonly Bombsite[]
}

export interface Bombsite {
  readonly id: string
  readonly name: string
  readonly bounds: Bounds
  readonly layer: Layer
}

// ─────────────────────────────────────────────────────────────────────────────
// Plays
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Attacking / defending side.
 *
 * The playbook speaks CS's own vocabulary ("T", "CT") rather than the game's WRECKERS /
 * WARDENS, because the whole point of the tool is to transcribe plays that are described
 * in those terms. `TEAM_TO_SIM` in `units.ts` maps them onto the sim's team indices.
 */
export type Team = 'T' | 'CT'

/** How an actor covers the leg of a path that *ends* at a waypoint. */
export type MoveMode =
  /** Full run. Loud. */
  | 'run'
  /** Shift-walk. Silent. */
  | 'walk'
  /** Crouch-walk. Silent and short. */
  | 'crouch'
  /** Do not move — hold this position for `holdTicks`. */
  | 'hold'

export interface Waypoint {
  readonly id: string
  readonly at: Vec2
  readonly mode: MoveMode
  readonly layer: Layer
  /**
   * Ticks spent standing still at this waypoint *after* arriving. Only meaningful in
   * combination with the leg that follows.
   */
  readonly holdTicks: number
  /**
   * Explicit arrival tick, overriding the speed-derived one.
   *
   * Left undefined the timeline derives arrival from distance and `mode`, which is what
   * makes a drawn path take as long as it really would. Set it when transcribing a demo
   * where you know the actual clock.
   */
  readonly arriveTick?: number
  /** Which way the actor is looking on arrival, in radians. Undefined = along the path. */
  readonly facing?: number
  /** Optional coaching note shown when the playhead is on this leg. */
  readonly note?: string
}

export interface Actor {
  readonly id: string
  readonly team: Team
  /** Display name / role, e.g. "Entry", "AWP", "Anchor". */
  readonly name: string
  readonly color: string
  /** Tick at which this actor starts moving. Lets you stagger an execute. */
  readonly startTick: number
  /** First waypoint is the spawn position; there is always at least one. */
  readonly path: readonly Waypoint[]
}

export type UtilityKind = 'smoke' | 'flash' | 'molotov' | 'he' | 'decoy'

export interface UtilityEvent {
  readonly id: string
  readonly kind: UtilityKind
  /** Actor who throws it, or null for an unattributed piece of util. */
  readonly actorId: string | null
  /** Where it is thrown from. Kept explicit so a lineup can be marked precisely. */
  readonly from: Vec2
  /** Where it lands. */
  readonly to: Vec2
  readonly layer: Layer
  /** Tick the throw is released. */
  readonly throwTick: number
  /**
   * Explicit detonation tick. Undefined derives it from throw distance, which keeps a
   * long pop-flash honestly slower than a point-blank one.
   */
  readonly detonateTick?: number
  readonly note?: string
}

/** A free-hand annotation layer: arrows and text a coach draws on top. */
export type AnnotationKind = 'arrow' | 'text' | 'zone'

export interface Annotation {
  readonly id: string
  readonly kind: AnnotationKind
  readonly points: readonly Vec2[]
  readonly layer: Layer
  readonly text: string
  readonly color: string
  /** Ticks over which the annotation is visible. -1 for `untilTick` means "forever". */
  readonly fromTick: number
  readonly untilTick: number
}

export interface Play {
  readonly id: string
  readonly name: string
  readonly mapId: string
  /** Free-text description of the intent — what this play is trying to achieve. */
  readonly description: string
  /** Which side the play is written for. Both sides can still have actors. */
  readonly side: Team
  /** Total length in ticks. Derived on save, but stored so an empty play still scrubs. */
  readonly durationTicks: number
  readonly actors: readonly Actor[]
  readonly utility: readonly UtilityEvent[]
  readonly annotations: readonly Annotation[]
  /** Where the bomb is planted, if the play includes a plant. */
  readonly plant: { readonly at: Vec2; readonly tick: number } | null
}

// ─────────────────────────────────────────────────────────────────────────────
// Sampled state — what the renderer consumes
// ─────────────────────────────────────────────────────────────────────────────

/** An actor's interpolated state at one tick. */
export interface ActorFrame {
  readonly actorId: string
  readonly at: Vec2
  readonly facing: number
  readonly layer: Layer
  readonly mode: MoveMode
  /** True once the actor has reached the end of its path. */
  readonly finished: boolean
  /** True before `startTick`, when the actor has not moved off spawn yet. */
  readonly waiting: boolean
  /** Speed in units/sec on this leg, 0 while holding. */
  readonly speed: number
  /** Note attached to the leg currently being walked, if any. */
  readonly note?: string
}

/** A piece of utility's state at one tick. */
export interface UtilityFrame {
  readonly eventId: string
  readonly kind: UtilityKind
  readonly layer: Layer
  /** 'flight' while in the air, 'active' while it is doing something, else it is omitted. */
  readonly phase: 'flight' | 'active' | 'fading'
  /** Current position — interpolated along the throw arc while in flight. */
  readonly at: Vec2
  /** Effect radius in units. 0 during flight. */
  readonly radius: number
  /** 0..1 opacity ramp so smokes bloom and fade instead of popping in and out. */
  readonly intensity: number
  readonly note?: string
}

/** Everything the renderer needs for a single tick. */
export interface PlayFrame {
  readonly tick: number
  readonly actors: readonly ActorFrame[]
  readonly utility: readonly UtilityFrame[]
  readonly annotations: readonly Annotation[]
  readonly planted: boolean
}
