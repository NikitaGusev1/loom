---
name: plan-from-spec
description: "Create an implementation plan from an approved spec without repeating broad discovery. With --auto-implement, produce an approved plan and immediately launch Loom's autonomous implementation pipeline."
---

# Plan From Spec

Use `gpt-5.6-terra` with medium reasoning. The approved spec already contains the design decisions, so Sol-level reasoning is unnecessary.

Turn an existing spec into an implementation plan.

## Artifact Repository

Before locating a spec or writing a plan, load `../../references/artifact-repository.md`. Prefer central artifacts under `projects/<project-slug>/` over older project-local docs unless the user gives an explicit path.

## Inputs

- Preferred: explicit path to a spec file.
- `--auto-implement`: the standard handoff from `explore`; suppress normal confirmation, mark the
  plan approved, validate it, and launch `auto-implement --mode autonomous`.
- If no path is provided, find the newest approved spec in the central artifact repo, then fall back to `.claude/ai/spec-*.md` or `.codex/ai/spec-*.md`, and confirm it is the intended source.

## Workflow

1. Read the spec fully.
2. Do a targeted freshness check only where the spec references files, APIs, or assumptions.
3. Resolve gaps with focused file reads. With `--auto-implement`, ask the user only if a gap would
   materially change the approved design and cannot be resolved safely from the codebase.
4. Write the durable plan at `projects/<project-slug>/plans/plan-YYYY-MM-DD-description.md` in the central artifact repo. Also copy it to `.claude/ai/` only when the next tool requires a project-local path.
5. With `--auto-implement`, use `status: approved`, run the plan reviewer automatically, and fix
   focused non-design issues for up to 3 iterations. Stop only for a fatal issue or a required design
   change.
6. After validation succeeds, invoke `auto-implement <plan-path> --mode autonomous`. Do not ask for
   plan approval, execution-mode selection, or implementation approval; the approved spec supplies
   that authorization. The downstream pipeline retains its documented hard stops and guardrails.

## Plan Shape

```markdown
---
date: YYYY-MM-DD
author: Codex
status: <approved when --auto-implement; otherwise draft>
related_spec: <spec path>
decomposition_path:
---

# <Title>

## Summary
## Preconditions
## Tasks
1. <task>
   - Files:
   - Changes:
   - Tests:
## Verification
## Rollback
## Open Questions
```

Plans should be executable by another agent: concrete files, ordered steps, expected tests, and no hidden design decisions.
