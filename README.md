# claude-sentinel

A Claude Code mod that marks every source file Claude writes with a manual-review line and holds commits until a person removes it.

```
// TODO: Manual review needed. Please delete this line after review.
```

Claude can edit dozens of files in one turn. The sentinel turns "did a person read this?" into something git can check. Each file Claude creates or changes gets the line. Claude cannot remove it, and a commit that stages a file still carrying it is denied. The only way through is a person deleting the line after reading the file.

## Install

The plugin is published through the [isabel-nh marketplace](https://github.com/isabel-nh/marketplace).

At the prompt of a terminal session:

```
/plugin marketplace add isabel-nh/marketplace
/plugin install sentinel@isabel-nh
```

From a shell:

```bash
claude plugin marketplace add isabel-nh/marketplace
```

```bash
claude plugin install sentinel@isabel-nh
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `isabel-nh/marketplace`, then Add plugin.

Then run `/sentinel-selftest` once. It checks insertion and the staged-file scan against a throwaway repo on your machine.

## What it does

| Tool call | Behavior |
|---|---|
| `Write` | The sentinel is inserted into the content before the file is written. If Claude rewrites a file and drops an existing sentinel, the line is put back and Claude is told. |
| `Edit`, `MultiEdit` | The sentinel is inserted after the edit. An edit that would remove a sentinel is denied. |
| `Bash` | Files that the command created or changed get the sentinel. These are files `git status` reports in the repositories the command touched, with a modification time after the command started. |
| `Bash` that changes the index | Staged files that carry a sentinel are unstaged again, and Claude is told `staging blocked due to presence of sentinels in files: <files>`. The check runs when a command changes or creates the index file of a repository it touched. |
| `Bash` running `git commit` | Denied as a tool error listing the staged files that still carry a sentinel. The scan reads the staged blobs, not the working tree. |

Commands that move many files at once without authoring them (`pull`, `merge`, `rebase`, `checkout`, `stash`, `reset`, `cherry-pick` and similar) are left alone.

### File types

The built-in table is below. The `fileTypes` option changes it: it can add types, turn types off, and change a type's comment style (see [Configuration](#configuration)).

| Comment | Files |
|---|---|
| `//` | `.cs`, `.js`, `.mjs`, `.ts`, `.jsx`, `.tsx` |
| `--` | `.sql` |
| `#` | `.py`, `.ps1`, `.sh`, `.yaml`, `.yml`, `.gitignore`, `.gitattributes` |

The line goes on line 1, or on line 2 behind a shebang in `.py`, `.sh`, `.ps1`, `.js`, `.mjs` and `.ts`. A UTF-8 BOM stays at byte 0. UTF-16 and UTF-32 files get the line in their own encoding. Line endings follow the file's own (CRLF or LF). Files under `.git`, `node_modules`, `bin`, `obj`, `packages`, `dist`, `build`, `target`, `.vs` and `.idea` are skipped, as are files over 4 MiB.

### The gate tool

`mcp__sentinel__commit_gate_status` takes `{ "repo": "<path>" }`. It unstages every staged file that still carries a sentinel, then reports what remains:

```
=== STAGED ===
M	src/a.cs

=== SENTINELS ===
  src/b.cs

=== GATES ===
GATE=BLOCKED
STAGED_COUNT=1
SENTINEL_COUNT=1
DIFFSTAT=1 file changed, 3 insertions(+)
```

`GATE` is `CLEAR` (nothing staged carried a sentinel), `BLOCKED` (the files under `SENTINELS` were unstaged) or `EMPTY` (nothing staged). An agent workflow can stage a commit's files, call the tool, and stop for review on anything but `CLEAR`.

## Configuration

| Option | Default | Effect |
|---|---|---|
| `commitWrapper` | empty | Regular expression matched against each line of a Bash command. A matching line is gated like `git commit`. Its repository is the line's `-C <dir>`, else a leading `cd`, else the session's directory. Use it for a script that runs `git commit` internally, where the mod cannot see the inner command. |

Set it from `/config`, or in `settings.json`:

```json
{
  "pluginConfigs": {
    "sentinel@isabel-nh": {
      "options": { "commitWrapper": "commit-msg\\.sh.*\\s-c(\\s|$)" }
    }
  }
}
```

An invalid pattern gates nothing and is reported once per session.

### File types option

| Option | Default | Effect |
|---|---|---|
| `fileTypes` | empty | A JSON object of changes to the built-in file types. Empty or `{}` means the built-in table only. |

`/sentinel-types` opens a pane that edits this option. The pane lists every type in effect and shows a preview of where the line goes in a sample file. The option itself holds only the changes from the built-in table. Built-in rows added in later versions therefore reach you without editing the option.

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

- A key that starts with `.` matches an extension. Any other key matches an exact file name. A file-name key wins over an extension key.
- An entry replaces the built-in row with the same key. `false` turns the key off.
- An invalid entry is dropped, and the built-in row for that key, if any, stays in effect. All problems are reported in one notice per session.

| Style | Fields | Line inserted |
|---|---|---|
| `line` | `prefix`, `skip` | `<prefix> TODO: Manual review needed. Please delete this line after review.` |
| `block` | `prefix`, `suffix`, `skip` | `<prefix> TODO: … after review. <suffix>` |
| `json-property` | `key` (default `_comment`) | `  "_comment": "TODO: … after review.",` on the line after the opening `{` |
| `markdown` | none | `# TODO: …` as line 2 inside YAML frontmatter when line 1 is `---`, else `<!-- TODO: … -->` on line 1 |

- **`skip`** is up to 3 regular expressions. They are checked in order against the line at a cursor that starts at line 1. A pattern that matches moves the cursor down one line, and a pattern that does not match is passed over. The sentinel goes at the cursor. The built-in shebang rule is `"skip": ["^#!"]`. Skip patterns apply only to UTF-8 files.
- The sentinel always lands within the first 4 lines.
- **`json-property`** needs the opening `{` alone on one of the first 3 lines. It takes the indent from the next property, and it leaves out the trailing comma for an empty object.

The pane's Add view offers presets: `.md` markdown, `.json` json-property, `.jsonc` `//` with an opening-bracket skip, `.css` `/* */`, and `.html` and `.xml` `<!-- -->`. None is on by default, because files that a Bash command changes are marked too. For example, `.json` turned on would mark `package-lock.json` after every `npm install`.

## Behavior on failure

The mod fails open. If git, the shell, or a file read fails, the tool call goes ahead and a notice says what was skipped. A crash never denies a call. The one deliberate denial is a commit, or an edit, that the rules above refuse.

## Platforms

- **Windows:** uses the Git Bash that ships with Git for Windows, found from `git --exec-path`. `bash` on PATH is never used there, because it may be WSL's.
- **macOS, Linux:** uses `bash` on PATH.

Byte-level work (UTF-16 files, reading staged blobs) needs that shell. Without it, UTF-8 files are still handled, and the rest is skipped with a notice.

## Limits

- The scan sees the index as it stands before the command runs. Files that `git commit -a` or `git commit <paths>` stage on their own are not scanned, and continuation commits (`git rebase --continue`, `git merge --continue`) are not gated. Stage first, then commit.
- A commit whose `-C` or `cd` target is a shell expansion (`"$REPO"`) is scanned in the session's directory instead, with a notice.
- Off Windows, a top-level directory with a one-letter name (`/c/...`) is read as a Windows drive.
- Staging is checked only after Claude's own Bash commands, and not after the commands left alone above (`stash`, `cherry-pick`, `merge` and similar). The commit gate still catches anything staged another way. In a single command such as `git add a.cs && git commit`, the commit scan runs before the add.
- Turning a type off also stops the commit scan for it, so existing sentinels in files of that type pass the gate.
- A `json-property` file whose top level is not an object (for example a `.json` file that starts with `[`), or whose opening brace shares its line, is skipped with a notice.
- Key matching is case-sensitive: `.CS` does not match `.cs`.

## Development

```bash
claude plugin test .
```

Type-check with TypeScript 5 once the plugin has been loaded (loading writes `.claude-plugin/types/`):

```bash
npx -y -p typescript@5 tsc -p .
```

## License

MIT
