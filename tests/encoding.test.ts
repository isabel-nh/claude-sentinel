import { expect, test } from 'claude-code/testing'
import { decodeLines, decodeUtf8, detectBom, encodeText, isValidUtf8, type Encoding } from '../hooks/encoding.ts'

const BOMS: Record<Encoding, number[]> = {
  'UTF-8': [0xef, 0xbb, 0xbf],
  'UTF-16LE': [0xff, 0xfe],
  'UTF-16BE': [0xfe, 0xff],
  'UTF-32LE': [0xff, 0xfe, 0, 0],
  'UTF-32BE': [0, 0, 0xfe, 0xff],
}

const withBom = (enc: Encoding, text: string) => new Uint8Array([...BOMS[enc], ...encodeText(text, enc)])

test('BOM detection checks UTF-32LE before UTF-16LE', () => {
  expect(detectBom(new Uint8Array([0xff, 0xfe, 0, 0, 0x61, 0, 0, 0])).kind).toBe('utf32le')
  expect(detectBom(new Uint8Array([0xff, 0xfe, 0x61, 0])).kind).toBe('utf16le')
  expect(detectBom(new Uint8Array([0, 0, 0xfe, 0xff])).kind).toBe('utf32be')
  expect(detectBom(new Uint8Array([0xfe, 0xff, 0, 0x61])).kind).toBe('utf16be')
  expect(detectBom(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))).toEqual({ kind: 'utf8', length: 3, encoding: 'UTF-8' })
  expect(detectBom(new Uint8Array([0x61]))).toEqual({ kind: 'none', length: 0, encoding: 'UTF-8' })
  expect(detectBom(new Uint8Array([]))).toEqual({ kind: 'none', length: 0, encoding: 'UTF-8' })
})

test('decodeLines keeps terminators and absolute byte offsets', () => {
  const b = withBom('UTF-16LE', 'a\r\nb\nc')
  const lines = decodeLines(b, detectBom(b), 2)
  expect(lines).toEqual([
    { text: 'a', terminator: '\r\n', end: 8 },
    { text: 'b', terminator: '\n', end: 12 },
  ])
})

test('decodeLines on a last line with no terminator', () => {
  const b = new TextEncoder().encode('x')
  expect(decodeLines(b, detectBom(b), 2)).toEqual([{ text: 'x', terminator: '', end: 1 }])
})

test('decodeLines on an empty body returns no lines', () => {
  expect(decodeLines(new Uint8Array([0xef, 0xbb, 0xbf]), detectBom(new Uint8Array([0xef, 0xbb, 0xbf])), 2)).toEqual([])
})

test('encodeText round-trips through decodeLines for every encoding', () => {
  for (const enc of Object.keys(BOMS) as Encoding[]) {
    const b = withBom(enc, 'é𝄞\nz')
    expect(decodeLines(b, detectBom(b), 1)[0]).toMatchObject({ text: 'é𝄞', terminator: '\n' })
  }
})

test('encodeText writes no BOM', () => {
  expect([...encodeText('a', 'UTF-16LE')]).toEqual([0x61, 0])
  expect([...encodeText('a', 'UTF-32BE')]).toEqual([0, 0, 0, 0x61])
})

test('isValidUtf8 accepts UTF-8 and rejects Windows-1252 bytes', () => {
  expect(isValidUtf8(new TextEncoder().encode('café 𝄞'), 0)).toBe(true)
  expect(isValidUtf8(new Uint8Array([0x63, 0xe9, 0x0a]), 0)).toBe(false)
  expect(isValidUtf8(new Uint8Array([0xed, 0xa0, 0x80]), 0)).toBe(false)
})

test('decodeUtf8 decodes from an offset', () => {
  expect(decodeUtf8(new Uint8Array([0xef, 0xbb, 0xbf, 0xc3, 0xa9]), 3)).toBe('é')
})
