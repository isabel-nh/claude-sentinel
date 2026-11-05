# Per-File-Type Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hard-coded sentinel file-type tables with a configurable type table (four named styles, skip rules, disable, add), edited through a pane with a live preview.

**Architecture:** `types.ts` turns the built-in rows plus the `fileTypes` JSON option into a `Table`. `styles.ts` implements `locate` per style over the first 4 lines, returning where the sentinel goes and the exact line. `apply.ts` keeps the byte, BOM and encoding work and delegates line choice to the style. The table rides on `ctx` to every hook, the scan and the gate tool. A pane (`pane.tsx`) edits the option through `$.config.set`, which reloads the mod.

**Tech Stack:** Claude Code mod (TypeScript hooks module, TSX for the pane), `claude-code/testing` kit, TypeScript 5 for type-checking.

**Spec:** `docs/superpowers/specs/2026-11-05-file-type-config-design.md`

## Global Constraints

- Mod runtime: no Node, no `Buffer`, no dynamic import. `$` cannot be passed as a value.
- With `fileTypes` empty, every insertion, guard decision and scan result is byte-identical to 0.2.0.
- The sentinel always sits within the first 4 lines (line index 0-3). At most 3 skip patterns.
- `MARKER` is never written whole in a source file's first 4 lines. Build sentinel text from `MARKER`/`TAIL` in `rules.ts`, as today.
- Fail-open: a crash, read failure or invalid config never denies a tool call. The only denials are a sentinel removal and a commit with staged sentinels.
- Styles are code. Config never supplies code; skip patterns are regex sources compiled with `new RegExp`.
- Version 0.3.0. New `userConfig` field `fileTypes`: type `string`, default `""`.
- **No commits by the executor.** Every changed source file gets a sentinel from the installed mod, and the commit gate blocks it until the user reviews. Each task ends with its tests green and its files left uncommitted. The user reviews and commits.
- Verification commands, run in `C:/git/claude-sentinel`:
  - Tests: `claude plugin test .`
  - Validate: `claude plugin validate .`
  - Types: `npx -y -p typescript@5 tsc -p .` (needs `.claude-plugin/types/`. If it is missing, use a temp tsconfig that extends `./tsconfig.json` and adds the bundled `plugin-authoring/types/claude-code.d.ts` to `include`.)

## Review Focus

