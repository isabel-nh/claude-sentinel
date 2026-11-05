import type { Host } from './host.ts'
import { scanStagedOrFail } from './scan.ts'

export const GATE_TOOL = {
  name: 'commit_gate_status',
  description: 'Unstage staged files that still carry a manual-review sentinel, then report STAGED, SENTINELS and GATES blocks.',
  inputSchema: { type: 'object', properties: { repo: { type: 'string' } }, required: ['repo'] },
} as const

const top = (p: string) => `:(top,literal)${p}`

// Destination -> source for every staged rename (`R<score>\0src\0dst\0`).
async function renameSources(host: Host, repo: string): Promise<Map<string, string>> {
  const r = await host.git(['diff', '--cached', '--name-status', '-z', '--diff-filter=R'], repo)
  const fields = r.exitCode === 0 ? r.stdout.split('\u0000') : []
  const out = new Map<string, string>()
  for (let i = 0; i + 2 < fields.length; i += 3) out.set(fields[i + 2]!, fields[i + 1]!)
  return out
}

// Unstages sentinel-bearing staged files (a rename's source with its
// destination, so the index never holds a half-rename that would commit as a
// bare deletion), then reports in the shape of the retired commit-gate-status.sh.
export async function gateStatus(host: Host, repo: string): Promise<string> {
  const probe = await host.git(['rev-parse', '--git-dir'], repo)
  if (probe.exitCode !== 0) return `ABORT: ${repo} is not a git worktree.`

  const violations = await scanStagedOrFail(host, repo)
  if (violations === undefined) return `ABORT: sentinel scan failed in ${repo}; nothing was unstaged.`
  if (violations.length > 0) {
    const sources = await renameSources(host, repo)
    const specs = violations.flatMap(p => (sources.has(p) ? [top(p), top(sources.get(p)!)] : [top(p)]))
    const reset = await host.git(['reset', '-q', '--', ...specs], repo)
    if (reset.exitCode !== 0) return 'ABORT: git reset failed to unstage the sentinel-bearing files.'
  }

  const stagedRun = await host.git(['diff', '--cached', '--name-status', '--diff-filter=ACMRD'], repo)
  const staged = stagedRun.exitCode === 0 ? stagedRun.stdout.replace(/\n+$/, '') : ''
  const stagedCount = staged === '' ? 0 : staged.split('\n').filter(l => l !== '').length
  const gate = violations.length > 0 ? 'BLOCKED' : stagedCount === 0 ? 'EMPTY' : 'CLEAR'
  const shortstat = await host.git(['diff', '--cached', '--shortstat'], repo)
  const diffstat = shortstat.exitCode === 0 ? shortstat.stdout.trim() : ''

  return [
    '=== STAGED ===',
    stagedCount === 0 ? '(nothing staged)' : staged,
    '',
    '=== SENTINELS ===',
    violations.length === 0 ? '(none)' : violations.map(p => `  ${p}`).join('\n'),
    '',
    '=== GATES ===',
    `GATE=${gate}`,
    `STAGED_COUNT=${stagedCount}`,
    `SENTINEL_COUNT=${violations.length}`,
    `DIFFSTAT=${diffstat}`,
    '',
  ].join('\n')
}
