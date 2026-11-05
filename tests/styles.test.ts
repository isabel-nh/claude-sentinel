import { expect, test } from 'claude-code/testing'
import { TAIL } from '../hooks/rules.ts'
import { locate, MAX_LINES, type Located } from '../hooks/styles.ts'
import type { Rule } from '../hooks/types.ts'

const hash = (...skip: string[]): Rule => ({ style: 'line', prefix: '#', skip: skip.map(s => new RegExp(s)) })
const JSON_RULE: Rule = { style: 'json-property', key: '_comment' }
const MD: Rule = { style: 'markdown' }

// Splices the located line in and expects locate to find it again at the same index.
function roundTrip(rule: Rule, lines: string[], utf8 = true): Located {
  const got = locate(rule, lines, utf8)
  if ('unsupported' in got) return got
  const spliced = [...lines.slice(0, got.at), got.line, ...lines.slice(got.at)].slice(0, MAX_LINES)
  expect(locate(rule, spliced, utf8)).toEqual({ at: got.at, present: true, line: got.line })
  return got
}

test('line skip walks patterns in order and passes over misses', () => {
  const rule = hash('^#!', '^# -\\*-')
  expect(roundTrip(rule, ['#!/bin/sh', '# -*- coding -*-', 'x'])).toEqual({ at: 2, present: false, line: `# ${TAIL}` })
  expect(roundTrip(rule, ['# -*- coding -*-', 'x'])).toMatchObject({ at: 1, present: false })
  expect(roundTrip(rule, ['x'])).toMatchObject({ at: 0, present: false })
  expect(roundTrip(rule, [])).toMatchObject({ at: 0, present: false })
})

test('skip never consumes a marker line', () => {
  const rule = hash('^#')
  const s = (locate(rule, ['x'], true) as { line: string }).line
  expect(locate(rule, [s, 'x'], true)).toEqual({ at: 0, present: true, line: s })
  expect(locate(rule, ['#!x', s, 'y'], true)).toEqual({ at: 1, present: true, line: s })
})

test('skip is ignored for non-UTF-8', () => {
  expect(locate(hash('^#!'), ['#!/bin/sh', 'x'], false)).toMatchObject({ at: 0, present: false })
})

test('at most 3 skips keep the sentinel within line 4', () => {
  expect(roundTrip(hash('^a', '^a', '^a'), ['a', 'a', 'a', 'a'])).toMatchObject({ at: 3, present: false })
})

test('block renders prefix, tail, suffix', () => {
  const rule: Rule = { style: 'block', prefix: '/*', suffix: '*/', skip: [] }
  expect(roundTrip(rule, ['x'])).toEqual({ at: 0, present: false, line: `/* ${TAIL} */` })
})

test('json-property places the key after the opening brace', () => {
  expect(roundTrip(JSON_RULE, ['{', '  "a": 1', '}'])).toEqual({ at: 1, present: false, line: `  "_comment": "${TAIL}",` })
  expect(roundTrip(JSON_RULE, ['{', '\t"a": 1'])).toEqual({ at: 1, present: false, line: `\t"_comment": "${TAIL}",` })
  expect(roundTrip(JSON_RULE, ['{', '}'])).toEqual({ at: 1, present: false, line: `  "_comment": "${TAIL}"` })
  expect(roundTrip(JSON_RULE, ['  {  ', '', '    "a": 1'])).toEqual({ at: 1, present: false, line: `    "_comment": "${TAIL}",` })
  expect(roundTrip(JSON_RULE, ['', '{', '  "a": 1'])).toMatchObject({ at: 2, present: false })
  expect(locate({ style: 'json-property', key: 'note' }, ['{', '}'], true)).toMatchObject({ line: `  "note": "${TAIL}"` })
})

test('json-property refuses what it cannot place', () => {
  expect(locate(JSON_RULE, ['', '', '', '{'], true)).toEqual({ unsupported: 'opening brace below line 3' })
  expect(locate(JSON_RULE, ['{"a":1}'], true)).toEqual({ unsupported: 'opening brace shares its line' })
  expect(locate(JSON_RULE, ['{ "a": 1,', '"b": 2 }'], true)).toEqual({ unsupported: 'opening brace shares its line' })
  expect(locate(JSON_RULE, ['[', '1', ']'], true)).toEqual({ unsupported: 'top level is not an object' })
  expect(locate(JSON_RULE, [], true)).toEqual({ unsupported: 'top level is not an object' })
  expect(locate(JSON_RULE, ['', ''], true)).toEqual({ unsupported: 'top level is not an object' })
})

test('markdown goes inside frontmatter, else an HTML comment on line 1', () => {
  expect(roundTrip(MD, ['---', 'name: x', '---'])).toEqual({ at: 1, present: false, line: `# ${TAIL}` })
  expect(roundTrip(MD, ['# Title'])).toEqual({ at: 0, present: false, line: `<!-- ${TAIL} -->` })
  expect(roundTrip(MD, ['---'])).toMatchObject({ at: 1, present: false })
  expect(roundTrip(MD, [])).toMatchObject({ at: 0, present: false })
})
