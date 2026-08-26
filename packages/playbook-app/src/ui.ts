/**
 * DOM panels: tool rail, roster, inspector, view options, timeline.
 *
 * Hand-rolled DOM with a full re-render per panel on change. Each panel is a few dozen
 * elements and re-renders only when state changes (not per frame), so the cost is invisible
 * and the code stays free of diffing machinery. The one exception is the timeline playhead,
 * which is moved by the render loop directly because it does change every frame.
 */

import {
  type Actor,
  type Layer,
  type MoveMode,
  type ResolvedTrack,
  type UtilityKind,
  MODE_LABEL,
  RATES,
  SPEED,
  TEAM_COLOR,
  UTILITY,
  detonationTick,
  formatTick,
  resolveActor,
  seek,
  setPlaying,
  ticksToSeconds,
  utilityEndTick,
} from '@cs2/playbook'
import { invalidateMapLayer } from './render.js'
import {
  type AppState,
  type ToolId,
  apply,
  notify,
  play,
  setSelection,
  setTool,
  toggleLayer,
  toggleTeam,
  tracks,
} from './state.js'

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function need<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (node === null) throw new Error(`missing element #${id}`)
  return node as T
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool rail
// ─────────────────────────────────────────────────────────────────────────────

interface ToolSpec {
  readonly id: ToolId
  readonly key: string
  readonly label: string
  readonly glyph: string
  readonly hint: string
}

const TOOLS: readonly ToolSpec[] = [
  { id: 'select', key: 'V', label: 'Select', glyph: '➤', hint: 'Click to select. Drag a handle to move it. Drag empty map to pan. Alt-click a path to add a bend.' },
  { id: 'path', key: 'P', label: 'Path', glyph: '✎', hint: 'Click to add waypoints to the selected player. 7/8/9 switch run / walk / crouch.' },
  { id: 'smoke', key: 'S', label: 'Smoke', glyph: '☁', hint: 'Drag from the lineup to the landing spot. Click alone throws from the selected player.' },
  { id: 'flash', key: 'F', label: 'Flash', glyph: '✦', hint: 'Drag from the lineup to where it pops.' },
  { id: 'molotov', key: 'M', label: 'Molotov', glyph: '🔥', hint: 'Drag from the lineup to the burn.' },
  { id: 'he', key: 'H', label: 'HE', glyph: '✸', hint: 'Drag from the lineup to the detonation.' },
  { id: 'decoy', key: 'D', label: 'Decoy', glyph: '◈', hint: 'Drag from the lineup to the landing spot.' },
  { id: 'arrow', key: 'A', label: 'Arrow', glyph: '↗', hint: 'Drag to draw a coaching arrow.' },
  { id: 'text', key: 'T', label: 'Text', glyph: 'T', hint: 'Click to drop a text note on the map.' },
  { id: 'zone', key: 'O', label: 'Zone', glyph: '▢', hint: 'Drag to shade an area.' },
  { id: 'measure', key: 'K', label: 'Measure', glyph: '↔', hint: 'Drag to measure a distance and how long it takes to walk it.' },
  { id: 'plant', key: 'B', label: 'Plant', glyph: '✹', hint: 'Click to set where the bomb goes down, at the playhead.' },
]

export function renderToolRail(state: AppState): void {
  const rail = need('toolrail')
  rail.replaceChildren()
  for (const spec of TOOLS) {
    const btn = el('button', 'tool')
    btn.type = 'button'
    btn.classList.toggle('active', state.tool === spec.id)
    btn.title = `${spec.label} (${spec.key}) — ${spec.hint}`
    btn.append(el('span', 'glyph', spec.glyph), el('span', 'key', spec.key))
    btn.addEventListener('click', () => setTool(state, spec.id))
    rail.append(btn)
  }
}

export function toolHint(tool: ToolId): string {
  return TOOLS.find((t) => t.id === tool)?.hint ?? ''
}

// ─────────────────────────────────────────────────────────────────────────────
// Roster
// ─────────────────────────────────────────────────────────────────────────────

