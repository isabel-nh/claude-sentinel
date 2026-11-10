import { bypassDenied, classify, findRoots, hookBypass, normalizeDrive, plumbingCall, plumbingDenied } from './command.ts'
import { applyAndReport, type Ctx } from './ctx.ts'
import { changedSince } from './detect.ts'
import { unstageSentinels } from './gate-tool.ts'
import { baselinePath, splitPrologue, withHooks } from './git-hooks.ts'
import type { Host } from './host.ts'
import { baselineFile, captureBaseline, rollBackUnreviewed, rolledBack, stagedUnreviewed, unchangedStaged, type Baseline } from './origin.ts'
import { mapLimit, scanStagedOrFail } from './scan.ts'
import { stageCalls, stagingDenied, stagingSentinels } from './stage.ts'

type Result = { deny?: string; context?: readonly string[] }
type Next<E, R> = (e: E) => Promise<R>

const CONCURRENCY = 4

export function commitBlocked(paths: readonly string[]): string {
  return `Commit blocked: sentinel review lines still present in staged files:\n${paths.map(p => `  ${p}\n`).join('')}Remove the sentinel lines after reviewing, then retry.`
}

export function originCommitBlocked(paths: readonly string[]): string {
  return `Commit blocked: staged content adds lines that no reviewed working-tree copy holds:\n${paths.map(p => `  ${p}\n`).join('')}Write the change into the working tree, where it gets a sentinel for review, and stage it after review.`
}

export function originUnstaged(paths: readonly string[]): string {
  return `staging blocked: the staged content of ${paths.join(', ')} adds lines that the reviewed working-tree copy does not hold; unstaged.`
}

const top = (p: string) => `:(top,literal)${p}`
const sameRepo = (baselines: readonly Baseline[], root: string) => {
  const own = baselines.find(b => b.root === root)
  return own === undefined ? [] : baselines.filter(b => b.common === own.common)
}

// The hook environment is injected as a bash prologue, so git cannot be run
// from the PowerShell tool with the pre-commit hook in place.
const POWERSHELL_GIT = /(?:^|[^\w.-])git(?:\.exe)?(?![\w.-])/i

export function powershellGitDenied(): string {
  return 'sentinel: denied: git from the PowerShell tool runs without the sentinel pre-commit hook. Run git commands through the Bash tool.'
}

export async function onPowerShell<E extends { command: string }, R extends Result>(ctx: Ctx, e: E, next: Next<E, R>): Promise<R> {
  return onBash(ctx, e, next, 'PowerShell')
}

