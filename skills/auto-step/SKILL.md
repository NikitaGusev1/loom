---
description: Single-phase headless executor for the /auto-implement supervisor loop. Reads checkpoint.phase, runs exactly that one phase, writes the updated checkpoint, and exits with the supervisor signal code. One invocation == one phase.
argument-hint: --resume-run <checkpoint-path>
phase: orchestration
disable-model-invocation: true
---

# Auto Step

Headless single-phase runner for the `/auto-implement` supervisor loop. **One invocation executes exactly one pipeline phase**, then exits. The loop lives in the supervisor — never here. This is the refresh boundary: each phase gets a clean `claude -p` context.

**Session model: set by the supervisor, not by this skill.** Each phase is launched as a one-shot `claude -p … --model <m>`, where `<m>` comes from the supervisor's **per-phase model map** (`models[phase] || models.default`, seeded by `/auto-run`: judgment phases → Opus 4.8, mechanical/routing phases → sonnet). A `-p` run can't `/model`-switch mid-session, so there is no in-session mandate to honor — the map is authoritative. (For a rare manual interactive `/auto-step` run, prefer Opus 4.8: the judgment phases want it.) Judgment phases (1, 7, 8) also spawn subagents internally pinned to Opus 4.8 regardless of the session model.

## Exit Code Contract (Resumable Signal)

The supervisor reads **only the exit code** — it never parses stdout. Exit code semantics mirror the dag-executor contract:

| Code | Meaning | Checkpoint state written | Supervisor action |
|------|---------|-------------------------|-------------------|
| `0`  | Phase advanced successfully | `status: running`, `phase: <next-phase>` | Re-read checkpoint, dispatch next phase |
| `1`  | Hard stop — do not auto-resume | `status: error` | Halt; surface checkpoint + logs to human |
| `2`  | Paused / needs human decision | `status: needs-decision`, `pendingGate: <gate-name>` | Park; wait for chat session to write `decision`; re-invoke same phase |

Exit 2 is **resumable**: the checkpoint phase is unchanged. After the chat session writes `decision`, the supervisor re-invokes `/auto-step --resume-run <ckpt>` for the same phase. Each phase body checks `DECISION` at entry and handles the resume path internally.

## Parameters

Parse from `$ARGUMENTS`:

- `--resume-run <ckpt>` (required): Repo-relative path to the checkpoint file at `.claude/ai/auto-run-<slug>.json`

```bash
CKPT=$(echo "$ARGUMENTS" | sed 's/.*--resume-run[= ]*//' | awk '{print $1}')
```

## Checkpoint Helper

All checkpoint I/O MUST go through the `dag-checkpoint` helper (dag-executor plugin bin/, on PATH while the plugin is enabled). Never write checkpoint JSON directly. Never echo review bodies, diff output, or full plan text to stdout — ingest only YAML frontmatter fields and exit codes.

```bash
# checkpoint helper: dag-checkpoint (dag-executor plugin bin/, on PATH while plugin enabled)

# Read a single field
VALUE=$(dag-checkpoint get "$CKPT" fieldName)

# Merge fields atomically (never clobbers fields not in the patch)
dag-checkpoint merge "$CKPT" '{"phase":"next-phase","status":"running"}'
```

Schema reference: `${CLAUDE_PLUGIN_ROOT}/references/auto-run-checkpoint.md`

## Entry

Read the phase to dispatch:

```bash
CKPT=$(echo "$ARGUMENTS" | sed 's/.*--resume-run[= ]*//' | awk '{print $1}')
# checkpoint helper: dag-checkpoint (dag-executor plugin bin/, on PATH while plugin enabled)

PHASE=$(dag-checkpoint get "$CKPT" phase)
```

If the checkpoint file does not exist or `PHASE` is empty:

```bash
echo "ERROR: checkpoint not found or missing phase field: $CKPT"
exit 1
```

## Dispatch Table

Branch on `$PHASE` and execute **exactly one** phase body. The fragments are the authoritative source — do not adapt or summarize their logic.

