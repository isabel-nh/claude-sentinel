import { expect, test } from 'claude-code/testing'
import { hasSentinel, insertSentinel, insertSentinelText } from '../hooks/apply.ts'
import { decodeUtf8, encodeText } from '../hooks/encoding.ts'
import { sentinelFor } from '../hooks/rules.ts'

const S = sentinelFor('a.cs')!
const SH = sentinelFor('a.sh')!
const SQL = sentinelFor('a.sql')!
const enc = (s: string) => new TextEncoder().encode(s)
const dec = (b: Uint8Array) => decodeUtf8(b, 0)
const cat = (...parts: (Uint8Array | number[])[]) => new Uint8Array(parts.flatMap(p => [...p]))

test('LF file gets sentinel + LF on line 1', () => {
  expect(dec(insertSentinel(enc('x\ny\n'), 'a.cs')!)).toBe(`${S}\nx\ny\n`)
})

test('CRLF file gets CRLF', () => {
  expect(dec(insertSentinel(enc('x\r\n'), 'a.cs')!)).toBe(`${S}\r\nx\r\n`)
})

test('empty file gets the sentinel and LF only', () => {
  expect(dec(insertSentinel(new Uint8Array(), 'a.cs')!)).toBe(`${S}\n`)
})

test('single line with no terminator', () => {
  expect(dec(insertSentinel(enc('x'), 'a.cs')!)).toBe(`${S}\nx`)
})

test('CRLF shebang keeps line 1 and its CR', () => {
  expect(dec(insertSentinel(enc('#!/bin/sh\r\necho\r\n'), 'a.sh')!)).toBe(`#!/bin/sh\r\n${SH}\r\necho\r\n`)
})

test('shebang with no terminator gains LF before the sentinel', () => {
  expect(dec(insertSentinel(enc('#!/bin/sh'), 'a.sh')!)).toBe(`#!/bin/sh\n${SH}\n`)
})

test('shebang longer than 512 characters still puts the sentinel on line 2', () => {
  const bang = `#!${'x'.repeat(600)}`
  expect(dec(insertSentinel(enc(`${bang}\nbody\n`), 'a.sh')!)).toBe(`${bang}\n${SH}\nbody\n`)
})

test('UTF-8 BOM stays at byte 0', () => {
  const out = insertSentinel(cat([0xef, 0xbb, 0xbf], enc('x\n')), 'a.cs')!
  expect([...out]).toEqual([...cat([0xef, 0xbb, 0xbf], enc(`${S}\nx\n`))])
})

test('UTF-16LE: only the sentinel is encoded and body bytes are identical', () => {
  const body = encodeText('select 1\r\n', 'UTF-16LE')
  const out = insertSentinel(cat([0xff, 0xfe], body), 'a.sql')!
  expect([...out]).toEqual([...cat([0xff, 0xfe], encodeText(`${SQL}\r\n`, 'UTF-16LE'), body)])
})

test('UTF-16 shebang script takes line 1', () => {
  const body = encodeText('#!/bin/sh\necho\n', 'UTF-16LE')
  const out = insertSentinel(cat([0xff, 0xfe], body), 'a.sh')!
  expect([...out]).toEqual([...cat([0xff, 0xfe], encodeText(`${SH}\n`, 'UTF-16LE'), body)])
})

test('Windows-1252 body bytes survive', () => {
  const b = new Uint8Array([0x63, 0xe9, 0x0a])
  const out = insertSentinel(b, 'a.sql')!
  expect([...out]).toEqual([...cat(enc(`${SQL}\n`), b)])
})

test('already present on line 1 or line 2 returns undefined', () => {
  expect(insertSentinel(enc(`${S}\nx`), 'a.cs')).toBeUndefined()
  expect(insertSentinel(enc(`#!/bin/sh\n${SH}\n`), 'a.sh')).toBeUndefined()
  expect(hasSentinel(enc(`${S}\r\nx`), 'a.cs')).toBe(true)
})

test('marker on line 3 only does not count as present', () => {
  const src = 'a\nb\n// TODO: Manual review needed\n'
  expect(dec(insertSentinel(enc(src), 'a.cs')!)).toBe(`${S}\n${src}`)
})

test('sentinel on line 1 of a shebang script is not where it belongs', () => {
  expect(hasSentinel(enc(`#!/bin/sh\necho\n`), 'a.sh')).toBe(false)
})

test('skipped extension returns undefined', () => {
  expect(insertSentinel(enc('x'), 'a.json')).toBeUndefined()
})

test('insertSentinelText mirrors insertSentinel for UTF-8', () => {
  expect(insertSentinelText('x\r\n', 'a.cs')).toBe(`${S}\r\nx\r\n`)
  expect(insertSentinelText('', 'a.cs')).toBe(`${S}\n`)
  expect(insertSentinelText(`${S}\nx`, 'a.cs')).toBeUndefined()
  expect(insertSentinelText('x', 'a.md')).toBeUndefined()
})

test('retire: UTF-8 BOM before a shebang keeps BOM at byte 0, shebang on line 1, sentinel on line 2', () => {
  const out = insertSentinel(cat([0xef, 0xbb, 0xbf], enc('#!/bin/bash\necho\n')), 'a.sh')!
  expect([...out.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
  expect(decodeUtf8(out, 3)).toBe(`#!/bin/bash\n${SH}\necho\n`)
})

test('retire: node shebang in .mjs keeps line 1; sentinel on line 2', () => {
  expect(dec(insertSentinel(enc('#!/usr/bin/env node\nconsole.log(1)\n'), 'a.mjs')!)).toBe(`#!/usr/bin/env node\n${sentinelFor('a.mjs')}\nconsole.log(1)\n`)
})
