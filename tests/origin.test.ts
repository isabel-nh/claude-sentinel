import { expect, test } from 'claude-code/testing'
import { addedLines, baselineFile, indexEntries, parseMoves, parseRaw, type Baseline } from '../hooks/origin.ts'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const NULL = '0'.repeat(40)

test('addedLines keeps hunk additions and skips headers', () => {
  const diff = ['diff --git a/x b/x', 'index 1..2 100644', '--- a/x', '+++ b/x', '@@ -1,0 +2,2 @@', '+one', '+', '-gone', 'diff --git a/y b/y', '+++ b/y', '@@ -0,0 +1 @@', '++plus'].join('\n')
  expect(addedLines(diff)).toEqual(['one', '', '+plus'])
})

test('addedLines drops a trailing carriage return', () => {
  expect(addedLines(['@@ -0,0 +1,2 @@', '+one\r', '+two'].join('\n'))).toEqual(['one', 'two'])
})

test('parseRaw maps null object ids to undefined', () => {
  const out = [`:100644 100644 ${A} ${B} M`, 'src/a.cs', `:000000 100644 ${NULL} ${B} A`, 'new file.cs', `:100644 000000 ${A} ${NULL} D`, 'gone.cs', ''].join('\u0000')
  expect(parseRaw(out)).toEqual([
    { path: 'src/a.cs', status: 'M', old: A, new: B },
    { path: 'new file.cs', status: 'A', old: undefined, new: B },
    { path: 'gone.cs', status: 'D', old: A, new: undefined },
  ])
})

test('parseMoves reads recorded ref updates, null ids as undefined, and skips malformed lines', () => {
  const text = [`refs/heads/main\t${A}\t${B}\tC:/r/.git\tC:/r`, `refs/heads/new\t${NULL}\t${B}\t/c/r/.git\t/c/r`, 'garbage', `\t${A}\t${B}\tx\ty`, ''].join('\r\n')
  expect(parseMoves(text)).toEqual([
    { ref: 'refs/heads/main', old: A, new: B, common: 'C:/r/.git', top: 'C:/r' },
    { ref: 'refs/heads/new', old: undefined, new: B, common: 'C:/r/.git', top: 'C:/r' },
  ])
})

test('indexEntries maps each staged path to its blob, a deletion to undefined', () => {
  const raw = [`:100644 100644 ${A} ${B} M`, 'src/a.ts', `:100644 000000 ${A} ${NULL} D`, 'gone.ts', ''].join('\u0000')
  expect([...indexEntries(raw)]).toEqual([
    ['src/a.ts', B],
    ['gone.ts', undefined],
  ])
})

test('parseRaw skips malformed records', () => {
  expect(parseRaw('garbage\u0000path\u0000')).toEqual([])
})

test('baselineFile writes one root line and one line per storable path', () => {
  const b: Baseline = {
    root: 'C:/r',
    top: 'C:/r',
    common: 'C:/r/.git',
    head: A,
    files: new Map([['src/a.cs', B], ['bad\tname.cs', B]]),
    staged: new Map([['src/b.cs', A]]),
    refs: new Map(),
  }
  const none: Baseline = { ...b, root: 'C:/e', top: 'C:/e', head: undefined, files: new Map(), staged: new Map() }
  expect(baselineFile([b, none])).toBe(`R\tC:/r\t${A}\nF\tC:/r\tsrc/a.cs\t${B}\nI\tC:/r\tsrc/b.cs\t${A}\nR\tC:/e\t\n`)
})
