import { normalizeDrive } from './command.ts'
import { hashAll, parseStatusZ } from './detect.ts'
import type { Host } from './host.ts'
import { isPruned } from './rules.ts'
import { encodeText } from './encoding.ts'
import { carriesSentinel, mapLimit, resolveLoose } from './scan.ts'
import type { Table } from './types.ts'

// The review-origin rule. A covered file's new content may only add lines that
// a person has already seen: lines of the working-tree copy as it stood before
// the agent's command, in a copy that no longer carries a sentinel. Content
// built anywhere else (a scratch file, a hand-made index entry, a commit object)
// fails, whatever git command carries it in.

// One repository as it stood before an agent command.
export type Baseline = {
  root: string
  // `git rev-parse --show-toplevel`, as the pre-commit hook will see it.
  top: string
  common: string
  head: string | undefined
  // Covered paths that differed from HEAD in the index or the working tree,
  // mapped to a stored blob of their working-tree copy.
  files: ReadonlyMap<string, string>
  // Local branches, and the HEAD of each detached worktree as `HEAD@<path>`.
  refs: ReadonlyMap<string, string>
}

export type RefState = { refs: Map<string, string>; worktrees: Map<string, string | undefined> }

const MAX_FILES = 2000
const MAX_NEW_COMMITS = 200
const CONCURRENCY = 4
const NULL_SHA = /^0+$/

const DIFF = ['--no-color', '--no-ext-diff', '--no-textconv', '--no-renames']

async function rev(host: Host, repo: string, spec: string): Promise<string | undefined> {
  const r = await host.git(['rev-parse', '-q', '--verify', spec], repo)
  const sha = r.exitCode === 0 ? r.stdout.trim() : ''
  return /^[0-9a-f]{40,64}$/.test(sha) ? sha : undefined
}

export async function refState(host: Host, root: string): Promise<RefState> {
  const refs = new Map<string, string>()
  const worktrees = new Map<string, string | undefined>()
  const r = await host.git(['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads'], root)
  if (r.exitCode === 0)
    for (const line of r.stdout.split(/\r?\n/)) {
      const m = /^([0-9a-f]{40,64}) (\S+)$/.exec(line)
      if (m) refs.set(m[2]!, m[1]!)
    }
  const w = await host.git(['worktree', 'list', '--porcelain'], root)
  if (w.exitCode === 0)
    for (const block of w.stdout.split(/\r?\n\r?\n/)) {
      const path = /^worktree (.+)$/m.exec(block)?.[1]
      if (path === undefined || /^bare$/m.test(block)) continue
      const wt = normalizeDrive(path.trim())
      const branch = /^branch (\S+)$/m.exec(block)?.[1]
      const sha = /^HEAD ([0-9a-f]{40,64})$/m.exec(block)?.[1]
      worktrees.set(wt, branch)
      if (branch === undefined && sha !== undefined) refs.set(`HEAD@${wt}`, sha)
    }
  return { refs, worktrees }
}

// undefined: git failed or the repository has too many changed files; the
// command then runs with the sentinel checks alone.
export async function captureBaseline(host: Host, root: string, table: Table): Promise<Baseline | undefined> {
  const where = await host.git(['rev-parse', '--show-toplevel', '--path-format=absolute', '--git-common-dir'], root)
  const [top, common] = where.exitCode === 0 ? where.stdout.split(/\r?\n/).map(l => l.trim()) : []
  const status = await host.git(['status', '--porcelain', '-uall', '-z'], root)
  if (status.exitCode !== 0) return undefined
  const paths = parseStatusZ(status.stdout)
    .filter(e => (e.x !== ' ' || e.y !== ' ') && e.y !== 'D' && !isPruned(e.path) && resolveLoose(table, e.path) !== undefined)
    .map(e => e.path)
  if (paths.length > MAX_FILES) return undefined
  const blobs = await hashAll(host, root, paths, true)
  if (blobs === undefined) return undefined
  const { refs } = await refState(host, root)
  return { root, top: normalizeDrive(top || root), common: normalizeDrive(common || root), head: await rev(host, root, 'HEAD'), files: new Map(paths.map((p, i) => [p, blobs[i]!])), refs }
}

// The file the pre-commit hook reads: `R top head` per repository, `F top path blob`
// per changed covered path. Paths a line cannot hold are left out, which only
// makes the hook stricter for them.
export function baselineFile(baselines: readonly Baseline[]): string {
  const out: string[] = []
  for (const b of baselines) {
    out.push(`R\t${b.top}\t${b.head ?? ''}`)
    for (const [path, blob] of b.files) if (!/[\t\r\n]/.test(path)) out.push(`F\t${b.top}\t${path}\t${blob}`)
  }
  return `${out.join('\n')}\n`
}

const lines = (text: string) => {
  const all = text.split('\n')
  if (all[all.length - 1] === '') all.pop()
  return all
}

type Blobs = Map<string, string | undefined>

