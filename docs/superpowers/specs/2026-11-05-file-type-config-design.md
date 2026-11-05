# Per-file-type configuration — design

Date: 2026-11-05. Target version: 0.3.0.

## Goal

Make the sentinel's file types configurable: add new types, override or disable built-in ones, choose how the sentinel is written per type (line comment, block comment, JSON property, Markdown frontmatter), and say which leading lines it goes below (shebang, JSONC opening bracket). Configuration lives in a plugin option and is edited through a pane with a live preview.

## Constraints

- Insertion, the deletion guard and the commit scan decide placement through one code path per style. They cannot disagree.
- The commit scan stays a bounded read: the sentinel always sits within the first 4 lines.
- Only configuration turns sentinels off for a type. Claude's own tool calls cannot.
- Styles are code in the plugin, selected by name. Configuration never supplies code.
- With no configuration, behavior is byte-identical to 0.2.0.

## Configuration

New `userConfig` field `fileTypes` (type `string`, default `""`): a JSON object holding differences from the built-in table.

```jsonc
{
  ".md":      { "style": "markdown" },
  ".css":     { "style": "block", "prefix": "/*", "suffix": "*/" },
  ".jsonc":   { "style": "line", "prefix": "//", "skip": ["^\\s*[\\[{]\\s*$"] },
  ".json":    { "style": "json-property", "key": "_comment" },
  "Makefile": { "style": "line", "prefix": "#" },
  ".sql":     false
}
```

- A key starting with `.` matches an extension (the text from the last `.` of the file name, as today). Any other key matches an exact file name. File-name keys win over extension keys.
- An entry replaces the built-in row with the same key. `false` disables that key.
- Empty string or `{}`: the built-in table alone.

### Entry fields

| Field | Styles | Rule |
|---|---|---|
| `style` | all | `line`, `block`, `json-property` or `markdown`. Required. |
| `prefix` | `line`, `block` | Non-empty, no line break. Required. |
| `suffix` | `block` | Non-empty, no line break. Required. |
| `skip` | `line`, `block` | Array of up to 3 regular expression sources. Optional, default `[]`. |
| `key` | `json-property` | JSON property name, non-empty. Optional, default `_comment`. |

Unknown fields are a problem (catches typos). A problem drops that entry only; the built-in row for its key, if any, stays in effect.

### Validation and notices

`buildTable(json)` returns `{ table, problems }`. `problems` covers: option not valid JSON, not an object, unknown style, missing or invalid field, unknown field, `skip` longer than 3, a `skip` pattern that does not compile. Each problem names the key and the reason. `register` shows all problems in one notice per session (`notify` key `config:fileTypes`), the same way an invalid `commitWrapper` is reported. A wholly invalid option leaves the built-in table in effect.

## Styles

Every style implements:

