import { expect, test } from 'claude-code/testing'
import { classify, findRoots, hookBypass, normalizeDrive, plumbingCall, type Classified } from '../hooks/command.ts'
import { VCS_VERBS } from '../hooks/rules.ts'
import { fakeHost } from './fake-host.ts'

const CWD = 'C:/cwd'
const HOME = '/c/Users/u'
const WRAPPER = /commit-msg\.sh.*\s-c(\s|$)/

const cases: [string, Partial<Classified>][] = [
  ['git commit -m x', { kind: 'commit', repo: CWD }],
  ['git -C "C:/a b" commit -m x', { kind: 'commit', repo: 'C:/a b' }],
  ["cd 'C:/r' && git add . && git commit -m x", { kind: 'commit', repo: 'C:/r' }],
  ['echo hi\ngit commit -m x', { kind: 'commit', repo: CWD }],
  ['git \\\ncommit -m x', { kind: 'commit', repo: CWD }],
  ['git -C C:/r pull', { kind: 'vcs' }],
  ['something-git-pull', { kind: 'other' }],
  ['ls -la', { kind: 'other', anchor: CWD }],
]

test('classify table', () => {
  for (const [cmd, want] of cases) expect({ cmd, ...classify(cmd, CWD, HOME) }).toMatchObject({ cmd, ...want })
})

const wrapperCases: [string, Partial<Classified>][] = [
  ['~/bin/commit-msg.sh -c -C C:/r "X"', { kind: 'wrapper-commit', repo: 'C:/r' }],
  ['cd C:/r && bash ~/bin/commit-msg.sh -q -c "X"', { kind: 'wrapper-commit', repo: 'C:/r' }],
  ['commit-msg.sh -c "X"', { kind: 'wrapper-commit', repo: CWD }],
  ['commit-msg.sh -c -C ~/r "x"', { kind: 'wrapper-commit', repo: 'C:/Users/u/r' }],
  ['commit-msg.sh "X"', { kind: 'other' }],
]

test('configured commit wrapper table', () => {
  for (const [cmd, want] of wrapperCases) expect({ cmd, ...classify(cmd, CWD, HOME, WRAPPER) }).toMatchObject({ cmd, ...want })
})

test('no wrapper configured: a wrapper-shaped line is an ordinary command', () => {
  expect(classify('commit-msg.sh -c -C C:/r "X"', CWD, HOME).kind).toBe('other')
})

test('every VCS verb other than commit classifies as vcs', () => {
  for (const verb of VCS_VERBS.filter(v => v !== 'commit')) {
    expect(classify(`git ${verb} x`, CWD, HOME).kind).toBe('vcs')
    expect(classify(`cd C:/r && git -C C:/r ${verb}`, CWD, HOME).kind).toBe('vcs')
  }
})

test('anchor comes from cd or pushd on line 1, with ~ expanded', () => {
  expect(classify('cd "C:/a b" && make', CWD, HOME)).toMatchObject({ kind: 'other', anchor: 'C:/a b' })
  expect(classify('pushd ~/proj; make', CWD, HOME)).toMatchObject({ kind: 'other', anchor: 'C:/Users/u/proj' })
  expect(classify('cd ~ && ls', CWD, HOME)).toMatchObject({ kind: 'other', anchor: 'C:/Users/u' })
  expect(classify('make\ncd C:/elsewhere', CWD, HOME)).toMatchObject({ kind: 'other', anchor: CWD })
})

test('paths are lifted out of python and posix spellings', () => {
  const c = classify("python -c \"open(r'C:\\\\r\\\\x.cs','w').write(s)\" && cat /c/q/y.sql", CWD, HOME)
  expect(c.kind).toBe('other')
  if (c.kind === 'other') expect(c.paths).toEqual(['C:/r/x.cs', 'C:/q/y.sql'])
})

test('normalizeDrive', () => {
  expect(normalizeDrive('/c/x/y')).toBe('C:/x/y')
  expect(normalizeDrive('C:\\x\\')).toBe('C:/x')
  expect(normalizeDrive('/usr/bin')).toBe('/usr/bin')
})

test('findRoots: .git file or dir counts, anchor first, /c/x and C:/x dedupe', async () => {
  const host = fakeHost({ files: { 'C:/wt/.git': 'gitdir: x' }, dirs: ['C:/r/.git'] })
  expect(await findRoots(host, 'C:/r/sub', ['/c/r/a.cs', 'C:/wt/deep/b.cs', 'C:/none/c.cs'])).toEqual(['C:/r', 'C:/wt'])
})

test('findRoots caps at 3 roots', async () => {
  const dirs = ['C:/a/.git', 'C:/b/.git', 'C:/c/.git', 'C:/d/.git']
  expect((await findRoots(fakeHost({ dirs }), 'C:/a', ['C:/b/x', 'C:/c/x', 'C:/d/x'])).length).toBe(3)
})

test('findRoots probes at most 40 paths', async () => {
  const paths = [...Array.from({ length: 40 }, (_, i) => `C:/n${i}/x.cs`), 'C:/late/x.cs']
  expect(await findRoots(fakeHost({ dirs: ['C:/late/.git'] }), 'C:/none', paths)).toEqual([])
})

