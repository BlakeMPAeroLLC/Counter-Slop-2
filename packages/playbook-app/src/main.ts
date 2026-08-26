/**
 * Entry point: wire the store to the DOM, then run the frame loop.
 *
 * The loop does three things per frame — advance the clock by real elapsed time, sample the
 * play into a `PlayFrame`, draw it. Everything else happens in response to events.
 */

import {
  type Play,
  type Viewport,
  ShareError,
  advance,
  createPlay,
  examplesForMap,
  formatIssues,
  frameAt,
  mapOrDefault,
  validateMapDef,
  validatePlay,
} from '@cs2/playbook'
import { attachKeyboard, attachPointer, fitToMap, type InteractionHost } from './interact.js'
import {
  attachDropTarget,
  browserCodec,
  copyToClipboard,
  exportFile,
  importFile,
  listPlays,
  loadAutosave,
  playFromHash,
  savePlay,
  scheduleAutosave,
  seedLibrary,
  shareUrl,
} from './persist.js'
import { invalidateMapLayer, render, type Canvases } from './render.js'
import {
  type AppState,
  apply,
  createState,
  loadPlay,
  notify,
  play,
  subscribe,
  tracks,
} from './state.js'
import {
  need,
  renderInspector,
  renderLayers,
  renderRoster,
  renderTimeline,
  renderToolRail,
  updatePlayhead,
} from './ui.js'

// ─────────────────────────────────────────────────────────────────────────────
// Toast
// ─────────────────────────────────────────────────────────────────────────────

let toastTimer: ReturnType<typeof setTimeout> | null = null

function toast(message: string): void {
  const node = need('toast')
  node.textContent = message
  node.classList.add('visible')
  if (toastTimer !== null) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => node.classList.remove('visible'), 4200)
}

/** Small modal used for the text-annotation tool and the share dialog. */
function promptText(initial: string): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = need('overlay')
    overlay.hidden = false
    overlay.replaceChildren()

    const card = document.createElement('div')
    card.className = 'card'
    const input = document.createElement('input')
    input.value = initial
    input.placeholder = 'Note text'
    const row = document.createElement('div')
    row.className = 'card-actions'
    const ok = document.createElement('button')
    ok.textContent = 'Add'
    ok.className = 'primary'
    const cancel = document.createElement('button')
    cancel.textContent = 'Cancel'

    const close = (value: string | null): void => {
      overlay.hidden = true
      overlay.replaceChildren()
      resolve(value)
    }
    ok.addEventListener('click', () => close(input.value))
    cancel.addEventListener('click', () => close(null))
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') close(input.value)
      if (ev.key === 'Escape') close(null)
    })
    overlay.addEventListener('click', (ev) => {
      if (ev.target === overlay) close(null)
    })

    row.append(cancel, ok)
    card.append(input, row)
    overlay.append(card)
    input.focus()
    input.select()
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Top bar
// ─────────────────────────────────────────────────────────────────────────────

function button(label: string, title: string, fn: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.textContent = label
  b.title = title
  b.addEventListener('click', fn)
  return b
}