1. **A skip pattern that matches the sentinel line itself.** For example `line` `#` with `skip: ["^#"]`: after insertion, `locate` would step past the sentinel, report `present: false`, and insert again on every write. Expected: a line containing `MARKER` is never consumed by a skip pattern. Test in Task 2.
2. **`.json` with a BOM or CRLF.** Expected: the BOM stays at byte 0, the property line uses `\r\n`, and `present` is found afterwards. Test in Task 3.
3. **Extension case.** `.MD` vs a `.md` key. Expected: case-sensitive matching, as 0.2.0 does for `.CS`, so a `.MD` file is untouched. Test in Task 1.
4. **Renaming a key in the pane's edit view.** Expected: the old key's entry is removed (or reset to built-in) and the new key is added, not both left in place. Test in Task 7.
5. **A key that is not a file name.** `.`, empty, or containing `/` or `\`. Expected: a problem, so the entry is dropped and Save is blocked. Test in Task 1.

---

## File Structure

| File | Responsibility |
|---|---|
| `hooks/types.ts` (new) | `Entry`/`Rule`/`Table` types, built-in entries, presets, `parseEntries`, `compileEntry`, `buildTable`, `resolve`, `diffAgainstBuiltins`. |
| `hooks/styles.ts` (new) | `locate` for `line`, `block`, `json-property`, `markdown`. |
| `hooks/rules.ts` | Keeps `MARKER`, `TAIL` (now exported), `PRUNED`/`isPruned`, `VCS_VERBS`, `PEEK_CHARS`, `basename`, `extension` (now exported). `blobCeiling` becomes the constant `BLOB_CEILING`. |
| `hooks/apply.ts` | Byte-level placement for any `at` in 0-3, delegating line choice to `styles.ts`. |
| `hooks/ctx.ts`, `register.ts`, `edit-write.ts`, `detect.ts`, `scan.ts`, `bash.ts`, `gate-tool.ts`, `selftest.ts` | Take the table. |
| `hooks/pane.tsx`, `types/pane-state.d.ts` (new) | Pane and its `$.state` typing. |
| `tests/types.test.ts`, `tests/styles.test.ts`, `tests/pane.test.tsx` (new) | New tests. Existing tests updated for the new signatures. |

---

### Task 1: Type table

**Files:**
- Create: `hooks/types.ts`, `tests/types.test.ts`
- Modify: `hooks/rules.ts` (export `TAIL` and `extension`; nothing removed yet)

**Interfaces:**
- Produces:
  ```ts
  export type StyleName = 'line' | 'block' | 'json-property' | 'markdown'
  export type Entry =
    | { style: 'line'; prefix: string; skip?: string[] }
    | { style: 'block'; prefix: string; suffix: string; skip?: string[] }
    | { style: 'json-property'; key?: string }
    | { style: 'markdown' }
  export type Rule =
    | { style: 'line'; prefix: string; skip: readonly RegExp[] }
    | { style: 'block'; prefix: string; suffix: string; skip: readonly RegExp[] }
    | { style: 'json-property'; key: string }
    | { style: 'markdown' }
  export type Table = ReadonlyMap<string, Rule>          // key: '.ext' or exact file name
  export type Problem = { key: string; reason: string }  // key '' for whole-option problems
  export const BUILTIN_ENTRIES: Readonly<Record<string, Entry>>
  export const PRESETS: Readonly<Record<string, Entry>>
  export function compileEntry(key: string, raw: unknown): Rule | Problem
  export function parseEntries(json: string): { entries: Record<string, Entry | false>; problems: Problem[] }
  export function buildTable(json: string): { table: Table; problems: Problem[] }
  export function resolve(table: Table, path: string): Rule | undefined   // basename key first, then extension
  export function diffAgainstBuiltins(effective: Record<string, Entry | false>): Record<string, Entry | false>
  ```
- Values from the spec:
  - `BUILTIN_ENTRIES`:
    - `line` `//`: `.cs`, `.jsx`, `.tsx`; `.js`, `.mjs`, `.ts` with `skip: ['^#!']`
    - `line` `--`: `.sql`
    - `line` `#`: `.yaml`, `.yml`; `.py`, `.sh`, `.ps1` with `skip: ['^#!']`; `.gitignore`, `.gitattributes`
  - `PRESETS`:
    - `.md` `{ style: 'markdown' }`
    - `.json` `{ style: 'json-property' }`
    - `.jsonc` `{ style: 'line', prefix: '//', skip: ['^\\s*[\\[{]\\s*$'] }`
    - `.css` block `/*` `*/`
    - `.html`, `.xml` block `<!--` `-->`
  - Problem reasons (exact text, prefixed by the key in notices):
    - `option is not valid JSON`
    - `option is not a JSON object`
    - `unknown style "<s>"`
    - `missing prefix`
    - `missing suffix`
    - `<field> must be a non-empty single-line string`
    - `unknown field "<f>"`
    - `skip allows at most 3 patterns`
    - `skip pattern "<p>" is not a valid regular expression`
    - `key must be a file name or .extension`

