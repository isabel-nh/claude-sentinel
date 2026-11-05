import { classify, findRoots, normalizeDrive } from './command.ts'
import { applyAndReport, type Ctx } from './ctx.ts'
import { changedSince } from './detect.ts'
import { mapLimit, scanStagedOrFail } from './scan.ts'

type Result = { deny?: string }
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

  const start = await host.now()
  const result = await next(e)
  const roots = await findRoots(host, c.anchor, c.paths, cwd)
  const changed = (await Promise.all(roots.map(root => changedSince(host, root, start, ctx.table)))).flat()
  await mapLimit(changed, CONCURRENCY, path => applyAndReport(ctx, host, path, 'Bash'))
  return result
}
