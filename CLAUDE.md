# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

claude-sentinel is a Claude Code mod (plugin `sentinel@isabel-nh`). It inserts a manual-review sentinel line into every covered file Claude writes, and holds back commits until a person deletes the line. README.md is the behavior spec: every user-visible change updates it, including its Limits section.

## Branches and pull requests

- Never commit to `main` and never push `main`. All changes go through a pull request on `isabel-nh/claude-sentinel`.
- Start each task in its own git worktree on a new branch cut from `origin/main`. Use the `EnterWorktree` tool, not `git worktree add` (git-guard denies it). Do not edit the main checkout at `C:/git/isabel-nh/claude-sentinel`.
- Commit on the task branch, push the branch, and open the PR with `gh pr create --base main`.
- Uncommitted changes already in the main checkout belong to other sessions. Leave them alone; do not fold them into a task branch.
- Bump the version in `.claude-plugin/plugin.json` in the PR. `claude plugin update` only picks up a version change. The installed plugin updates from `main` only after the PR merges: `claude plugin marketplace update isabel-nh`, then `claude plugin update sentinel@isabel-nh`, then restart Claude Code.

## Commands

The unit suite runs every `tests/*.test.ts(x)` in the engine's test kit (`claude-code/testing`). It has no single-test filter. Run it in the background:

```bash
claude plugin test .
```

The attack suite replays known bypasses and everyday flows through the real Bash handler against real git, in throwaway repositories with a temporary HOME. It runs in a few minutes and costs no API credit. Run it for any change to `hooks/bash.ts`, `hooks/origin.ts`, `hooks/git-hooks.ts` or `hooks/command.ts`:

```bash
node integration/attacks.ts
```

- `--verbose` prints each command's outcome; `--prologue` runs the `git-env` fallback instead of process-env routing.
- `RESIDUAL` marks a known gap listed under Limits in README.md and does not fail the run.

Type-check (needs `.claude-plugin/types/`, which loading the plugin writes):

```bash
npx -y -p typescript@5 tsc -p .
```

`integration/hardening.ts` starts real Haiku sessions that try to get past the sentinel. It spends API credit and gives the agent unrestricted Bash, so run it only when asked.

## Architecture

- `hooks/register.ts` is the single entry point (`hooks/hooks.json`). One `tool.call` hook dispatches Write, Edit, MultiEdit, Bash, PowerShell and the `commit_gate_status` tool. The loader forbids passing `$` as a value, so each hook body builds a `HostIO` from `$.process`/`$.fs`/`$.env` itself. Every other module works on the `Host` seam (`hooks/host.ts`), which keeps the logic testable without the engine.
- `hooks/bash.ts` `onBash` wraps each Bash command in one sequence. The `next` call covers the permission prompt and auto mode's review as well as the command itself, so anything a person does meanwhile lands inside the window.
  1. Before the command:
     - deny hook bypasses and plumbing (`hooks/command.ts`);
     - deny `git add` of sentinel-bearing files (`hooks/stage.ts`);
     - capture a baseline per repository the command touches (`hooks/origin.ts` `captureBaseline`): HEAD, refs, stored working-tree blobs, staged entries.
  2. Write the baseline to `~/.claude/sentinel/baselines/<id>.tsv` and run the command.
  3. After the command:
     - roll back refs moved onto unreviewed commits;
     - unstage unreviewed staged content;
     - mark changed files (`hooks/detect.ts` `changedSince`, then `hooks/apply.ts`);
     - unstage staged sentinels.
- `hooks/git-hooks.ts` generates `~/.claude/sentinel/git-hooks/`: the `sentinel-scan` pre-commit script (a shell port of the scan and review-origin rule) and one shim per client-side hook name. The shims hand over to the repository's own hooks. `core.hooksPath` reaches every Bash child through `GIT_CONFIG_PARAMETERS` in the mod's process env (`routeProcessHooks`). Because one process env serves all commands, Bash calls are serialized. The fallback is a `git-env` prologue in front of the command (`withHooks`/`splitPrologue`), which must replay byte-identically for auto mode.
- In-band versus out-of-band: during a command, the `reference-transaction`, `pre-push` and `post-index-change` shims append the command's own ref updates and index writes to `<baseline>.moves`. Rollback and unstaging judge only what that record attributes to the command, so commits and staging a person does from a terminal meanwhile are left alone. A missing record falls back to judging everything.
- File types: `hooks/types.ts` builds the table from the built-ins plus the `fileTypes` option. `hooks/styles.ts` places the line, `hooks/encoding.ts` handles BOMs and UTF-16/32, `hooks/pane.tsx` is the `/sentinel-types` editor, and `hooks/selftest.ts` backs `/sentinel-selftest`.

## Conventions specific to this repo

- The mod's own source must never hold the full marker text. `hooks/rules.ts` assembles `MARKER` from words, and generated scripts split it across shell words, because a file with the marker in its first lines reads as carrying a sentinel and blocks its own commit.
- Bash commands in this repo cannot name `SENTINEL_BASELINE`, `GIT_CONFIG_*` or `~/.claude/sentinel`: the mod denies them as hook bypasses. Use the Read and Grep tools to inspect code that mentions them.
- New git-facing behavior gets an `integration/attacks.ts` scenario. A legitimate flow uses `expect: 'lands'` or `'staged'`, and a bypass attempt uses `'blocked'`. Pass a `during` callback to `bash()` to simulate a person acting in a terminal while a command is pending.
- The mod fails open: a crash or failed git call lets the tool call proceed with a notice. Only the rules' own denials deny.
- For the engine API (`$.tool`, `$.env`, `$.session`, test kit), load the `plugin-authoring` skill.