- [ ] **Step 1: Write the failing tests** in `tests/types.test.ts`:
  - `built-in table matches 0.2.0`: for each of `a.cs a.js a.mjs a.ts a.jsx a.tsx a.yaml a.yml a.sql a.py a.ps1 a.sh .gitignore sub/.gitattributes`, `resolve(buildTable('').table, p)` has the 0.2.0 prefix, and `skip` sources are `['^#!']` exactly for `.js .mjs .ts .py .sh .ps1`. `resolve` of `a.txt`, `a.md` and `a.json` is `undefined`.
  - `option entries override, add and disable`: `buildTable('{".md":{"style":"markdown"},".sql":false,".cs":{"style":"line","prefix":"#"}}')` → `.md` is markdown, `.sql` is undefined, `.cs` prefix is `#`, and there are no problems.
  - `file-name key beats extension`: the option `{"x.cs":{"style":"line","prefix":"#"}}` → `resolve(t, 'C:/r/x.cs').prefix === '#'` and `resolve(t, 'y.cs').prefix === '//'`.
  - `extension match is case-sensitive` (Review Focus 3): `resolve(buildTable('{".md":{"style":"markdown"}}').table, 'README.MD')` is `undefined`.
  - `each problem drops only its entry`: one test per reason above, each asserting `problems` equals `[{ key, reason }]` and that the built-in row for that key, if any, is still resolved.
  - `invalid keys` (Review Focus 5): keys `'.'`, `''`, `'a/b'` and `'a\\b'` each give `key must be a file name or .extension`.
  - `empty and {} options give the built-in table`.
  - `diffAgainstBuiltins drops entries equal to their built-in row and keeps false`.
- [ ] **Step 2: Run** `claude plugin test .`. Expected: `types.test.ts` fails to import `../hooks/types.ts`, and the other suites pass.
- [ ] **Step 3: Implement `hooks/types.ts`.** `buildTable` = built-in rows, then each valid option entry overrides or deletes its key. A wholly invalid option gives the built-in table plus one problem with key `''`. Skip sources compile with `new RegExp(src)`, no flags. Entry equality in `diffAgainstBuiltins` is a structural comparison of the JSON form.
- [ ] **Step 4: Run** `claude plugin test .`. Expected: all suites pass.

### Task 2: Styles

**Files:**
- Create: `hooks/styles.ts`, `tests/styles.test.ts`

**Interfaces:**
- Consumes: `Rule` from Task 1; `MARKER`, `TAIL` from `rules.ts`.
- Produces:
  ```ts
  export const MAX_LINES = 4
  // line: the sentinel line for this file, no EOL (the caller appends the file's EOL)
  export type Located = { at: number; present: boolean; line: string } | { unsupported: string }
  // lines: up to MAX_LINES decoded lines, CR stripped; utf8: file is UTF-8 (with or without BOM)
  export function locate(rule: Rule, lines: readonly string[], utf8: boolean): Located
  ```
- `locate` builds the line itself, because only it knows the indent, the comma and the Markdown variant.
- Lines, from the spec:
  - `line`: `<prefix> <TAIL>`
  - `block`: `<prefix> <TAIL> <suffix>`
  - `json-property`: `<indent>"<key>": "<TAIL>",`. The comma is dropped when the next line after the brace starts with `}`. The indent is the next non-blank line's leading whitespace, else two spaces.
  - `markdown`: with frontmatter, `# <TAIL>` at index 1; otherwise `<!-- <TAIL> -->` at index 0.
  - Unsupported reasons:
    - `top level is not an object`
    - `opening brace shares its line`
    - `opening brace below line 3`

- [ ] **Step 1: Write the failing tests** in `tests/styles.test.ts`. Each is a table of `[lines, utf8, expected Located]` plus round-trip checks. Round trip means: splice `located.line` into `lines` at `at`, then `locate` again returns `present: true` at the same `at`.
  - `line skip walks patterns in order and passes over misses`:
    - rule `#` with skip `['^#!', '^# -\\*-']`
    - `['#!/bin/sh', '# -*- coding -*-', 'x']` → `at: 2`
    - `['# -*- coding -*-', 'x']` → `at: 1`
    - `['x']` → `at: 0`
  - `skip never consumes a marker line` (Review Focus 1): rule `#` with skip `['^#']`; with `s = locate(rule, ['x'], true).line`, `locate(rule, [s, 'x'], true)` → `{ at: 0, present: true }`.
  - `skip is ignored for non-UTF-8`: `['#!/bin/sh', 'x']` with `utf8 false` → `at: 0`.
  - `at most 3 skips keep the sentinel within line 4`: 3 matching patterns over 4 matching lines → `at: 3`.
  - `block renders prefix, tail, suffix`: `locate({ style: 'block', prefix: '/*', suffix: '*/', skip: [] }, ['x'], true).line` equals `` `/* ${TAIL} */` ``.
  - `json-property` (rule key `_comment`):
    - `['{', '  "a": 1', '}']` → `{ at: 1, present: false, line: `  "_comment": "${TAIL}",` }`
    - `['{', '\t"a": 1']` → line starts with `'\t"_comment"'`
    - `['{', '}']` → line `  "_comment": "${TAIL}"` (no comma)
    - `['', '{', '  "a": 1']` → `at: 2`
    - `['', '', '', '{']` → unsupported `opening brace below line 3`
    - `['{"a":1}']` → `opening brace shares its line`
    - `['[', '1', ']']` → `top level is not an object`
    - `[]` → `top level is not an object`
  - `markdown`:
    - `['---', 'name: x', '---']` → `at: 1`, line `# <TAIL>`
    - `['# Title']` → `at: 0`, line `<!-- <TAIL> -->`
    - `['---']` → `at: 1`
