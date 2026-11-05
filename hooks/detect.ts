import type { Host } from './host.ts'
import { isPruned, sentinelFor } from './rules.ts'

export type StatusEntry = { y: string; path: string }

// `git status --porcelain -z`: "XY path\0", with a rename or copy (X = R/C)
// followed by one extra field holding the source path.
export function parseStatusZ(stdout: string): StatusEntry[] {
  const fields = stdout.split('\u0000')
  const out: StatusEntry[] = []
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]!
    if (f.length < 4) continue
    out.push({ y: f[1]!, path: f.slice(3) })
    if (f[0] === 'R' || f[0] === 'C') i++
  }
  return out
}

export async function changedSince(host: Host, root: string, start: number): Promise<string[]> {
  const r = await host.git(['status', '--porcelain', '-uall', '-z'], root)
  if (r.exitCode !== 0) return []
  const out: string[] = []
  for (const { y, path } of parseStatusZ(r.stdout)) {
    if (y === ' ' || sentinelFor(path) === undefined || isPruned(path)) continue
    const abs = `${root}/${path}`
    const mtime = await host.mtimeMs(abs)
    if (mtime !== undefined && mtime > start) out.push(abs)
  }
  return out
}
