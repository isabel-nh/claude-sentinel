import { resolvePath } from './command.ts'
import type { Host } from './host.ts'
import { carriesSentinel, mapLimit, resolveLoose } from './scan.ts'
import type { Table } from './types.ts'

// One `git add` / `git stage` the command runs, in the directory it runs in.
export type StageCall = { repo: string; args: string[] }

const WORD = `(?:"([^"]*)"|'([^']*)'|([^\\s;&|)}]+))`
const WORDS = new RegExp(WORD, 'g')
const CD = new RegExp(`^[({\\s]*(?:cd|pushd)\\s+(?:--\\s+)?${WORD}[)}\\s]*$`)
const GIT_STAGE = new RegExp(`^[({\\s]*git((?:\\s+(?:-C\\s+${WORD}|-c\\s+\\S+|--?[A-Za-z][\\w-]*(?:=\\S+)?))*)\\s+(?:add|stage)(?=\\s|$)(.*)$`)
const DIR_FLAG = new RegExp(`-C\\s+${WORD}`, 'g')
// Arguments the dry run cannot reproduce: interactive staging, and words the
// shell would expand first.
const OPAQUE = /[$`<>*?[\]]|(?:^|\s)(?:-p|--patch|-i|--interactive|-e|--edit|-n|--dry-run|--pathspec-from-file(?:=\S*)?)(?=\s|$)/

const MAX_FILES = 2000
const CONCURRENCY = 4

const wordAt = (m: RegExpExecArray | RegExpMatchArray, at: number) => m[at] ?? m[at + 1] ?? m[at + 2]

// The staging calls a command makes, each in the directory a preceding `cd`
// or its own `-C` names. A call whose arguments the shell would rewrite is
// left out: the post-command unstage and the pre-commit hook still cover it.
export function stageCalls(command: string, cwd: string, home: string | undefined): StageCall[] {
  const calls: StageCall[] = []
  let dir = cwd
  for (const segment of command.replace(/\\\r?\n/g, ' ').split(/&&|\|\||[;|\r\n]/)) {
    const cd = CD.exec(segment)
    if (cd) {
      const target = wordAt(cd, 1)
      if (target !== undefined) dir = resolvePath(target, dir, home)
      continue
    }
    const m = GIT_STAGE.exec(segment)
    if (!m) continue
    const rest = m[5] ?? ''
    if (OPAQUE.test(rest)) continue
    let repo = dir
    for (const d of (m[1] ?? '').matchAll(DIR_FLAG)) {
      const target = wordAt(d, 1)
      if (target !== undefined) repo = resolvePath(target, repo, home)
    }
    const args = [...rest.matchAll(WORDS)].map(w => wordAt(w, 1)!).filter(a => a !== undefined)
    calls.push({ repo, args })
  }
  return calls
}

// Files the call would stage that carry a sentinel in the working tree,
// relative to the call's directory. undefined: the dry run failed, so the
// command is left to fail (or be caught) on its own.
export async function stagingSentinels(host: Host, call: StageCall, table: Table): Promise<string[] | undefined> {
  const dry = await host.git(['add', '--dry-run', ...call.args], call.repo)
  if (dry.exitCode !== 0) return undefined
  const paths = dry.stdout
    .split(/\r?\n/)
    .map(l => /^add '(.*)'$/.exec(l.trim())?.[1])
    .filter((p): p is string => p !== undefined)
  if (paths.length > MAX_FILES) return undefined
  const hits = await mapLimit(paths, CONCURRENCY, async p => {
    const read = await host.readFile(`${call.repo.replace(/\/$/, '')}/${p}`)
    return 'bytes' in read && carriesSentinel(read.bytes, resolveLoose(table, p) !== undefined)
  })
  return paths.filter((_, i) => hits[i])
}

export function stagingDenied(paths: readonly string[]): string {
  return `Staging blocked: sentinel review lines still present in:\n${paths.map(p => `  ${p}\n`).join('')}Stage only files a person has reviewed. The sentinel line is removed by hand after review.`
}