- [ ] **Step 2: Run** `claude plugin test .`. Expected: `styles.test.ts` fails to import.
- [ ] **Step 3: Implement `hooks/styles.ts`.**
  - `present` is `lines[at]?.includes(MARKER) ?? false`.
  - The skip walk:
    ```ts
    let at = 0
    if (utf8) for (const p of rule.skip) if (at < lines.length && !lines[at]!.includes(MARKER) && p.test(lines[at]!)) at++
    ```
- [ ] **Step 4: Run** `claude plugin test .`. Expected: all pass.

### Task 3: Byte placement through rules

**Files:**
- Modify: `hooks/apply.ts`, `hooks/rules.ts`, `tests/apply.test.ts`, `tests/apply-file.test.ts`, `tests/rules.test.ts`

**Interfaces:**
- Consumes: `Rule`, `Table`, `resolve`, `buildTable` (Task 1); `locate`, `MAX_LINES` (Task 2).
- Produces:
  ```ts
  export type Inserted = { bytes: Uint8Array } | { present: true } | { unsupported: string }
  export function insertSentinel(bytes: Uint8Array, rule: Rule): Inserted
  export function insertSentinelText(text: string, rule: Rule): string | undefined   // undefined unless inserted
  export function hasSentinel(bytes: Uint8Array, rule: Rule): boolean               // false when unsupported
  export async function applyToFile(host: Host, path: string, table: Table): Promise<ApplyOutcome>   // unsupported → { failed: reason }
  export const BLOB_CEILING: number   // rules.ts: 4 + MAX_LINES * PEEK_CHARS * 4
  ```
- `rules.ts` loses `BY_EXTENSION`, `BY_BASENAME`, `SHEBANG_EXTENSIONS`, `sentinelFor`, `isShebangExt`, `sentinelLineNo` and `blobCeiling`. Callers outside `apply.ts` still use `sentinelFor` until Task 4. In this task, give `rules.ts` a temporary `sentinelFor(path)` that returns `resolve(buildTable('').table, path)`, so the other modules keep compiling. Task 4 deletes it.

- [ ] **Step 1: Rewrite the existing tests' expectations to the new signatures.** `insertSentinel(bytes, rule)` with `rule = resolve(buildTable('').table, path)!`. Keep every expected byte string from 0.2.0 unchanged, since these tests are the byte-identity check. Add:
  - `json-property inserts after the brace, keeps BOM and CRLF` (Review Focus 2): input BOM + `{\r\n  "a": 1\r\n}\r\n` with rule `.json` preset → BOM + `{\r\n  "_comment": "<TAIL>",\r\n  "a": 1\r\n}\r\n`. `hasSentinel` on the output is true.
  - `json-property empty object has no comma`: `{\n}\n` → `{\n  "_comment": "<TAIL>"\n}\n`.
  - `unsupported json is left alone`: `[1]\n` → `{ unsupported: 'top level is not an object' }`. `applyToFile` gives `{ failed: 'top level is not an object' }`, and the fake host's file is unchanged.
  - `markdown frontmatter gets line 2`: `---\nname: x\n---\nbody\n` → `---\n# <TAIL>\nname: x\n---\nbody\n`.
  - `insertion at line 3 after an unterminated line 2`: rule `#` with 3 skips over `#!a\n#b\n#c` → `#!a\n#b\n#c\n# <TAIL>\n`.
