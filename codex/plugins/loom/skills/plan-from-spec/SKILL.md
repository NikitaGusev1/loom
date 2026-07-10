---
name: plan-from-spec
description: "Create an implementation plan from an existing spec document, especially one produced by explore. Use when the user has an approved spec and wants a concrete build plan without repeating broad discovery."
---

# Plan From Spec

Turn an existing spec into an implementation plan.

## Inputs

- Preferred: explicit path to a spec file.
- If no path is provided, find the newest `.claude/ai/spec-*.md` or `.codex/ai/spec-*.md` and confirm it is the intended source.

## Workflow

1. Read the spec fully.
2. Do a targeted freshness check only where the spec references files, APIs, or assumptions.
3. Resolve gaps with focused file reads or a concise user question.
4. Write a plan at `.claude/ai/plan-YYYY-MM-DD-description.md`.

## Plan Shape

```markdown
---
date: YYYY-MM-DD
author: Codex
status: draft
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
