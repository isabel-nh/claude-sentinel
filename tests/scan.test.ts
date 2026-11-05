import { expect, test } from 'claude-code/testing'
import type { RunResult } from '../hooks/host.ts'
import { encodeText } from '../hooks/encoding.ts'
import { scanStaged, scanStagedOrFail } from '../hooks/scan.ts'
import { sentinelFor } from './sentinels.ts'
import { BUILTIN_TABLE } from '../hooks/types.ts'
import { fakeHost } from './fake-host.ts'

const S = sentinelFor('a.cs')!
const ok = (stdout: string): RunResult => ({ exitCode: 0, stdout, stderr: '' })

type Repo = { staged: string[]; text: Record<string, string>; binary?: Record<string, Uint8Array> }

function repoGit(repo: Repo, calls: string[][] = []) {
  return (args: readonly string[]): RunResult => {
    calls.push([...args])
    const specs = args.slice(args.indexOf('--') + 1).map(s => s.replace(/^:\(top,literal\)/, ''))
    const z = (ps: string[]) => ok(ps.map(p => `${p}\u0000`).join(''))
    if (args[0] === 'diff') return z(repo.staged)
    if (args[0] === 'grep' && args.includes('-F')) return z(specs.filter(p => repo.text[p]?.includes('TODO: Manual review needed')))
    if (args[0] === 'grep') return z(specs.filter(p => p in repo.text))
    if (args[0] === 'show') return ok(repo.text[args[1]!.slice(1)] ?? '')
    return ok('')
  }
}

test('scanStaged reports a staged file whose sentinel line holds the marker', async () => {
  const host = fakeHost({ git: repoGit({ staged: ['a.cs', 'b.cs', 'c.json'], text: { 'a.cs': `${S}\nx\n`, 'b.cs': 'x\n', 'c.json': `${S}\n` } }) })
  expect(await scanStaged(host, 'C:/r', BUILTIN_TABLE)).toEqual(['a.cs'])
})

test('scanStaged ignores the marker on line 3', async () => {
  const host = fakeHost({ git: repoGit({ staged: ['a.cs'], text: { 'a.cs': `x\ny\n${S}\n` } }) })
  expect(await scanStaged(host, 'C:/r', BUILTIN_TABLE)).toEqual([])
})

test('scanStaged reads non-text blobs through readBlob (UTF-16LE sentinel)', async () => {
  const blob = new Uint8Array([0xff, 0xfe, ...encodeText(`${sentinelFor('a.sql')!}\r\nselect 1\r\n`, 'UTF-16LE')])
  const host = fakeHost({ git: repoGit({ staged: ['w.sql', 'a.cs'], text: { 'a.cs': 'x\n' } }), blobs: { 'C:/r:w.sql': blob } })
  expect(await scanStaged(host, 'C:/r', BUILTIN_TABLE)).toEqual(['w.sql'])
})

test('scanStaged chunks pathspecs at 150 per grep call, as literal pathspecs', async () => {
  const staged = Array.from({ length: 301 }, (_, i) => `f${i}.cs`)
  const calls: string[][] = []
  const host = fakeHost({ git: repoGit({ staged, text: Object.fromEntries(staged.map(p => [p, 'x\n'])) }, calls) })
  expect(await scanStaged(host, 'C:/r', BUILTIN_TABLE)).toEqual([])
  const markerCalls = calls.filter(c => c[0] === 'grep' && c.includes('-F'))
  expect(markerCalls.map(c => c.length - c.indexOf('--') - 1)).toEqual([150, 150, 1])
  expect(markerCalls[0]!.at(-1)).toBe(':(top,literal)f149.cs')
  expect(markerCalls[0]).toContain('--full-name')
})

test('scanStaged keeps staging order', async () => {
  const host = fakeHost({ git: repoGit({ staged: ['z.cs', 'a.cs'], text: { 'z.cs': `${S}\n`, 'a.cs': `${S}\n` } }) })
  expect(await scanStaged(host, 'C:/r', BUILTIN_TABLE)).toEqual(['z.cs', 'a.cs'])
})

test('scanStaged fails open when git fails', async () => {
  const host = fakeHost({ git: () => ({ exitCode: 128, stdout: '', stderr: 'fatal' }) })
  expect(await scanStaged(host, 'C:/r', BUILTIN_TABLE)).toEqual([])
})

test('scanStagedOrFail tells a git failure apart from a clean index', async () => {
  expect(await scanStagedOrFail(fakeHost({ git: () => ({ exitCode: 128, stdout: '', stderr: 'fatal' }) }), 'C:/r', BUILTIN_TABLE)).toBeUndefined()
  expect(await scanStagedOrFail(fakeHost({ git: repoGit({ staged: [], text: {} }) }), 'C:/r', BUILTIN_TABLE)).toEqual([])
})

test('final: an unreadable non-text blob fails the scan rather than passing it', async () => {
  const host = fakeHost({ git: repoGit({ staged: ['w.sql'], text: {} }) })
  expect(await scanStagedOrFail(host, 'C:/r', BUILTIN_TABLE)).toBeUndefined()
})
