---
name: cleanup
description: "Fix type errors, lint violations, and formatting issues in files touched by the current branch. Use after implementation and before review when static checks or formatting need cleanup."
---

# Cleanup

Model policy: use `gpt-5.6-terra` with medium reasoning for safe mechanical fixes.

Clean only files touched by the current branch.

## Workflow

1. Determine the base branch: default remote HEAD, then `main`, `master`, `develop`.
2. Find touched files with `git diff --name-only <base>...HEAD` plus unstaged/staged changes.
3. Derive commands from repo docs and manifests:
   - JS/TS: package-manager scripts for lint, typecheck, format.
   - Python: `ruff`, `black`, `mypy`, or documented commands.
   - Go: `gofmt`, `go vet`.
   - Rust: `cargo fmt`, `cargo clippy`.
4. Run auto-fix/format commands scoped to touched files when the tool supports file arguments.
5. Run lint/typecheck and fix straightforward issues in touched files only.
6. Stop and ask before making broad architectural changes or touching unrelated files.
7. Summarize files checked, commands run, fixes made, and remaining issues.

Absent commands are clean skips, not failures. Do not invent tooling.