export function renderRoster(state: AppState): void {
  const host = need('roster')
  host.replaceChildren()
  const current = play(state)

  for (const team of ['T', 'CT'] as const) {
    const header = el('div', 'roster-team')
    const swatch = el('span', 'team-swatch')
    swatch.style.background = TEAM_COLOR[team]
    const hidden = state.hiddenTeams.has(team)
    const toggle = el('button', 'team-toggle', hidden ? 'show' : 'hide')
    toggle.type = 'button'
    toggle.addEventListener('click', () => toggleTeam(state, team))
    header.append(swatch, el('span', 'team-name', team === 'T' ? 'Attackers (T)' : 'Defenders (CT)'), toggle)
    host.append(header)

    for (const actor of current.actors.filter((a) => a.team === team)) {
      host.append(rosterRow(state, actor))
    }
  }
}

function rosterRow(state: AppState, actor: Actor): HTMLElement {
  const row = el('div', 'roster-row')
  const selected =
    (state.selection.kind === 'actor' || state.selection.kind === 'waypoint') &&
    state.selection.actorId === actor.id
  row.classList.toggle('selected', selected)
  if (state.hiddenTeams.has(actor.team)) row.classList.add('muted')

  const dot = el('span', 'actor-dot')
  dot.style.background = actor.color

  const name = el('input', 'actor-name')
  name.value = actor.name
  name.spellcheck = false
  name.addEventListener('change', () => {
    apply(state, { kind: 'setActor', actorId: actor.id, name: name.value })
  })

  const track = resolveActor(actor)
  const legs = actor.path.length - 1
  const meta = el(
    'span',
    'actor-meta',
    legs <= 0 ? 'on spawn' : `${legs} legs · ${formatTick(track.endTick)}`,
  )
  if (track.overSpeed) {
    meta.classList.add('warn')
    meta.title = 'A pinned arrival time on this path is faster than a player can run.'
  }

  row.addEventListener('click', (ev) => {
    if (ev.target === name) return
    setSelection(state, { kind: 'actor', actorId: actor.id })
  })

  row.append(dot, name, meta)
  return row
}

// ─────────────────────────────────────────────────────────────────────────────
// Inspector
// ─────────────────────────────────────────────────────────────────────────────

function field(label: string, control: HTMLElement, note?: string): HTMLElement {
  const wrap = el('label', 'field')
  wrap.append(el('span', 'field-label', label), control)
  if (note !== undefined) wrap.append(el('span', 'field-note', note))
  return wrap
}

function numberInput(value: number, onChange: (n: number) => void, step = 0.1): HTMLInputElement {
  const input = el('input', 'num')
  input.type = 'number'
  input.step = String(step)
  input.value = String(Math.round(value * 100) / 100)
  input.addEventListener('change', () => {
    const n = Number(input.value)
    if (Number.isFinite(n)) onChange(n)
  })
  return input
}

