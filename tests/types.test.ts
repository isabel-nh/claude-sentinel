import { expect, test } from 'claude-code/testing'
import { BUILTIN_ENTRIES, BUILTIN_TABLE, buildTable, compileEntry, diffAgainstBuiltins, parseEntries, resolve, type Rule } from '../hooks/types.ts'

const prefixOf = (r: Rule | undefined) => (r !== undefined && 'prefix' in r ? r.prefix : undefined)
const skipOf = (r: Rule | undefined) => (r !== undefined && 'skip' in r ? r.skip.map(p => p.source) : undefined)

test('built-in table matches 0.2.0', () => {
  const { table, problems } = buildTable('')
  expect(problems).toEqual([])
  const want: [string, string, string[]][] = [
    ['a.cs', '//', []], ['a.jsx', '//', []], ['a.tsx', '//', []],
    ['a.js', '//', ['^#!']], ['a.mjs', '//', ['^#!']], ['a.ts', '//', ['^#!']],
    ['a.sql', '--', []],
    ['a.yaml', '#', []], ['a.yml', '#', []],
    ['a.py', '#', ['^#!']], ['a.sh', '#', ['^#!']], ['a.ps1', '#', ['^#!']],
    ['C:\\r\\.gitignore', '#', []], ['sub/.gitattributes', '#', []],
  ]
  for (const [p, prefix, skip] of want) {
    const r = resolve(table, p)
    expect({ p, style: r?.style, prefix: prefixOf(r), skip: skipOf(r) }).toEqual({ p, style: 'line', prefix, skip })
  }
  for (const p of ['a.txt', 'a.md', 'a.json', 'gitignore', 'x.gitignore.bak']) expect(resolve(table, p)).toBeUndefined()
})

test('option entries override, add and disable', () => {
  const { table, problems } = buildTable('{".md":{"style":"markdown"},".sql":false,".cs":{"style":"line","prefix":"#"}}')
  expect(problems).toEqual([])
  expect(resolve(table, 'a.md')).toEqual({ style: 'markdown' })
  expect(resolve(table, 'a.sql')).toBeUndefined()
  expect(prefixOf(resolve(table, 'a.cs'))).toBe('#')
})

test('file-name key beats extension', () => {
  const { table } = buildTable('{"x.cs":{"style":"line","prefix":"#"}}')
  expect(prefixOf(resolve(table, 'C:/r/x.cs'))).toBe('#')
  expect(prefixOf(resolve(table, 'y.cs'))).toBe('//')
})

test('extension match ignores case; file-name match does not', () => {
  expect(resolve(buildTable('{".md":{"style":"markdown"}}').table, 'README.MD')).toEqual({ style: 'markdown' })
  expect(resolve(buildTable('{"Makefile":{"style":"line","prefix":"#"}}').table, 'MAKEFILE')).toBeUndefined()
})

test('json-property defaults its key; block and markdown compile', () => {
  const { table } = buildTable('{".json":{"style":"json-property"},".css":{"style":"block","prefix":"/*","suffix":"*/"}}')
  expect(resolve(table, 'a.json')).toEqual({ style: 'json-property', key: '_comment' })
  expect(resolve(table, 'a.css')).toEqual({ style: 'block', prefix: '/*', suffix: '*/', skip: [] })
})

test('whole-option problems keep the built-in table', () => {
  for (const [json, reason] of [['{', 'option is not valid JSON'], ['[1]', 'option is not a JSON object'], ['"x"', 'option is not a JSON object']] as const) {
    const { table, problems } = buildTable(json)
    expect(problems).toEqual([{ key: '', reason }])
    expect(prefixOf(resolve(table, 'a.cs'))).toBe('//')
  }
})

test('each problem drops only its entry', () => {
  const cases: [string, unknown, string][] = [
    ['.sql', { style: 'nope' }, 'unknown style "nope"'],
    ['.sql', { style: 'line' }, 'missing prefix'],
    ['.sql', { style: 'block', prefix: '/*' }, 'missing suffix'],
    ['.sql', { style: 'line', prefix: '' }, 'prefix must be a non-empty single-line string'],
    ['.sql', { style: 'line', prefix: 'a\nb' }, 'prefix must be a non-empty single-line string'],
    ['.sql', { style: 'json-property', key: '' }, 'key must be a non-empty single-line string'],
    ['.sql', { style: 'line', prefix: '#', colour: 1 }, 'unknown field "colour"'],
    ['.sql', { style: 'markdown', prefix: '#' }, 'unknown field "prefix"'],
    ['.sql', { style: 'line', prefix: '#', skip: ['a', 'b', 'c', 'd'] }, 'skip allows at most 3 patterns'],
    ['.sql', { style: 'line', prefix: '#', skip: ['('] }, 'skip pattern "(" is not a valid regular expression'],
    ['.sql', 'line', 'entry must be an object or false'],
  ]
  for (const [key, entry, reason] of cases) {
    const { table, problems } = buildTable(JSON.stringify({ [key]: entry, '.md': { style: 'markdown' } }))
    expect({ entry, problems }).toEqual({ entry, problems: [{ key, reason }] })
    expect(prefixOf(resolve(table, 'a.sql'))).toBe('--')
    expect(resolve(table, 'a.md')).toEqual({ style: 'markdown' })
  }
})

test('invalid keys', () => {
  for (const key of ['.', '', 'a/b', 'a\\b']) {
    expect(compileEntry(key, { style: 'markdown' })).toEqual({ key, reason: 'key must be a file name or .extension' })
    expect(buildTable(JSON.stringify({ [key]: { style: 'markdown' } })).problems).toEqual([{ key, reason: 'key must be a file name or .extension' }])
  }
})

test('empty and {} options give the built-in table', () => {
  for (const json of ['', '   ', '{}']) {
    const { table, problems } = buildTable(json)
    expect(problems).toEqual([])
    expect(table.size).toBe(Object.keys(BUILTIN_ENTRIES).length)
  }
})

test('parseEntries keeps valid entries and false', () => {
  const { entries, problems } = parseEntries('{".md":{"style":"markdown"},".sql":false,".x":{"style":"nope"}}')
  expect(entries).toEqual({ '.md': { style: 'markdown' }, '.sql': false })
  expect(problems).toEqual([{ key: '.x', reason: 'unknown style "nope"' }])
})

test('diffAgainstBuiltins drops entries equal to their built-in row and keeps false', () => {
  expect(diffAgainstBuiltins({ '.cs': BUILTIN_ENTRIES['.cs']!, '.sql': false, '.md': { style: 'markdown' }, '.py': { style: 'line', prefix: '#' } })).toEqual({
    '.sql': false,
    '.md': { style: 'markdown' },
    '.py': { style: 'line', prefix: '#' },
  })
})

test('extensions match regardless of case; an exact-case key wins', () => {
  const { table } = buildTable('{".CS":{"style":"line","prefix":"#"}}')
  expect(prefixOf(resolve(BUILTIN_TABLE, 'src/A.CS'))).toBe('//')
  expect(prefixOf(resolve(BUILTIN_TABLE, 'x.Sql'))).toBe('--')
  expect(prefixOf(resolve(table, 'a.CS'))).toBe('#')
  expect(prefixOf(resolve(table, 'a.cs'))).toBe('//')
  expect(prefixOf(resolve(table, 'a.Cs'))).toBeDefined()
})
