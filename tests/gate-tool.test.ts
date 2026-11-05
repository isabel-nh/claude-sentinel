import { expect, test } from 'claude-code/testing'
import type { RunResult } from '../hooks/host.ts'
import { sentinelFor } from './sentinels.ts'
import { fakeEngine } from './fake-engine.ts'

const S = sentinelFor('a.cs')!
const TOOL = 'mcp__sentinel__commit_gate_status'
const ok = (stdout: string): RunResult => ({ exitCode: 0, stdout, stderr: '' })
const z = (...ps: string[]) => ps.map(p => `${p}\u0000`).join('')

// An index: path -> staged text, plus rename sources; `reset` unstages.
function index(staged: Record<string, string>, renames: Record<string, string> = {}, resets: string[][] = []) {
  return (args: readonly string[]): RunResult => {
    const paths = Object.keys(staged)
    if (args[0] === 'rev-parse') return ok('.git\n')
    if (args[0] === 'reset') {
      resets.push([...args])
      for (const spec of args.slice(args.indexOf('--') + 1)) delete staged[spec.replace(/^:\(top,literal\)/, '')]
      return ok('')
    }
    if (args[0] === 'diff' && args.includes('--name-only')) return ok(z(...paths))
    if (args[0] === 'diff' && args.includes('--diff-filter=R')) return ok(paths.filter(p => p in renames).flatMap(p => ['R100', renames[p]!, p]).map(f => `${f}\u0000`).join(''))
    if (args[0] === 'diff' && args.includes('--name-status')) return ok(paths.map(p => (p in renames ? `R100\t${renames[p]}\t${p}\n` : `M\t${p}\n`)).join(''))
    if (args[0] === 'diff' && args.includes('--shortstat')) return ok(paths.length ? ` ${paths.length} file changed, 1 insertion(+)\n` : '')
    if (args[0] === 'grep' && args.includes('-F')) return ok(z(...paths.filter(p => staged[p]!.includes(S.slice(3)))))
    if (args[0] === 'grep') return ok(z(...paths))
    if (args[0] === 'show') return ok(staged[args[1]!.slice(1)] ?? '')
    return ok('')
  }
}

const tool = (on: any) => on('tool.call', () => ({ result: 'unanswered' }))

test('clean index: GATE=CLEAR block, exact text', async ($, on) => {
  fakeEngine(on, { git: index({ 'a.cs': 'x\n' }) })
  tool(on)
  const r = await $.tool.call({ tool: TOOL, repo: 'C:/r' } as any)
  expect(r.result).toBe(
    '=== STAGED ===\nM\ta.cs\n\n=== SENTINELS ===\n(none)\n\n=== GATES ===\nGATE=CLEAR\nSTAGED_COUNT=1\nSENTINEL_COUNT=0\nDIFFSTAT=1 file changed, 1 insertion(+)\n',
  )
})

test('nothing staged: "(nothing staged)" and GATE=EMPTY', async ($, on) => {
  fakeEngine(on, { git: index({}) })
  tool(on)
  const r = await $.tool.call({ tool: TOOL, repo: 'C:/r' } as any)
  expect(r.result).toBe('=== STAGED ===\n(nothing staged)\n\n=== SENTINELS ===\n(none)\n\n=== GATES ===\nGATE=EMPTY\nSTAGED_COUNT=0\nSENTINEL_COUNT=0\nDIFFSTAT=\n')
})

test('sentinel in a rename destination unstages destination and source; GATE=BLOCKED', async ($, on) => {
  const resets: string[][] = []
  fakeEngine(on, { git: index({ 'new name.cs': `${S}\nx\n`, 'b.cs': 'y\n' }, { 'new name.cs': 'old.cs' }, resets) })
  tool(on)
  const r = await $.tool.call({ tool: TOOL, repo: 'C:/r' } as any)
  expect(resets).toEqual([['reset', '-q', '--', ':(top,literal)new name.cs', ':(top,literal)old.cs']])
  expect(r.result).toBe(
    '=== STAGED ===\nM\tb.cs\n\n=== SENTINELS ===\n  new name.cs\n\n=== GATES ===\nGATE=BLOCKED\nSTAGED_COUNT=1\nSENTINEL_COUNT=1\nDIFFSTAT=1 file changed, 1 insertion(+)\n',
  )
})

test('not a worktree: ABORT line', async ($, on) => {
  fakeEngine(on, { git: () => ({ exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' }) })
  tool(on)
  const r = await $.tool.call({ tool: TOOL, repo: 'C:/x' } as any)
  expect(r.result).toBe('ABORT: C:/x is not a git worktree.')
})

test('session.start registers the tool with its schema', async ($, on) => {
  const registered: any[] = []
  fakeEngine(on)
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('tool.register', (_: unknown, e: any) => {
    registered.push(e)
    return { value: { tool: `mcp__sentinel__${e.name}` } }
  })
  await $.session.start({ cwd: 'C:/r', surface: 'desktop', isInteractive: true })
  expect(registered.length).toBe(1)
  expect(registered[0]).toMatchObject({
    name: 'commit_gate_status',
    description: 'Unstage staged files that still carry a manual-review sentinel, then report STAGED, SENTINELS and GATES blocks.',
    inputSchema: { type: 'object', properties: { repo: { type: 'string' } }, required: ['repo'] },
  })
})

test('final: a failed scan aborts instead of reporting CLEAR', async ($, on) => {
  fakeEngine(on, { git: args => (args[0] === 'rev-parse' ? ok('.git\n') : { exitCode: 128, stdout: '', stderr: 'fatal' }) })
  tool(on)
  const r = await $.tool.call({ tool: TOOL, repo: 'C:/r' } as any)
  expect(r.result).toBe('ABORT: sentinel scan failed in C:/r; nothing was unstaged.')
})

test('a configured .md type with a staged sentinel is unstaged and reported', { options: { fileTypes: '{".md":{"style":"markdown"}}' } }, async ($, on) => {
  const resets: string[][] = []
  const md = `---\n# ${S.slice(3)}\nname: x\n---\n`
  fakeEngine(on, { git: index({ 'a.md': md, 'b.cs': 'y\n' }, {}, resets) })
  tool(on)
  const r = await $.tool.call({ tool: TOOL, repo: 'C:/r' } as any)
  expect(resets).toEqual([['reset', '-q', '--', ':(top,literal)a.md']])
  expect(r.result).toContain('=== SENTINELS ===\n  a.md\n')
})
