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
const CD_HEAD = /^\s*[({]?\s*(?:cd|pushd)\s+(?:--\s+)?/
// git, any global options (-C dir, -c k=v, --no-pager, --git-dir=x), then
// commit; preceded by anything that is not part of a longer word, so
// subshells and `bash -c "git commit"` count.
const GIT_OPTION = `(?:-C\\s+${WORD}|-c\\s+\\S+|--?[A-Za-z][\\w-]*(?:=\\S+)?)`
const GIT_COMMIT = new RegExp(`(?:^|[^\\w./-])git\\s+(?:${GIT_OPTION}\\s+)*commit(?:[\\s"')]|$)`)
const GIT_DIR = new RegExp(`\\s-C\\s+${WORD}`, 'g')
const WRAPPER_DIR = new RegExp(`\\s-C\\s+${WORD}`)
// A whole segment that is one VCS call, or a cd/pushd ahead of one.
const VCS_SEGMENT = new RegExp(`^[({\\s]*git\\s+(-C\\s+\\S+\\s+)?(${VCS_VERBS.join('|')})(\\s|$)`)
const CD_SEGMENT = /^[({\s]*(?:cd|pushd)(\s|$)/
const SEPARATORS = /&&|\|\||[;|&\r\n]/
// Plumbing that writes commits, trees or refs without running the commit
// hooks, called directly or through an inline alias.
const PLUMBING_VERBS = 'commit-tree|update-ref|mktree|fast-import|stash\\s+(?:store|create)'
// The verb may end a command substitution or a list: `$(git stash create)`.
const VERB_END = '(?=[\\s);&|`]|$)'
const PLUMBING = new RegExp(`(?:^|[^\\w-])git(?:\\.exe)?\\s+(?:(?:-C\\s+\\S+|-c\\s+\\S+|--?[A-Za-z][\\w-]*(?:=\\S+)?)\\s+)*(${PLUMBING_VERBS})${VERB_END}`, 'i')
const PLUMBING_ALIAS = new RegExp(`alias\\.[\\w-]+=!?\\s*(?:git\\s+)?(${PLUMBING_VERBS})${VERB_END}`, 'i')
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
export function resolvePath(p: string, cwd: string, home: string | undefined): string {
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

// One shell word from the start of s, with adjacent quoted and bare parts
// joined as the shell joins them (`a''b`, `"a "b`). Backslashes stay literal,
// as Windows paths are written. undefined for an unterminated quote.
export function readWord(s: string): string | undefined {
  let out = ''
  let i = 0
  while (i < s.length) {
    const c = s[i]!
    if (/[\s;&|)]/.test(c)) break
    if (c === "'" || c === '"') {
      const end = s.indexOf(c, i + 1)
      if (end < 0) return undefined
      out += s.slice(i + 1, end)
      i = end + 1
    } else {
      out += c
      i++
    }
  }
  return out === '' ? undefined : out
}

function cdTarget(line: string, cwd: string, home: string | undefined): string | undefined {
  const m = CD_HEAD.exec(line)
  const target = m ? readWord(line.slice(m[0].length)) : undefined
  return target === undefined ? undefined : resolvePath(target, cwd, home)
}

// The line up to an unquoted `#` that starts a word.
export function stripComment(line: string): string {
  let quote: string | undefined
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (quote !== undefined) {
      if (c === quote) quote = undefined
    } else if (c === "'" || c === '"') quote = c
    else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]!))) return line.slice(0, i)
  }
  return line
}

