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
function bash(on: any, ran: string[], effect: () => void = () => {}) {
  on('tool.call', (_: unknown, e: any) => {
    ran.push(e.command)
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

test('a staged sentinel in a type turned off does not block the commit', { options: { fileTypes: '{".cs":false}' } }, async ($, on) => {
  const { ran } = setup(on, { git: stagedRepo(true) })
  const r = await $.tool.call({ tool: 'Bash', command: 'git commit -m x' })
  expect(r.deny).toBeUndefined()
  expect(ran).toEqual(['git commit -m x'])
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
  expect(engine.gitCalls.some(c => c.args[0] === 'diff' && c.args.includes('--cached'))).toBe(false)
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
