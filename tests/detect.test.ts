import { expect, test } from 'claude-code/testing'
import { changedSince, parseStatusZ } from '../hooks/detect.ts'
import { fakeHost } from './fake-host.ts'

// Recorded from git 2.x: an unstaged edit, a staged rename (source in the next
// field), a file staged unchanged since, and an untracked file.
const RECORDED = ' M mod.txt\u0000R  new name.txt\u0000old.txt\u0000M  staged.txt\u0000?? untracked.txt\u0000'

test('parseStatusZ consumes the rename source field', () => {
  expect(parseStatusZ(RECORDED)).toEqual([
    { y: 'M', path: 'mod.txt' },
    { y: ' ', path: 'new name.txt' },
    { y: ' ', path: 'staged.txt' },
    { y: '?', path: 'untracked.txt' },
  ])
})

test('parseStatusZ consumes the copy source field and tolerates empty input', () => {
  expect(parseStatusZ('C  b.cs\u0000a.cs\u0000 M c.cs\u0000')).toEqual([{ y: ' ', path: 'b.cs' }, { y: 'M', path: 'c.cs' }])
  expect(parseStatusZ('')).toEqual([])
})

test('changedSince keeps allowlisted, unpruned, worktree-dirty files newer than start', async () => {
  const status = [' M a.cs', 'M  staged.cs', '?? new.sql', ' M old.cs', ' M bin/out.cs', ' M notes.md', 'R  moved b.py', 'b.py'].join('\u0000') + '\u0000'
  const host = fakeHost({
    git: args => ({ exitCode: 0, stdout: args[0] === 'status' ? status : '', stderr: '' }),
    mtimes: { 'C:/r/a.cs': 20, 'C:/r/staged.cs': 20, 'C:/r/new.sql': 20, 'C:/r/old.cs': 5, 'C:/r/bin/out.cs': 20, 'C:/r/notes.md': 20, 'C:/r/moved b.py': 20 },
  })
  expect(await changedSince(host, 'C:/r', 10)).toEqual(['C:/r/a.cs', 'C:/r/new.sql'])
  expect(host.gitCalls[0]).toEqual({ args: ['status', '--porcelain', '-uall', '-z'], cwd: 'C:/r' })
})

test('changedSince on git failure returns nothing', async () => {
  const host = fakeHost({ git: () => ({ exitCode: 128, stdout: '', stderr: 'not a repo' }) })
  expect(await changedSince(host, 'C:/r', 0)).toEqual([])
})
