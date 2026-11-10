import { expect, test } from 'claude-code/testing'
import type { RunResult } from '../hooks/host.ts'
import { sentinelFor } from './sentinels.ts'
import { fakeEngine, type EngineInit, type FakeEngine } from './fake-engine.ts'

const S = sentinelFor('a.cs')!
const ok = (stdout: string): RunResult => ({ exitCode: 0, stdout, stderr: '' })
const z = (...ps: string[]) => ps.map(p => `${p}\u0000`).join('')
const DENY = 'Commit blocked: sentinel review lines still present in staged files:\n  a.cs\nRemove the sentinel lines after reviewing, then retry.'

// A repo at C:/r with a.cs staged; `marked` puts the sentinel in the staged blob.
function stagedRepo(marked: boolean) {
  return (args: readonly string[]): RunResult => {
    if (args[0] === 'diff') return ok(z('a.cs'))
    if (args[0] === 'grep') return args.includes('-F') && !marked ? { exitCode: 1, stdout: '', stderr: '' } : ok(z('a.cs'))
    if (args[0] === 'show') return ok(marked ? `${S}\nx\n` : 'x\n')
    return ok('')
  }
}

// The bottom tool.call hook stands for Bash: `effect` is what the command does.
// `ran` holds each command as the agent wrote it: the hook-env line the mod
// puts in front is checked by its own tests.
const HOOK_ENV_LINE = ". 'C:/Users/u/.claude/sentinel/git-env'\n"
const BASELINE_LINE = /^export SENTINEL_BASELINE='C:\/Users\/u\/\.claude\/sentinel\/baselines\/[^']+\.tsv'\n/
function bash(on: any, ran: string[], effect: () => void = () => {}) {
  on('tool.call', (_: unknown, e: any) => {
    expect(e.command.startsWith(HOOK_ENV_LINE)).toBe(true)
    ran.push(e.command.slice(HOOK_ENV_LINE.length).replace(BASELINE_LINE, ''))
    effect()
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })
}

function setup(on: any, init: EngineInit, effect?: (engine: FakeEngine) => void) {
  let t = 100
  const engine = fakeEngine(on, { cwd: 'C:/r', now: () => ++t, ...init, files: { 'C:/r/.git': 'gitdir: x', ...init.files } })
  const ran: string[] = []
  bash(on, ran, () => effect?.(engine))
  return { engine, ran }
}

test('raw commit with a staged sentinel is denied with the gate text; the tool never ran', async ($, on) => {
  const { ran } = setup(on, { git: stagedRepo(true) })
  const r = await $.tool.call({ tool: 'Bash', command: 'git commit -m x' })
  expect(r.deny).toBe(DENY)
  expect(ran).toEqual([])
})

const WRAPPER_OPTIONS = { options: { commitWrapper: 'commit-msg\\.sh.*\\s-c(\\s|$)' } }
const WRAPPER_CMD = '~/bin/commit-msg.sh -c -C C:/r "X"'

test('configured wrapper commit with a staged sentinel gets the same deny', WRAPPER_OPTIONS, async ($, on) => {
  const { ran } = setup(on, { git: stagedRepo(true) })
  const r = await $.tool.call({ tool: 'Bash', command: WRAPPER_CMD })
  expect(r.deny).toBe(DENY)
  expect(ran).toEqual([])
})

test('with no wrapper configured the same command runs', async ($, on) => {
  const { ran } = setup(on, { git: stagedRepo(true) })
  const r = await $.tool.call({ tool: 'Bash', command: WRAPPER_CMD })
  expect(r.deny).toBeUndefined()
  expect(ran).toEqual([WRAPPER_CMD])
})

test('an invalid wrapper pattern is reported and gates nothing', { options: { commitWrapper: '(' } }, async ($, on) => {
  const { engine, ran } = setup(on, { git: stagedRepo(true) })
  const r = await $.tool.call({ tool: 'Bash', command: WRAPPER_CMD })
  expect(r.deny).toBeUndefined()
  expect(ran).toEqual([WRAPPER_CMD])
  expect(engine.toasts.some(t => t.includes('commitWrapper'))).toBe(true)
})

test('commit when clean runs the tool', async ($, on) => {
  const { ran } = setup(on, { git: stagedRepo(false) })
  const r = await $.tool.call({ tool: 'Bash', command: 'git commit -m x' })
  expect(r.deny).toBeUndefined()
  expect(ran).toEqual(['git commit -m x'])
})

test('VCS command runs the tool and issues no git status', async ($, on) => {
  const { engine, ran } = setup(on, {})
  await $.tool.call({ tool: 'Bash', command: 'git -C C:/r pull' })
  expect(ran).toEqual(['git -C C:/r pull'])
  expect(engine.gitCalls.filter(c => c.args[0] === 'status')).toEqual([])
})

