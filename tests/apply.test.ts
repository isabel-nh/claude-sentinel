import { expect, test } from 'claude-code/testing'
import { hasSentinel, insertSentinel, insertSentinelText } from '../hooks/apply.ts'
import { decodeUtf8, encodeText } from '../hooks/encoding.ts'
import { TAIL } from '../hooks/rules.ts'
import { buildTable, PRESETS, resolve, type Rule } from '../hooks/types.ts'

const S = `// ${TAIL}`
const SH = `# ${TAIL}`
const SQL = `-- ${TAIL}`
const TABLE = buildTable('').table
const rule = (p: string): Rule => resolve(TABLE, p)!
// The inserted bytes; fails the test on any other outcome.
const ins = (b: Uint8Array, p: string | Rule): Uint8Array => {
  const r = insertSentinel(b, typeof p === 'string' ? rule(p) : p)
  if (!('bytes' in r)) throw new Error(`not inserted: ${JSON.stringify(r)}`)
  return r.bytes
}
const enc = (s: string) => new TextEncoder().encode(s)
const dec = (b: Uint8Array) => decodeUtf8(b, 0)
const cat = (...parts: (Uint8Array | number[])[]) => new Uint8Array(parts.flatMap(p => [...p]))

test('LF file gets sentinel + LF on line 1', () => {
  expect(dec(ins(enc('x\ny\n'), 'a.cs'))).toBe(`${S}\nx\ny\n`)
})

test('CRLF file gets CRLF', () => {
  expect(dec(ins(enc('x\r\n'), 'a.cs'))).toBe(`${S}\r\nx\r\n`)
})

test('empty file gets the sentinel and LF only', () => {
  expect(dec(ins(new Uint8Array(), 'a.cs'))).toBe(`${S}\n`)
})

test('single line with no terminator', () => {
  expect(dec(ins(enc('x'), 'a.cs'))).toBe(`${S}\nx`)
})

test('CRLF shebang keeps line 1 and its CR', () => {
  expect(dec(ins(enc('#!/bin/sh\r\necho\r\n'), 'a.sh'))).toBe(`#!/bin/sh\r\n${SH}\r\necho\r\n`)
})

test('shebang with no terminator gains LF before the sentinel', () => {
  expect(dec(ins(enc('#!/bin/sh'), 'a.sh'))).toBe(`#!/bin/sh\n${SH}\n`)
})

test('shebang longer than 512 characters still puts the sentinel on line 2', () => {
  const bang = `#!${'x'.repeat(600)}`
  expect(dec(ins(enc(`${bang}\nbody\n`), 'a.sh'))).toBe(`${bang}\n${SH}\nbody\n`)
})

test('UTF-8 BOM stays at byte 0', () => {
  const out = ins(cat([0xef, 0xbb, 0xbf], enc('x\n')), 'a.cs')
  expect([...out]).toEqual([...cat([0xef, 0xbb, 0xbf], enc(`${S}\nx\n`))])
})

test('UTF-16LE: only the sentinel is encoded and body bytes are identical', () => {
  const body = encodeText('select 1\r\n', 'UTF-16LE')
  const out = ins(cat([0xff, 0xfe], body), 'a.sql')
  expect([...out]).toEqual([...cat([0xff, 0xfe], encodeText(`${SQL}\r\n`, 'UTF-16LE'), body)])
})

test('UTF-16 shebang script takes line 1', () => {
  const body = encodeText('#!/bin/sh\necho\n', 'UTF-16LE')
  const out = ins(cat([0xff, 0xfe], body), 'a.sh')
  expect([...out]).toEqual([...cat([0xff, 0xfe], encodeText(`${SH}\n`, 'UTF-16LE'), body)])
})

test('Windows-1252 body bytes survive', () => {
  const b = new Uint8Array([0x63, 0xe9, 0x0a])
  const out = ins(b, 'a.sql')
  expect([...out]).toEqual([...cat(enc(`${SQL}\n`), b)])
})

