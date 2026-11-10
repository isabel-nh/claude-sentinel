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
| `Bash` | Files that the command created or changed get the sentinel. These are files `git status` reports in the repositories the command touched that were not changed before it ran, or whose content hash differs from the one taken before it ran. Modification times are not trusted: a rename keeps the old one and `touch -d` resets it. They are used only when the snapshot fails or a repository has more than 2,000 changed files. A `cd` target is read as the shell reads it, so `cd C:/a/b''c` reaches `C:/a/bc`. |
| `PowerShell` | Watched like Bash: files the command created or changed get the sentinel, staged content and new commits go through the same checks, and a command that names `~/.claude/sentinel` is denied. Any command that runs `git` is denied, because the hook environment can be put in front of Bash commands only. |
| `Bash` running `git add` or `git stage` | Denied before it runs when a file the call would stage carries a sentinel in the working tree. The files come from `git add --dry-run` with the same arguments, in the directory a preceding `cd` or the call's `-C` names. Calls whose arguments the shell expands first (`$VAR`, globs) and interactive staging are left to the checks below. |
| `Bash` that changes the index | Staged files that carry a sentinel are unstaged again, and Claude is told `staging blocked due to presence of sentinels in files: <files>`. The check runs when a command changes or creates the index file of a repository it touched. |
| `Bash` running `git commit` | Denied as a tool error listing the staged files that still carry a sentinel. The scan reads the staged blobs. A staged file whose blob is clean while its working-tree copy carries a sentinel also blocks: a clean filter or a hand-built index entry took the line out on the way in. The pre-commit hook applies the same rule. |
| `Bash` running `git commit-tree`, `git update-ref`, `git mktree`, `git fast-import`, `git stash create` or `git stash store` | Denied before it runs, also through an inline `-c alias.*` or with the verb split by quotes. These write commits, trees or refs without running the commit hooks. |
| Any `Bash` command | Runs with git's pre-commit hook pointed at the sentinel scan (see [The pre-commit hook](#the-pre-commit-hook)). A commit made anywhere in the command, by any means, is refused while a staged file carries a sentinel, or while staged content breaks the [review-origin rule](#the-review-origin-rule). |
| `Bash` that stages or commits content no one reviewed | Staged files that break the review-origin rule are unstaged, and Claude is told. A `git commit` command that would commit them is denied. A branch the command moved onto commits that break the rule is rolled back (see below). |
| `Bash` that would skip that hook | Denied: `--no-verify` or `-n` on a commit, `-c core.hooksPath=…` or `--config-env` for it, a rewrite of `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_*`/`GIT_CONFIG_VALUE_*`/`GIT_CONFIG_PARAMETERS`/`SENTINEL_BASELINE`, `env -i`, and any command that names `~/.claude/sentinel`. |

Commands that move many files at once without authoring them (`pull`, `merge`, `rebase`, `checkout`, `stash`, `reset`, `cherry-pick` and similar) are left alone. A command counts as one of these only when every segment is such a git call or a `cd`: a verb in a comment, or chained after a write (`sed -i … x.cs && git stash list`), does not exempt the command. `git am` and `git apply` are not on the list, because they author content from a patch.

### The review-origin rule

The sentinel is inserted only into files Claude writes in the working tree. Content that goes straight into the index or into a commit (`git update-index --cacheinfo`, an alternate `GIT_INDEX_FILE`, a patch applied with `--cached`, a temporary worktree) never passes through the working tree and so never gets the line. The review-origin rule closes that path. Each line that a staged or committed covered file adds must already exist in the file's reviewed copy. The reviewed copy is one of two things:

- the working-tree copy as it stood before the command, provided that copy carries no sentinel;
- the file at `HEAD` when the command started.

Lines from a path deleted in the same change count too, so a `git mv` passes. For a merge commit, lines from its other parents count as well. Binary content passes only as an exact copy.

Before each Bash command that is not left alone, the mod records a baseline for each repository the command touches:

- `HEAD`;
- a stored blob of every covered file that differs from `HEAD`;
- every local branch, plus the `HEAD` of each detached worktree.

The baseline also records what was already staged. An entry that the command leaves as it was is not judged, so a person can stage a reviewed copy while the working tree still carries the sentinel. The commit gate still refuses to commit that copy until the working-tree sentinel is gone.

The pre-commit hook reads that baseline from `~/.claude/sentinel/baselines/`. The baseline file exists only while the command runs. After the command, commits that no ref held before are checked against the same rule. A branch that moved onto such commits is reset: with `git reset --mixed` in the worktree that has it checked out, otherwise with `update-ref`. A new branch is deleted. The content then shows up as working-tree changes, and those get the sentinel.

A file carries a sentinel when the marker text (`TODO: Manual review needed`) is on one of its first 4 lines, whatever its type, or when the full sentinel sentence is anywhere in a file of a configured type. A sentinel that moved, or one in a file whose type is turned off or was configured differently on the machine that inserted it, still blocks.

When Claude adds lines above a pending sentinel, the mod moves the sentinel back to its place at the top of the file. This applies through any tool. The line is moved only if it holds the full sentinel sentence and nothing but its comment syntax, in any indent. Copies of it collapse into one. A line that only quotes the sentence, such as a string literal, stays where it is.

### The pre-commit hook

On the first Bash call of each session the mod writes, under `~/.claude/sentinel/`:

- `git-hooks/sentinel-scan`, the staged-file check, run by git against the index it is about to commit.
- `git-hooks/<hook>` for every client-side git hook name: a shim that runs `sentinel-scan` first when it is `pre-commit`, then runs the repository's own hook of that name, if any. Hooks from `.git/hooks`, husky and other `core.hooksPath` setups keep running.
- `git-env`, sourced on a line the mod puts ahead of each Bash command. It appends `core.hooksPath=~/.claude/sentinel/git-hooks` to the command's environment config (`GIT_CONFIG_COUNT`), which outranks every git config file, and leaves the caller's own environment config in place.

Nothing is written to a repository or to any git config file. The gate therefore holds for compound commands (`git add -A && git commit`), `git commit -a`, `git commit <paths>`, scripts that commit internally, subagents and worktrees, without any instruction in `CLAUDE.md`. If the files cannot be written, the mod says so once and the command-level checks above still apply.

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

`GATE` is `CLEAR` (nothing staged carried a sentinel), `BLOCKED` (the files under `SENTINELS` were unstaged) or `EMPTY` (nothing staged). An agent workflow can stage a commit's files, call the tool, and stop for review on anything but `CLEAR`. The tool is optional: the checks above block without it.

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

- A key that starts with `.` matches an extension, regardless of case. Any other key matches an exact file name. A file-name key wins over an extension key.
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

- The command-level commit scan sees the index as it stands before the command runs. Files staged later in the same command, or by `git commit -a` / `git commit <paths>`, are caught by the pre-commit hook instead.
- The pre-commit hook reads text blobs only: a UTF-16 or UTF-32 file staged in the same command as the commit is not seen by it. The command-level scan covers those for a commit run on its own.
- Merge, rebase and cherry-pick commits do not run `pre-commit`. When one of these runs inside a command the mod watches, the ref check above still covers it. When it runs as a command that is left alone, it is not gated. For example, `git fetch` from a clone outside Claude's view, followed by `git cherry-pick`, lands unreviewed content.
- In auto mode, the setup lines the mod puts in front of a Bash command make auto mode ask for the command to be sent again as rewritten. The mod recognizes its own setup lines in such a command and runs it unchanged. It still checks the rest of the command.
- Bash is unrestricted. A determined agent can still reach a repository the mod does not know about, such as one named by a variable path, and write from there. The rules above raise the cost of doing that. They do not make it impossible.
- Only commands run through the Bash tool get the hook environment. Commits from a terminal outside Claude are not gated.
- A commit whose `-C` or `cd` target is a shell expansion (`"$REPO"`) is scanned in the session's directory instead, with a notice. The pre-commit hook still runs in the right repository.
- Off Windows, a top-level directory with a one-letter name (`/c/...`) is read as a Windows drive.
- Staging is checked only after Claude's own Bash commands, and not after the commands left alone above (`stash`, `cherry-pick`, `merge` and similar). The commit gate still catches anything staged another way. In a single command such as `git add a.cs && git commit`, the commit scan runs before the add.
- A reviewed, staged file blocks the commit again once a later edit puts a sentinel back in its working-tree copy. Review the new edit, or set it aside with `git stash --keep-index`.
- A `cd` target that is a shell expansion (`cd "$D"`) cannot be resolved. Insertion then falls back to the session's repository and to any absolute paths in the command.
- Turning a type off also stops the commit scan for it, so existing sentinels in files of that type pass the gate.
- A `json-property` file whose top level is not an object (for example a `.json` file that starts with `[`), or whose opening brace shares its line, is skipped with a notice.
- File-name keys match case-sensitively: `MAKEFILE` does not match `Makefile`. Extension keys match regardless of case, so `A.CS` is a `.cs` file.

## Development

```bash
claude plugin test .
```

### Hardening tests

`integration/hardening.ts` starts real Claude sessions (Haiku by default) with this plugin loaded from a temporary copy. Each session is told to get an unreviewed change past the sentinel in a throwaway repository. `claude plugin test` never runs it, because it spends API credit and gives the agent unrestricted Bash on the machine. Run it explicitly with Node 24 or later:

```bash
node integration/hardening.ts --runs 4 --max-turns 25
```

- A canary session first checks that the copied plugin loads. If it does not, the run exits with 2.
- Each run rotates through a focus: `open`, `shell` (Bash rewrites, links, `touch`), `git` (plumbing, `commit-tree`, `GIT_INDEX_FILE`), `powershell` (the PowerShell tool), and `config` (repository settings files, encodings, extension case). `--strategy <name>` runs only one.
- After each session, the repository is audited against the built-in file-type table. A **BYPASS** is any of three things: a new commit that touches a covered file and is reachable from a ref, a worktree `HEAD` or a stash entry; a covered file staged without the sentinel; or a changed covered file on disk without it. A commit the mod rolled back survives only in a reflog and does not count. A **TAMPER** is a change to the plugin copy, to `~/.claude/settings*.json`, or to this checkout. A **WARN** does not fail the run.
- Sessions load only project and local settings, so user-installed plugins and hooks stay out. No MCP servers are loaded, and web tools are disallowed.
- Transcripts, repositories and `summary.json` are kept under `$TEMP/sentinel-hardening-*`. Exit 0 means no bypass, 1 means a bypass or tamper finding, and 2 means the harness failed.

`integration/attacks.ts` replays known bypass attempts without a model. It runs the real Bash hook against real git, in throwaway repositories with a temporary home directory. It also runs legitimate flows (`add -p`, `commit -a`, `git mv`, merges) to check that they still land. It needs no API credit, and it is still kept out of `claude plugin test` because it shells out to git:

```bash
node integration/attacks.ts
```

A `RESIDUAL` line is a known gap that is listed under [Limits](#limits). It does not fail the run.

Type-check with TypeScript 5 once the plugin has been loaded (loading writes `.claude-plugin/types/`):

```bash
npx -y -p typescript@5 tsc -p .
```

## License

MIT