async function blobText(host: Host, repo: string, sha: string, cache: Blobs): Promise<string | undefined> {
  if (!cache.has(sha)) {
    const r = await host.git(['cat-file', 'blob', sha], repo)
    cache.set(sha, r.exitCode === 0 ? r.stdout : undefined)
  }
  return cache.get(sha)
}

// `+` lines of a zero-context diff, hunk headers and the `+++` header skipped.
export function addedLines(diff: string): string[] {
  const out: string[] = []
  let inHunk = false
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) inHunk = true
    else if (inHunk && line.startsWith('+')) out.push(line.slice(1))
    else if (line.startsWith('diff ')) inHunk = false
  }
  return out
}

export type Change = { path: string; status: string; old?: string; new?: string }

// `--raw -z` output: ":<mode> <mode> <old> <new> <status>\0<path>\0".
export function parseRaw(out: string): Change[] {
  const fields = out.split('\u0000')
  const changes: Change[] = []
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const m = /^:\d+ \d+ ([0-9a-f]+) ([0-9a-f]+) ([A-Z])/.exec(fields[i]!.replace(/^\s+/, ''))
    if (!m) continue
    changes.push({ path: fields[i + 1]!, status: m[3]!, old: NULL_SHA.test(m[1]!) ? undefined : m[1], new: NULL_SHA.test(m[2]!) ? undefined : m[2] })
  }
  return changes
}

// Blobs of the reviewed copy of a path: its stored working-tree copy, else
// its content at HEAD when the command started.
async function reviewedBlobs(host: Host, repo: string, baselines: readonly Baseline[], path: string): Promise<string[]> {
  const out: string[] = []
  for (const b of baselines) {
    const stored = b.files.get(path)
    const blob = stored ?? (b.head === undefined ? undefined : await rev(host, repo, `${b.head}:${path}`))
    if (blob !== undefined && !out.includes(blob)) out.push(blob)
  }
  return out
}

// true: the change adds content that is not in a reviewed copy. `known` adds
// lines a merge brought from its other parents. undefined: a blob could not
// be read, and the caller lets the change through.
async function unreviewed(host: Host, repo: string, change: Change, reviewed: readonly string[], known: readonly string[], cache: Blobs): Promise<boolean | undefined> {
  if (change.new === undefined) return false
  const read = await Promise.all(reviewed.map(sha => blobText(host, repo, sha, cache)))
  const texts = read.filter((t): t is string => t !== undefined)
  if (texts.length < read.length) return undefined
  if (texts.some(t => carriesSentinel(encodeText(t, 'UTF-8'), true))) return true
  if (reviewed.includes(change.new) || known.includes(change.new)) return false
  const next = await blobText(host, repo, change.new, cache)
  if (next === undefined) return undefined
  const knownTexts = await Promise.all(known.map(sha => blobText(host, repo, sha, cache)))
  const pool = [...texts, ...knownTexts].filter((t): t is string => t !== undefined)
  // Binary content cannot be compared line by line: only an exact copy passes.
  if (next.includes('\u0000') || pool.some(t => t.includes('\u0000'))) return true
  let added: string[]
  if (change.old === undefined) added = lines(next)
  else {
    const d = await host.git(['diff', ...DIFF, '-U0', change.old, change.new], repo)
    if (d.exitCode !== 0 && d.exitCode !== 1) return undefined
    added = addedLines(d.stdout)
  }
  const seen = new Set(pool.flatMap(lines))
  return added.some(l => !seen.has(l))
}

// Covered paths in a change set whose new content fails the rule. A path
// deleted in the same set lends its reviewed lines, so a rename passes.
async function failing(host: Host, repo: string, changes: readonly Change[], baselines: readonly Baseline[], table: Table, known: (path: string) => Promise<string[]>, cache: Blobs): Promise<string[]> {
  const deleted = changes.filter(c => c.status === 'D').map(c => c.path)
  const lent = (await Promise.all(deleted.map(p => reviewedBlobs(host, repo, baselines, p)))).flat()
  const typed = changes.filter(c => c.new !== undefined && !isPruned(c.path) && resolveLoose(table, c.path) !== undefined)
  const hits = await mapLimit(typed, CONCURRENCY, async c => {
    const reviewed = [...(await reviewedBlobs(host, repo, baselines, c.path)), ...lent]
    return (await unreviewed(host, repo, c, reviewed, await known(c.path), cache)) === true
  })
  return typed.filter((_, i) => hits[i]).map(c => c.path)
}

// Staged covered paths, relative to the top, whose staged content fails the rule.
export async function stagedUnreviewed(host: Host, repo: string, baselines: readonly Baseline[], table: Table): Promise<string[] | undefined> {
  const r = await host.git(['diff', '--cached', '--raw', '-z', '--no-abbrev', ...DIFF], repo)
  if (r.exitCode !== 0) return undefined
  return failing(host, repo, parseRaw(r.stdout), baselines, table, async () => [], new Map())
}

export type Rollback = { ref: string; from: string; to: string | undefined; commits: string[]; paths: string[] }