test('python rewrite of C:/r/x.sql gets the sentinel after the tool ran', async ($, on) => {
  const status = (args: readonly string[]) => ok(args[0] === 'status' ? z(' M x.sql') : '')
  const { engine } = setup(on, { git: status, files: { 'C:/r/x.sql': 'select 0\n' } }, e => e.put('C:/r/x.sql', 'select 1\n'))
  await $.tool.call({ tool: 'Bash', command: `python -c "open(r'C:\\\\r\\\\x.sql','w').write('select 1')"` })
  expect(engine.text('C:/r/x.sql')).toBe(`${sentinelFor('x.sql')}\nselect 1\n`)
})

test('a file staged unchanged (Y = space) after the command is not touched', async ($, on) => {
  const status = (args: readonly string[]) => ok(args[0] === 'status' ? z('M  y.sql') : '')
  const { engine } = setup(on, { git: status, files: { 'C:/r/y.sql': 'select 0\n' } }, e => e.put('C:/r/y.sql', 'select 1\n'))
  await $.tool.call({ tool: 'Bash', command: 'git add y.sql && make' })
  expect(engine.text('C:/r/y.sql')).toBe('select 1\n')
})

test('a file changed before the command started is not touched', async ($, on) => {
  const status = (args: readonly string[]) => ok(args[0] === 'status' ? z(' M old.sql') : '')
  const { engine } = setup(on, { git: status, files: { 'C:/r/old.sql': 'select 0\n' }, mtimes: { 'C:/r/old.sql': 1 } })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(engine.text('C:/r/old.sql')).toBe('select 0\n')
})

test('scan git failure lets the commit through with one notice', async ($, on) => {
  const { engine, ran } = setup(on, { git: () => ({ exitCode: 128, stdout: '', stderr: 'fatal' }) })
  const r = await $.tool.call({ tool: 'Bash', command: 'git commit -m x' })
  expect(r.deny).toBeUndefined()
  expect(ran).toEqual(['git commit -m x'])
  expect(engine.toasts.length).toBe(1)
  expect(engine.toasts[0]).toContain('C:/r')
})

test('final: an unresolvable -C "$WT" commit scans cwd and is denied when cwd has staged sentinels', async ($, on) => {
  const inRepo = stagedRepo(true)
  const { ran } = setup(on, { git: (args, cwd) => (cwd === 'C:/r' ? inRepo(args) : { exitCode: 128, stdout: '', stderr: 'no such dir' }) })
  const r = await $.tool.call({ tool: 'Bash', command: 'git -C "$WT" commit -m x' })
  expect(r.deny).toBe(DENY)
  expect(ran).toEqual([])
})

test('retire: a command touching a second repo inserts in both roots', async ($, on) => {
  const status = (args: readonly string[], cwd: string) => ok(args[0] === 'status' ? z(cwd === 'C:/q' ? ' M y.sql' : ' M x.sql') : '')
  const { engine } = setup(
    on,
    { git: status, files: { 'C:/q/.git': 'gitdir: y', 'C:/r/x.sql': 'select 0\n', 'C:/q/y.sql': 'select 0\n' } },
    e => {
      e.put('C:/r/x.sql', 'select 1\n')
      e.put('C:/q/y.sql', 'select 2\n')
    },
  )
  await $.tool.call({ tool: 'Bash', command: 'cp C:/q/y.sql C:/q/y.sql.bak && make' })
  expect(engine.text('C:/r/x.sql')).toBe(`${sentinelFor('x.sql')}\nselect 1\n`)
  expect(engine.text('C:/q/y.sql')).toBe(`${sentinelFor('y.sql')}\nselect 2\n`)
})

test('a staged sentinel in a type turned off still blocks the commit', { options: { fileTypes: '{".cs":false}' } }, async ($, on) => {
  const { ran } = setup(on, { git: stagedRepo(true) })
  const r = await $.tool.call({ tool: 'Bash', command: 'git commit -m x' })
  expect(r.deny).toBe(DENY)
  expect(ran).toEqual([])
})

