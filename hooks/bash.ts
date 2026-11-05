import { classify, findRoots, normalizeDrive } from './command.ts'
import { applyAndReport, type Ctx } from './ctx.ts'
import { changedSince } from './detect.ts'
import { unstageSentinels } from './gate-tool.ts'
import type { Host } from './host.ts'
import { mapLimit, scanStagedOrFail } from './scan.ts'

type Result = { deny?: string; context?: readonly string[] }
type Next<E, R> = (e: E) => Promise<R>

const CONCURRENCY = 4

export function commitBlocked(paths: readonly string[]): string {
  return `Commit blocked: sentinel review lines still present in staged files:\n${paths.map(p => `  ${p}\n`).join('')}Remove the sentinel lines after reviewing, then retry.`
}

export async function onBash<E extends { command: string }, R extends Result>(ctx: Ctx, e: E, next: Next<E, R>): Promise<R> {
  const host = await ctx.host()
  const cwd = normalizeDrive(await ctx.cwd())
  if (ctx.wrapper?.error !== undefined) await ctx.notify('config:commitWrapper', ctx.wrapper.error)
  const c = classify(e.command, cwd, host.home, ctx.wrapper?.pattern)

  if (c.kind === 'vcs') return next(e)

  if (c.kind === 'commit' || c.kind === 'wrapper-commit') {
    // A shell expansion ("$WT", `pwd`) cannot be resolved here: scan cwd, and say so.
    const unresolved = /[$`]/.test(c.repo)
    const repo = unresolved ? cwd : normalizeDrive(c.repo)
    if (unresolved) await ctx.notify(`unresolved:${c.repo}`, `sentinel (Bash): commit repository ${c.repo} is a shell expansion; scanned ${cwd} instead.`)
    const violations = await scanStagedOrFail(host, repo, ctx.table)
    if (violations === undefined) {
      await ctx.notify(`scan:${repo}`, `sentinel (Bash): staged-file scan failed in ${repo}; the commit was not gated.`)
      return next(e)
    }
    return violations.length > 0 ? ({ deny: commitBlocked(violations) } as R) : next(e)
  }

  const before = await findRoots(host, c.anchor, c.paths, cwd)
  const stamps = new Map(await Promise.all(before.map(async root => [root, await indexStamp(host, root)] as const)))
  const start = await host.now()
  const result = await next(e)
  const roots = await findRoots(host, c.anchor, c.paths, cwd)
  const changed = (await Promise.all(roots.map(root => changedSince(host, root, start, ctx.table)))).flat()
  await mapLimit(changed, CONCURRENCY, path => applyAndReport(ctx, host, path, 'Bash'))

  // An index the command changed (or created) is checked for staged sentinels.
  const blocked = (
    await mapLimit(roots, CONCURRENCY, async root => {
      const stamp = await indexStamp(host, root)
      if (stamp === undefined || stamp === stamps.get(root)) return []
      const outcome = await unstageSentinels(host, root, ctx.table)
      if ('unstaged' in outcome) return outcome.unstaged.map(p => `${root.replace(/\/$/, '')}/${p}`)
      await ctx.notify(`staging:${root}`, `sentinel (Bash): staged-file ${outcome.failed} failed in ${root}; staging was not checked.`)
      return []
    })
  ).flat()
  if (blocked.length === 0) return result
  return { ...result, context: [...(result.context ?? []), stagingBlocked(blocked)] }
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