test('findRoots walks at most 16 levels', async () => {
  const deep = `C:/top/${Array.from({ length: 20 }, (_, i) => `d${i}`).join('/')}`
  expect(await findRoots(fakeHost({ dirs: ['C:/top/.git'] }), deep, [])).toEqual([])
})

test('final: a relative cd target resolves against cwd', () => {
  expect(classify('cd src && make', CWD, HOME)).toMatchObject({ kind: 'other', anchor: 'C:/cwd/src' })
  expect(classify('cd ../x && make', CWD, HOME)).toMatchObject({ kind: 'other', anchor: 'C:/x' })
  expect(classify('cd sub && git commit -m x', CWD, HOME)).toMatchObject({ kind: 'commit', repo: 'C:/cwd/sub' })
})

test('final: commit forms with global options, subshells and bash -c are commits', () => {
  for (const cmd of ['git -c user.email=x commit -m y', 'git --no-pager commit -m y', '(git commit -m y)', 'bash -c "git commit -m y"'])
    expect({ cmd, ...classify(cmd, CWD, HOME) }).toMatchObject({ cmd, kind: 'commit', repo: CWD })
  expect(classify('git -c a=b -C "C:/a b" commit', CWD, HOME)).toMatchObject({ kind: 'commit', repo: 'C:/a b' })
  expect(classify('git -C ~/r commit -m y', CWD, HOME)).toMatchObject({ kind: 'commit', repo: 'C:/Users/u/r' })
})

test('final: findRoots falls back to cwd when the anchor has no repo', async () => {
  expect(await findRoots(fakeHost({ dirs: ['C:/cwd/.git'] }), 'C:/elsewhere', [], 'C:/cwd')).toEqual(['C:/cwd'])
  expect(await findRoots(fakeHost({ dirs: ['C:/a/.git', 'C:/cwd/.git'] }), 'C:/a', [], 'C:/cwd')).toEqual(['C:/a'])
})

test('a VCS verb in a comment or chained after another command does not make it vcs', () => {
  expect(classify("printf 'x' > a.cs # git fetch", CWD, HOME).kind).toBe('other')
  expect(classify('sed -i 1d a.cs && git stash list', CWD, HOME).kind).toBe('other')
  expect(classify('echo x > a.cs\ngit pull', CWD, HOME).kind).toBe('other')
  expect(classify('cd C:/r && git fetch && git pull --ff-only', CWD, HOME).kind).toBe('vcs')
  expect(classify('git fetch # sync first', CWD, HOME).kind).toBe('vcs')
})

test('cd targets join quoted and bare parts as the shell does', () => {
  expect(classify("cd C:/a/hard''ness && sed -i 1d x.cs", CWD, HOME)).toMatchObject({ kind: 'other', anchor: 'C:/a/hardness' })
  expect(classify('cd "C:/a "b && ls', CWD, HOME)).toMatchObject({ kind: 'other', anchor: 'C:/a b' })
})

test('absolute paths are also read with quotes joined', () => {
  const c = classify("sed -i 1d C:/a/hard''ness/x.cs", CWD, HOME)
  expect(c.kind).toBe('other')
  if (c.kind === 'other') expect(c.paths).toContain('C:/a/hardness/x.cs')
})

test('plumbing that writes commits or refs is found however it is spelled', () => {
  expect(plumbingCall('t=$(git write-tree) && git commit-tree $t -p HEAD -m x')).toBe('commit-tree')
  expect(plumbingCall('"$(git --exec-path)/git" update-ref refs/heads/x y')).toBe('update-ref')
  expect(plumbingCall("git com''mit-tree t")).toBe('commit-tree')
  expect(plumbingCall('git -C C:/r mktree < list')).toBe('mktree')
  expect(plumbingCall('git -c alias.ct=commit-tree ct t')).toBe('commit-tree')
  expect(plumbingCall('git commit -m "mention commit-tree"')).toBeUndefined()
  expect(plumbingCall('ls # git update-ref')).toBeUndefined()
})

test('fast-import and stash create/store count as plumbing', () => {
  expect(plumbingCall('git fast-import < stream')).toBe('fast-import')
  expect(plumbingCall('s=$(git stash create)')).toBe('stash create')
  expect(plumbingCall('git stash  store $s')).toBe('stash store')
  expect(plumbingCall('git stash store -m x abc')).toBe('stash store')
  expect(plumbingCall('git stash push -m x')).toBeUndefined()
})

test('hook bypass covers the baseline variable and the sentinel home', () => {
  expect(hookBypass('SENTINEL_BASELINE=/dev/null git commit -m x')).toBeDefined()
  expect(hookBypass('rm ~/.claude/sentinel/baselines/1.tsv')).toBeDefined()
  expect(hookBypass('cat C:\\Users\\u\\.claude\\sentinel\\hooks\\pre-commit')).toBeDefined()
  expect(hookBypass('git commit -m x')).toBeUndefined()
})

test('am and apply are not exempt VCS verbs', () => {
  expect(classify('git am x.patch', CWD, HOME).kind).toBe('other')
  expect(classify('git apply x.patch', CWD, HOME).kind).toBe('other')
})
