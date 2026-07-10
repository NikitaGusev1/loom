---
name: auto-step
description: "Advance or inspect one phase of a Loom/dag-executor automated run. Use when supervising an existing checkpointed run one step at a time."
---

# Auto Step

Operate on a single checkpointed automation phase.

## Workflow

1. Locate the checkpoint or state file from the user's path, `.claude/ai/`, or the latest supervisor output.
2. Read only the compact state needed to understand the current phase.
3. If a helper command is available, prefer it over reimplementing phase logic:

```sh
dag-checkpoint <checkpoint-path>
```

or the command documented in the run output.

4. Report the current phase, gate status, next action, and any required user decision.
5. If the phase requires code edits, switch to the relevant skill (`implement-plan`, `cleanup`, `triage-review`, or `code-review`) rather than mixing responsibilities.

Do not auto-approve gates that require human judgment unless the user requested autonomous mode.