| `checkpoint.phase` at invocation | Phase | Source |
|----------------------------------|-------|--------|
| `validate-plan` | 1 — Validate Plan | `${CLAUDE_PLUGIN_ROOT}/references/auto-step-phases-judgment.md` § "Phase 1: Validate Plan" |
| `mode-selection` | 2 — Mode Selection | `${CLAUDE_PLUGIN_ROOT}/references/auto-step-phases-mechanical.md` § "Phase 2 — Mode Selection" |
| `mode-selected` | 3 — Implement | **Supervisor CLI only** — `/auto-step` is never invoked for this phase; see note below |
| `reviewing` | 4 — Figma Verification | `${CLAUDE_PLUGIN_ROOT}/references/auto-step-phases-mechanical.md` § "Phase 4 — Figma Verification (Post-Merge Diff)" |
| `figma-verified` | 5 — Cleanup | `${CLAUDE_PLUGIN_ROOT}/references/auto-step-phases-mechanical.md` § "Phase 5 — Cleanup" |
| `cleaned` | 6 — Simplify | `${CLAUDE_PLUGIN_ROOT}/references/auto-step-phases-mechanical.md` § "Phase 6 — Simplify" |
| `simplified` | 7 — Triage Review (first run) | `${CLAUDE_PLUGIN_ROOT}/references/auto-step-phases-judgment.md` § "Phase 7: Triage Review" |
| `triage-review` | 7 — Triage Review (re-entry after operator repair) | `${CLAUDE_PLUGIN_ROOT}/references/auto-step-phases-judgment.md` § "Phase 7: Triage Review" |
| `evaluate-review` | 8 — Evaluate Review | `${CLAUDE_PLUGIN_ROOT}/references/auto-step-phases-judgment.md` § "Phase 8: Evaluate Review" |
| `fix-issues` | 9 — Fix Issues | See Phase 9 body below |

Any other `$PHASE` value (`done`, `error`, `aborted`, `needs-decision`, or unknown):

```bash
echo "ERROR: unexpected checkpoint.phase='$PHASE' — auto-step has nothing to run"
exit 1
```

These are terminal or park states that the supervisor handles directly; `/auto-step` is never invoked with them.

---

### Phase 3 Delegation (mode-selected)

**`/auto-step` is never invoked when `checkpoint.phase == mode-selected`.**

When Phase 2 writes `phase: mode-selected` and exits 0, the supervisor reads the checkpoint directly, then runs the dag-executor CLI instead of spawning a claude session:

```bash
dag-executor <dagPath> \
  --model=<resolved: checkpoint.models["mode-selected"] || checkpoint.models.default> \
  > <logfile> 2>&1
```

Zero Claude context is consumed during Phase 3. The supervisor maps dag-executor exit codes to checkpoint writes per `${CLAUDE_PLUGIN_ROOT}/references/auto-step-phase-implement.md`. After Phase 3 exit 0, the supervisor writes `phase: reviewing` and re-enters the dispatch loop (which invokes `/auto-step` for Phase 4).

---

### Phase 9: Fix Issues

Phase 9 has no dedicated fragment. Execute this body when `checkpoint.phase == fix-issues`.

**Entry:**

```bash
CKPT="$CKPT"
# checkpoint helper: dag-checkpoint (dag-executor plugin bin/, on PATH while plugin enabled)

RETRY_COUNT=$(dag-checkpoint get "$CKPT" retryCount)
MAX_RETRIES=$(dag-checkpoint get "$CKPT" maxRetries 2>/dev/null || echo "2")
REVIEW_PATH=$(dag-checkpoint get "$CKPT" reviewPath)
PLAN_PATH=$(dag-checkpoint get "$CKPT" planPath)
```

**Step 1 — Increment and check retry counter:**

```bash
NEW_RETRY=$((RETRY_COUNT + 1))
dag-checkpoint merge "$CKPT" "{\"retryCount\":${NEW_RETRY}}"

if [ "$NEW_RETRY" -gt "$MAX_RETRIES" ]; then
  dag-checkpoint merge "$CKPT" '{"status":"error","phase":"fix-issues"}'
  echo "ERROR: max retries ($MAX_RETRIES) exceeded — create /handoff"
  exit 1
fi
```