function renderTopbar(state: AppState): void {
  const nameInput = need<HTMLInputElement>('play-name')
  if (nameInput.value !== play(state).name) nameInput.value = play(state).name

  const mapGroup = need('map-group')
  mapGroup.replaceChildren()
  const mapLabel = document.createElement('span')
  mapLabel.className = 'chip'
  mapLabel.textContent = state.map.name
  mapLabel.title = state.map.notes
  mapGroup.append(mapLabel)

  const libSelect = document.createElement('select')
  libSelect.title = 'Open a saved play'
  const placeholder = document.createElement('option')
  placeholder.textContent = 'Open…'
  placeholder.value = ''
  libSelect.append(placeholder)
  for (const p of state.library) {
    const opt = document.createElement('option')
    opt.value = p.id
    opt.textContent = p.name
    libSelect.append(opt)
  }
  libSelect.addEventListener('change', () => {
    const target = state.library.find((p) => p.id === libSelect.value)
    if (target !== undefined) {
      loadPlay(state, target)
      toast(`Opened “${target.name}”`)
    }
    libSelect.value = ''
  })
  mapGroup.append(libSelect)

  const fileGroup = need('file-group')
  fileGroup.replaceChildren()

  fileGroup.append(
    button('New', 'Start a blank play on this map', () => {
      loadPlay(state, createPlay(state.map))
      toast('New play — pick a player, press P and start drawing')
    }),
    button('Save', 'Save to this browser’s library', () => {
      savePlay(play(state))
      state.library = listPlays()
      notify()
      toast(`Saved “${play(state).name}”`)
    }),
    button('Export', 'Download as a .play.json file', () => exportFile(play(state))),
    button('Import', 'Load a .play.json file', () => {
      void importFile().then(
        (p) => {
          if (p !== null) {
            loadPlay(state, p)
            toast(`Imported “${p.name}”`)
          }
        },
        (err: unknown) => toast(err instanceof Error ? err.message : 'Import failed'),
      )
    }),
  )

  if (browserCodec !== null) {
    fileGroup.append(
      button('Share link', 'Copy a link that contains this whole play', () => {
        void shareUrl(play(state)).then(
          async (url) => {
            const copied = await copyToClipboard(url)
            globalThis.location.hash = url.slice(url.indexOf('#'))
            toast(copied ? 'Share link copied to the clipboard' : 'Share link is in the address bar')
          },
          (err: unknown) => toast(err instanceof ShareError ? err.message : 'Could not build a link'),
        )
      }),
    )
  }

  const help = button('?', 'Keyboard shortcuts', () => showShortcuts())
  help.className = 'ghost'
  fileGroup.append(help)
}

function showShortcuts(): void {
  const overlay = need('overlay')
  overlay.hidden = false
  overlay.replaceChildren()
  const card = document.createElement('div')
  card.className = 'card wide'
  card.innerHTML = `
    <h3>Shortcuts</h3>
    <div class="shortcut-grid">
      <div><b>V</b> select</div><div><b>P</b> draw path</div>
      <div><b>S F M H D</b> smoke / flash / molly / HE / decoy</div><div><b>A T O</b> arrow / text / zone</div>
      <div><b>K</b> measure</div><div><b>B</b> bomb plant spot</div>
      <div><b>7 8 9</b> run / walk / crouch</div><div><b>Z X C</b> draw onto lower / ground / upper</div>
      <div><b>Shift+Z X C</b> show / dim that layer</div><div><b>1–5</b> select player</div>
      <div><b>Space</b> play / pause</div><div><b>← →</b> step one tick</div>
      <div><b>Shift+← →</b> step one second</div><div><b>[ ]</b> playback speed</div>
      <div><b>Home / End</b> jump to start / end</div><div><b>0</b> fit map</div>
      <div><b>L</b> callout names</div><div><b>R</b> paths</div>
      <div><b>G</b> grid</div><div><b>E</b> presentation mode</div>
      <div><b>Del</b> delete selection</div><div><b>Cmd/Ctrl+Z</b> undo · <b>+Shift</b> redo</div>
      <div><b>Wheel</b> zoom at cursor</div><div><b>Middle / right / space-drag</b> pan</div>
      <div><b>Alt-click a path</b> insert a bend</div><div><b>Drag a timeline diamond</b> pin an arrival time</div>
    </div>
    <div class="card-actions"><button class="primary" id="shortcut-close">Close</button></div>
  `
  overlay.append(card)
  const close = (): void => {
    overlay.hidden = true
    overlay.replaceChildren()
  }
  document.getElementById('shortcut-close')?.addEventListener('click', close)
  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) close()
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────────────────────────

