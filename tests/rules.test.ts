import { expect, test } from 'claude-code/testing'
import { BLOB_CEILING, MARKER, basename, extension, isPruned } from '../hooks/rules.ts'

test('prune paths match whole directory names', () => {
  expect(isPruned('src/bin/x.cs')).toBe(true)
  expect(isPruned('node_modules/a.js')).toBe(true)
  expect(isPruned('a/.vs/x.cs')).toBe(true)
  expect(isPruned('src/binder/x.cs')).toBe(false)
})

test('blob ceiling covers a BOM and four lines of four-byte characters', () => {
  expect(BLOB_CEILING).toBe(4 + 4 * 512 * 4)
})

test('basename splits on both separators', () => {
  expect(basename('C:\\r\\sub/.gitignore')).toBe('.gitignore')
  expect(basename('a.cs')).toBe('a.cs')
})

test('extension is the last dot of the file name; a leading dot alone is none', () => {
  expect(extension('C:/r.d/a.b.cs')).toBe('.cs')
  expect(extension('.gitignore')).toBe('')
  expect(extension('Makefile')).toBe('')
})

test('final: MARKER assembles to the exact marker text', () => {
  expect(MARKER).toBe('TODO: Manual review needed')
})
