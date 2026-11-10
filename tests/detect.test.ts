import { expect, test } from 'claude-code/testing'
import { changedSince, parseStatusZ, snapshot } from '../hooks/detect.ts'
import { BUILTIN_TABLE, buildTable } from '../hooks/types.ts'
import { fakeHost } from './fake-host.ts'

// Recorded from git 2.x: an unstaged edit, a staged rename (source in the next
// field), a file staged unchanged since, and an untracked file.
const RECORDED = ' M mod.txt\u0000R  new name.txt\u0000old.txt\u0000M  staged.txt\u0000?? untracked.txt\u0000'

test('parseStatusZ consumes the rename source field', () => {
  expect(parseStatusZ(RECORDED)).toEqual([
    { x: ' ', y: 'M', path: 'mod.txt' },
    { x: 'R', y: ' ', path: 'new name.txt' },
    { x: 'M', y: ' ', path: 'staged.txt' },
    { x: '?', y: '?', path: 'untracked.txt' },
  ])
})

test('parseStatusZ consumes the copy source field and tolerates empty input', () => {
  expect(parseStatusZ('C  b.cs\u0000a.cs\u0000 M c.cs\u0000')).toEqual([{ x: 'C', y: ' ', path: 'b.cs' }, { x: ' ', y: 'M', path: 'c.cs' }])
  expect(parseStatusZ('')).toEqual([])
})

test('changedSince keeps allowlisted, unpruned, worktree-dirty files newer than start', async () => {
  const status = [' M a.cs', 'M  staged.cs', '?? new.sql', ' M old.cs', ' M bin/out.cs', ' M notes.md', 'R  moved b.py', 'b.py'].join('\u0000') + '\u0000'
  const host = fakeHost({
    git: args => ({ exitCode: 0, stdout: args[0] === 'status' ? status : '', stderr: '' }),
    mtimes: { 'C:/r/a.cs': 20, 'C:/r/staged.cs': 20, 'C:/r/new.sql': 20, 'C:/r/old.cs': 5, 'C:/r/bin/out.cs': 20, 'C:/r/notes.md': 20, 'C:/r/moved b.py': 20 },
  })
  expect(await changedSince(host, 'C:/r', 10, BUILTIN_TABLE)).toEqual(['C:/r/a.cs', 'C:/r/new.sql'])
  expect(host.gitCalls[0]).toEqual({ args: ['status', '--porcelain', '-uall', '-z'], cwd: 'C:/r' })
})

test('changedSince on git failure returns nothing', async () => {
  const host = fakeHost({ git: () => ({ exitCode: 128, stdout: '', stderr: 'not a repo' }) })
  expect(await changedSince(host, 'C:/r', 0, BUILTIN_TABLE)).toEqual([])
})

test('changedSince lists a .md only when the table has a .md type', async () => {
  const host = fakeHost({ git: () => ({ exitCode: 0, stdout: ' M notes.md\u0000', stderr: '' }), mtimes: { 'C:/r/notes.md': 20 } })
  expect(await changedSince(host, 'C:/r', 10, BUILTIN_TABLE)).toEqual([])
  expect(await changedSince(host, 'C:/r', 10, buildTable('{".md":{"style":"markdown"}}').table)).toEqual(['C:/r/notes.md'])
})

// status and hash-object answered from `state`: path -> content hash.
function hashed(state: { status: string; hashes: Record<string, string> }) {
  return (args: readonly string[]) => {
    if (args[0] === 'status') return { exitCode: 0, stdout: state.status, stderr: '' }
    if (args[0] === 'hash-object') {
      const paths = args.slice(args.indexOf('--') + 1)
      return { exitCode: 0, stdout: paths.map(p => `${state.hashes[p]}\n`).join(''), stderr: '' }
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
}

test('with a snapshot, a changed hash counts even when the mtime was set back', async () => {
  const state = { status: ' M a.cs\u0000 M same.cs\u0000', hashes: { 'a.cs': 'h1', 'same.cs': 's' } }
  const host = fakeHost({ git: hashed(state), mtimes: { 'C:/r/a.cs': 1, 'C:/r/same.cs': 1 } })
  const before = await snapshot(host, 'C:/r', BUILTIN_TABLE)
  expect(before).toEqual(new Map([['a.cs', 'h1'], ['same.cs', 's']]))
  state.hashes['a.cs'] = 'h2'
  expect(await changedSince(host, 'C:/r', 10, BUILTIN_TABLE, before)).toEqual(['C:/r/a.cs'])
  const args = host.gitCalls.find(c => c.args[0] === 'hash-object')!.args
  expect(args.slice(0, 3)).toEqual(['hash-object', '--no-filters', '--'])
})

test('with a snapshot, a file renamed in with an old mtime counts as new', async () => {
  const state = { status: '?? r.txt\u0000', hashes: { 'r.cs': 'h' } as Record<string, string> }
  const host = fakeHost({ git: hashed(state), mtimes: { 'C:/r/r.cs': 1 } })
  const before = await snapshot(host, 'C:/r', BUILTIN_TABLE)
  expect(before).toEqual(new Map())
  state.status = '?? r.cs\u0000'
  expect(await changedSince(host, 'C:/r', 10, BUILTIN_TABLE, before)).toEqual(['C:/r/r.cs'])
})

test('a short hash-object answer drops the snapshot back to mtimes', async () => {
  const host = fakeHost({ git: args => ({ exitCode: 0, stdout: args[0] === 'status' ? ' M a.cs\u0000' : '', stderr: '' }), mtimes: { 'C:/r/a.cs': 20 } })
  expect(await snapshot(host, 'C:/r', BUILTIN_TABLE)).toBeUndefined()
  expect(await changedSince(host, 'C:/r', 10, BUILTIN_TABLE, new Map([['a.cs', 'h']]))).toEqual(['C:/r/a.cs'])
})
