---
description: Fixes type errors, lint violations, and formatting issues in files touched by the current branch. Run standalone after implementation, before code review. Toolchain-agnostic — derives commands from the repo; absent checks are skipped, never faked.
phase: maintenance
---

# Cleanup

Fix pre-existing and introduced static-analysis issues in files touched by the current branch. Runs auto-fix tools first, then uses agent judgment for remaining errors.

**Scope**: Only files modified on the current branch vs the repo's default branch. Untouched files are never modified.

**Skip-don't-fail discipline**: an absent tool, script, or file class is a clean skip with a one-line note — never an error, never a faked result. A repo with no lintable diff reports "nothing to clean up" and exits 0.

## Step 0: Resolve Toolchain

Derive the repo's commands; do not assume an ecosystem:

1. **Base branch**: the repo's default branch (`git remote show origin | grep 'HEAD branch'`, fallback `main`, then `master`, then `develop` — first that exists).
2. **Toolchain by manifest**:
   - `package.json` → package manager from lockfile (`package-lock.json` -> npm, `yarn.lock` -> yarn, `pnpm-lock.yaml` -> pnpm, `bun.lockb` -> bun; never default to yarn). Commands from scripts: lint (`lint`), typecheck (`lintTypes` / `typecheck` / `tsc`), format (`format` / prettier). Files: `*.ts *.tsx *.js *.jsx *.mjs *.cjs *.vue *.svelte`.
   - `pyproject.toml` / `setup.cfg` → `ruff check --fix` / `ruff format` or configured black/flake8, plus `mypy` when configured. Files: `*.py`.
   - `go.mod` → `gofmt -w`, `go vet`. Files: `*.go`.
   - `Cargo.toml` → `cargo fmt`, `cargo clippy`. Files: `*.rs`.
   - `Makefile` with documented `lint`/`fmt` targets → use those.
3. A check with no derivable command is skipped and noted in the summary. If root `CLAUDE.md` documents commands, prefer those.

## Step 1: Detect Touched Files

1. Run `git diff --name-only <base>...HEAD` filtered to lintable extensions from Step 0.
2. If no touched lintable files: report "No lintable files touched on this branch — nothing to clean up" and exit cleanly.
3. Display the count: "Found N touched files to check".

## Step 2: Auto-Fix Pass

Run formatter/lint-fix only on touched files, not the full codebase.

1. Check for unstaged changes with `git diff --name-only`; if any exist, `git stash --keep-index` to protect work-in-progress and note the stash for Step 8.
2. Run the lint auto-fix command on touched files. Skip if no lint command was derived.
3. Run the format command on touched files. Skip if none derived.
4. If the file list exceeds roughly 50 files, pipe through `xargs`.

## Step 3: Run Checks

1. Run the derived typecheck command and capture full output. Skip if none.
2. Run the derived lint command in check mode and capture full output. Skip if none.
3. Filter both outputs to lines referencing files in the touched list.
4. If no errors remain in touched files, or all checks were skipped, report the clean summary and jump to Step 8.

## Step 4: Categorize Errors

Classify each remaining error as **easy** or **hard**.

### Easy

- Unused variables or imports
- Missing imports for known types or modules
- Simple type mismatches fixable by narrowing or a targeted assertion
- Unused parameters, by prefixing `_` or removing
- Formatting issues the formatter missed
- Simple lint-rule violations with obvious fixes

### Hard

- Complex generic/type-system errors requiring understanding of type relationships
- Errors requiring changes to files outside the touched list
- Ambiguous fixes where multiple valid approaches exist
- Errors spanning multiple interconnected files
- Errors caused by incorrect library typings or declaration files

When in doubt, classify as hard.

## Step 5: Fix Easy Errors

1. For each easy error, read the file, understand the context, and apply a targeted edit. Do not rewrite whole files.
2. Do not touch hard-classified errors here.
3. Track fixes for the summary.

## Step 6: Verify

1. Re-run the Step 3 checks, filtered to touched files.
2. If fixes introduced new errors, fix and re-verify. Stop after 3 iterations and report anything remaining.
3. Run a final formatting pass on touched files.

## Step 7: Handle Hard Errors

Present each hard error to the user:

```text
Hard error in `<file>:<line>`:
  <error message>

Analysis: <brief explanation of what's needed to fix it>

Options: (F) Fix it, (S) Skip it, (A) Abort cleanup
```

- **Fix**: attempt it, then re-verify.
- **Skip**: leave it and note it in the summary.
- **Abort**: stop cleanup and jump to Step 8.

Orchestrated autonomous runs may instruct this skill to skip Step 7 entirely and classify all remaining errors as skipped. Honor that instruction.

## Step 8: Summary

If a stash was created in Step 2, restore it with `git stash pop`.

Report:

```text
Cleanup complete.

Files checked: N
Checks run: [typecheck: <cmd> | skipped] [lint: <cmd> | skipped] [format: <cmd> | skipped]
Errors found: N
Errors fixed: N
Errors remaining: N

Fixed:
- <file>:<line> — <brief description>

Remaining:
- <file>:<line> — <error> — <reason skipped>
```

If nothing was found, simplify to:

```text
Cleanup complete. No errors found in N touched files.
```