async function boot(): Promise<void> {
  // Validate the shipped geometry at startup as well as in CI. A map that fails here is
  // still drawn — a warning beats a blank screen — but the reason lands in the console.
  const map = mapOrDefault('dust2')
  const mapIssues = validateMapDef(map)
  if (mapIssues.length > 0) console.warn(`Map validation issues:\n${formatIssues(mapIssues)}`)

  seedLibrary()
  const library = listPlays()

  const shared = await playFromHash()
  const initial: Play =
    shared ?? loadAutosave() ?? examplesForMap('dust2')[0] ?? createPlay(map)

  const state = createState(initial, library)

  const playIssues = validatePlay(initial, state.map)
  if (playIssues.length > 0) console.warn(`Play validation issues:\n${formatIssues(playIssues)}`)

  const canvases: Canvases = {
    map: need<HTMLCanvasElement>('map-canvas'),
    scene: need<HTMLCanvasElement>('scene-canvas'),
  }

  const host: InteractionHost = {
    canvas: canvases.scene,
    viewport: () => {
      const rect = canvases.scene.getBoundingClientRect()
      return { width: Math.max(1, rect.width), height: Math.max(1, rect.height) }
    },
    toast,
    promptText,
  }

  attachPointer(state, host)
  attachKeyboard(state, host, () => fitToMap(state, host.viewport()))
  attachDropTarget(
    (p) => {
      loadPlay(state, p)
      toast(`Loaded “${p.name}”`)
    },
    (message) => toast(message),
  )

  need<HTMLInputElement>('play-name').addEventListener('change', (ev) => {
    const input = ev.target as HTMLInputElement
    apply(state, { kind: 'setMeta', name: input.value })
  })

  // Panels re-render on state change; the canvas is driven by the frame loop instead.
  let lastRevision = -1
  subscribe(() => {
    renderToolRail(state)
    renderRoster(state)
    renderInspector(state)
    renderLayers(state)
    renderTopbar(state)
    if (state.history.revision !== lastRevision) {
      lastRevision = state.history.revision
      renderTimeline(state)
      scheduleAutosave(play(state))
    } else {
      updatePlayhead(state)
    }
  })

  // Build every panel before measuring anything. The timeline's height depends on how many
  // actors the play has, and it is a grid row, so laying it out changes how tall the stage is.
  notify()
  renderTimeline(state)
  lastRevision = state.history.revision

  // Fit on the first *observed* size rather than on the next animation frame. A frame
  // callback can still run before the timeline has been laid out, and fitting against a
  // stage that is about to get shorter leaves the map cropped top and bottom.
  let hasFitted = false
  const resize = new ResizeObserver(() => {
    invalidateMapLayer()
    const vp = host.viewport()
    if (!hasFitted && vp.width > 2 && vp.height > 2) {
      hasFitted = true
      fitToMap(state, vp)
    }
  })
  resize.observe(canvases.scene)

  let last = performance.now()
  let loopErrors = 0

  const loop = (now: number): void => {
    // The frame is scheduled first and the work is guarded, because a throw anywhere in here
    // would otherwise skip the next `requestAnimationFrame` and stop rendering for good —
    // which looks exactly like a blank map rather than like a bug.
    requestAnimationFrame(loop)

    try {
      const dt = Math.min(0.25, (now - last) / 1000)
      last = now

      const wasPlaying = state.clock.playing
      state.clock = advance(state.clock, dt)

      const list = tracks(state)
      const frame = frameAt(play(state), list, state.clock.tick)

      // Record drawn positions so hit testing picks what the user can actually see.
      state.lastPositions.clear()
      for (const af of frame.actors) state.lastPositions.set(af.actorId, af.at)

      const vp: Viewport = render(canvases, state, frame, list)
      void vp

      updatePlayhead(state)
      updateNowPlaying(state, frame)

      // Playback ending (non-loop) flips the transport button, so panels need to know.
      if (wasPlaying && !state.clock.playing) notify()
    } catch (err) {
      loopErrors += 1
      // Log the first few and then go quiet: a bug that fires every frame would otherwise
      // bury the console in sixty identical stacks a second.
      if (loopErrors <= 3) console.error('playbook frame error', err)
      if (loopErrors === 3) console.error('further frame errors will be suppressed')
    }
  }
  requestAnimationFrame(loop)

  toast('Press ? for shortcuts. Space plays, drag the timeline to scrub.')
}

/** The little readout under the canvas: hovered callout, plus any active leg note. */
function updateNowPlaying(state: AppState, frame: ReturnType<typeof frameAt>): void {
  const node = need('hint')
  const notes: string[] = []
  const current = play(state)
  for (const af of frame.actors) {
    if (af.note === undefined) continue
    const actor = current.actors.find((a) => a.id === af.actorId)
    if (actor === undefined || state.hiddenTeams.has(actor.team)) continue
    notes.push(`${actor.name}: ${af.note}`)
  }
  const parts: string[] = []
  if (state.hint !== '') parts.push(state.hint)
  const text = [parts.join(''), ...notes.slice(0, 3)].filter((x) => x !== '').join('  ·  ')
  if (node.textContent !== text) node.textContent = text
}

void boot().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err)
  const node = document.getElementById('hint')
  if (node !== null) node.textContent = `Failed to start: ${message}`
  console.error(err)
})