- `locate(lines)` over at most the first 4 decoded lines → `{ at, present }` (0-based line index where the sentinel belongs, and whether the line at that index already carries `MARKER`), or `{ unsupported: reason }`.
- `render(eol, indent)` → the sentinel line, without BOM handling (the caller encodes it in the file's encoding).

The standard text `TAIL` is `TODO: Manual review needed. Please delete this line after review.`

### `line`

Line: `<prefix> <TAIL>`.

Placement: walk the `skip` patterns in order with a cursor starting at line 0. For each pattern, if it matches the line at the cursor (CR stripped), advance the cursor. A pattern that does not match is passed over. The sentinel goes at the cursor. Skip patterns apply only to UTF-8 files (with or without BOM); for UTF-16/32 files the cursor stays at 0, as the shebang rule does today.

If the line at the cursor is the last line and has no terminator, a line break is added after it before the sentinel (today's shebang behavior).

### `block`

Line: `<prefix> <TAIL> <suffix>`. Placement as `line`.

### `json-property`

Applies when the first non-whitespace character of the file is `{`.

- The sentinel goes on the line after the one holding the opening `{`.
- If `{` is not alone on its line (`{"a": 1}` on one line, or `{ "a": 1,` with content after the brace), the file is `unsupported` (`opening brace shares its line`).
- Line: `<indent>"<key>": "<TAIL>",` where `indent` is the leading whitespace of the next non-blank line after the brace, or two spaces when none.
- An empty object (`{` followed directly by `}`): no trailing comma.
- First non-whitespace character `[`, anything else, or an empty file: `unsupported` (`top level is not an object`).
- The opening `{` must be on one of the first 3 lines (keeping the sentinel within line 4); later is `unsupported` (`opening brace below line 3`).
- `present`: the line after the brace contains `MARKER`.

The file is not parsed as a whole. A `.json` file that is malformed past the opening line is the author's problem, as it is for every other type.

### `markdown`

- Line 1 is exactly `---` (CR stripped): the sentinel goes at line 2 as `# <TAIL>`, a YAML comment inside the frontmatter.
- Otherwise: line 1, as `<!-- <TAIL> -->`.

## Placement in practice: apply.ts

`place(bytes, rule)` keeps BOM detection, decoding and line-ending detection, decodes up to 4 lines and calls `rule.style.locate`. `insertSentinel(bytes, rule)`, `hasSentinel(bytes, rule)`, `insertSentinelText(text, rule)` and `applyToFile(host, path, table)` take the resolved rule or table in place of the internal lookup. An `unsupported` result:

- `insertSentinel` returns `undefined` with the reason available to the caller.
- `applyToFile` returns `{ failed: <reason> }`, which reaches the existing per-file notice.
- `hasSentinel` returns `false`.

## Modules

| Module | Change |
|---|---|
| `hooks/types.ts` (new) | Built-in rows, `buildTable`, `resolve(table, path)`, presets for the pane. |
| `hooks/styles.ts` (new) | The four styles. |
| `hooks/rules.ts` | Keeps `MARKER`, `PRUNED`/`isPruned`, `VCS_VERBS`, `PEEK_CHARS`, `basename`. Loses `BY_EXTENSION`, `BY_BASENAME`, `SHEBANG_EXTENSIONS`, `sentinelFor`, `isShebangExt`, `sentinelLineNo`. `blobCeiling()` becomes a constant: BOM (4) + 4 lines × `PEEK_CHARS` × 4 bytes. |
| `hooks/apply.ts` | As above. |
| `hooks/ctx.ts` | `Ctx` gains `table`. |
| `hooks/register.ts` | Builds the table from `options.fileTypes`, puts it on `ctx`, reports problems, registers the pane command. |
| `hooks/edit-write.ts`, `detect.ts`, `scan.ts`, `bash.ts`, `gate-tool.ts`, `selftest.ts` | Resolve through `ctx.table` in place of `sentinelFor`. |
| `hooks/pane.tsx` (new) | The pane. |

### Built-in rows

Equivalent to 0.2.0:

- `line` `//`: `.cs`, `.jsx`, `.tsx`; `.js`, `.mjs`, `.ts` with `skip: ["^#!"]`
- `line` `--`: `.sql`
- `line` `#`: `.yaml`, `.yml`; `.py`, `.sh`, `.ps1` with `skip: ["^#!"]`; file names `.gitignore`, `.gitattributes`

### Presets

Offered in the pane's Add view, not enabled by default: `.md` markdown; `.json` json-property; `.jsonc` line `//` with `skip: ["^\\s*[\\[{]\\s*$"]`; `.css` block `/* */`; `.html` and `.xml` block `<!-- -->`.

They are off by default because Bash-produced changes are marked too: `.json` on by default would mark `package-lock.json` after every `npm install`.

## Scan

Unchanged except that `scanStagedOrFail` takes the table, and staged files are filtered through `resolve`. A staged file whose type is disabled, or has no rule, is not scanned: disabling a type also lets existing sentinels of that type through the gate.

## Pane

`/sentinel-types` opens a docked pane `sentinel-types` (not `holdToasts`).

**List view.** One row per effective type: key, style, a short summary (`// · skip ^#!`), and a source tag (`built-in`, `custom`, `overrides built-in`, `off`). Entries dropped as invalid show a ⚠ row with the problem text. Each row has Edit, Off/On, and (changed rows only) Reset. Add at the top, with a preset choice.

**Edit view.**

- Fields: key (`Input`), style (`Select`), and only the fields the style uses: prefix, suffix, key name, up to 3 skip-pattern inputs.
- Errors show inline as you type, from the same validation `buildTable` uses. Save is disabled while there are errors.
- Preview: an optional sample-file path (`Input`). Its first lines are run through `insertSentinel` with the draft rule and shown as a `Code` block. With no path, a built-in sample for the style is used. An `unsupported` result shows its reason.

**Save.** Serializes the diff against the built-in rows and calls `$.config.set({ key: 'sentinel.fileTypes', value })`.

- `{ deny }`: the reason shows in the pane.
- Success: the mod reloads with the new table and the pane returns to the list view.
- The draft is kept in `$.state`, so a reload mid-edit keeps it.

**Surfaces.** Terminal and desktop. On mobile (no `Input` or `Select`) the pane shows the list view only, without edit controls.

## Testing

TDD with `claude plugin test .`; each behavior's test is watched failing first.

- `types.test.ts`: merge order; file name over extension; `false` disables; each problem kind with its text; the built-in table reproduces 0.2.0's mapping for every 0.2.0 type and shebang case.
- `styles.test.ts`: input → output tables per style; `locate` after `render` reports `present`. Cases:
  - `skip` order and the 3-pattern limit, and a skip pattern on the unterminated last line
  - CRLF, BOM, UTF-16
  - `{}`; `{\n  "a": 1\n}`; tab indent; `{"a":1}` on one line; leading `[`; empty file
  - Markdown with frontmatter, without, and a file that is only `---`
- Existing `apply`, `scan`, `edit-write`, `bash`, `detect`, `gate-tool`, `selftest` tests pass a table and keep their intent. New cases:
  - a custom type through each hook
  - a disabled type passes the scan
  - an invalid option shows one notice and leaves the built-in rows working
- `pane.test.tsx`, looped over `terminal` and `desktop`:
  - add from a preset, edit, disable, reset
  - preview text for a sample
  - an invalid entry blocks Save
  - Save calls `config.set` with diff-only JSON, and a denied save shows its reason
- Selftest: `.md` (with frontmatter) and `.json` fixtures run against a table with those presets enabled.

## Out of scope

- Guarding `settings.json` against edits by Claude.
- Styles beyond the four.
- More than 3 skip patterns, or placement below line 4.
- Glob or path-pattern keys.
