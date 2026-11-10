import { decodeLines, decodeUtf8, detectBom } from './encoding.ts'
import type { Host } from './host.ts'
import { basename, BLOB_CEILING, extension, MARKER, TAIL } from './rules.ts'
import { MAX_LINES } from './styles.ts'
import { resolve, type Rule, type Table } from './types.ts'

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

const lowered = new WeakMap<Table, ReadonlyMap<string, Rule>>()

// resolve, but blind to case: `A.CS` is held to the `.cs` row. Insertion keeps
// the exact-case table; only the gates widen it, so no marked file slips past.
export function resolveLoose(table: Table, path: string): Rule | undefined {
  const exact = resolve(table, path)
  if (exact !== undefined) return exact
  let low = lowered.get(table)
  if (low === undefined) {
    low = new Map([...table].map(([k, v]) => [k.toLowerCase(), v]))
    lowered.set(table, low)
  }
  return low.get(basename(path).toLowerCase()) ?? low.get(extension(path).toLowerCase())
}

// A sentinel is the marker on any of the first MAX_LINES lines of any file, or
// the full sentinel text anywhere in a file of a configured type. Neither
// depends on the exact insertion line, so a sentinel that moved, or one in a
// file whose type was configured differently when it was inserted, still counts.
export function carriesSentinel(bytes: Uint8Array, typed: boolean): boolean {
  const bom = detectBom(bytes)
  if (decodeLines(bytes, bom, MAX_LINES).some(l => l.text.includes(MARKER))) return true
  return typed && bom.kind === 'none' && decodeUtf8(bytes, 0).includes(TAIL)
}

function textCarriesSentinel(text: string, typed: boolean): boolean {
  if (text.split('\n', MAX_LINES).some(l => l.includes(MARKER))) return true
  return typed && text.includes(TAIL)
}

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

// Staged paths whose blob is clean while the working-tree copy carries a
// sentinel: content a clean filter (or a hand-built index entry) took the
// line out of on its way into the index. Skipped when the top is unknown.
async function strippedOnStage(host: Host, repo: string, clean: readonly string[], typed: ReadonlySet<string>): Promise<Set<string>> {
  if (clean.length === 0) return new Set()
  const top = await host.git(['rev-parse', '--show-toplevel'], repo)
  const root = top.exitCode === 0 ? top.stdout.trim().replace(/\\/g, '/').replace(/\/$/, '') : ''
  if (!/^([A-Za-z]:)?\//.test(root)) return new Set()
  const hits = await mapLimit(clean, CONCURRENCY, async p => {
    const read = await host.readFile(`${root}/${p}`)
    return 'bytes' in read && carriesSentinel(read.bytes, typed.has(p))
  })
  return new Set(clean.filter((_, i) => hits[i]))
}

// Staged paths that carry a sentinel (carriesSentinel), all relative to the
// repository top (repo may be a subdirectory). Fail-open: any git failure
// yields an empty list rather than a blocked commit.
export async function scanStaged(host: Host, repo: string, table: Table): Promise<string[]> {
  return (await scanStagedOrFail(host, repo, table)) ?? []
}

// As scanStaged, but undefined when the scan itself failed, so the caller can
// report that the commit went through ungated.
export async function scanStagedOrFail(host: Host, repo: string, table: Table): Promise<string[] | undefined> {
  try {
    const diff = await host.git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], repo)
    if (diff.exitCode !== 0) return undefined
    const staged = nulList(diff.stdout)
    if (staged.length === 0) return []
    const typed = new Set(staged.filter(p => resolveLoose(table, p) !== undefined))

    // Text blobs are found by grep over every staged path; non-text blobs
    // (UTF-16, UTF-32) are read only for configured types.
    const marked = await grepChunks(host, repo, staged, ['-F', '-e', MARKER])
    const text = await grepChunks(host, repo, [...typed], ['-e', ''])
    if (marked === undefined || text === undefined) return undefined

    // undefined: the blob could not be read, which fails the whole scan
    // rather than passing a file that may carry the sentinel.
    const hits = await mapLimit(staged, CONCURRENCY, async (path): Promise<boolean | undefined> => {
      if (marked.has(path)) {
        const show = await host.git(['show', `:${path}`], repo)
        return show.exitCode === 0 ? textCarriesSentinel(show.stdout, typed.has(path)) : undefined
      }
      if (!typed.has(path) || text.has(path)) return false
      const blob = await host.readBlob(repo, path, BLOB_CEILING)
      return blob === undefined ? undefined : carriesSentinel(blob, true)
    })
    if (hits.includes(undefined)) return undefined
    const stripped = await strippedOnStage(host, repo, staged.filter((_, i) => !hits[i]), typed)
    return staged.filter((p, i) => hits[i] || stripped.has(p))
  } catch {
    return undefined
  }
}
