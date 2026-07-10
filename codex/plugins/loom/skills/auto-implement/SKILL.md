---
name: auto-implement
description: "Run the end-to-end Loom implementation pipeline from an approved plan: review plan, decompose, implement, cleanup, review, triage, and fix confirmed issues."
---

# Auto Implement

Coordinate the full implementation pipeline.

## Workflow

1. Resolve the plan path. If none is supplied, find the newest `.claude/ai/plan-*.md` and confirm.
2. Read the plan and determine whether it has a `decomposition_path`.
3. Prefer the supervised DAG path for multi-task work:
   - use `auto-run` when the user wants the checkpointed supervisor;
   - use `decompose` first if no DAG exists and parallel execution is useful;
   - use `implement-dag` to execute a ready DAG.
4. For small or sequential work, use `implement-plan`.
5. After implementation:
   - run `cleanup`;
   - run `simplify` if changes are non-trivial;
   - run `code-review`;
   - run `triage-review` if the review has CRITICAL or WARNING findings;
   - fix confirmed blocking findings and re-run verification/review as needed.

Keep each phase's output artifact in `.claude/ai/` so Claude and Codex workflows can share state.
