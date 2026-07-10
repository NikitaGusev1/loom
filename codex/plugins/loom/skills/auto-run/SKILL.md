---
name: auto-run
description: "Launch, monitor, or resume a supervised Loom/dag-executor automation run from a plan. Use when the user wants the multi-phase supervisor flow rather than manual implementation."
---

# Auto Run

Run the supervised automation flow for a plan.

## Workflow

1. Resolve the plan path. If omitted, find the newest `.claude/ai/plan-*.md` and confirm.
2. Inspect the plan frontmatter for `decomposition_path`.
3. Check that required commands are available: `loom-supervisor`, `dag-executor`, and repo verification commands.
4. Launch or resume with the command documented by this repo's `README.md` or prior checkpoint. Typical shape:

```sh
loom-supervisor <plan-path>
```

5. Keep the session focused on monitoring:
   - read checkpoint summaries, not whole logs unless debugging;
   - route approval gates to the user;
   - report failures with exact resume commands.

In Codex, use normal command sessions for monitoring. If a background launch requires shell behavior or permissions outside the sandbox, request escalation explicitly.