// A repo at C:/r whose index holds `staged` (path -> blob text); `reset`
// unstages and is recorded. The index file is C:/r/.git/index.
function indexRepo(staged: Record<string, string>, resets: string[][], failScan = false) {
  return (args: readonly string[]): RunResult => {
    const paths = Object.keys(staged)
    if (args[0] === 'rev-parse' && args.includes('--git-path')) return ok('.git/index\n')
    if (args[0] === 'rev-parse') return ok('.git\n')
    if (args[0] === 'reset') {
      resets.push([...args])
      for (const spec of args.slice(args.indexOf('--') + 1)) delete staged[spec.replace(/^:\(top,literal\)/, '')]
      return ok('')
    }
    if (args[0] === 'diff' && args.includes('--name-only')) return failScan ? { exitCode: 128, stdout: '', stderr: 'boom' } : ok(z(...paths))
    if (args[0] === 'diff') return ok('')
    if (args[0] === 'grep' && args.includes('-F')) return ok(z(...paths.filter(p => staged[p]!.includes(S.slice(3)))))
    if (args[0] === 'grep') return ok(z(...paths))
    if (args[0] === 'show') return ok(staged[args[1]!.slice(1)] ?? '')
    return ok('')
  }
}

const INDEX = 'C:/r/.git/index'

test('staging a sentineled file unstages it and tells the agent', async ($, on) => {
  const resets: string[][] = []
  setup(on, { git: indexRepo({ 'a.cs': `${S}\nx\n`, 'b.cs': 'y\n' }, resets), files: { [INDEX]: 'i' }, mtimes: { [INDEX]: 1 } }, e => e.put(INDEX, 'i2'))
  const r = await $.tool.call({ tool: 'Bash', command: 'git add a.cs b.cs' })
  expect(resets).toEqual([['reset', '-q', '--', ':(top,literal)a.cs']])
  expect((r as any).context).toEqual(['staging blocked due to presence of sentinels in files: C:/r/a.cs'])
})

test('an unchanged index is not scanned', async ($, on) => {
  const resets: string[][] = []
  const { engine } = setup(on, { git: indexRepo({ 'a.cs': `${S}\nx\n` }, resets), files: { [INDEX]: 'i' }, mtimes: { [INDEX]: 1 } })
  const r = await $.tool.call({ tool: 'Bash', command: 'make' })
  // The baseline's own `diff --cached --raw` reads what was staged before; no scan follows.
  expect(engine.gitCalls.some(c => c.args[0] === 'diff' && c.args.includes('--cached') && !c.args.includes('--raw'))).toBe(false)
  expect(resets).toEqual([])
  expect((r as any).context).toBeUndefined()
})

test('staging only clean files unstages nothing', async ($, on) => {
  const resets: string[][] = []
  setup(on, { git: indexRepo({ 'b.cs': 'y\n' }, resets), files: { [INDEX]: 'i' }, mtimes: { [INDEX]: 1 } }, e => e.put(INDEX, 'i2'))
  const r = await $.tool.call({ tool: 'Bash', command: 'git add b.cs' })
  expect(resets).toEqual([])
  expect((r as any).context).toBeUndefined()
})

test('a failed staging scan unstages nothing and says so once', async ($, on) => {
  const resets: string[][] = []
  const { engine } = setup(on, { git: indexRepo({ 'a.cs': `${S}\nx\n` }, resets, true), files: { [INDEX]: 'i' }, mtimes: { [INDEX]: 1 } }, e => e.put(INDEX, 'i2'))
  const r = await $.tool.call({ tool: 'Bash', command: 'git add a.cs' })
  expect(resets).toEqual([])
  expect((r as any).context).toBeUndefined()
  expect(engine.toasts).toEqual(['sentinel (Bash): staged-file scan failed in C:/r; staging was not checked.'])
})

// A repo at C:/r where `git add --dry-run` reports `would` and C:/r holds `files`.
function dryRunRepo(would: string[]) {
  return (args: readonly string[]): RunResult => {
    if (args[0] === 'add' && args[1] === '--dry-run') return ok(would.map(p => `add '${p}'\n`).join(''))
    if (args[0] === 'diff') return ok('')
    return ok('')
  }
}

test('pre-stage: git add of a sentineled file is denied before it runs, commit and all', async ($, on) => {
  const { ran, engine } = setup(on, { git: dryRunRepo(['a.cs', 'b.cs']), files: { 'C:/r/a.cs': `${S}\nx\n`, 'C:/r/b.cs': 'y\n' } })
  const r = await $.tool.call({ tool: 'Bash', command: 'git add -A && git commit -m x' })
  expect(r.deny).toBe('Staging blocked: sentinel review lines still present in:\n  a.cs\nStage only files a person has reviewed. The sentinel line is removed by hand after review.')
  expect(ran).toEqual([])
  expect(engine.gitCalls.find(c => c.args[0] === 'add')).toEqual({ args: ['add', '--dry-run', '-A'], cwd: 'C:/r' })
})