- [ ] **Step 2: Run** `claude plugin test .`. Expected: the rewritten apply tests fail on signature or type errors.
- [ ] **Step 3: Implement.**
  - `place` decodes `MAX_LINES` lines and calls `locate`.
  - Insert at `at`: the head is `bytes[0 .. lines[at-1].end]` (or `bom.length` when `at = 0`), plus a line break if `lines[at-1]` has no terminator, then the encoded sentinel and EOL, then the rest.
  - EOL is the first line's terminator, defaulting to `\n`, as today.
  - `BLOB_CEILING` replaces `blobCeiling(path)` in `scan.ts`.
- [ ] **Step 4: Run** `claude plugin test .` and the type check. Expected: all pass and tsc reports no errors.

### Task 4: Table through the hooks, scan, gate and option

**Files:**
- Modify: `hooks/ctx.ts`, `hooks/register.ts`, `hooks/edit-write.ts`, `hooks/detect.ts`, `hooks/scan.ts`, `hooks/bash.ts`, `hooks/gate-tool.ts`, `hooks/rules.ts` (delete the temporary `sentinelFor`), `.claude-plugin/plugin.json`
- Tests: `tests/edit-write.test.ts`, `tests/bash.test.ts`, `tests/detect.test.ts`, `tests/scan.test.ts`, `tests/gate-tool.test.ts`

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces:
  - `Ctx` gains `table: Table`.
  - `changedSince(host, root, start, table)`.
  - `scanStaged(host, repo, table)` and `scanStagedOrFail(host, repo, table)`.
  - `gateStatus(host, repo, table)`.
  - `applyAndReport` passes `ctx.table`.
  - `lineOfMarker` in `edit-write.ts` reports the 1-based index of the first of up to 4 lines containing `MARKER`.
- `plugin.json`:
  - version `0.3.0`
  - `userConfig.fileTypes`: `{ "type": "string", "title": "File types", "description": "JSON object of changes to the built-in sentinel file types: \".ext\" or a file name mapped to a style entry, or false to turn it off. Edit with /sentinel-types.", "default": "" }`
- `register`: `const { table, problems } = buildTable(options.fileTypes ?? '')`. In the `tool.call` body, if `problems.length > 0`, call `ctx.notify('config:fileTypes', 'sentinel: fileTypes entries ignored: ' + problems.map(p => (p.key ? p.key + ': ' : '') + p.reason).join('; ') + '.')`.

- [ ] **Step 1: Update existing tests** to build `buildTable('').table` where a table is needed. Their assertions stay the same. Add:
  - `edit-write`: `{ options: { fileTypes: '{".md":{"style":"markdown"}}' } }`, a Write of `C:/r/a.md` with `---\nname: x\n---\n` → frontmatter with the sentinel on line 2. An Edit removing it is denied with `DENY_REMOVAL`.
  - `edit-write`: with `{".cs":false}`, a Write of `a.cs` is unchanged.
  - `bash`: with `{".cs":false}`, staging a `.cs` that carries a sentinel → `git commit` runs (not denied).
  - `bash`: `{ options: { fileTypes: '{".x":{"style":"nope"}}' } }` → the command runs, exactly one toast contains `fileTypes` and `unknown style "nope"`, and a `.cs` Write still gets its sentinel.
  - `detect`: a changed `.md` is listed only when the table has `.md`.
  - `gate-tool`: a custom `.md` with a sentinel is unstaged and reported.
- [ ] **Step 2: Run** `claude plugin test .`. Expected: the new cases fail, and the updated ones fail on signatures.
- [ ] **Step 3: Implement** the signatures above. Delete the temporary `sentinelFor`.
- [ ] **Step 4: Run** tests, validate and tsc. Expected: all pass, `validate` passes, and tsc is clean.

