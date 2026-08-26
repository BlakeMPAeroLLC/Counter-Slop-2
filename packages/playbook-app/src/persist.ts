/**
 * Persistence: autosave, a named library, files, and share links.
 *
 * Everything lives in the browser. There is no server, so a play cannot be lost to one going
 * down and cannot be leaked by one being misconfigured — the trade is that the library is
 * per-browser, which is why file export exists alongside it.
 */

import {
  type Codec,
  type Play,
  EXAMPLE_PLAYS,
  PlayParseError,
  ShareError,
  decodePlay,
  encodePlay,
  parsePlayJson,
  stringifyPlay,
  tokenFromHash,
} from '@cs2/playbook'

const AUTOSAVE_KEY = 'cs2.playbook.autosave'
const INDEX_KEY = 'cs2.playbook.index'
const PLAY_PREFIX = 'cs2.playbook.play.'
const SEEDED_KEY = 'cs2.playbook.seeded'

/**
 * `localStorage` throws in a few real situations — Safari private browsing, storage disabled
 * by policy, quota exceeded. None of them should take the editor down, so every access is
 * wrapped and a failure degrades to "this session is not saved".
 */
function store(): Storage | null {
  try {
    const s = globalThis.localStorage
    // Probe, because the object can exist and still throw on write.
    s.setItem('cs2.playbook.probe', '1')
    s.removeItem('cs2.playbook.probe')
    return s
  } catch {
    return null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Autosave
// ─────────────────────────────────────────────────────────────────────────────

let autosaveTimer: ReturnType<typeof setTimeout> | null = null

/** Debounced so a drag does not write to disk two hundred times. */
export function scheduleAutosave(play: Play): void {
  if (autosaveTimer !== null) clearTimeout(autosaveTimer)
  autosaveTimer = setTimeout(() => {
    autosaveTimer = null
    const s = store()
    if (s === null) return
    try {
      s.setItem(AUTOSAVE_KEY, stringifyPlay(play))
    } catch {
      /* Quota exceeded. Nothing useful to do; the editor keeps working. */
    }
  }, 400)
}

export function loadAutosave(): Play | null {
  const s = store()
  if (s === null) return null
  const text = s.getItem(AUTOSAVE_KEY)
  if (text === null) return null
  try {
    return parsePlayJson(text)
  } catch {
    // A corrupt autosave must never wedge startup — drop it and open a fresh play instead.
    s.removeItem(AUTOSAVE_KEY)
    return null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Library
// ─────────────────────────────────────────────────────────────────────────────

function readIndex(s: Storage): string[] {
  const raw = s.getItem(INDEX_KEY)
  if (raw === null) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function savePlay(play: Play): void {
  const s = store()
  if (s === null) return
  try {
    s.setItem(`${PLAY_PREFIX}${play.id}`, stringifyPlay(play))
    const index = readIndex(s)
    if (!index.includes(play.id)) s.setItem(INDEX_KEY, JSON.stringify([...index, play.id]))
  } catch {
    /* Out of quota. The caller surfaces this via `savePlay` returning nothing useful. */
  }
}

export function deletePlay(id: string): void {
  const s = store()
  if (s === null) return
  s.removeItem(`${PLAY_PREFIX}${id}`)
  s.setItem(INDEX_KEY, JSON.stringify(readIndex(s).filter((x) => x !== id)))
}

export function listPlays(): Play[] {
  const s = store()
  if (s === null) return [...EXAMPLE_PLAYS]
  const out: Play[] = []
  for (const id of readIndex(s)) {
    const text = s.getItem(`${PLAY_PREFIX}${id}`)
    if (text === null) continue
    try {
      out.push(parsePlayJson(text))
    } catch {
      /* Skip a corrupt entry rather than failing the whole listing. */
    }
  }
  return out
}

/**
 * Copies the bundled examples into the library the first time the app runs.
 *
 * Guarded by its own key rather than by "is the library empty", so deleting every example
 * on purpose does not bring them all back on the next reload.
 */
export function seedLibrary(): void {
  const s = store()
  if (s === null) return
  if (s.getItem(SEEDED_KEY) !== null) return
  for (const play of EXAMPLE_PLAYS) savePlay(play)
  s.setItem(SEEDED_KEY, new Date().toISOString())
}

// ─────────────────────────────────────────────────────────────────────────────
// Files
// ─────────────────────────────────────────────────────────────────────────────

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'play'
  )
}

export function exportFile(play: Play): void {
  const blob = new Blob([stringifyPlay(play)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${slug(play.name)}.play.json`
  a.click()
  // Revoking immediately can cancel the download in some browsers; a tick is enough.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Opens a file picker and resolves to the parsed play, or null if cancelled. */
export function importFile(): Promise<Play | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json,application/json'
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (file === undefined) {
        resolve(null)
        return
      }
      void file.text().then(
        (text) => {
          try {
            resolve(parsePlayJson(text))
          } catch (err) {
            const message = err instanceof PlayParseError ? err.message : 'could not read that file'
            throw new Error(message)
          }
        },
        () => resolve(null),
      )
    })
    input.click()
  })
}

/** Wires drag-and-drop of a `.play.json` onto the whole window. */
export function attachDropTarget(onPlay: (play: Play) => void, onError: (message: string) => void): void {
  const stop = (ev: DragEvent): void => {
    ev.preventDefault()
    ev.stopPropagation()
  }
  globalThis.addEventListener('dragover', stop)
  globalThis.addEventListener('drop', (ev) => {
    stop(ev)
    const file = ev.dataTransfer?.files?.[0]
    if (file === undefined) return
    void file.text().then((text) => {
      try {
        onPlay(parsePlayJson(text))
      } catch (err) {
        onError(err instanceof PlayParseError ? err.message : 'that file is not a play')
      }
    })
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Share links
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Codec over the platform's `CompressionStream`.
 *
 * Available in every current browser. Where it is missing the share buttons are hidden rather
 * than silently producing a link nobody can open.
 */
export const browserCodec: Codec | null = (() => {
  const g = globalThis as {
    CompressionStream?: new (format: string) => TransformStream<Uint8Array, Uint8Array>
    DecompressionStream?: new (format: string) => TransformStream<Uint8Array, Uint8Array>
  }
  const Comp = g.CompressionStream
  const Decomp = g.DecompressionStream
  if (Comp === undefined || Decomp === undefined) return null

  const pump = async (
    bytes: Uint8Array,
    stream: TransformStream<Uint8Array, Uint8Array>,
  ): Promise<Uint8Array> => {
    const writer = stream.writable.getWriter()
    void writer.write(bytes)
    void writer.close()
    const chunks: Uint8Array[] = []
    const reader = stream.readable.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value !== undefined) chunks.push(value)
    }
    const total = chunks.reduce((n, c) => n + c.length, 0)
    const out = new Uint8Array(total)
    let offset = 0
    for (const c of chunks) {
      out.set(c, offset)
      offset += c.length
    }
    return out
  }

  return {
    compress: (bytes) => pump(bytes, new Comp('deflate-raw')),
    decompress: (bytes) => pump(bytes, new Decomp('deflate-raw')),
  }
})()

/** Builds a share URL for the current play, or throws `ShareError` if it is too big. */
export async function shareUrl(play: Play): Promise<string> {
  if (browserCodec === null) throw new ShareError('this browser cannot build share links')
  const token = await encodePlay(play, browserCodec)
  const base = `${globalThis.location.origin}${globalThis.location.pathname}`
  return `${base}#p=${token}`
}

/** Reads a play out of the current URL hash, if there is one. */
export async function playFromHash(): Promise<Play | null> {
  if (browserCodec === null) return null
  const token = tokenFromHash(globalThis.location.hash)
  if (token === null || token === '') return null
  try {
    return await decodePlay(token, browserCodec)
  } catch {
    return null
  }
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await globalThis.navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