test('pre-stage: the dry run follows a cd and -C, and a clean add runs', async ($, on) => {
  const { ran, engine } = setup(on, { git: dryRunRepo(['b.cs']), files: { 'C:/r/sub/.git': 'gitdir: x', 'C:/r/sub/b.cs': 'y\n' } })
  await $.tool.call({ tool: 'Bash', command: 'cd sub && git add "b.cs"; git -C C:/o stage x.cs' })
  expect(engine.gitCalls.filter(c => c.args[0] === 'add')).toEqual([
    { args: ['add', '--dry-run', 'b.cs'], cwd: 'C:/r/sub' },
    { args: ['add', '--dry-run', 'x.cs'], cwd: 'C:/o' },
  ])
  expect(ran).toEqual(['cd sub && git add "b.cs"; git -C C:/o stage x.cs'])
})

test('pre-stage: a sentinel in an unconfigured type is denied too', async ($, on) => {
  setup(on, { git: dryRunRepo(['c.json']), files: { 'C:/r/c.json': `{\n  "_comment": "${S.slice(3)}",\n}\n` } })
  const r = await $.tool.call({ tool: 'Bash', command: 'git add c.json' })
  expect(r.deny).toContain('  c.json\n')
})

const BYPASSES = [
  'git commit --no-verify -m x',
  'git add a.cs && git commit -nm x',
  'git -c core.hooksPath=/dev/null commit -m x',
  'GIT_CONFIG_COUNT=0 git commit -m x',
  'env -i git commit -m x',
]

for (const command of BYPASSES) {
  test(`hook bypass is denied: ${command}`, async ($, on) => {
    const { ran } = setup(on, { git: stagedRepo(false) })
    const r = await $.tool.call({ tool: 'Bash', command })
    expect(r.deny).toStartWith('sentinel: denied: ')
    expect(ran).toEqual([])
  })
}

test('a commit message mentioning -n or --no-verify is not a bypass', async ($, on) => {
  const { ran } = setup(on, { git: stagedRepo(false) })
  const command = 'git commit -m "drop --no-verify and -n from docs"'
  const r = await $.tool.call({ tool: 'Bash', command })
  expect(r.deny).toBeUndefined()
  expect(ran).toEqual([command])
})

test('the hook shims are installed once, with the scan, every hook name and the env file', async ($, on) => {
  const { engine } = setup(on, {})
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  const dir = 'C:/Users/u/.claude/sentinel/git-hooks'
  expect(engine.writes.filter(w => w === `${dir}/pre-commit`)).toHaveLength(1)
  expect(engine.text(`${dir}/sentinel-scan`)).toContain('git diff --cached')
  expect(engine.text(`${dir}/pre-push`)).toContain('git rev-parse --git-path hooks')
  expect(engine.text('C:/Users/u/.claude/sentinel/git-env')).toContain(`=${dir}"`)
})

test('a write chained with a VCS verb in a comment still gets the sentinel', async ($, on) => {
  const status = (args: readonly string[]) => ok(args[0] === 'status' ? z(' M x.sql') : '')
  const { engine } = setup(on, { git: status, files: { 'C:/r/x.sql': 'select 0\n' } }, e => e.put('C:/r/x.sql', 'select 1\n'))
  await $.tool.call({ tool: 'Bash', command: "printf 'select 1' > x.sql # git fetch" })
  expect(engine.text('C:/r/x.sql')).toBe(`${sentinelFor('x.sql')}\nselect 1\n`)
})

test('a sentinel removed and the mtime set back is put back (content hash, not mtime)', async ($, on) => {
  const hashes: Record<string, string> = { 'x.sql': 'before' }
  const git = (args: readonly string[]) => {
    if (args[0] === 'status') return ok(z(' M x.sql'))
    if (args[0] === 'hash-object') return ok(args.slice(args.indexOf('--') + 1).map(p => `${hashes[p]}\n`).join(''))
    return ok('')
  }
  const { engine } = setup(on, { git, files: { 'C:/r/x.sql': `${sentinelFor('x.sql')}\nselect 0\n` }, mtimes: { 'C:/r/x.sql': 1 } }, e => {
    e.files.set('C:/r/x.sql', new TextEncoder().encode('select 0\n'))
    hashes['x.sql'] = 'after'
  })
  await $.tool.call({ tool: 'Bash', command: 'sed -i 1d x.sql && touch -d 2001-01-01 x.sql' })
  expect(engine.text('C:/r/x.sql')).toBe(`${sentinelFor('x.sql')}\nselect 0\n`)
})