export function renderInspector(state: AppState): void {
  const host = need('inspector')
  host.replaceChildren()
  const sel = state.selection
  const current = play(state)

  if (sel.kind === 'none') {
    host.append(el('p', 'empty', toolHint(state.tool)))
    host.append(playMeta(state))
    return
  }

  if (sel.kind === 'waypoint') {
    const actor = current.actors.find((a) => a.id === sel.actorId)
    const wp = actor?.path.find((w) => w.id === sel.waypointId)
    if (actor === undefined || wp === undefined) return
    const index = actor.path.indexOf(wp)
    const track = resolveActor(actor)
    const leg = track.legs.find((l) => !l.holding && l.to === wp.at)

    host.append(el('div', 'inspector-title', `${actor.name} · waypoint ${index + 1}/${actor.path.length}`))

    const modes: readonly MoveMode[] = ['run', 'walk', 'crouch']
    const modeRow = el('div', 'seg')
    for (const m of modes) {
      const b = el('button', 'seg-btn', MODE_LABEL[m])
      b.type = 'button'
      b.classList.toggle('active', wp.mode === m)
      b.addEventListener('click', () =>
        apply(state, { kind: 'setWaypoint', actorId: actor.id, waypointId: wp.id, mode: m }),
      )
      modeRow.append(b)
    }
    host.append(field('Movement', modeRow, `${SPEED[wp.mode]} u/s`))

    host.append(
      field(
        'Hold on arrival',
        numberInput(ticksToSeconds(wp.holdTicks), (n) =>
          apply(state, {
            kind: 'setWaypoint',
            actorId: actor.id,
            waypointId: wp.id,
            holdTicks: Math.max(0, Math.round(n * 64)),
          }),
        ),
        'seconds',
      ),
    )

    const pinned = wp.arriveTick !== undefined
    const pinRow = el('div', 'seg')
    const pinBtn = el('button', 'seg-btn', pinned ? 'Unpin' : 'Pin to playhead')
    pinBtn.type = 'button'
    pinBtn.classList.toggle('active', pinned)
    pinBtn.addEventListener('click', () =>
      apply(state, {
        kind: 'setWaypoint',
        actorId: actor.id,
        waypointId: wp.id,
        arriveTick: pinned ? null : Math.round(state.clock.tick),
      }),
    )
    pinRow.append(pinBtn)
    host.append(
      field(
        'Arrival time',
        pinRow,
        pinned
          ? `pinned to ${formatTick(wp.arriveTick ?? 0)}`
          : leg === undefined
            ? 'derived from distance'
            : `derived: ${formatTick(leg.toTick)}`,
      ),
    )

    if (leg !== undefined) {
      const speedNote = el(
        'span',
        'field-note',
        `${Math.round(leg.length)} units at ${Math.round(leg.impliedSpeed)} u/s`,
      )
      if (leg.impliedSpeed > SPEED.run + 0.5) {
        speedNote.classList.add('warn')
        speedNote.textContent += ` — faster than a player can run (${SPEED.run} u/s)`
      }
      host.append(speedNote)
    }

    const note = el('textarea', 'note')
    note.value = wp.note ?? ''
    note.placeholder = 'Coaching note for this leg…'
    note.addEventListener('change', () =>
      apply(state, {
        kind: 'setWaypoint',
        actorId: actor.id,
        waypointId: wp.id,
        note: note.value.trim() === '' ? null : note.value,
      }),
    )
    host.append(field('Note', note))

    const del = el('button', 'danger', 'Delete waypoint')
    del.type = 'button'
    del.addEventListener('click', () => {
      apply(state, { kind: 'deleteWaypoint', actorId: actor.id, waypointId: wp.id })
      setSelection(state, { kind: 'actor', actorId: actor.id })
    })
    host.append(del)
    return
  }

  if (sel.kind === 'actor') {
    const actor = current.actors.find((a) => a.id === sel.actorId)
    if (actor === undefined) return
    host.append(el('div', 'inspector-title', actor.name))
    host.append(
      field(
        'Starts moving at',
        numberInput(ticksToSeconds(actor.startTick), (n) =>
          apply(state, { kind: 'setActor', actorId: actor.id, startTick: Math.max(0, Math.round(n * 64)) }),
        ),
        'seconds after the gates open — stagger an execute here',
      ),
    )
    const clear = el('button', 'danger', 'Clear path')
    clear.type = 'button'
    clear.addEventListener('click', () => apply(state, { kind: 'clearPath', actorId: actor.id }))
    host.append(clear)
    return
  }

  if (sel.kind === 'utility') {
    const ev = current.utility.find((e) => e.id === sel.eventId)
    if (ev === undefined) return
    const spec = UTILITY[ev.kind]
    host.append(el('div', 'inspector-title', `${spec.label}`))

    const kindRow = el('div', 'seg')
    for (const k of Object.keys(UTILITY) as UtilityKind[]) {
      const b = el('button', 'seg-btn', UTILITY[k].label)
      b.type = 'button'
      b.classList.toggle('active', ev.kind === k)
      // Changing kind means delete + re-add, because `kind` is not independently editable —
      // the timings and radius all derive from it.
      b.addEventListener('click', () => {
        if (k === ev.kind) return
        apply(state, { kind: 'deleteUtility', eventId: ev.id })
        apply(state, {
          kind: 'addUtility',
          utilKind: k,
          from: ev.from,
          to: ev.to,
          layer: ev.layer,
          throwTick: ev.throwTick,
          actorId: ev.actorId,
        })
        setSelection(state, { kind: 'none' })
      })
      kindRow.append(b)
    }
    host.append(field('Type', kindRow))

    host.append(
      field(
        'Thrown at',
        numberInput(ticksToSeconds(ev.throwTick), (n) =>
          apply(state, { kind: 'setUtility', eventId: ev.id, throwTick: Math.max(0, Math.round(n * 64)) }),
        ),
        `lands ${formatTick(detonationTick(ev))}, gone by ${formatTick(utilityEndTick(ev))}`,
      ),
    )

    const thrower = ev.actorId === null ? null : current.actors.find((a) => a.id === ev.actorId)
    host.append(
      el(
        'span',
        'field-note',
        thrower === null || thrower === undefined ? 'Unattributed' : `Thrown by ${thrower.name}`,
      ),
    )

    const note = el('textarea', 'note')
    note.value = ev.note ?? ''
    note.placeholder = 'What is this piece of util for?'
    note.addEventListener('change', () =>
      apply(state, { kind: 'setUtility', eventId: ev.id, note: note.value.trim() === '' ? null : note.value }),
    )
    host.append(field('Note', note))

    const del = el('button', 'danger', 'Delete utility')
    del.type = 'button'
    del.addEventListener('click', () => {
      apply(state, { kind: 'deleteUtility', eventId: ev.id })
      setSelection(state, { kind: 'none' })
    })
    host.append(del)
    return
  }

  if (sel.kind === 'annotation') {
    const a = current.annotations.find((x) => x.id === sel.annotationId)
    if (a === undefined) return
    host.append(el('div', 'inspector-title', `Annotation · ${a.kind}`))
    if (a.kind !== 'arrow') {
      const text = el('input', 'num')
      text.value = a.text
      text.addEventListener('change', () =>
        apply(state, { kind: 'setAnnotation', annotationId: a.id, text: text.value }),
      )
      host.append(field('Text', text))
    }
    host.append(
      field(
        'Visible from',
        numberInput(ticksToSeconds(a.fromTick), (n) =>
          apply(state, { kind: 'setAnnotation', annotationId: a.id, fromTick: Math.max(0, Math.round(n * 64)) }),
        ),
        'seconds',
      ),
    )
    host.append(
      field(
        'Visible until',
        numberInput(a.untilTick < 0 ? -1 : ticksToSeconds(a.untilTick), (n) =>
          apply(state, {
            kind: 'setAnnotation',
            annotationId: a.id,
            untilTick: n < 0 ? -1 : Math.round(n * 64),
          }),
        ),
        '-1 means never hide',
      ),
    )
    const del = el('button', 'danger', 'Delete annotation')
    del.type = 'button'
    del.addEventListener('click', () => {
      apply(state, { kind: 'deleteAnnotation', annotationId: a.id })
      setSelection(state, { kind: 'none' })
    })
    host.append(del)
  }
}