### Task 5: Selftest covers the new styles

**Files:**
- Modify: `hooks/selftest.ts`, `tests/selftest.test.ts`

**Interfaces:**
- `runSelftest(host)` builds its own table: `buildTable(JSON.stringify({ '.md': PRESETS['.md'], '.json': PRESETS['.json'] })).table`, layered on the built-in rows.
- New fixtures: `e.md` = `---\nname: x\n---\nbody\n` and `f.json` = `{\n  "a": 1\n}\n`.
- The scan expectation becomes `a.cs,b.sql,c.sql,d.sql,e.md,f.json`, and after clearing `b.sql` it is `a.cs,c.sql,d.sql,e.md,f.json`. Check names change to `scan finds all six` and `scan after clearing b.sql`. The `changedSince` check now writes `g.cs`.

- [ ] **Step 1: Update `tests/selftest.test.ts`** for the new check names and fixture count.
- [ ] **Step 2: Run** `claude plugin test .`. Expected: the selftest suite fails.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** tests. Expected: all pass. A real-host check (`/sentinel-selftest`) is left to the user after reload.

### Task 6: Pane list view and save

**Files:**
- Create: `hooks/pane.tsx`, `types/pane-state.d.ts`, `tests/pane.test.tsx`
- Modify: `hooks/register.ts` (register the `sentinel-types` command and the `ui.render` hook), `tsconfig.json` (no change expected: `hooks` and `types` are already included)

Load the `plugin-authoring` skill before this task and follow its `examples/pane.tsx`, `pane-state.d.ts` and `pane.test.tsx`.

**Interfaces:**
- Consumes: `BUILTIN_ENTRIES`, `PRESETS`, `parseEntries`, `diffAgainstBuiltins` (Task 1).
- Produces:
  - `export const PANE = 'sentinel-types'`
  - `export type TypeRow = { key: string; entry: Entry | false; source: 'built-in' | 'custom' | 'overrides built-in' | 'off'; problem?: string }`
  - `export function rows(optionJson: string): TypeRow[]`: sorted by key. Problems from `parseEntries` appear as rows with `problem` set.
  - `export function summary(entry: Entry): string`, for example `// · skip ^#!`, `/* … */`, `json "_comment"`, `markdown`.
  - `export function nextOption(optionJson: string, change: { key: string; entry: Entry | false | 'reset' }): string`: applies the change, then returns `JSON.stringify(diffAgainstBuiltins(...))`, or `''` when the result is empty.
- State (`types/pane-state.d.ts`): `'sentinel': { view: Shaped<{ mode: 'list' } | { mode: 'edit'; originalKey?: string; draft: DraftEntry; samplePath: string }> }`, where `DraftEntry` holds `key`, `style`, `prefix`, `suffix`, `jsonKey` and `skip` (3 strings). Shape tag `view-1`.
- `register`:
  - On `session.start`, `$.command.register({ name: 'sentinel-types', description: 'Edit the sentinel file types.' })`.
  - `command.run` `{ command: 'sentinel-types' }` → `$.ui.open({ id: PANE, title: 'Sentinel file types' })` returns `{ text: 'Sentinel file types pane opened.' }`.
  - The `ui.render` hook reads the current option from `$.config.list()`, row key `sentinel.fileTypes`.
- Save path: `$.config.set({ key: 'sentinel.fileTypes', value: nextOption(...) })`. A `{ deny }` sets a pane-local error line `Not saved: <deny>`.

