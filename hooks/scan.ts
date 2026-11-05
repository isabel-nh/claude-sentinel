import { hasSentinel } from './apply.ts'
import type { Host } from './host.ts'
import { MARKER, blobCeiling, sentinelFor } from './rules.ts'

const CHUNK = 150
const CONCURRENCY = 4

export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

const nulList = (s: string) => s.split('\u0000').filter(p => p !== '')

// git grep exits 1 for "no match"; anything above that is a real failure.
async function grepChunks(host: Host, repo: string, paths: readonly string[], pattern: readonly string[]): Promise<Set<string> | undefined> {
  const chunks: string[][] = []
  for (let i = 0; i < paths.length; i += CHUNK) chunks.push(paths.slice(i, i + CHUNK))
  const results = await mapLimit(chunks, CONCURRENCY, chunk =>
    host.git(['grep', '--cached', '--full-name', '-I', '-l', '-z', ...pattern, '--', ...chunk.map(p => `:(top,literal)${p}`)], repo),
  )
  if (results.some(r => r.exitCode > 1 || r.exitCode < 0)) return undefined
  return new Set(results.flatMap(r => nulList(r.stdout)))
}

// Staged paths whose sentinel line still carries the marker, all relative to
// the repository top (repo may be a subdirectory). Fail-open: any git failure
// yields an empty list rather than a blocked commit.
export async function scanStaged(host: Host, repo: string): Promise<string[]> {
  return (await scanStagedOrFail(host, repo)) ?? []
}

// As scanStaged, but undefined when the scan itself failed, so the caller can
// report that the commit went through ungated.
export async function scanStagedOrFail(host: Host, repo: string): Promise<string[] | undefined> {
  try {
    const diff = await host.git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], repo)
    if (diff.exitCode !== 0) return undefined
    const staged = nulList(diff.stdout).filter(p => sentinelFor(p) !== undefined)
    if (staged.length === 0) return []

    const marked = await grepChunks(host, repo, staged, ['-F', '-e', MARKER])
    const text = await grepChunks(host, repo, staged, ['-e', ''])
    if (marked === undefined || text === undefined) return undefined

    // undefined: the blob could not be read, which fails the whole scan
    // rather than passing a file that may carry the sentinel.
    const hits = await mapLimit(staged, CONCURRENCY, async (path): Promise<boolean | undefined> => {
      if (text.has(path)) {
        if (!marked.has(path)) return false
        const show = await host.git(['show', `:${path}`], repo)
        return show.exitCode === 0 ? hasSentinel(new TextEncoder().encode(show.stdout), path) : undefined
      }
      const blob = await host.readBlob(repo, path, blobCeiling(path))
      return blob === undefined ? undefined : hasSentinel(blob, path)
    })
    if (hits.includes(undefined)) return undefined
    return staged.filter((_, i) => hits[i])
  } catch {
    return undefined
  }
}