for (const command of ['git commit-tree $t -p HEAD -m x', '"$(git --exec-path)/git" update-ref refs/heads/main abc']) {
  test(`plumbing is denied before it runs: ${command}`, async ($, on) => {
    const { ran } = setup(on, {})
    const r = await $.tool.call({ tool: 'Bash', command })
    expect(r.deny).toStartWith('sentinel: denied: git ')
    expect(ran).toEqual([])
  })
}

// The bottom tool.call hook stands for PowerShell: commands reach it unchanged.
function powershell(on: any, init: EngineInit, effect: (engine: FakeEngine) => void = () => {}) {
  let t = 100
  const engine = fakeEngine(on, { cwd: 'C:/r', now: () => ++t, ...init, files: { 'C:/r/.git': 'gitdir: x', ...init.files } })
  const ran: string[] = []
  on('tool.call', (_: unknown, e: any) => {
    ran.push(e.command)
    effect(engine)
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })
  return { engine, ran }
}

test('PowerShell: git is denied before it runs, however it is spelled', async ($, on) => {
  const { ran } = powershell(on, {})
  for (const command of ['git add src/app.cs; git commit -m x', "& 'git.exe' commit -m x", 'Set-Location C:/r; GIT status']) {
    const r = await $.tool.call({ tool: 'PowerShell', command })
    expect(r.deny).toContain('Run git commands through the Bash tool')
  }
  expect(ran).toEqual([])
})

test('PowerShell: a file the command wrote gets the sentinel', async ($, on) => {
  const status = (args: readonly string[]) => ok(args[0] === 'status' ? z(' M x.sql') : '')
  const { engine, ran } = powershell(on, { git: status, files: { 'C:/r/x.sql': 'select 0\n' } }, e => e.put('C:/r/x.sql', 'select 1\n'))
  const command = "[IO.File]::WriteAllText('C:/r/x.sql', 'select 1')"
  await $.tool.call({ tool: 'PowerShell', command })
  expect(ran).toEqual([command])
  expect(engine.text('C:/r/x.sql')).toBe(`${sentinelFor('x.sql')}\nselect 1\n`)
})

test('PowerShell: a command naming the sentinel home is denied', async ($, on) => {
  const { ran } = powershell(on, {})
  const r = await $.tool.call({ tool: 'PowerShell', command: 'Remove-Item ~/.claude/sentinel -Recurse' })
  expect(r.deny).toContain('would skip the sentinel pre-commit hook')
  expect(ran).toEqual([])
})

// Auto mode sends a rewritten command back exactly as rewritten.
function rawBash(on: any, init: EngineInit = {}) {
  let t = 100
  fakeEngine(on, { cwd: 'C:/r', now: () => ++t, ...init, files: { 'C:/r/.git': 'gitdir: x', ...init.files } })
  const raw: string[] = []
  on('tool.call', (_: unknown, e: any) => {
    raw.push(e.command)
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })
  return raw
}

const REPLAYED_BASELINE = "export SENTINEL_BASELINE='C:/Users/u/.claude/sentinel/baselines/1794331211365-71vqb0bj.tsv'\n"

test('a command sent back with the mod prologue runs exactly as sent', async ($, on) => {
  const raw = rawBash(on)
  const command = `${HOOK_ENV_LINE}${REPLAYED_BASELINE}ls -la`
  const r = await $.tool.call({ tool: 'Bash', command })
  expect(r.deny).toBeUndefined()
  expect(raw).toEqual([command])
})

test('a VCS command sent back with the env line runs exactly as sent', async ($, on) => {
  const raw = rawBash(on)
  const command = `${HOOK_ENV_LINE}git -C C:/r pull`
  const r = await $.tool.call({ tool: 'Bash', command })
  expect(r.deny).toBeUndefined()
  expect(raw).toEqual([command])
})

test('a baseline path the mod could not have written is still a bypass', async ($, on) => {
  const raw = rawBash(on)
  for (const forged of ["export SENTINEL_BASELINE='C:/tmp/x.tsv'\n", "export SENTINEL_BASELINE='C:/Users/u/.claude/sentinel/baselines/../x.tsv'\n"]) {
    const r = await $.tool.call({ tool: 'Bash', command: `${HOOK_ENV_LINE}${forged}ls` })
    expect(r.deny).toContain('would skip the sentinel pre-commit hook')
  }
  expect(raw).toEqual([])
})

test('the body behind a replayed prologue is still checked', async ($, on) => {
  const raw = rawBash(on)
  const r = await $.tool.call({ tool: 'Bash', command: `${HOOK_ENV_LINE}${REPLAYED_BASELINE}echo x > "$SENTINEL_BASELINE"` })
  expect(r.deny).toContain('would skip the sentinel pre-commit hook')
  expect(raw).toEqual([])
})