**Step 2 — Apply targeted fixes:**

Run `/implement-plan` with BOTH the plan path AND the review file path. This triggers fix-from-review mode: the implementer reads review issues and applies targeted fixes to flagged code only. No re-implementation of passing work.

If `/implement-plan` crashes or exits non-zero:

```bash
dag-checkpoint merge "$CKPT" '{"status":"error","phase":"fix-issues"}'
echo "ERROR: /implement-plan fix run failed"
exit 1
```

**Step 3 — Advance to Cleanup:**

```bash
dag-checkpoint merge "$CKPT" '{"phase":"figma-verified","status":"running"}'
exit 0
```

Phase 4 (Figma Verification) is skipped on the retry path — the supervisor dispatches directly to Phase 5 (Cleanup) via `phase: figma-verified`. Phase 8 (Evaluate Review) handles stale-review detection; it re-runs `/code-review` automatically if code changed since the last review timestamp.

**Exit codes:**

| Code | `status` | `phase` | Trigger |
|------|---------|---------|---------|
| `0`  | `running` | `figma-verified` | Fixes applied; advancing to Phase 5 (Cleanup) |
| `1`  | `error` | `fix-issues` | Max retries exceeded or `/implement-plan` crashed |

---

## Checkpoint State Summary

Full picture of what each phase writes on each exit path. Use this to verify the dispatch loop covers all reachable states.

| Phase | Entry `checkpoint.phase` | Exit 0 → `phase` | Exit 1 → `phase` | Exit 2 → `phase` / `pendingGate` |
|-------|--------------------------|------------------|------------------|-----------------------------------|
| 1 — Validate Plan | `validate-plan` | `mode-selection` | `validate-plan` | `validate-plan` / `plan-not-approved` or `plan-needs-revision` |
| 2 — Mode Selection | `mode-selection` | `mode-selected` | _(unchanged)_ | — |
| 3 — Implement (supervisor CLI) | `mode-selected` | `reviewing` | _(unchanged)_ | _(unchanged)_ / `post-impl-pause` |
| 4 — Figma Verification | `reviewing` | `figma-verified` | _(unchanged)_ | — |
| 5 — Cleanup | `figma-verified` | `cleaned` | _(unchanged)_ | — |
| 6 — Simplify | `cleaned` | `simplified` | _(unchanged)_ | — |
| 7 — Triage Review | `simplified` or `triage-review` | `evaluate-review` | `triage-review` | — |
| 8 — Evaluate Review | `evaluate-review` | `done` or `fix-issues` | `evaluate-review` | `evaluate-review` / `warnings-gate` or `fix-approval` |
| 9 — Fix Issues | `fix-issues` | `figma-verified` | `fix-issues` | — |

Phase 3 is the only phase where exit 2 is possible from the dag-executor (`post-impl-pause`). All other phases that have no exit-2 row are hard-stop-only on failure.

## Supervisor Contract (Non-Normative)

This skill is intended to be invoked by a supervisor process, not by a human directly. For reference, the supervisor loop is:

1. Read `checkpoint.phase` after init (or after previous phase exit).
2. If `phase == mode-selected`: run dag-executor CLI per `${CLAUDE_PLUGIN_ROOT}/references/auto-step-phase-implement.md`; write checkpoint; re-read phase.
3. If `phase` is terminal (`done`, `aborted`) or parked (`needs-decision`): stop / wait.
4. Otherwise: `claude -p /auto-step --resume-run <ckpt> --model <phase-model>`
   - Model selection from `checkpoint.models`, keyed by **phase name** with a `default` fallback (`models[phase] || models.default`): judgment-role phase names (`validate-plan`, `simplified`/`triage-review`, `evaluate-review`) default to Opus 4.8; mechanical-role phase names (`mode-selection`, `reviewing`, `figma-verified`, `cleaned`, `fix-issues`) default to sonnet.
5. Read exit code only. Branch per the exit code contract above.
6. On exit 2: wait for chat session to write `decision`, then go to step 4 for the same phase.
