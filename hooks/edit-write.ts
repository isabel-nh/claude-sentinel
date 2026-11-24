import { hasSentinel, insertSentinelText } from './apply.ts'
import { normalizeDrive, repoOf } from './command.ts'
import { applyAndReport, type Ctx } from './ctx.ts'
import type { Host } from './host.ts'
import { isPruned, MARKER } from './rules.ts'
import { MAX_LINES } from './styles.ts'
import { resolve, type Table } from './types.ts'

export const DENY_REMOVAL = 'Sentinel lines are removed only by the user, manually, after review.'

type Edit = { old_string: string; new_string: string }
type Result = { deny?: string; isError?: true; context?: readonly string[] }
type Next<E, R> = (e: E) => Promise<R>

const copies = (s: string) => s.split(MARKER).length - 1

function lineOfMarker(text: string): number {
  const at = text.split('\n', MAX_LINES).findIndex(l => l.includes(MARKER))
  return at === -1 ? 1 : at + 1
}

// Files outside a git working tree, and untracked files git ignores, are not
// committed, so they get no sentinel. A later copy into a repository through
// Bash or PowerShell, or a .gitignore change, shows the file in `git status`
// there and it is marked then. A tracked file is marked even when a pattern
// matches it: `git check-ignore` reports only untracked paths. A failed check
// marks the file.
async function committable(host: Host, path: string): Promise<boolean> {
  const repo = await repoOf(host, path)
  if (repo === undefined) return false
  const rel = normalizeDrive(path).slice(repo.endsWith('/') ? repo.length : repo.length + 1)
  return (await host.git(['check-ignore', '-q', '--', rel], repo)).exitCode !== 0
}

const IGNORE_FILE = /(?:^|\/)(?:\.gitignore|\.git\/info\/exclude)$/

async function ignoredTyped(host: Host, repo: string, table: Table): Promise<Set<string> | undefined> {
  const r = await host.git(['ls-files', '-z', '-o', '-i', '--exclude-standard'], repo)
  if (r.exitCode !== 0) return undefined
  return new Set(r.stdout.split('\u0000').filter(p => p !== '' && resolve(table, p) !== undefined && !isPruned(p)))
}

// Files the edit to an ignore file stopped ignoring get their sentinel now.
async function watchIgnores<R extends Result>(ctx: Ctx, path: string, tool: string, run: () => Promise<R>): Promise<R> {
  if (!IGNORE_FILE.test(normalizeDrive(path))) return run()
  const host = await ctx.host()
  const repo = await repoOf(host, path)
  const before = repo === undefined ? undefined : await ignoredTyped(host, repo, ctx.table)
  const result = await run()
  if (before === undefined || before.size === 0 || result.deny !== undefined || result.isError) return result
  const after = await ignoredTyped(host, repo!, ctx.table)
  if (after === undefined) {
    await ctx.notify(`ignores:${repo}`, `sentinel (${tool}): could not list ignored files in ${repo}; files that the change to ${path} un-ignored were not marked.`)
    return result
  }
  const base = repo!.replace(/\/$/, '')
  for (const p of before) if (!after.has(p)) await applyAndReport(ctx, host, `${base}/${p}`, tool)
  return result
}

export function onWrite<E extends { file_path: string; content: string }, R extends Result>(ctx: Ctx, e: E, next: Next<E, R>): Promise<R> {
  return watchIgnores(ctx, e.file_path, 'Write', () => write(ctx, e, next))
}

export function onEdit<E extends { file_path: string }, R extends Result>(ctx: Ctx, e: E, next: Next<E, R>): Promise<R> {
  return watchIgnores(ctx, e.file_path, 'Edit', () => edit(ctx, e, next))
}

async function write<E extends { file_path: string; content: string }, R extends Result>(ctx: Ctx, e: E, next: Next<E, R>): Promise<R> {
  const path = e.file_path
  const rule = resolve(ctx.table, path)
  if (rule === undefined) return next(e)
  const host = await ctx.host()
  if (!(await committable(host, path))) return next(e)
  const before = await host.readFile(path)
  const hadSentinel = 'bytes' in before && hasSentinel(before.bytes, rule)

  // The tool runs with the input as given and the line goes in afterward:
  // auto mode rejects a call whose input a hook changed after its review.
  const result = await next(e)
  if (result.deny !== undefined || result.isError) return result

  await applyAndReport(ctx, host, path, 'Write')
  const content = insertSentinelText(e.content, rule)
  if (content === undefined || !hadSentinel) return result
  const note = `Sentinel line kept on line ${lineOfMarker(content)} of ${path}; only the user removes it.`
  return { ...result, context: [...(result.context ?? []), note] }
}

async function edit<E extends { file_path: string }, R extends Result>(ctx: Ctx, e: E, next: Next<E, R>): Promise<R> {
  const path = e.file_path
  if (resolve(ctx.table, path) === undefined) return next(e)
  const loose = e as E & Partial<Edit> & { edits?: readonly Edit[] }
  const edits: readonly Edit[] = loose.edits ?? [{ old_string: loose.old_string!, new_string: loose.new_string! }]
  if (edits.some(x => copies(x.new_string) < copies(x.old_string))) return { deny: DENY_REMOVAL } as R

  const result = await next(e)
  if (result.deny !== undefined || result.isError) return result
  const host = await ctx.host()
  if (await committable(host, path)) await applyAndReport(ctx, host, path, 'Edit')
  return result
}