export async function onBash<E extends { command: string }, R extends Result>(ctx: Ctx, e: E, next: Next<E, R>, tool: 'Bash' | 'PowerShell' = 'Bash'): Promise<R> {
  const host = await ctx.host()
  const cwd = normalizeDrive(await ctx.cwd())
  const ps = tool === 'PowerShell'
  if (ps && POWERSHELL_GIT.test(e.command)) return { deny: powershellGitDenied() } as R
  if (ctx.wrapper?.error !== undefined) await ctx.notify('config:commitWrapper', ctx.wrapper.error)

  // With the shims installed, git runs the pre-commit scan itself against the
  // index it commits, whatever staged it and wherever the command runs.
  const env = ps ? undefined : await ctx.hooksEnv?.()
  // The mod's own prologue, sent back as auto mode asks, is not the agent's:
  // every check reads the command behind it.
  const pre = env === undefined || host.home === undefined ? undefined : splitPrologue(e.command, env, host.home)
  const body = pre?.body ?? e.command
  // The rewritten command; unchanged when it already is what the mod would send.
  const wrap = (command: string): E => (command === e.command ? e : ({ ...e, command } as E))

  const c = classify(body, cwd, host.home, ctx.wrapper?.pattern)
  const bypass = hookBypass(body)
  if (bypass !== undefined && (ps || env !== undefined)) return { deny: bypassDenied(bypass) } as R

  const plumbing = plumbingCall(body)
  if (plumbing !== undefined) return { deny: plumbingDenied(plumbing) } as R

  for (const call of ps ? [] : stageCalls(body, cwd, host.home)) {
    const hits = await stagingSentinels(host, call, ctx.table)
    if (hits !== undefined && hits.length > 0) return { deny: stagingDenied(hits) } as R
  }

  if (c.kind === 'vcs') return next(env === undefined ? e : wrap(withHooks(body, env)))

  // A shell expansion ("$WT", `pwd`) cannot be resolved here: scan cwd, and say so.
  const given = c.kind === 'other' ? undefined : c.repo
  const unresolved = given !== undefined && /[$`]/.test(given)
  const repo = given === undefined ? undefined : unresolved ? cwd : normalizeDrive(given)
  if (unresolved) await ctx.notify(`unresolved:${given}`, `sentinel (${tool}): commit repository ${given} is a shell expansion; scanned ${cwd} instead.`)

  const before = c.kind === 'other' ? await findRoots(host, c.anchor, c.paths, cwd) : await findRoots(host, repo!, [], cwd)
  const baselines = (await mapLimit(before, CONCURRENCY, root => captureBaseline(host, root, ctx.table))).filter((b): b is Baseline => b !== undefined)

  if (repo !== undefined) {
    const violations = await scanStagedOrFail(host, repo, ctx.table)
    if (violations === undefined) await ctx.notify(`scan:${repo}`, `sentinel (${tool}): staged-file scan failed in ${repo}; ${env === undefined ? 'the commit was not gated' : 'only the pre-commit hook gates the commit'}.`)
    else if (violations.length > 0) return { deny: commitBlocked(violations) } as R
    const root = before[0]
    const unreviewed = root === undefined ? undefined : await stagedUnreviewed(host, repo, sameRepo(baselines, root), ctx.table)
    if (unreviewed !== undefined && unreviewed.length > 0) return { deny: originCommitBlocked(unreviewed) } as R
  }

  // The baseline file lives only while the command runs.
  // A replayed prologue keeps its id, so the command runs as it was reviewed;
  // the file behind it is written fresh either way.
  const id = pre?.baselineId ?? `${await host.now()}-${Math.random().toString(36).slice(2, 10)}`
  const file = host.home === undefined ? undefined : baselinePath(host.home, id)
  const dir = file !== undefined && (await host.bash('mkdir -p "${1%/*}"', [file])).exitCode === 0
  const written = dir && env !== undefined && (await host.writeText(file!, baselineFile(baselines)))
  const run = env === undefined ? e : wrap(withHooks(body, env, written ? file : undefined))

  try {
    const stamps = new Map(await Promise.all(before.map(async root => [root, await indexStamp(host, root)] as const)))
    const start = await host.now()
    const result = await next(run)
    const context: string[] = []

    // Branches the command moved onto unreviewed commits go back first, so
    // the content they carried shows up below as working-tree changes.
    const rollbacks = await rollBackUnreviewed(host, baselines, ctx.table, dir ? `${file}.revs` : undefined)
    if (rollbacks === undefined && baselines.length > 0) await ctx.notify('audit', 'sentinel (Bash): new commits could not be checked for unreviewed content.')
    for (const r of rollbacks ?? []) context.push(rolledBack(r))

    const roots = c.kind === 'other' ? await findRoots(host, c.anchor, c.paths, cwd) : before
    const moved = (
      await mapLimit(roots, CONCURRENCY, async root => {
        const stamp = await indexStamp(host, root)
        return stamp !== undefined && stamp !== stamps.get(root) ? [root] : []
      })
    ).flat()

    // Staged content that is not a reviewed copy is unstaged before files are
    // marked: content written and staged in one command then shows as a
    // working-tree change and gets its sentinel.
    const stripped: string[] = []
    await mapLimit(moved, CONCURRENCY, async root => {
      const group = sameRepo(baselines, root)
      if (group.length === 0) return
      const unreviewed = await stagedUnreviewed(host, root, group, ctx.table)
      if (unreviewed === undefined || unreviewed.length === 0) return
      const reset = await host.git(['reset', '-q', '--', ...unreviewed.map(top)], root)
      if (reset.exitCode !== 0) await ctx.notify(`origin:${root}`, `sentinel (${tool}): could not unstage ${unreviewed.join(', ')} in ${root}.`)
      else stripped.push(...unreviewed.map(p => `${root.replace(/\/$/, '')}/${p}`))
    })

    const files = new Map(baselines.map(b => [b.root, b.files] as const))
    const changed = (await Promise.all(roots.map(root => changedSince(host, root, start, ctx.table, files.get(root))))).flat()
    await mapLimit(changed, CONCURRENCY, path => applyAndReport(ctx, host, path, tool))

    // An index the command changed (or created) is checked for staged sentinels.
    const blocked: string[] = []
    await mapLimit(moved, CONCURRENCY, async root => {
      const outcome = await unstageSentinels(host, root, ctx.table, await unchangedStaged(host, root, sameRepo(baselines, root)))
      if ('unstaged' in outcome) blocked.push(...outcome.unstaged.map(p => `${root.replace(/\/$/, '')}/${p}`))
      else await ctx.notify(`staging:${root}`, `sentinel (${tool}): staged-file ${outcome.failed} failed in ${root}; staging was not checked.`)
    })
    if (blocked.length > 0) context.push(stagingBlocked(blocked))
    if (stripped.length > 0) context.push(originUnstaged(stripped))
    return context.length === 0 ? result : { ...result, context: [...(result.context ?? []), ...context] }
  } finally {
    if (dir) await host.bash('rm -f "$1" "$1.revs"', [file!])
  }
}

export function stagingBlocked(paths: readonly string[]): string {
  return `staging blocked due to presence of sentinels in files: ${paths.join(', ')}`
}

async function indexStamp(host: Host, root: string): Promise<number | undefined> {
  const r = await host.git(['rev-parse', '--git-path', 'index'], root)
  const rel = r.exitCode === 0 ? r.stdout.trim() : ''
  if (rel === '') return undefined
  return host.mtimeMs(/^([A-Za-z]:)?\//.test(rel) ? rel : `${root.replace(/\/$/, '')}/${rel}`)
}
