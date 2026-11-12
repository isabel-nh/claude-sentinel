import { normalizeDrive } from './command.ts'
import type { Host } from './host.ts'
import { MARKER, TAIL } from './rules.ts'
import { MAX_LINES } from './styles.ts'
import type { Table } from './types.ts'

// Every client-side hook git runs from the hooks directory. Pointing
// core.hooksPath at the shim directory would otherwise silence a repository's
// own hooks (husky, lint-staged), so each shim hands over to the original.
export const HOOK_NAMES: readonly string[] = [
  'applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-commit', 'pre-merge-commit',
  'prepare-commit-msg', 'commit-msg', 'post-commit', 'pre-rebase', 'post-checkout', 'post-merge',
  'pre-push', 'pre-auto-gc', 'post-rewrite', 'sendemail-validate', 'reference-transaction',
  'push-to-checkout', 'post-index-change',
]

export const SCAN_NAME = 'sentinel-scan'

export type HookPaths = { dir: string; env: string }

export function hookPaths(home: string): HookPaths {
  const base = `${normalizeDrive(home)}/.claude/sentinel`
  return { dir: `${base}/git-hooks`, env: `${base}/git-env` }
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

// The marker is split across two shell words so the generated script never
// holds it whole, as rules.ts does for the mod's own source.
const splitWords = (s: string) => {
  const cut = s.indexOf(' ') + 1
  return `${quote(s.slice(0, cut))}${quote(s.slice(cut))}`
}

const globChar = (c: string) => (/[A-Za-z]/.test(c) ? `[${c.toLowerCase()}${c.toUpperCase()}]` : /[0-9._-]/.test(c) ? c : `\\${c}`)
const glob = (s: string) => [...s].map(globChar).join('')

// Case-blind `case` patterns for the configured types: `.ext` keys match a
// suffix, file-name keys a whole path component.
export function typedPatterns(table: Table): string[] {
  return [...table.keys()].flatMap(k => (k.startsWith('.') ? [`*${glob(k)}`] : [glob(k), `*/${glob(k)}`]))
}

// The review-origin rule (origin.ts) for the index being committed. The mod
// writes SENTINEL_BASELINE just before each agent command: `R top head` per
// repository it saw, `F top path blob` per changed covered path. Every line a
// staged covered file adds must be in the reviewed copy: that stored blob,
// else the path at the recorded HEAD. In a repository the mod did not see,
// the working-tree copy stands in, and must not be newer than the baseline
// file (written during the command).
const ORIGIN_CHECK: readonly string[] = [
  'origin=',
  'base=${SENTINEL_BASELINE:-}',
  'tmp=',
  'if [ -n "$base" ] && [ -r "$base" ] && tmp=$(mktemp -d 2>/dev/null); then',
  '  T=$(git rev-parse --show-toplevel 2>/dev/null | tr "[:upper:]" "[:lower:]")',
  '  export T',
  `  rline=$(awk -F'\\t' '$1=="R" && tolower($2)==ENVIRON["T"] {print "y\\t" $3; exit}' "$base")`,
  "  known=${rline%%$'\\t'*}",
  "  head0=${rline#*$'\\t'}",
  '  reviewed() {',
  '    b=',
  '    if [ -n "$known" ]; then',
  `      b=$(P="$1" awk -F'\\t' '$1=="F" && tolower($2)==ENVIRON["T"] && $3==ENVIRON["P"] {print $4; exit}' "$base")`,
  '      [ -z "$b" ] && [ -n "$head0" ] && b=$(git rev-parse -q --verify "$head0:$1" 2>/dev/null)',
  '    elif [ -f "$1" ]; then',
  '      b=$(git hash-object -w --no-filters -- "$1" 2>/dev/null)',
  '    fi',
  '    [ -n "$b" ] && printf \'%s\\n\' "$b"',
  '    return 0',
  '  }',
  "  deleted=$(git diff --cached --name-only -z --no-renames --diff-filter=D | tr '\\0' '\\n')",
  "  changed=$(git diff --cached --name-only -z --no-renames --diff-filter=ACMT | tr '\\0' '\\n')",
  '  while IFS= read -r p; do',
  '    [ -n "$p" ] && is_typed "$p" || continue',
  '    case "$hits" in *"  $p"$\'\\n\'*) continue ;; esac',
  '    if [ -z "$known" ] && [ "$p" -nt "$base" ]; then origin="$origin  $p (written during this command)"$\'\\n\'; continue; fi',
  '    new=$(git rev-parse -q --verify ":$p" 2>/dev/null) || continue',
  // An entry staged before the command and left as it was is not the command's doing.
  `    [ -n "$known" ] && [ "$(P="$p" awk -F'\\t' '$1=="I" && tolower($2)==ENVIRON["T"] && $3==ENVIRON["P"] {print $4; exit}' "$base")" = "$new" ] && continue`,
  '    allowed=$( { reviewed "$p"; while IFS= read -r q; do [ -n "$q" ] && reviewed "$q"; done <<< "$deleted"; } )',
  '    printf \'%s\\n\' "$allowed" | grep -qxF -- "$new" && continue',
  '    : > "$tmp/pool"',
  '    marked_copy=',
  '    while IFS= read -r b; do',
  '      [ -n "$b" ] && git cat-file blob "$b" > "$tmp/one" 2>/dev/null || continue',
  `      if head -n ${MAX_LINES} "$tmp/one" | grep -qF -- "$marker" || grep -qF -- "$full" "$tmp/one"; then marked_copy=1; fi`,
  '      cat "$tmp/one" >> "$tmp/pool"',
  "      printf '\\n' >> \"$tmp/pool\"",
  '    done <<< "$allowed"',
  '    if [ -n "$marked_copy" ]; then origin="$origin  $p (its working-tree copy still carries a sentinel)"$\'\\n\'; continue; fi',
  '    if [ "$(git diff --cached --numstat --no-renames -- "$p" | cut -f1)" = "-" ]; then origin="$origin  $p (binary, not a reviewed copy)"$\'\\n\'; continue; fi',
  "    git diff --cached -U0 --no-color --no-ext-diff --no-textconv --no-renames -- \"$p\" | awk '/^diff /{h=0} /^@@/{h=1; next} h && /^\\+/{print substr($0, 2)}' > \"$tmp/added\"",
  // Line endings are not compared: the reviewed copy is stored unfiltered, the staged blob normalized.
  "    awk '{sub(/\\r$/, \"\")} FILENAME==ARGV[1] {s[$0]=1; next} !($0 in s) {bad=1; exit} END {exit bad}' \"$tmp/pool\" \"$tmp/added\" || origin=\"$origin  $p\"$'\\n'",
  '  done <<< "$changed"',
  '  rm -rf "$tmp"',
  'fi',
]

// The pre-commit check, run by git against the index it is about to commit:
// the same rule as scan.ts carriesSentinel, for text blobs.
export function scanScript(table: Table): string {
  const patterns = typedPatterns(table)
  const typed = patterns.length === 0 ? 'is_typed() { return 1; }' : `is_typed() { case $1 in ${patterns.join('|')}) return 0 ;; esac; return 1; }`
  return [
    '#!/usr/bin/env bash',
    '# claude-sentinel pre-commit scan. Generated by the sentinel mod each session; edits are overwritten.',
    'export GIT_LITERAL_PATHSPECS=1',
    `marker=${splitWords(MARKER)}`,
    `full=${splitWords(TAIL)}`,
    typed,
    "staged=$(git diff --cached --name-only -z --diff-filter=ACMR | tr '\\0' '\\n')",
    '[ -n "$staged" ] || exit 0',
    "marked=$(printf '%s\\n' \"$staged\" | tr '\\n' '\\0' | xargs -0 git grep --cached --full-name -I -l -z -F -e \"$marker\" -- 2>/dev/null | tr '\\0' '\\n')",
    'hits=',
    'while IFS= read -r p; do',
    '  [ -n "$p" ] || continue',
    `  if git show ":$p" 2>/dev/null | head -n ${MAX_LINES} | grep -qF -- "$marker"; then hits="$hits  $p"$'\\n'`,
    '  elif is_typed "$p" && git show ":$p" 2>/dev/null | grep -qF -- "$full"; then hits="$hits  $p"$\'\\n\'',
    '  fi',
    'done <<< "$marked"',
    '# A clean blob whose working-tree copy carries the sentinel: a clean filter',
    '# or hand-built index entry took the line out on the way in. Hooks run at the top.',
    'while IFS= read -r p; do',
    '  [ -n "$p" ] && [ -f "$p" ] || continue',
    '  case "$hits" in *"  $p"$\'\\n\'*) continue ;; esac',
    `  if head -n ${MAX_LINES} -- "$p" 2>/dev/null | grep -qF -- "$marker"; then hits="$hits  $p"$'\\n'`,
    '  elif is_typed "$p" && grep -qF -- "$full" "$p" 2>/dev/null; then hits="$hits  $p"$\'\\n\'',
    '  fi',
    'done <<< "$staged"',
    ...ORIGIN_CHECK,
    '[ -z "$hits$origin" ] && exit 0',
    "[ -n \"$hits\" ] && printf 'Commit blocked: sentinel review lines still present in staged files:\\n%sRemove the sentinel lines after reviewing, then retry.\\n' \"$hits\" >&2",
    "[ -n \"$origin\" ] && printf 'Commit blocked: staged content adds lines that no reviewed working-tree copy holds:\\n%sWrite the change into the working tree, where it gets a sentinel for review, and stage it after review.\\n' \"$origin\" >&2",
    'exit 1',
    '',
  ].join('\n')
}

// One script, copied under every hook name: pre-commit runs the scan first;
// every hook then restores the caller's git config and runs the repository's
// own hook of that name, if it has one. reference-transaction also records
// each committed ref update of an agent command in the baseline's moves file
// (`ref old new common top` per line): rollback judges only those, so a commit
// a person makes from a terminal meanwhile is left alone. A local push updates
// the target in a receive-pack child that git starts without the hook config,
// so pre-push records the target's refs from the pushing side.
export function shimScript(): string {
  return [
    '#!/bin/sh',
    '# claude-sentinel git hook shim. Generated by the sentinel mod each session; edits are overwritten.',
    'name=${0##*/}',
    'here=$(cd "$(dirname "$0")" && pwd)',
    `if [ "$name" = pre-commit ]; then "$here/${SCAN_NAME}" || exit 1; fi`,
    'piped=',
    'moves=${SENTINEL_BASELINE:+$SENTINEL_BASELINE.moves}',
    '[ -n "$moves" ] && [ -f "$moves" ] || moves=',
    'case $name in reference-transaction|pre-push) piped=$(cat; echo .) ;; esac',
    'if [ "$name" = reference-transaction ] && [ "$1" = committed ] && [ -n "$moves" ]; then',
    '  c=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)',
    '  t=$(git rev-parse --show-toplevel 2>/dev/null)',
    `  printf '%s' "\${piped%.}" | while read -r o n r; do [ -n "$r" ] && printf '%s\\t%s\\t%s\\t%s\\t%s\\n' "$r" "$o" "$n" "$c" "$t"; done >> "$moves"`,
    'fi',
    'if [ "$name" = pre-push ] && [ -n "$moves" ]; then',
    '  d=${2#file://}',
    '  c=$( (unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY; git -C "$d" rev-parse --path-format=absolute --git-common-dir) 2>/dev/null)',
    '  t=$( (unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY; git -C "$d" rev-parse --show-toplevel) 2>/dev/null)',
    `  [ -n "$c" ] && printf '%s' "\${piped%.}" | while read -r lr ls rr rs; do [ -n "$rr" ] && printf '%s\\t%s\\t%s\\t%s\\t%s\\n' "$rr" "$rs" "$ls" "$c" "$t"; done >> "$moves"`,
    'fi',
    // An index write: an `index - - common path` line, and the staged entries
    // as this write left them, in a file named for the index path.
    'if [ "$name" = post-index-change ] && [ -n "$moves" ]; then',
    '  c=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)',
    `  i=$(git rev-parse --path-format=absolute --git-path index 2>/dev/null | tr '[:upper:]' '[:lower:]')`,
    '  if [ -n "$i" ]; then',
    `    printf 'index\\t-\\t-\\t%s\\t%s\\n' "$c" "$i" >> "$moves"`,
    `    k=$(printf '%s' "$i" | cksum | cut -d' ' -f1)`,
    '    git diff --cached --raw -z --no-abbrev --no-color --no-ext-diff --no-textconv --no-renames > "$moves.idx.$k" 2>/dev/null',
    '  fi',
    'fi',
    'if [ -n "${SENTINEL_GIT_CONFIG_COUNT+x}" ]; then GIT_CONFIG_COUNT=$SENTINEL_GIT_CONFIG_COUNT; export GIT_CONFIG_COUNT; fi',
    'if [ -n "${SENTINEL_GIT_CONFIG_PARAMETERS+x}" ]; then',
    '  if [ -n "$SENTINEL_GIT_CONFIG_PARAMETERS" ]; then GIT_CONFIG_PARAMETERS=$SENTINEL_GIT_CONFIG_PARAMETERS; export GIT_CONFIG_PARAMETERS; else unset GIT_CONFIG_PARAMETERS; fi',
    'fi',
    'unset SENTINEL_HOOKS_DIR SENTINEL_GIT_CONFIG_COUNT SENTINEL_GIT_CONFIG_PARAMETERS',
    'own=$(git rev-parse --git-path hooks 2>/dev/null) || exit 0',
    '[ -n "$own" ] && [ -d "$own" ] || exit 0',
    '[ "$(cd "$own" && pwd)" = "$here" ] && exit 0',
    '[ -f "$own/$name" ] && [ -x "$own/$name" ] || exit 0',
    // The repository's own hook gets the input this shim read.
    `case $name in reference-transaction|pre-push) printf '%s' "\${piped%.}" | "$own/$name" "$@"; exit $? ;; esac`,
    'exec "$own/$name" "$@"',
    'exit 0',
    '',
  ].join('\n')
}

// Sourced at the top of each Bash command: appends core.hooksPath=<dir> to the
// command's environment config (GIT_CONFIG_COUNT), which outranks every config
// file, so git itself runs the gate whatever the repository or working directory.
export function envScript(dir: string): string {
  return [
    '# claude-sentinel: routes git hooks through the sentinel shims for one Bash command.',
    'if [ -z "${SENTINEL_HOOKS_DIR:-}" ]; then',
    '  SENTINEL_GIT_CONFIG_COUNT=${GIT_CONFIG_COUNT:-0}',
    '  export SENTINEL_GIT_CONFIG_COUNT',
    '  export "GIT_CONFIG_KEY_${SENTINEL_GIT_CONFIG_COUNT}=core.hooksPath"',
    `  export "GIT_CONFIG_VALUE_\${SENTINEL_GIT_CONFIG_COUNT}=${dir.replace(/["$`\\]/g, '\\$&')}"`,
    '  GIT_CONFIG_COUNT=$((SENTINEL_GIT_CONFIG_COUNT + 1))',
    `  SENTINEL_HOOKS_DIR=${quote(dir)}`,
    '  export GIT_CONFIG_COUNT SENTINEL_HOOKS_DIR',
    'fi',
    '',
  ].join('\n')
}