// Quotes and escapes removed, so `com''mit-tree` reads as `commit-tree`.
const dequote = (s: string) => s.replace(/\\(?=\S)/g, '').replace(/['"]/g, '')

// A command is left alone as VCS only when every segment is a VCS call or a
// cd/pushd: a verb in a comment, or chained after a write, does not count.
function isVcsOnly(joined: string): boolean {
  const segments = joined
    .split(/\r?\n/)
    .map(stripComment)
    .flatMap(l => l.split(SEPARATORS))
    .map(s => s.trim())
    .filter(s => s !== '')
  return segments.some(s => VCS_SEGMENT.test(s)) && segments.every(s => VCS_SEGMENT.test(s) || CD_SEGMENT.test(s))
}

// The plumbing verb a command runs, if any.
export function plumbingCall(command: string): string | undefined {
  const text = dequote(
    command
      .replace(/\\\r?\n/g, ' ')
      .split(/\r?\n/)
      .map(stripComment)
      .join('\n'),
  )
  for (const line of text.split('\n')) {
    const m = PLUMBING.exec(line) ?? PLUMBING_ALIAS.exec(line)
    if (m) return m[1]!.toLowerCase().replace(/\s+/g, ' ')
  }
  return undefined
}

export function plumbingDenied(verb: string): string {
  return `sentinel: denied: git ${verb} writes commits, trees or refs without the commit gate. Stage files and use git commit; the gate passes once a person has removed the sentinel lines.`
}

function lastDirFlag(text: string): string | undefined {
  let found: string | undefined
  for (const m of text.matchAll(GIT_DIR)) found = word(m, 1)
  return found
}

const QUOTED = /"(?:[^"\\]|\\.)*"|'[^']*'/g
const NO_VERIFY = /(?:^|\s)(?:--no-verify|-[A-Za-z]*n[A-Za-z]*)(?=\s|$)/
const HOOKS_OVERRIDE = /(?:-c\s*|--config-env[=\s]\s*)["']?core\.hookspath/i
const ENV_OVERRIDE = /\b(?:GIT_CONFIG_(?:COUNT|KEY_|VALUE_|PARAMETERS)|SENTINEL_(?:HOOKS_DIR|GIT_CONFIG_COUNT|BASELINE))|\benv\s+(?:-[A-Za-z]*i\b|--ignore-environment)/
// The shims, the env file and the per-command baselines.
const OWN_FILES = /\.claude[\\/]+sentinel(?:[\\/]|\b)/i

// What would keep git from running the sentinel pre-commit hook: --no-verify
// (or -n) on a commit, a command-line core.hooksPath, which outranks the
// environment config the mod sets, or a rewrite of that environment.
export function hookBypass(command: string): string | undefined {
  const joined = command.replace(/\\\r?\n/g, ' ')
  for (const line of joined.split(/\r?\n/)) {
    const commit = GIT_COMMIT.exec(line)
    if (commit && NO_VERIFY.test(line.slice(commit.index + commit[0].length).split(/&&|\|\||[;|]/)[0]!.replace(QUOTED, ' '))) return 'skipping hooks on a commit (--no-verify, -n)'
  }
  if (HOOKS_OVERRIDE.test(joined)) return 'overriding core.hooksPath on the command line'
  if (ENV_OVERRIDE.test(joined)) return 'changing the git config environment the sentinel hook relies on'
  if (OWN_FILES.test(joined)) return "touching the sentinel's hook and baseline files"
  return undefined
}

export function bypassDenied(what: string): string {
  return `sentinel: denied: ${what} would skip the sentinel pre-commit hook. Run the command without it; the hook passes once a person has removed the sentinel lines.`
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
      return { kind: 'wrapper-commit', repo: fromFlag !== undefined ? resolvePath(fromFlag, cwd, home) : (cdTarget(line, cwd, home) ?? cwd) }
    }
    const commit = GIT_COMMIT.exec(line)
    if (commit) {
      const fromFlag = lastDirFlag(commit[0])
      return { kind: 'commit', repo: fromFlag !== undefined ? resolvePath(fromFlag, cwd, home) : (cdTarget(line, cwd, home) ?? cwd) }
    }
  }

  if (isVcsOnly(joined)) return { kind: 'vcs' }

  const anchor = cdTarget(lines[0] ?? '', cwd, home) ?? cwd
  // As written, and again with quotes joined (`C:/a/b''c` is C:/a/bc).
  const paths = [...new Set([...absolutePaths(joined), ...absolutePaths(joined.replace(/['"]/g, ''))])]
  return { kind: 'other', anchor, paths }
}

function absolutePaths(text: string): string[] {
  return text
    .replace(/\\/g, '/')
    .replace(NOT_PATH, ' ')
    .split(/\s+/)
    .filter(w => /^([A-Za-z]:\/|\/)/.test(w))
    .map(normalizeDrive)
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
