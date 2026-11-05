import type { Host } from './host.ts'
import { VCS_VERBS } from './rules.ts'

export type Classified =
  | { kind: 'commit'; repo: string }
  | { kind: 'wrapper-commit'; repo: string }
  | { kind: 'vcs' }
  | { kind: 'other'; anchor: string; paths: string[] }

const MAX_ROOTS = 3
const MAX_PATH_PROBES = 40
const MAX_WALK = 16

// One possibly-quoted shell word: "x y", 'x y' or bare.
const WORD = `(?:"([^"]+)"|'([^']+)'|([^\\s;&|)]+))`
const CD = new RegExp(`^\\s*[({]?\\s*(?:cd|pushd)\\s+(?:--\\s+)?${WORD}`)
// git, any global options (-C dir, -c k=v, --no-pager, --git-dir=x), then
// commit; preceded by anything that is not part of a longer word, so
// subshells and `bash -c "git commit"` count.
const GIT_OPTION = `(?:-C\\s+${WORD}|-c\\s+\\S+|--?[A-Za-z][\\w-]*(?:=\\S+)?)`
const GIT_COMMIT = new RegExp(`(?:^|[^\\w./-])git\\s+(?:${GIT_OPTION}\\s+)*commit(?:[\\s"')]|$)`)
const GIT_DIR = new RegExp(`\\s-C\\s+${WORD}`, 'g')
const WRAPPER_DIR = new RegExp(`\\s-C\\s+${WORD}`)
const VCS = new RegExp(`(^|[^A-Za-z0-9_-])git\\s+(-C\\s+\\S+\\s+)?(${VCS_VERBS.join('|')})(\\s|$)`)
const NOT_PATH = /["'(){}[\],;=`|&<>]/g

export function normalizeDrive(p: string): string {
  let s = p.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  const posix = /^\/([A-Za-z])(\/|$)/.exec(s)
  if (posix) s = `${posix[1]!.toUpperCase()}:/${s.slice(3)}`
  return s.length > 3 ? s.replace(/\/+$/, '') : s
}

function word(m: RegExpExecArray, at: number): string | undefined {
  return m[at] ?? m[at + 1] ?? m[at + 2]
}

function expandHome(p: string, home: string | undefined): string {
  if (home === undefined) return p
  if (p === '~') return home
  if (p.startsWith('~/')) return `${home}/${p.slice(2)}`
  return p
}

// Absolute (drive, posix or ~) paths as given; anything else joined to cwd,
// with . and .. segments folded.
function resolve(p: string, cwd: string, home: string | undefined): string {
  const expanded = normalizeDrive(expandHome(p, home))
  const abs = /^([A-Za-z]:\/|\/)/.test(expanded) ? expanded : `${normalizeDrive(cwd)}/${expanded}`
  const out: string[] = []
  for (const seg of abs.split('/')) {
    if (seg === '.' || (seg === '' && out.length > 0)) continue
    if (seg === '..') {
      if (out.length > 1) out.pop()
    } else out.push(seg)
  }
  return normalizeDrive(out.join('/') || '/')
}

function cdTarget(line: string, cwd: string, home: string | undefined): string | undefined {
  const m = CD.exec(line)
  const target = m ? word(m, 1) : undefined
  return target === undefined ? undefined : resolve(target, cwd, home)
}

function lastDirFlag(text: string): string | undefined {
  let found: string | undefined
  for (const m of text.matchAll(GIT_DIR)) found = word(m, 1)
  return found
}

export type Wrapper = { pattern?: RegExp; error?: string }

// Empty means no wrapper; an invalid pattern gates nothing and is reported.
export function compileWrapper(source: unknown): Wrapper {
  if (typeof source !== 'string' || source.trim() === '') return {}
  try {
    return { pattern: new RegExp(source) }
  } catch (err) {
    return { error: `sentinel: commitWrapper pattern ${JSON.stringify(source)} is not a valid regular expression (${err instanceof Error ? err.message : String(err)}); no wrapper commit is gated.` }
  }
}

// `wrapper`, the user's commitWrapper pattern, marks a line that commits
// through a script; its repository comes from the script's own -C flag.
export function classify(command: string, cwd: string, home: string | undefined, wrapper?: RegExp): Classified {
  const joined = command.replace(/\\\r?\n/g, ' ')
  const lines = joined.split(/\r?\n/)

  for (const line of lines) {
    if (wrapper?.test(line)) {
      const dir = WRAPPER_DIR.exec(line)
      const fromFlag = dir ? word(dir, 1) : undefined
      return { kind: 'wrapper-commit', repo: fromFlag !== undefined ? resolve(fromFlag, cwd, home) : (cdTarget(line, cwd, home) ?? cwd) }
    }
    const commit = GIT_COMMIT.exec(line)
    if (commit) {
      const fromFlag = lastDirFlag(commit[0])
      return { kind: 'commit', repo: fromFlag !== undefined ? resolve(fromFlag, cwd, home) : (cdTarget(line, cwd, home) ?? cwd) }
    }
  }

  if (VCS.test(joined)) return { kind: 'vcs' }

  const anchor = cdTarget(lines[0] ?? '', cwd, home) ?? cwd
  const paths = joined
    .replace(/\\/g, '/')
    .replace(NOT_PATH, ' ')
    .split(/\s+/)
    .filter(w => /^([A-Za-z]:\/|\/)/.test(w))
    .map(normalizeDrive)
  return { kind: 'other', anchor, paths }
}

async function repoOf(host: Host, start: string): Promise<string | undefined> {
  let d = normalizeDrive(start)
  for (let i = 0; i < MAX_WALK && d !== ''; i++) {
    if (await host.exists(`${d}/.git`)) return d
    const cut = d.lastIndexOf('/')
    if (cut <= 0 || d.endsWith(':/')) return undefined
    d = d.slice(0, cut)
    if (/^[A-Za-z]:$/.test(d)) d += '/'
  }
  return undefined
}

export async function findRoots(host: Host, anchor: string, paths: readonly string[], fallback?: string): Promise<string[]> {
  const roots: string[] = []
  const add = (r: string | undefined) => {
    if (r !== undefined && !roots.includes(r)) roots.push(r)
  }
  add(await repoOf(host, anchor))
  if (roots.length === 0 && fallback !== undefined) add(await repoOf(host, fallback))
  let probes = 0
  for (const p of paths) {
    if (roots.length >= MAX_ROOTS || probes >= MAX_PATH_PROBES) break
    probes++
    add(await repoOf(host, p))
  }
  return roots
}
