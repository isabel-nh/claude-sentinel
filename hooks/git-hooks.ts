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
  // The mod deletes the baseline when its Bash call ends, which can be before a
  // backgrounded commit's scan finishes; the scan now reads a private copy
  // taken at start.
  'if [ -n "$base" ] && [ -r "$base" ] && tmp=$(mktemp -d 2>/dev/null); then',
  '  if cp -p -- "$base" "$tmp/base" 2>/dev/null; then base="$tmp/base"; else base=; rm -rf "$tmp"; fi',
  'else',
  '  base=',
  'fi',
  'if [ -n "$base" ]; then',
  ...String.raw`  T=$(git rev-parse --show-toplevel 2>/dev/null | tr "[:upper:]" "[:lower:]")
  export T
  rline=$(awk -F'\t' '$1=="R" && tolower($2)==ENVIRON["T"] {print "y\t" $3; exit}' "$base")
  IFS=$'\t' read -r known head0 <<< "$rline"
  for f in cand gone req ask res plan cpaths want dl blobs num diff; do : > "$tmp/$f"; done
  git diff --cached --raw -z --no-abbrev --no-renames --diff-filter=ACMTD 2>/dev/null | tr '\0' '\n' > "$tmp/raw"
  while IFS= read -r meta && IFS= read -r p; do
    read -r _ _ _ new st <<< "$meta"
    if [ "$st" = D ]; then printf '%s\n' "$p" >> "$tmp/gone"; printf '%s\n' "$p" >> "$tmp/req"; continue; fi
    [ -n "$p" ] && is_typed "$p" || continue
    case "$hits" in *"  $p"$'\n'*) continue ;; esac
    if [ -z "$known" ] && [ "$p" -nt "$base" ]; then printf 'w\t%s\t%s\n' "$new" "$p" >> "$tmp/cand"; continue; fi
    printf 'c\t%s\t%s\n' "$new" "$p" >> "$tmp/cand"
    printf '%s\n' "$p" >> "$tmp/req"
  done < "$tmp/raw"
  if [ -s "$tmp/cand" ]; then
    ask="$tmp/ask"
    if [ -n "$known" ]; then
      if [ -n "$head0" ]; then
        ask="$tmp/req"
        while IFS= read -r q; do printf '%s:%s\n' "$head0" "$q"; done < "$tmp/req" | git cat-file --batch-check > "$tmp/res" 2>/dev/null
      fi
    else
      while IFS= read -r q; do [ -f "$q" ] && printf '%s\n' "$q"; done < "$tmp/req" > "$tmp/ask"
      if [ -s "$tmp/ask" ] && ! git hash-object -w --no-filters --stdin-paths < "$tmp/ask" > "$tmp/res" 2>/dev/null; then
        while IFS= read -r q; do git hash-object -w --no-filters -- "$q" 2>/dev/null || echo; done < "$tmp/ask" > "$tmp/res"
      fi
    fi
    K="$known" D="$tmp" awk -F'\t' '
      BEGIN { K = ENVIRON["K"]; T = ENVIRON["T"]; D = ENVIRON["D"] }
      FILENAME == ARGV[1] { if (K != "" && tolower($2) == T && ($1 == "F" || $1 == "I") && !(($1, $3) in e)) e[$1, $3] = $4; next }
      FILENAME == ARGV[2] { ask[++na] = $0; next }
      FILENAME == ARGV[3] {
        ++nr
        if (K == "") { if ($0 != "") res[ask[nr]] = $0 }
        else if (split($0, w, " ") == 3 && w[1] ~ /^[0-9a-f]+$/ && w[3] ~ /^[0-9]+$/) res[ask[nr]] = w[1]
        next
      }
      FILENAME == ARGV[4] { gone[++ng] = $0; next }
      { c = index($0, "\t"); r = substr($0, c + 1); i = index(r, "\t"); ck[++nc] = substr($0, 1, c - 1); cn[nc] = substr(r, 1, i - 1); cp[nc] = substr(r, i + 1) }
      function reviewed(x) { if (K != "" && (("F", x) in e) && e["F", x] != "") return e["F", x]; return (x in res) ? res[x] : "" }
      END {
        for (j = 1; j <= ng; j++) { b = reviewed(gone[j]); if (b != "" && !(b in dset)) { dset[b] = 1; dl[++nd] = b } }
        for (j = 1; j <= nc; j++) {
          p = cp[j]; n = cn[j]
          if (ck[j] == "w") { print "w\t-\t" p > (D "/plan"); continue }
          if (K != "" && (("I", p) in e) && e["I", p] == n) continue
          o = reviewed(p)
          if (n == o || (n in dset)) continue
          print "c\t" (o == "" ? "-" : o) "\t" p > (D "/plan"); print p > (D "/cpaths"); need = 1
          if (o != "" && !(o in asked)) { asked[o] = 1; print o > (D "/want") }
        }
        if (need) for (j = 1; j <= nd; j++) { print dl[j] > (D "/dl"); if (!(dl[j] in asked)) { asked[dl[j]] = 1; print dl[j] > (D "/want") } }
      }' "$base" "$ask" "$tmp/res" "$tmp/gone" "$tmp/cand"
  fi
  if [ -s "$tmp/plan" ]; then
    [ -s "$tmp/want" ] && git cat-file --batch < "$tmp/want" > "$tmp/blobs" 2>/dev/null
    if [ -s "$tmp/cpaths" ]; then
      tr '\n' '\0' < "$tmp/cpaths" | xargs -0 git diff --cached --numstat -z --no-renames -- 2>/dev/null | tr '\0' '\n' > "$tmp/num"
      tr '\n' '\0' < "$tmp/cpaths" | xargs -0 git -c core.quotePath=false diff --cached -U0 --no-color --no-ext-diff --no-textconv --no-renames --src-prefix=a/ --dst-prefix=b/ -- > "$tmp/diff" 2>/dev/null
    fi
    origin=$(M="$marker" FT="$full" LC_ALL=C awk '
      # BINMODE: Windows gawk keeps the CR of CRLF, which the blob byte count needs.
      BEGIN { M = ENVIRON["M"]; FT = ENVIRON["FT"]; BINMODE = 1 }
      function unq(s,   r, i, c) {
        sub(/\t$/, "", s)
        if (substr(s, 1, 1) != "\"") return s
        s = substr(s, 2, length(s) - 2); r = ""
        for (i = 1; i <= length(s); i++) {
          c = substr(s, i, 1)
          if (c != "\\") { r = r c; continue }
          c = substr(s, ++i, 1)
          if (c ~ /[0-7]/) { r = r sprintf("%c", c * 64 + substr(s, i + 1, 1) * 8 + substr(s, i + 2, 1)); i += 2 }
          else if (c == "n") r = r "\n"
          else if (c == "t") r = r "\t"
          else if (c == "r") r = r "\r"
          else if (c == "a") r = r "\007"
          else if (c == "b") r = r "\b"
          else if (c == "f") r = r "\f"
          else if (c == "v") r = r "\v"
          else r = r c
        }
        return r
      }
      FILENAME == ARGV[1] { c = index($0, "\t"); r = substr($0, c + 1); i = index(r, "\t"); pk[++np] = substr($0, 1, c - 1); pp[np] = substr(r, i + 1); if (pk[np] == "c") own[pp[np]] = substr(r, 1, i - 1); next }
      FILENAME == ARGV[2] { isd[$0] = 1; next }
      FILENAME == ARGV[3] {
        if (left > 0) {
          left -= length($0) + 1
          if (!isblob) next
          if ((++ln <= ${MAX_LINES} && index($0, M)) || index($0, FT)) mk[cur] = 1
          sub(/\r$/, "")
          if (cur in isd) dp[$0] = 1; else op[cur, $0] = 1
          next
        }
        if (split($0, h, " ") == 3 && h[3] ~ /^[0-9]+$/) { cur = h[1]; isblob = h[2] == "blob"; left = h[3] + 1; ln = 0 }
        next
      }
      FILENAME == ARGV[4] { c = index($0, "\t"); r = substr($0, c + 1); i = index(r, "\t"); p = substr(r, i + 1); a = substr($0, 1, c - 1); num[p] = (p in num) ? num[p] "\n" a : a; next }
      FILENAME == ARGV[5] {
        if (/^diff /) { hunk = 0; next }
        if (/^@@/) { hunk = 1; next }
        if (!hunk) { if (substr($0, 1, 4) == "+++ ") { fp = unq(substr($0, 5)); if (substr(fp, 1, 2) == "b/") fp = substr(fp, 3) } next }
        if (substr($0, 1, 1) == "+") { l = substr($0, 2); sub(/\r$/, "", l); if (!(l in dp) && !((own[fp], l) in op)) bad[fp] = 1 }
        next
      }
      END {
        for (d in isd) if (mk[d]) dm = 1
        for (j = 1; j <= np; j++) {
          p = pp[j]
          if (pk[j] == "w") print "  " p " (written during this command)"
          else if (dm || mk[own[p]]) print "  " p " (its working-tree copy still carries a sentinel)"
          else if (num[p] == "-") print "  " p " (binary, not a reviewed copy)"
          else if (p in bad) print "  " p
        }
      }' "$tmp/plan" "$tmp/dl" "$tmp/blobs" "$tmp/num" "$tmp/diff")
    [ -n "$origin" ] && origin="$origin"$'\n'
  fi
  rm -rf "$tmp"`.split('\n'),
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
    ...String.raw`wt_list() {
  while IFS= read -r p; do
    [ -n "$p" ] && [ -f "$p" ] || continue
    case "$hits" in *"  $p"$'\n'*) continue ;; esac
    if is_typed "$p"; then [ "$1" = typed ] || continue; else [ "$1" = plain ] || continue; fi
    printf './%s\n' "$p"
  done <<< "$staged"
  return 0
}
wt_err=$(mktemp 2>/dev/null) || wt_err=/dev/null
wt=$( set -o pipefail; {
  wt_list plain | tr '\n' '\0' | M="$marker" LC_ALL=C xargs -0 -r awk 'FNR <= ${MAX_LINES} && index($0, ENVIRON["M"]) {print substr(FILENAME, 3); nextfile} FNR >= ${MAX_LINES} {nextfile}' || exit
  wt_list typed | tr '\n' '\0' | M="$marker" FT="$full" LC_ALL=C xargs -0 -r awk '(FNR <= ${MAX_LINES} && index($0, ENVIRON["M"])) || index($0, ENVIRON["FT"]) {print substr(FILENAME, 3); nextfile}'
} 2>"$wt_err" )
wt_rc=$?
wt_fail=
if [ "$wt_rc" -ne 0 ]; then
  wt_fail="exit $wt_rc"
  [ "$wt_err" != /dev/null ] && wt_why=$(head -n 3 "$wt_err" 2>/dev/null) && [ -n "$wt_why" ] && wt_fail="$wt_fail: $wt_why"
fi
[ "$wt_err" != /dev/null ] && rm -f "$wt_err"
if [ -n "$wt" ]; then
  while IFS= read -r p; do
    case $'\n'"$wt"$'\n' in *$'\n'"$p"$'\n'*) hits="$hits  $p"$'\n' ;; esac
  done <<< "$staged"
fi`.split('\n'),
    ...ORIGIN_CHECK,
    '[ -z "$hits$origin$wt_fail" ] && exit 0',
    "[ -n \"$hits\" ] && printf 'Commit blocked: sentinel review lines still present in staged files:\\n%sRemove the sentinel lines after reviewing, then retry.\\n' \"$hits\" >&2",
    "[ -n \"$wt_fail\" ] && printf 'Commit blocked: the working-tree sentinel check failed (%s).\\nRetry the commit.\\n' \"$wt_fail\" >&2",
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
