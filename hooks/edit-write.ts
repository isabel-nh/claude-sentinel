import { hasSentinel, insertSentinelText } from './apply.ts'
import { repoOf } from './command.ts'
import { applyAndReport, type Ctx } from './ctx.ts'
import { MARKER } from './rules.ts'
import { MAX_LINES } from './styles.ts'
import { resolve } from './types.ts'

export const DENY_REMOVAL = 'Sentinel lines are removed only by the user, manually, after review.'

type Edit = { old_string: string; new_string: string }
type Result = { deny?: string; isError?: true; context?: readonly string[] }
type Next<E, R> = (e: E) => Promise<R>

const copies = (s: string) => s.split(MARKER).length - 1

function lineOfMarker(text: string): number {
  const at = text.split('\n', MAX_LINES).findIndex(l => l.includes(MARKER))
  return at === -1 ? 1 : at + 1
}

// Files outside a git working tree are never committed, so they get no
// sentinel. A later copy into a repository through Bash or PowerShell shows up
// in `git status` there and is marked then.

export async function onWrite<E extends { file_path: string; content: string }, R extends Result>(ctx: Ctx, e: E, next: Next<E, R>): Promise<R> {
  const path = e.file_path
  const rule = resolve(ctx.table, path)
  if (rule === undefined) return next(e)
  const host = await ctx.host()
  if ((await repoOf(host, path)) === undefined) return next(e)
  const before = await host.readFile(path)
  const hadSentinel = 'bytes' in before && hasSentinel(before.bytes, rule)

  const content = insertSentinelText(e.content, rule)
  const result = await next(content === undefined ? e : { ...e, content })
  if (result.deny !== undefined || result.isError) return result

  await applyAndReport(ctx, host, path, 'Write')
  if (content === undefined || !hadSentinel) return result
  const note = `Sentinel line kept on line ${lineOfMarker(content)} of ${path}; only the user removes it.`
  return { ...result, context: [...(result.context ?? []), note] }
}

export async function onEdit<E extends { file_path: string }, R extends Result>(ctx: Ctx, e: E, next: Next<E, R>): Promise<R> {
  const path = e.file_path
  if (resolve(ctx.table, path) === undefined) return next(e)
  const loose = e as E & Partial<Edit> & { edits?: readonly Edit[] }
  const edits: readonly Edit[] = loose.edits ?? [{ old_string: loose.old_string!, new_string: loose.new_string! }]
  if (edits.some(x => copies(x.new_string) < copies(x.old_string))) return { deny: DENY_REMOVAL } as R

  const result = await next(e)
  if (result.deny !== undefined || result.isError) return result
  const host = await ctx.host()
  if ((await repoOf(host, path)) !== undefined) await applyAndReport(ctx, host, path, 'Edit')
  return result
}