test('already present on line 1 or line 2 reports present', () => {
  expect(insertSentinel(enc(`${S}\nx`), rule('a.cs'))).toEqual({ present: true })
  expect(insertSentinel(enc(`#!/bin/sh\n${SH}\n`), rule('a.sh'))).toEqual({ present: true })
  expect(hasSentinel(enc(`${S}\r\nx`), rule('a.cs'))).toBe(true)
})

test('marker on line 3 only does not count as present', () => {
  const src = 'a\nb\n// TODO: Manual review needed\n'
  expect(dec(ins(enc(src), 'a.cs'))).toBe(`${S}\n${src}`)
})

test('sentinel on line 1 of a shebang script is not where it belongs', () => {
  expect(hasSentinel(enc(`#!/bin/sh\necho\n`), rule('a.sh'))).toBe(false)
})

test('a type with no rule resolves to nothing', () => {
  expect(resolve(TABLE, 'a.json')).toBeUndefined()
})

const PRESET_TABLE = buildTable(JSON.stringify(PRESETS)).table
const JSON_RULE = resolve(PRESET_TABLE, 'a.json')!
const MD_RULE = resolve(PRESET_TABLE, 'a.md')!

test('insertSentinelText mirrors insertSentinel for UTF-8', () => {
  expect(insertSentinelText('x\r\n', rule('a.cs'))).toBe(`${S}\r\nx\r\n`)
  expect(insertSentinelText('', rule('a.cs'))).toBe(`${S}\n`)
  expect(insertSentinelText(`${S}\nx`, rule('a.cs'))).toBeUndefined()
  expect(insertSentinelText('[1]\n', JSON_RULE)).toBeUndefined()
})

test('retire: UTF-8 BOM before a shebang keeps BOM at byte 0, shebang on line 1, sentinel on line 2', () => {
  const out = ins(cat([0xef, 0xbb, 0xbf], enc('#!/bin/bash\necho\n')), 'a.sh')
  expect([...out.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
  expect(decodeUtf8(out, 3)).toBe(`#!/bin/bash\n${SH}\necho\n`)
})

test('retire: node shebang in .mjs keeps line 1; sentinel on line 2', () => {
  expect(dec(ins(enc('#!/usr/bin/env node\nconsole.log(1)\n'), 'a.mjs'))).toBe(`#!/usr/bin/env node\n${S}\nconsole.log(1)\n`)
})

test('json-property inserts after the brace, keeps BOM and CRLF', () => {
  const out = ins(cat([0xef, 0xbb, 0xbf], enc('{\r\n  "a": 1\r\n}\r\n')), JSON_RULE)
  expect([...out.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
  expect(decodeUtf8(out, 3)).toBe(`{\r\n  "_comment": "${TAIL}",\r\n  "a": 1\r\n}\r\n`)
  expect(hasSentinel(out, JSON_RULE)).toBe(true)
})

test('json-property empty object has no comma', () => {
  expect(dec(ins(enc('{\n}\n'), JSON_RULE))).toBe(`{\n  "_comment": "${TAIL}"\n}\n`)
})

test('unsupported json is left alone', () => {
  expect(insertSentinel(enc('[1]\n'), JSON_RULE)).toEqual({ unsupported: 'top level is not an object' })
  expect(hasSentinel(enc('[1]\n'), JSON_RULE)).toBe(false)
})

test('markdown frontmatter gets line 2', () => {
  expect(dec(ins(enc('---\nname: x\n---\nbody\n'), MD_RULE))).toBe(`---\n# ${TAIL}\nname: x\n---\nbody\n`)
})

test('insertion at line 4 after an unterminated line 3', () => {
  const r: Rule = { style: 'line', prefix: '#', skip: [/^#!/, /^#b/, /^#c/] }
  expect(dec(ins(enc('#!a\n#b\n#c'), r))).toBe(`#!a\n#b\n#c\n# ${TAIL}\n`)
})