function playMeta(state: AppState): HTMLElement {
  const wrap = el('div', 'play-meta')
  const current = play(state)
  const desc = el('textarea', 'note')
  desc.value = current.description
  desc.placeholder = 'What is this play trying to achieve?'
  desc.addEventListener('change', () => apply(state, { kind: 'setMeta', description: desc.value }))
  wrap.append(field('Play notes', desc))

  const sideRow = el('div', 'seg')
  for (const side of ['T', 'CT'] as const) {
    const b = el('button', 'seg-btn', side)
    b.type = 'button'
    b.classList.toggle('active', current.side === side)
    b.addEventListener('click', () => apply(state, { kind: 'setMeta', side }))
    sideRow.append(b)
  }
  wrap.append(field('Written for', sideRow))
  return wrap
}

// ─────────────────────────────────────────────────────────────────────────────
// View options
// ─────────────────────────────────────────────────────────────────────────────

const LAYER_LABEL: Readonly<Record<Layer, string>> = {
  lower: 'Lower (tunnels, pit)',
  ground: 'Ground',
  upper: 'Upper (tunnels, plateau)',
}

export function renderLayers(state: AppState): void {
  const host = need('layers')
  host.replaceChildren()

  host.append(el('div', 'sub', 'Layers — unchecked layers dim rather than disappear'))
  for (const layer of ['upper', 'ground', 'lower'] as Layer[]) {
    const row = el('label', 'check')
    const box = el('input')
    box.type = 'checkbox'
    box.checked = state.visibleLayers.has(layer)
    box.addEventListener('change', () => {
      toggleLayer(state, layer)
      invalidateMapLayer()
    })
    row.append(box, el('span', undefined, LAYER_LABEL[layer]))
    host.append(row)
  }

  host.append(el('div', 'sub', 'Drawing onto layer'))
  const drawRow = el('div', 'seg')
  for (const layer of ['lower', 'ground', 'upper'] as Layer[]) {
    const b = el('button', 'seg-btn', layer)
    b.type = 'button'
    b.classList.toggle('active', state.drawLayer === layer)
    b.addEventListener('click', () => {
      state.drawLayer = layer
      notify()
    })
    drawRow.append(b)
  }
  host.append(drawRow)

  host.append(el('div', 'sub', 'Display'))
  const toggles: readonly [string, keyof AppState, string][] = [
    ['Callout names', 'showCallouts', 'L'],
    ['Paths', 'showPaths', 'R'],
    ['Grid', 'showGrid', 'G'],
    ['Presentation mode', 'presenting', 'E'],
  ]
  for (const [label, key, hotkey] of toggles) {
    const row = el('label', 'check')
    const box = el('input')
    box.type = 'checkbox'
    box.checked = state[key] === true
    box.addEventListener('change', () => {
      ;(state as unknown as Record<string, boolean>)[key] = box.checked
      if (key === 'presenting') document.body.classList.toggle('presenting', box.checked)
      invalidateMapLayer()
      notify()
    })
    row.append(box, el('span', undefined, `${label} (${hotkey})`))
    host.append(row)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Timeline
// ─────────────────────────────────────────────────────────────────────────────

let playheadEl: HTMLElement | null = null
let clockEl: HTMLElement | null = null
let lanesEl: HTMLElement | null = null

/** Moves the playhead without rebuilding the timeline. Called every frame. */
export function updatePlayhead(state: AppState): void {
  if (playheadEl === null || lanesEl === null) return
  const pct = (state.clock.tick / Math.max(1, state.clock.durationTicks)) * 100
  playheadEl.style.left = `${Math.max(0, Math.min(100, pct))}%`
  if (clockEl !== null) {
    clockEl.textContent = `${formatTick(state.clock.tick)} / ${formatTick(state.clock.durationTicks)}`
  }
}

export function renderTimeline(state: AppState): void {
  const host = need('timeline')
  host.replaceChildren()

  host.append(transportBar(state))

  const lanes = el('div', 'lanes')
  lanesEl = lanes
  const duration = Math.max(1, state.clock.durationTicks)

  lanes.append(ruler(state, duration))

  const current = play(state)
  for (const track of tracks(state)) {
    const actor = current.actors.find((a) => a.id === track.actorId)
    if (actor === undefined) continue
    if (state.hiddenTeams.has(actor.team)) continue
    lanes.append(actorLane(state, actor, track, duration))
  }

  if (current.utility.length > 0) lanes.append(utilityLane(state, duration))

  const head = el('div', 'playhead')
  playheadEl = head
  lanes.append(head)

  // Click or drag anywhere on the lanes to scrub.
  const scrub = (ev: PointerEvent): void => {
    const rect = lanes.getBoundingClientRect()
    const t = (ev.clientX - rect.left) / Math.max(1, rect.width)
    state.clock = seek(state.clock, t * duration)
    updatePlayhead(state)
  }
  lanes.addEventListener('pointerdown', (ev) => {
    lanes.setPointerCapture(ev.pointerId)
    state.clock = setPlaying(state.clock, false)
    scrub(ev)
    notify()
  })
  lanes.addEventListener('pointermove', (ev) => {
    if (lanes.hasPointerCapture(ev.pointerId)) scrub(ev)
  })

  host.append(lanes)
  updatePlayhead(state)
}

function transportBar(state: AppState): HTMLElement {
  const bar = el('div', 'transport')

  const mk = (label: string, title: string, fn: () => void): HTMLButtonElement => {
    const b = el('button', 'transport-btn', label)
    b.type = 'button'
    b.title = title
    b.addEventListener('click', () => {
      fn()
      notify()
    })
    return b
  }

  bar.append(mk('⏮', 'Jump to start (Home)', () => (state.clock = seek(state.clock, 0))))
  bar.append(mk('◀|', 'Back one tick (←, Shift+← for a second)', () => (state.clock = seek(state.clock, Math.round(state.clock.tick) - 1))))
  const playBtn = mk(state.clock.playing ? '⏸' : '▶', 'Play / pause (Space)', () => {
    state.clock = setPlaying(state.clock, !state.clock.playing)
  })
  playBtn.classList.add('primary')
  bar.append(playBtn)
  bar.append(mk('|▶', 'Forward one tick (→)', () => (state.clock = seek(state.clock, Math.round(state.clock.tick) + 1))))
  bar.append(mk('⏭', 'Jump to end (End)', () => (state.clock = seek(state.clock, state.clock.durationTicks))))

  const rateSel = el('select', 'rate')
  for (const r of RATES) {
    const opt = el('option', undefined, `${r}×`)
    opt.value = String(r)
    if (r === state.clock.rate) opt.selected = true
    rateSel.append(opt)
  }
  rateSel.title = 'Playback speed ([ and ])'
  rateSel.addEventListener('change', () => {
    state.clock = { ...state.clock, rate: Number(rateSel.value) }
    notify()
  })
  bar.append(rateSel)

  const loop = el('label', 'check inline')
  const loopBox = el('input')
  loopBox.type = 'checkbox'
  loopBox.checked = state.clock.loop
  loopBox.addEventListener('change', () => {
    state.clock = { ...state.clock, loop: loopBox.checked }
    notify()
  })
  loop.append(loopBox, el('span', undefined, 'Loop'))
  bar.append(loop)

  const clock = el('div', 'clock')
  clockEl = clock
  bar.append(clock)

  const modeInfo = el('div', 'transport-hint', toolHint(state.tool))
  bar.append(modeInfo)

  return bar
}

function ruler(state: AppState, duration: number): HTMLElement {
  const row = el('div', 'ruler')
  const seconds = Math.ceil(duration / 64)
  // A tick every second is too dense past ~40s; step up to five-second marks.
  const step = seconds > 40 ? 5 : seconds > 20 ? 2 : 1
  for (let sec = 0; sec <= seconds; sec += step) {
    const mark = el('div', 'ruler-mark')
    mark.style.left = `${((sec * 64) / duration) * 100}%`
    mark.append(el('span', undefined, `${sec}s`))
    row.append(mark)
  }
  void state
  return row
}

function actorLane(state: AppState, actor: Actor, track: ResolvedTrack, duration: number): HTMLElement {
  const lane = el('div', 'lane')
  const selected =
    (state.selection.kind === 'actor' || state.selection.kind === 'waypoint') &&
    state.selection.actorId === actor.id
  lane.classList.toggle('selected', selected)

  const label = el('div', 'lane-label', actor.name)
  label.style.borderLeftColor = actor.color
  label.addEventListener('click', () => setSelection(state, { kind: 'actor', actorId: actor.id }))
  lane.append(label)

  const strip = el('div', 'lane-strip')

  for (const leg of track.legs) {
    const bar = el('div', 'leg')
    bar.classList.add(leg.holding ? 'hold' : leg.mode)
    bar.style.left = `${(leg.fromTick / duration) * 100}%`
    bar.style.width = `${Math.max(0.25, ((leg.toTick - leg.fromTick) / duration) * 100)}%`
    bar.style.background = leg.holding ? 'transparent' : actor.color
    if (leg.impliedSpeed > SPEED.run + 0.5) bar.classList.add('overspeed')
    bar.title = leg.holding
      ? `Holding ${formatTick(leg.toTick - leg.fromTick)}`
      : `${MODE_LABEL[leg.mode]} ${Math.round(leg.length)}u in ${formatTick(leg.toTick - leg.fromTick)} (${Math.round(leg.impliedSpeed)} u/s)`
    strip.append(bar)
  }

  // Waypoint diamonds, draggable horizontally to pin an arrival time.
  let tickCursor = track.startTick
  actor.path.forEach((wp, index) => {
    if (index === 0) return
    const leg = track.legs.find((l) => !l.holding && l.to === wp.at && l.fromTick >= tickCursor)
    const arriveTick = leg?.toTick ?? tickCursor
    tickCursor = arriveTick

    const pip = el('div', 'pip')
    pip.style.left = `${(arriveTick / duration) * 100}%`
    pip.classList.toggle('pinned', wp.arriveTick !== undefined)
    pip.classList.toggle(
      'selected',
      state.selection.kind === 'waypoint' && state.selection.waypointId === wp.id,
    )
    pip.title = `Waypoint ${index + 1} at ${formatTick(arriveTick)} — drag to pin the arrival time`

    pip.addEventListener('pointerdown', (ev) => {
      ev.stopPropagation()
      pip.setPointerCapture(ev.pointerId)
      setSelection(state, { kind: 'waypoint', actorId: actor.id, waypointId: wp.id })
    })
    pip.addEventListener('pointermove', (ev) => {
      if (!pip.hasPointerCapture(ev.pointerId)) return
      const rect = strip.getBoundingClientRect()
      const t = Math.max(0, (ev.clientX - rect.left) / Math.max(1, rect.width)) * duration
      apply(state, {
        kind: 'setWaypoint',
        actorId: actor.id,
        waypointId: wp.id,
        arriveTick: Math.round(t),
      })
    })
    strip.append(pip)
  })

  lane.append(strip)
  return lane
}

function utilityLane(state: AppState, duration: number): HTMLElement {
  const lane = el('div', 'lane utility-lane')
  lane.append(el('div', 'lane-label', 'Utility'))
  const strip = el('div', 'lane-strip')

  for (const ev of play(state).utility) {
    const spec = UTILITY[ev.kind]
    const pop = detonationTick(ev)
    const end = utilityEndTick(ev)

    const flight = el('div', 'util-flight')
    flight.style.left = `${(ev.throwTick / duration) * 100}%`
    flight.style.width = `${Math.max(0.2, ((pop - ev.throwTick) / duration) * 100)}%`
    flight.style.borderColor = spec.color
    strip.append(flight)

    const active = el('div', 'util-active')
    active.style.left = `${(pop / duration) * 100}%`
    active.style.width = `${Math.max(0.3, ((end - pop) / duration) * 100)}%`
    active.style.background = spec.color
    active.title = `${spec.label} thrown ${formatTick(ev.throwTick)}, lands ${formatTick(pop)}, gone ${formatTick(end)}`
    active.classList.toggle(
      'selected',
      state.selection.kind === 'utility' && state.selection.eventId === ev.id,
    )
    active.addEventListener('pointerdown', (e) => {
      e.stopPropagation()
      setSelection(state, { kind: 'utility', eventId: ev.id })
    })
    strip.append(active)
  }

  lane.append(strip)
  return lane
}

export { need }
