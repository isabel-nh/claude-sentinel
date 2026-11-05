import { expect, test } from 'claude-code/testing'
import { MARKER, basename, blobCeiling, isPruned, sentinelFor, sentinelLineNo } from '../hooks/rules.ts'

const SLASH = '// TODO: Manual review needed. Please delete this line after review.'
const DASH = '-- TODO: Manual review needed. Please delete this line after review.'
const HASH = '# TODO: Manual review needed. Please delete this line after review.'

test('sentinel text by extension', () => {
  for (const p of ['C:/r/a.cs', 'a.js', 'a.mjs', 'a.ts']) expect(sentinelFor(p)).toBe(SLASH)
  expect(sentinelFor('a.sql')).toBe(DASH)
  for (const p of ['a.py', 'a.ps1', 'a.sh', 'C:\\r\\.gitignore', '/r/.gitattributes']) expect(sentinelFor(p)).toBe(HASH)
})

test('tsx, jsx take the // sentinel; yaml takes #', () => {
  for (const p of ['C:/r/App.tsx', 'a.jsx']) expect(sentinelFor(p)).toBe(SLASH)
  expect(sentinelFor('C:\\r\\.azuredevops\\pipeline.yaml')).toBe(HASH)
  expect(sentinelFor('C:/r/azure-pipelines.yml')).toBe(HASH)
})

test('yaml is never a shebang type; sentinel stays on line 1', () => {
  expect(sentinelLineNo('a.yaml', true, '#!x')).toBe(1)
  expect(sentinelLineNo('a.tsx', true, '#!x')).toBe(1)
})

test('skipped and unknown extensions have no sentinel', () => {
  for (const p of ['a.json', 'a.md', 'a.csproj', 'a.txt', 'a.CS', 'gitignore', 'C:\\r\\x.gitignore.bak'])
    expect(sentinelFor(p)).toBeUndefined()
})

test('line 2 only behind a UTF-8 shebang in a script type', () => {
  expect(sentinelLineNo('a.sh', true, '#!/bin/bash\r')).toBe(2)
  expect(sentinelLineNo('a.ts', true, '#!/usr/bin/env node')).toBe(2)
  expect(sentinelLineNo('a.sh', false, '#!/bin/bash')).toBe(1)
  expect(sentinelLineNo('a.cs', true, '#!x')).toBe(1)
  expect(sentinelLineNo('a.sh', true, 'echo')).toBe(1)
})

test('prune paths match whole directory names', () => {
  expect(isPruned('src/bin/x.cs')).toBe(true)
  expect(isPruned('node_modules/a.js')).toBe(true)
  expect(isPruned('a/.vs/x.cs')).toBe(true)
  expect(isPruned('src/binder/x.cs')).toBe(false)
})

test('blob ceilings', () => {
  expect(blobCeiling('a.cs')).toBe(2052)
  expect(blobCeiling('a.ts')).toBe(4100)
})

test('basename splits on both separators', () => {
  expect(basename('C:\\r\\sub/.gitignore')).toBe('.gitignore')
  expect(basename('a.cs')).toBe('a.cs')
})

test('final: MARKER assembles to the exact marker text', () => {
  expect(MARKER).toBe('TODO: Manual review needed')
})