- [ ] **Step 1: Write the failing tests** in `tests/pane.test.tsx`:
  - Unit tests of `rows`, `summary` and `nextOption`:
    - `rows('')` has 14 built-in rows.
    - `rows('{".sql":false,".md":{"style":"markdown"}}')` tags `.sql` `off` and `.md` `custom`.
    - `nextOption('', { key: '.cs', entry: BUILTIN_ENTRIES['.cs'] })` is `''`.
    - `nextOption('{".sql":false}', { key: '.sql', entry: 'reset' })` is `''`.
  - `list view on terminal and desktop`, looped over both surfaces:
    - Mount with the config row value `'{".sql":false}'`. A Text matching `/\.sql.*off/` is found.
    - Pressing that row's On button calls `config.set` with value `''`.
  - `a denied save shows its reason`: the `config.set` hook answers `{ deny: 'locked' }`, and a Text `Not saved: locked` appears.
  - `mobile shows the list without buttons`: no `Button` is found on `mobile`.
- [ ] **Step 2: Run** `claude plugin test .`. Expected: the pane suite fails to import.
- [ ] **Step 3: Implement** the list view with Off/On, Reset and Add buttons. Add switches to edit mode with an empty draft; Task 7 completes the edit view.
- [ ] **Step 4: Run** tests and tsc. Expected: all pass.

### Task 7: Pane edit view and preview

**Files:**
- Modify: `hooks/pane.tsx`, `tests/pane.test.tsx`

**Interfaces:**
- Consumes: `compileEntry` (Task 1); `insertSentinel` (Task 3); `rows`, `nextOption` and the state (Task 6).
- Produces:
  - `export function draftToEntry(d: DraftEntry): Entry`
  - `export function draftProblems(d: DraftEntry): string[]`: `compileEntry` reasons, plus `key must be a file name or .extension`.
  - `export function preview(rule: Rule, sample: string): string`: the first 6 lines of the result, or `unsupported: <reason>`.
  - `export const SAMPLES: Record<StyleName, string>`:
    - `line` / `block`: `#!/usr/bin/env sh\necho hi\n`
    - `json-property`: `{\n  "name": "x"\n}\n`
    - `markdown`: `---\nname: x\n---\nbody\n`
- Edit view:
  - Fields: key `Input`; style `Select`; only the inputs the style uses; up to 3 skip `Input`s; sample path `Input`; a preview `Code` block; Save (disabled while `draftProblems` is non-empty); Cancel.
  - Add view: a preset `Select` that fills the draft.
  - Sample file: read with `$.fs.read(path)`, at most the first 4 KiB. A read failure shows `cannot read <path>` and falls back to `SAMPLES`.
  - Save with `originalKey !== draft.key`: first `nextOption(..., { key: originalKey, entry: 'reset' })`, then `{ key: draft.key, entry }`. This is one `config.set` with the combined result.

- [ ] **Step 1: Write the failing tests**:
  - `draftProblems` lists `missing prefix` for an empty `line` prefix.
  - `preview(PRESET .json rule, '[1]\n')` is `unsupported: top level is not an object`.
  - Edit view, looped over terminal and desktop:
    - Edit `.sql` and type `#` into the prefix input. The preview `Code` source starts with `` `# ${TAIL}` ``.
    - Save → `config.set` value `{".sql":{"style":"line","prefix":"#"}}`.
  - `renaming a key replaces the old entry` (Review Focus 4): from option `{".md":{"style":"markdown"}}`, edit `.md`, change the key to `.markdown`, Save → value `{".markdown":{"style":"markdown"}}`.
  - `invalid draft blocks save`: the key `a/b` shows the problem text, and the Save button is disabled.
  - `add from preset`: Add, choose `.jsonc`, Save → value contains `".jsonc"` with `skip` `["^\\s*[\\[{]\\s*$"]`.
- [ ] **Step 2: Run** `claude plugin test .`. Expected: the new pane tests fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** tests, validate and tsc. Expected: all pass.

### Task 8: Documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1:** README updates:
  - **What it does / File types:** say the table is configurable.
  - **Configuration:** a `fileTypes` row, the JSON shape (the spec's example), the four styles with their output lines, skip rules and the 4-line limit, the presets and why they are opt-in, and `/sentinel-types`.
  - **Limits:** disabling a type also stops scanning it; `.json` files starting with `[` are skipped; matching is case-sensitive.
- [ ] **Step 2: Run** `claude plugin validate .`. Expected: passes.
