---
name: implement-plan
description: "Implement an approved plan directly in Codex. Use for sequential implementation from a plan when a DAG run is unnecessary or unavailable."
---

# Implement Plan

Implement a written plan with normal Codex editing and verification.

## Workflow

1. Read the plan fully. Confirm any unresolved open questions before editing.
2. Learn the repo's commands from `CLAUDE.md`, `AGENTS.md`, `README.md`, package manifests, and lockfiles.
3. Work task-by-task in plan order.
4. Keep edits scoped to the plan and local conventions.
5. Run focused verification after each meaningful batch, then final verification.
6. Run `simplify` when the implementation is complete and non-trivial.
7. Run `code-review` before calling the work complete, unless the user explicitly asks to skip review.

If the plan references a DAG and the user wants parallel execution, use `implement-dag` instead.
