/**
 * Share links.
 *
 * A play encodes to `#p=<base64url(deflate-raw(json))>` and lives entirely in the URL
 * fragment, which means sharing needs no server, no account, and no upload — the fragment is
 * never even sent to the host serving the page. For a coaching tool passed around in a team
 * chat that is exactly the right trade.
 *
 * The compressor is injected rather than imported so this module stays DOM-free: the browser
 * supplies a `CompressionStream` codec, and the test supplies one built on `node:zlib`. That
 * is also how the round trip gets real compression coverage in a `node` test environment.
 */

import { parsePlayFile, toPlayFile } from './serialize.js'
import type { Play } from './types.js'

/**
 * Minimal declarations for the two globals this module needs.
 *
 * The package compiles with `"types": []` so that nothing here can accidentally depend on
 * Node or DOM typings — that constraint is what keeps the core reusable from the browser, the
 * server and a `node` test run alike. `TextEncoder`/`TextDecoder` are standard in all three,
 * but they live in `@types/node` and `lib.dom`, neither of which is loaded. Declaring the
 * surface actually used is cheaper and more honest than pulling in either library.
 */
declare const TextEncoder: {
  new (): { encode(input: string): Uint8Array }
}
declare const TextDecoder: {
  new (): { decode(input: Uint8Array): string }
}

export interface Codec {
  compress(bytes: Uint8Array): Promise<Uint8Array>
  decompress(bytes: Uint8Array): Promise<Uint8Array>
}

/**
 * Refuse to produce a link longer than this many characters.
 *
 * Browsers tolerate far more, but chat clients and mail readers truncate long URLs silently,
 * and a play that arrives half-decoded is worse than one that never arrived. Past this point
 * the UI offers "copy the JSON" instead.
 */
export const MAX_TOKEN_LENGTH = 12_000

export class ShareError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ShareError'
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// base64url
// ─────────────────────────────────────────────────────────────────────────────

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/**
 * Hand-rolled base64url.
 *
 * `btoa` is browser-only and `Buffer` is Node-only; this module has to run in both without
 * either. It is thirty lines and it removes a platform branch from the one code path whose
 * failure mode is a silently corrupted share link.
 */
export function toBase64Url(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0
    const b1 = bytes[i + 1] ?? 0
    const b2 = bytes[i + 2] ?? 0
    const remaining = bytes.length - i
    out += B64_ALPHABET[b0 >> 2]
    out += B64_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)]
    if (remaining > 1) out += B64_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)]
    if (remaining > 2) out += B64_ALPHABET[b2 & 0x3f]
  }
  return out
}

export function fromBase64Url(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9\-_]/g, '')
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let outIndex = 0
  let acc = 0
  let bits = 0
  for (const ch of clean) {
    const v = B64_ALPHABET.indexOf(ch)
    if (v < 0) throw new ShareError('share link contains characters that are not valid base64url')
    acc = (acc << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[outIndex++] = (acc >> bits) & 0xff
    }
  }
  return out.subarray(0, outIndex)
}

// ─────────────────────────────────────────────────────────────────────────────
// Encode / decode
// ─────────────────────────────────────────────────────────────────────────────

export async function encodePlay(play: Play, codec: Codec): Promise<string> {
  // No pretty-printing and no `savedAt` churn: a link is transient, and the timestamp would
  // make the same play produce a different link every time you clicked Share.
  const json = JSON.stringify(toPlayFile(play, ''))
  const packed = await codec.compress(new TextEncoder().encode(json))
  const token = toBase64Url(packed)
  if (token.length > MAX_TOKEN_LENGTH) {
    throw new ShareError(
      `this play is too large to share as a link (${token.length} characters, limit ${MAX_TOKEN_LENGTH}). ` +
        'Export it as a .play.json file instead.',
    )
  }
  return token
}

export async function decodePlay(token: string, codec: Codec): Promise<Play> {
  const bytes = fromBase64Url(token)
  let json: string
  try {
    json = new TextDecoder().decode(await codec.decompress(bytes))
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error'
    throw new ShareError(`could not decompress the share link: ${message}`)
  }
  return parsePlayFile(JSON.parse(json))
}

/** Pulls the `p=` token out of a location hash, or null if there is not one. */
export function tokenFromHash(hash: string): string | null {
  const trimmed = hash.startsWith('#') ? hash.slice(1) : hash
  for (const part of trimmed.split('&')) {
    if (part.startsWith('p=')) return part.slice(2)
  }
  return null
}
