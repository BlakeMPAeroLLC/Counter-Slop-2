import { deflateRaw, inflateRaw } from 'node:zlib'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import {
  type Codec,
  MAX_TOKEN_LENGTH,
  ShareError,
  decodePlay,
  encodePlay,
  fromBase64Url,
  toBase64Url,
  tokenFromHash,
} from '../src/share.js'
import { createPlay } from '../src/play.js'
import { DUST2 } from '../src/maps/dust2.js'
import { DUST2_PLAYS } from '../src/plays/dust2.js'

const deflate = promisify(deflateRaw)
const inflate = promisify(inflateRaw)

/**
 * `share.ts` takes its compressor as a parameter precisely so it can be exercised here: the
 * browser injects a `CompressionStream`, this test injects `node:zlib`. Same wire format, so
 * a link produced in one is readable by the other.
 */
const nodeCodec: Codec = {
  compress: async (bytes) => new Uint8Array(await deflate(bytes)),
  decompress: async (bytes) => new Uint8Array(await inflate(bytes)),
}

describe('base64url', () => {
  it('round-trips arbitrary bytes at every length modulo 3', () => {
    for (const len of [0, 1, 2, 3, 4, 5, 255, 1000]) {
      const bytes = new Uint8Array(len)
      for (let i = 0; i < len; i++) bytes[i] = (i * 37 + 11) & 0xff
      expect(Array.from(fromBase64Url(toBase64Url(bytes)))).toEqual(Array.from(bytes))
    }
  })

  it('produces only URL-safe characters', () => {
    const bytes = new Uint8Array(512)
    for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff
    expect(toBase64Url(bytes)).toMatch(/^[A-Za-z0-9\-_]*$/)
  })
})

describe('encodePlay / decodePlay', () => {
  it('round-trips a blank play', async () => {
    const play = createPlay(DUST2)
    const token = await encodePlay(play, nodeCodec)
    expect(await decodePlay(token, nodeCodec)).toEqual(play)
  })

  it('round-trips every bundled example', async () => {
    for (const play of DUST2_PLAYS) {
      const token = await encodePlay(play, nodeCodec)
      expect(await decodePlay(token, nodeCodec)).toEqual(play)
    }
  })

  it('is deterministic, so clicking Share twice gives the same link', async () => {
    const play = DUST2_PLAYS[0]
    expect(play).toBeDefined()
    if (play === undefined) return
    expect(await encodePlay(play, nodeCodec)).toBe(await encodePlay(play, nodeCodec))
  })

  it('keeps a full example play well inside the link length limit', async () => {
    for (const play of DUST2_PLAYS) {
      const token = await encodePlay(play, nodeCodec)
      expect(token.length).toBeLessThan(MAX_TOKEN_LENGTH / 2)
    }
  })

  it('refuses an oversized play instead of producing a truncated link', async () => {
    // Deliberately near-incompressible filler. A run of repeated characters would deflate to
    // almost nothing and the cap would never trip, which would make this test pass for the
    // wrong reason.
    let noise = ''
    let seed = 12345
    while (noise.length < 200_000) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      noise += String.fromCharCode(33 + (seed % 90))
    }
    const fat = { ...createPlay(DUST2), description: noise }
    await expect(encodePlay(fat, nodeCodec)).rejects.toThrow(ShareError)
  })

  it('reports a corrupt token rather than crashing', async () => {
    await expect(decodePlay('not-a-real-token', nodeCodec)).rejects.toThrow()
  })
})

describe('tokenFromHash', () => {
  it('finds the token with or without the leading hash', () => {
    expect(tokenFromHash('#p=abc')).toBe('abc')
    expect(tokenFromHash('p=abc')).toBe('abc')
  })

  it('finds it among other fragment params', () => {
    expect(tokenFromHash('#foo=1&p=abc&bar=2')).toBe('abc')
  })

  it('returns null when there is nothing to load', () => {
    expect(tokenFromHash('')).toBeNull()
    expect(tokenFromHash('#other=1')).toBeNull()
  })
})