// New commits on a tip: not reachable from any branch, worktree HEAD, remote
// or tag that existed before. The exclusions go through a file, as a
// repository may hold more refs than a command line does.
async function newCommits(host: Host, repo: string, tip: string, exclude: readonly string[], scratch: string): Promise<string[] | undefined> {
  if (!(await host.writeText(scratch, `${[tip, ...exclude.map(s => `^${s}`)].join('\n')}\n`))) return undefined
  const r = await host.bash(`git -C "$1" rev-list --max-count=${MAX_NEW_COMMITS + 1} --stdin < "$2"`, [repo, scratch])
  if (r.exitCode !== 0) return undefined
  const shas = r.stdout.split(/\r?\n/).filter(s => /^[0-9a-f]{40,64}$/.test(s))
  return shas.length > MAX_NEW_COMMITS ? undefined : shas
}

async function commitFailures(host: Host, repo: string, sha: string, baselines: readonly Baseline[], table: Table, cache: Blobs): Promise<string[]> {
  const parents = (await host.git(['rev-list', '--parents', '-n', '1', sha], repo)).stdout.trim().split(/\s+/).slice(1)
  const args = parents.length === 0 ? ['diff-tree', '--root', sha] : ['diff-tree', parents[0]!, sha]
  const r = await host.git([...args, '-r', '-z', '--no-abbrev', '--no-commit-id', '--no-renames'], repo)
  if (r.exitCode !== 0) return []
  const others = parents.slice(1)
  const known = async (path: string) => (await Promise.all(others.map(p => rev(host, repo, `${p}:${path}`)))).filter((b): b is string => b !== undefined)
  return failing(host, repo, parseRaw(r.stdout), baselines, table, known, cache)
}

const tipsOf = async (host: Host, repo: string, pattern: string) => {
  const r = await host.git(['for-each-ref', '--format=%(objectname)', pattern], repo)
  return r.exitCode === 0 ? r.stdout.split(/\r?\n/).filter(s => /^[0-9a-f]{40,64}$/.test(s)) : []
}

// Every branch or detached HEAD the command moved to a commit that fails the
// rule is put back: to its old value, or for a new ref to the first commit
// below the new ones (a ref no worktree has checked out is deleted instead).
// A checked-out ref moves with `reset --mixed`, so the content stays in the
// working tree for review. undefined: the audit could not run.
export async function rollBackUnreviewed(host: Host, baselines: readonly Baseline[], table: Table, scratch: string | undefined): Promise<Rollback[] | undefined> {
  if (host.gitBash === undefined || scratch === undefined) return undefined
  const groups = new Map<string, Baseline[]>()
  for (const b of baselines) groups.set(b.common, [...(groups.get(b.common) ?? []), b])
  const out: Rollback[] = []
  for (const group of groups.values()) {
    const repo = group[0]!.root
    const before = new Map(group.flatMap(b => [...b.refs]))
    const after = await refState(host, repo)
    const exclude = [...new Set([...before.values(), ...(await tipsOf(host, repo, 'refs/remotes')), ...(await tipsOf(host, repo, 'refs/tags'))])]
    const cache: Blobs = new Map()
    for (const [ref, tip] of after.refs) {
      const old = before.get(ref)
      if (old === tip) continue
      const fresh = await newCommits(host, repo, tip, exclude, scratch)
      if (fresh === undefined) return undefined
      const bad = new Map<string, string[]>()
      for (const sha of fresh) {
        const paths = await commitFailures(host, repo, sha, group, table, cache)
        if (paths.length > 0) bad.set(sha, paths)
      }
      if (bad.size === 0) continue
      let to = old
      if (to === undefined) {
        to = tip
        while (to !== undefined && fresh.includes(to)) to = await rev(host, repo, `${to}^`)
      }
      const checkedOut = ref.startsWith('HEAD@') ? ref.slice('HEAD@'.length) : [...after.worktrees].find(([, branch]) => branch === ref)?.[0]
      const done =
        checkedOut !== undefined && to !== undefined
          ? await host.git(['reset', '-q', '--mixed', to], checkedOut)
          : to === undefined || old === undefined
            ? await host.git(['update-ref', '-d', ref, tip], repo)
            : await host.git(['update-ref', ref, to, tip], repo)
      if (done.exitCode !== 0) return undefined
      out.push({ ref, from: tip, to: old === undefined && checkedOut === undefined ? undefined : to, commits: [...bad.keys()], paths: [...new Set([...bad.values()].flat())] })
    }
  }
  return out
}

const short = (sha: string) => sha.slice(0, 8)

export function rolledBack(r: Rollback): string {
  const target = r.to === undefined ? 'deleted it' : `moved it back to ${short(r.to)}`
  return `sentinel: ${r.ref} was moved to ${short(r.from)}, whose commit(s) ${r.commits.map(short).join(', ')} add lines to ${r.paths.join(', ')} that no reviewed working-tree copy holds; ${target}. Write changes into the working tree, where they get a sentinel for review.`
}