// `baseline`: the review-origin file for this command (origin.ts baselineFile).
export function withHooks(command: string, env: string, baseline?: string): string {
  const origin = baseline === undefined ? '' : `export SENTINEL_BASELINE=${quote(baseline)}\n`
  return `. ${quote(env)}\n${origin}${command}`
}

export function baselinePath(home: string, id: string): string {
  return `${normalizeDrive(home)}/.claude/sentinel/baselines/${id}.tsv`
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// A command that already starts with the prologue withHooks writes: auto mode
// asks for a rewritten command to be sent again exactly as rewritten, so the
// mod has to recognize its own prologue and leave it in place. Only the exact
// env line and a baseline id the mod could have generated count.
export function splitPrologue(command: string, env: string, home: string): { body: string; baselineId?: string } | undefined {
  const envLine = `. ${quote(env)}\n`
  if (!command.startsWith(envLine)) return undefined
  const rest = command.slice(envLine.length)
  const dir = escapeRe(`${normalizeDrive(home)}/.claude/sentinel/baselines/`)
  const m = new RegExp(`^export SENTINEL_BASELINE='${dir}([0-9]+-[a-z0-9]{1,8})\\.tsv'\\n`).exec(rest)
  return m ? { body: rest.slice(m[0].length), baselineId: m[1]! } : { body: rest }
}

// Variables the mod sets in its own process environment, which every Bash
// child inherits: the hooks then apply without a line in front of the command,
// which auto mode would have to review a second time. `$.env` takes literal
// names, hence the closed set.
export type EnvName = 'GIT_CONFIG_PARAMETERS' | 'SENTINEL_GIT_CONFIG_PARAMETERS' | 'SENTINEL_HOOKS_DIR' | 'SENTINEL_BASELINE'
export type ProcessEnv = { get(name: EnvName): Promise<string | undefined>; set(name: EnvName, value: string | undefined): Promise<boolean> }

// One `git -c` entry in GIT_CONFIG_PARAMETERS form.
export const hooksParameter = (dir: string) => `'core.hooksPath'=${quote(dir)}`

// Appends core.hooksPath=<dir> to GIT_CONFIG_PARAMETERS, keeping what was there
// for the shims to restore. false: the engine refused a write; the prologue
// carries the hooks instead.
export async function routeProcessHooks(env: ProcessEnv, dir: string): Promise<boolean> {
  if ((await env.get('SENTINEL_HOOKS_DIR')) === dir) return true
  const prior = (await env.get('GIT_CONFIG_PARAMETERS')) ?? ''
  const own = hooksParameter(dir)
  if (!(await env.set('SENTINEL_GIT_CONFIG_PARAMETERS', prior))) return false
  if (!(await env.set('GIT_CONFIG_PARAMETERS', prior === '' ? own : `${prior} ${own}`))) return false
  if (await env.set('SENTINEL_HOOKS_DIR', dir)) return true
  await env.set('GIT_CONFIG_PARAMETERS', prior === '' ? undefined : prior)
  return false
}

export type Install = HookPaths | { failed: string }

export async function installHooks(host: Host, table: Table, at?: HookPaths): Promise<Install> {
  if (host.gitBash === undefined) return { failed: 'Git Bash not found' }
  const paths = at ?? (host.home === undefined ? undefined : hookPaths(host.home))
  if (paths === undefined) return { failed: '$HOME not found' }
  const { dir, env } = paths
  if ((await host.bash('mkdir -p "$1"', [dir])).exitCode !== 0) return { failed: `could not create ${dir}` }
  const files: [string, string][] = [
    [`${dir}/${SCAN_NAME}`, scanScript(table)],
    ...HOOK_NAMES.map((n): [string, string] => [`${dir}/${n}`, shimScript()]),
    [env, envScript(dir)],
  ]
  for (const [path, text] of files) if (!(await host.writeText(path, text))) return { failed: `could not write ${path}` }
  if ((await host.bash('chmod +x "$1"/*', [dir])).exitCode !== 0) return { failed: `could not mark ${dir} executable` }
  return { dir, env }
}
