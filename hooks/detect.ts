import type { Host } from './host.ts'
import { isPruned } from './rules.ts'
import { resolve, type Table } from './types.ts'

export type StatusEntry = { x: string; y: string; path: string }

// `git status --porcelain -z`: "XY path\0", with a rename or copy (X = R/C)
// followed by one extra field holding the source path.
export function parseStatusZ(stdout: string): StatusEntry[] {
  const fields = stdout.split('\u0000')
  const out: StatusEntry[] = []
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]!
    if (f.length < 4) continue
    out.push({ x: f[0]!, y: f[1]!, path: f.slice(3) })
    if (f[0] === 'R' || f[0] === 'C') i++
  }
  return out
}

// Content hash of each worktree-dirty typed file, keyed by repo-relative path.
export type Snapshot = ReadonlyMap<string, string>

const MAX_SNAPSHOT = 2000
const CHUNK = 150

async function dirtyTyped(host: Host, root: string, table: Table): Promise<string[] | undefined> {
  const r = await host.git(['status', '--porcelain', '-uall', '-z'], root)
  if (r.exitCode !== 0) return undefined
  return parseStatusZ(r.stdout)
    .filter(({ y, path }) => y !== ' ' && resolve(table, path) !== undefined && !isPruned(path))
    .map(e => e.path)
}

// Raw bytes (--no-filters), one hash per path; undefined unless every path
// hashed. `write` also stores each blob, so its content can be read back later.
export async function hashAll(host: Host, root: string, paths: readonly string[], write = false): Promise<string[] | undefined> {
  const out: string[] = []
  for (let i = 0; i < paths.length; i += CHUNK) {
    const chunk = paths.slice(i, i + CHUNK)
    const r = await host.git(['hash-object', ...(write ? ['-w'] : []), '--no-filters', '--', ...chunk], root)
    const hashes = r.exitCode === 0 ? r.stdout.split(/\r?\n/).filter(h => h !== '') : []
    if (hashes.length !== chunk.length) return undefined
    out.push(...hashes)
  }
  return out
}

// Taken before a command runs. undefined (git failed, or too many dirty files)
// leaves changedSince to compare modification times instead.
export async function snapshot(host: Host, root: string, table: Table): Promise<Snapshot | undefined> {
  const paths = await dirtyTyped(host, root, table)
  if (paths === undefined || paths.length > MAX_SNAPSHOT) return undefined
  const hashes = await hashAll(host, root, paths)
  return hashes === undefined ? undefined : new Map(paths.map((p, i) => [p, hashes[i]!]))
}

// Worktree-dirty typed files the command changed. With a snapshot: files that
// were not dirty before, or whose content differs from it, whatever their
// modification time (a rename keeps it, `touch -d` resets it). Without one:
// files modified after `start`.
export async function changedSince(host: Host, root: string, start: number, table: Table, before?: Snapshot): Promise<string[]> {
  const paths = await dirtyTyped(host, root, table)
  if (paths === undefined) return []
  if (before !== undefined) {
    const known = paths.filter(p => before.has(p))
    const hashes = await hashAll(host, root, known)
    if (hashes !== undefined) {
      const differs = new Set(known.filter((p, i) => hashes[i] !== before.get(p)))
      return paths.filter(p => !before.has(p) || differs.has(p)).map(p => `${root}/${p}`)
    }
  }
  const out: string[] = []
  for (const path of paths) {
    const abs = `${root}/${path}`
    const mtime = await host.mtimeMs(abs)
    if (mtime !== undefined && mtime > start) out.push(abs)
  }
  return out
}
