# Auto-Step Phase Bodies: Judgment Phases (1, 7, 8)

Reusable phase-body fragments for the `/auto-step` supervisor. Each section is a
self-contained execution contract for one judgment phase. The supervisor spawns
a headless agent, passes it the checkpoint path and phase number, and the agent
executes exactly this body — nothing more.

**Default model for all three phases: `opus`.**  
The supervisor selects the model from `checkpoint.models` keyed by **phase name**
(`models[phase] || models.default`) — e.g. `models["validate-plan"]` for Phase 1,
`models["triage-review"]` for Phase 7, `models["evaluate-review"]` for Phase 8.
The phase body documents the default; it does not call the model selector itself.

**All checkpoint I/O must go through the `dag-checkpoint` helper (dag-executor plugin bin/, on PATH).**  
Never write checkpoint JSON directly. Never echo review bodies, diff output, or
full plan text to stdout — ingest only YAML frontmatter fields and exit codes.

---

## Exit Code Convention

| Code | Meaning |
|------|---------|
| `0`  | Phase completed; checkpoint advanced to next phase or `done`. |
| `1`  | Hard stop — checkpoint `status` set to `error`; do not resume automatically. |
| `2`  | Gated — checkpoint `status` set to `needs-decision`, `pendingGate` written; supervisor waits for chat to set `decision`. |

---

## Phase 1: Validate Plan

**Orchestration position**: first phase, before any implementation.  
**Default model**: `opus` (plan-reviewer subagent pinned to opus).  
**Ingests**: plan YAML frontmatter `status` field + plan-reviewer verdict string only. Never reads the full plan body for routing decisions.

### Entry

```bash
CKPT="$1"   # path to .claude/ai/auto-run-<slug>.json
# checkpoint helper: dag-checkpoint (dag-executor plugin bin/, on PATH while plugin enabled)

PLAN_PATH=$(dag-checkpoint get "$CKPT" planPath)
RUN_MODE=$(dag-checkpoint get "$CKPT" runMode)    # human | autonomous
DECISION=$(dag-checkpoint get "$CKPT" decision 2>/dev/null || echo "")
```

### Resume path

If `DECISION` is non-empty, a prior run parked at a needs-decision gate and the
chat session has since written a verdict. Clear the gate and branch:

```bash
if [ -n "$DECISION" ]; then
  dag-checkpoint merge "$CKPT" '{"status":"running","pendingGate":null,"decision":null}'

  case "$DECISION" in
    proceed)
      # Human approved proceeding despite NEEDS_REVISION — advance to phase 2.
      dag-checkpoint merge "$CKPT" '{"phase":"mode-selection","status":"running"}'
      exit 0
      ;;
    abort | *)
      dag-checkpoint merge "$CKPT" '{"status":"aborted"}'
      exit 1
      ;;
  esac
fi
```

### Step 1 — Check plan frontmatter status

Read **only the YAML frontmatter block** of the plan file (lines between the
opening `---` and the closing `---`). Extract the `status` field.

- If `status: approved` (case-insensitive) is present → continue to Step 2.
- If `status` is absent, or has any other value (e.g. `draft`, `in-progress`):
  - **Human mode**: write needs-decision gate and exit 2:
    ```bash
    dag-checkpoint merge "$CKPT" \
      '{"status":"needs-decision","pendingGate":"plan-not-approved","phase":"validate-plan"}'
    echo "GATE:plan-not-approved"
    echo "PROMPT:Plan at $PLAN_PATH does not have status: approved."
    echo "OPTIONS:proceed|abort"
    exit 2
    ```
  - **Autonomous mode**: write error and exit 1:
    ```bash
    dag-checkpoint merge "$CKPT" '{"status":"error","phase":"validate-plan"}'
    echo "ERROR: autonomous mode — refusing to implement unapproved plan: $PLAN_PATH"
    exit 1
    ```

### Step 2 — Run plan-reviewer agent

Spawn a `plan-reviewer` subagent (model: `opus`) with the plan path as its sole
argument. The plan-reviewer validates file references, API/prop assumptions,
persist whitelist, navigation wiring, translations, and testIDs against the
actual codebase. Wait for completion.

Parse **only the verdict line** from the agent's output. The verdict is one of:
`READY`, `NEEDS_REVISION`, or `BLOCKED`. Ignore all other output — never relay
the full reviewer body to the checkpoint or to routing logic.

```
REVIEWER_VERDICT=$(... parse first line matching /^(READY|NEEDS_REVISION|BLOCKED)/)
```

### Step 3 — Route on verdict

#### READY

```bash
dag-checkpoint merge "$CKPT" '{"phase":"mode-selection","status":"running"}'
exit 0
```

#### NEEDS_REVISION

- **Human mode** — write needs-decision gate and exit 2:
  ```bash
  dag-checkpoint merge "$CKPT" \
    '{"status":"needs-decision","pendingGate":"plan-needs-revision","phase":"validate-plan"}'
  echo "GATE:plan-needs-revision"
  echo "PROMPT:plan-reviewer returned NEEDS_REVISION. Fix the plan first, or proceed anyway?"
  echo "OPTIONS:proceed|abort"
  exit 2
  ```
- **Autonomous mode** — write error and exit 1:
  ```bash
  dag-checkpoint merge "$CKPT" '{"status":"error","phase":"validate-plan"}'
  echo "ERROR: autonomous mode — plan has NEEDS_REVISION gaps; halting."
  exit 1
  ```

#### BLOCKED

Hard stop in any mode. The plan has fatal issues (e.g. references nonexistent
files or APIs).

```bash
dag-checkpoint merge "$CKPT" '{"status":"error","phase":"validate-plan"}'
echo "ERROR: plan-reviewer returned BLOCKED — fatal plan issues; halting."
exit 1
```

### Checkpoint state on exit

| Exit | `status` | `phase` | `pendingGate` |
|------|---------|---------|--------------|
| 0    | `running` | `mode-selection` | `null` |
| 1    | `error` | `validate-plan` | `null` |
| 2    | `needs-decision` | `validate-plan` | `plan-not-approved` or `plan-needs-revision` |

---

## Phase 7: Triage Review

**Orchestration position**: after Phase 6 (Simplify), before Phase 8.  
**Default model**: `opus` (review-triager subagent pinned to opus).  
**Ingests**: review YAML frontmatter `critical_count` and `warning_count` integers (pre-triage), then post-triage frontmatter field set for validation. Never reads the review finding bodies or diff output.

### Entry

```bash
CKPT="$1"
# checkpoint helper: dag-checkpoint (dag-executor plugin bin/, on PATH while plugin enabled)

REVIEW_PATH=$(dag-checkpoint get "$CKPT" reviewPath)
```

No resume path: Phase 7 has no human-mode gate. Any failure is a hard stop.

### Step 1 — Read pre-triage frontmatter

Read **only the YAML frontmatter block** of `$REVIEW_PATH`. Extract:
- `critical_count` (integer, required)
- `warning_count` (integer, required)

If either field is missing or non-integer, halt:

```bash
dag-checkpoint merge "$CKPT" '{"status":"error","phase":"triage-review"}'
echo "ERROR: review frontmatter missing critical_count or warning_count"
exit 1
```

### Step 2 — Skip path

```bash
if [ $((critical_count + warning_count)) -eq 0 ]; then
  echo "No CRITICAL or WARNING findings — skipping triage"
  dag-checkpoint merge "$CKPT" '{"phase":"evaluate-review","status":"running"}'
  exit 0
fi
```

Do NOT set `triaged: true` on the review file. Phase 8's back-compat branch
handles a missing `triaged` field correctly.

### Step 3 — Dispatch triage

Run `/triage-review "$REVIEW_PATH"` and wait for completion. The skill spawns
the `review-triager` agent which edits the review file in place. Capture the
exit code; a non-zero exit triggers the crash check in Step 4.

### Step 4 — Post-run validation (fail-loud)

After the triage agent completes, re-read **only the YAML frontmatter** of
`$REVIEW_PATH`. Do NOT read the finding bodies. Extract the updated field set.

Halt with a clear error message (naming the specific failing check) and exit 1
if any of the following are true:

1. The triage agent crashed or exited non-zero.
2. Frontmatter is missing `triaged: true`.
3. Frontmatter is missing `triaged_at`.
4. Frontmatter is missing `backlog_count`, OR `backlog_count` is negative or
   non-integer.
5. Any CRITICAL or WARNING finding block lacks a `**Triage:**` line OR a
   `**Reason:**` line. Scan finding heading lines `### C<n>` / `### W<n>` /
   `### CRITICAL <n>` / `### WARNING <n>` — both heading formats are valid.
6. Any `**Triage:**` value is not in `{confirmed, deferred, rejected}`.
7. Any `deferred` CRITICAL or WARNING finding block lacks a `**Backlog:**` line
   OR a `**BacklogReason:**` line.
8. Any SUGGESTION block lacks a `**Backlog:**` line OR a `**BacklogReason:**`
   line (when the SUGGESTIONS section is non-empty).
9. Any `**Backlog:**` value is not in `{yes, no}`.
10. `backlog_count` ≠ actual count of `**Backlog:** yes` lines across
    CRITICAL/WARNING/SUGGESTIONS sections.
11. Post-triage `critical_count > raw_critical_count` — counts can only shrink
    or stay equal (monotone-shrink invariant).
12. Post-triage `warning_count > raw_warning_count` — same monotone-shrink
    invariant.
13. Post-triage `critical_count` or `warning_count` is negative or non-integer.

For checks 5–8, include the specific finding heading (e.g.
`### C2 Missing null guard`) in the error message so the operator can locate it
without reading the full file.

```bash
dag-checkpoint merge "$CKPT" '{"status":"error","phase":"triage-review"}'
echo "ERROR: triage validation failed — <specific check>"
exit 1
```

Do NOT enter Phase 8 in any failure case. The operator must repair the review
file by hand and re-run.

### Step 5 — Advance

All validation checks passed.

```bash
dag-checkpoint merge "$CKPT" '{"phase":"evaluate-review","status":"running"}'
exit 0
```

### Checkpoint state on exit

| Exit | `status` | `phase` | Notes |
|------|---------|---------|-------|
| 0    | `running` | `evaluate-review` | Normal advance (or skip-on-zero). |
| 1    | `error` | `triage-review` | Validation failure; operator must repair review file. |

**Mode behavior**: identical in human and autonomous modes. There is no gate and
no override on the validation checks — a malformed triage output is always a
hard fault.

---

## Phase 8: Evaluate Review

**Orchestration position**: after Phase 7 (Triage Review), or re-entered after
Phase 9 (Fix Issues) cycles back through Phase 5 and Phase 6.  
**Default model**: `opus` (all judgment; no generative code work in this phase).  
**Ingests**: review YAML frontmatter verdict fields only (`triaged`,
`verdict`, `critical_count`, `warning_count`, `plan_issue`, `fixable_by_ai`,
`retry_recommended`, `backlog_count`). Never reads the full review body or
finding prose. Never reads diffs.

### Entry

```bash
CKPT="$1"
# checkpoint helper: dag-checkpoint (dag-executor plugin bin/, on PATH while plugin enabled)

PLAN_PATH=$(dag-checkpoint get "$CKPT" planPath)
REVIEW_PATH=$(dag-checkpoint get "$CKPT" reviewPath)
RETRY_COUNT=$(dag-checkpoint get "$CKPT" retryCount)
RUN_MODE=$(dag-checkpoint get "$CKPT" runMode)    # human | autonomous
DECISION=$(dag-checkpoint get "$CKPT" decision 2>/dev/null || echo "")
```

### Resume path

If `DECISION` is non-empty, the phase previously parked at a needs-decision
gate (Path B or Path C below). Clear the gate and branch on the decision value:

```bash
if [ -n "$DECISION" ]; then
  dag-checkpoint merge "$CKPT" '{"status":"running","pendingGate":null,"decision":null}'

  case "$DECISION" in
    proceed-to-done | proceed)
      dag-checkpoint merge "$CKPT" '{"phase":"done","status":"done"}'
      exit 0
      ;;
    fix)
      dag-checkpoint merge "$CKPT" '{"phase":"fix-issues","status":"running"}'
      exit 0
      ;;
    abort | *)
      dag-checkpoint merge "$CKPT" '{"status":"aborted"}'
      exit 1
      ;;
  esac
fi
```

### Step 1 — Check for stale review

Check whether any source file tracked by git was modified **after** the
modification timestamp of `$REVIEW_PATH`. This detects code changes made by
Phase 5 (Cleanup) or Phase 6 (Simplify) since the last review was written.

- If no review file exists at all: this is a pipeline error. Phase 3 should have
  produced one. Do not silently run `/code-review` here; halt instead:
  ```bash
  dag-checkpoint merge "$CKPT" '{"status":"error","phase":"evaluate-review"}'
  echo "ERROR: no review file found at $REVIEW_PATH — pipeline error in Phase 3"
  exit 1
  ```

- If files were modified after the review timestamp: run `/code-review` to
  generate a fresh review. Parse only the output path (the new
  `.claude/ai/review-*.md` filename) from the skill's final output line.
  Update the checkpoint:
  ```bash
  NEW_REVIEW_PATH="<parsed from /code-review output>"
  dag-checkpoint merge "$CKPT" "{\"reviewPath\":\"$NEW_REVIEW_PATH\"}"
  REVIEW_PATH="$NEW_REVIEW_PATH"
  ```

### Step 2 — Read verdict frontmatter

Read **only the YAML frontmatter block** of `$REVIEW_PATH`. Extract these fields
and coerce to their native types (boolean / integer):

| Field | Type | Notes |
|-------|------|-------|
| `triaged` | boolean | Optional; absent or `false` = raw-counts back-compat path. |
| `verdict` | string | Informational; overridden by Step 3 recompute. |
| `critical_count` | integer | Post-triage when `triaged: true`; raw otherwise. |
| `warning_count` | integer | Post-triage when `triaged: true`; raw otherwise. |
| `plan_issue` | boolean | Read as written — **never default to `false`**. See note. |
| `fixable_by_ai` | boolean | |
| `retry_recommended` | boolean | |
| `backlog_count` | integer | Present only when `triaged: true`; informational, does not affect routing. |

> **`plan_issue` note**: the review-triage Workflow hardcodes `plan_issue: false`
> in its rendered frontmatter (`review-triage.js:204`), but a review produced by
> the prose `/code-review` CAN set `plan_issue: true`. Always read the actual
> value from the frontmatter — never assume it can only be false.

### Step 3 — Recompute verdict

Compute the recomputed verdict from `critical_count` and `warning_count` (the
values read in Step 2 — post-triage when `triaged: true`, raw otherwise):

```
critical_count > 0  →  REJECTED
warning_count  > 0  →  APPROVED_WITH_CONDITIONS
else            →  APPROVED
```

The `verdict` field stored in the review file is informational. Always use the
recomputed value for routing.

### Step 4 — Route on recomputed verdict

#### Path A: APPROVED (0 critical, 0 warnings)

```bash
dag-checkpoint merge "$CKPT" '{"phase":"done","status":"done"}'
exit 0
```

#### Path B: APPROVED_WITH_CONDITIONS (0 critical, N warnings)

- **Human mode** — write needs-decision gate and exit 2:
  ```bash
  dag-checkpoint merge "$CKPT" \
    '{"status":"needs-decision","pendingGate":"warnings-gate","phase":"evaluate-review"}'
  echo "GATE:warnings-gate"
  echo "PROMPT:Code review passed with $warning_count warning(s). No critical issues."
  echo "OPTIONS:proceed-to-done|fix|abort"
  exit 2
  ```

- **Autonomous mode**:
  - `warning_count ≤ 3` → advance to done:
    ```bash
    dag-checkpoint merge "$CKPT" '{"phase":"done","status":"done"}'
    exit 0
    ```
  - `warning_count > 3` → advance to fix cycle:
    ```bash
    dag-checkpoint merge "$CKPT" '{"phase":"fix-issues","status":"running"}'
    exit 0
    ```

#### Path C: REJECTED (N critical issues)

Evaluate sub-conditions in order:

**C1. `plan_issue: true`** — always stop, any mode:

```bash
dag-checkpoint merge "$CKPT" '{"status":"error","phase":"evaluate-review"}'
echo "STOP: plan_issue=true — run /enhance-plan $PLAN_PATH $REVIEW_PATH, then re-run /auto-implement $PLAN_PATH"
exit 1
```

**C2. `fixable_by_ai: false` OR `retry_recommended: false`** — always stop, any
mode:

```bash
dag-checkpoint merge "$CKPT" '{"status":"error","phase":"evaluate-review"}'
echo "STOP: fixable_by_ai=$fixable_by_ai retry_recommended=$retry_recommended — escalating; create /handoff"
exit 1
```

**C3. `fixable_by_ai: true` AND `retry_recommended: true`** (auto-fixable):

- **Human mode** — write needs-decision gate and exit 2:
  ```bash
  dag-checkpoint merge "$CKPT" \
    '{"status":"needs-decision","pendingGate":"fix-approval","phase":"evaluate-review"}'
  echo "GATE:fix-approval"
  echo "PROMPT:Review REJECTED with $critical_count critical issue(s). AI can fix. Approve fix cycle?"
  echo "OPTIONS:fix|abort"
  exit 2
  ```

- **Autonomous mode** — advance to fix cycle:
  ```bash
  dag-checkpoint merge "$CKPT" '{"phase":"fix-issues","status":"running"}'
  exit 0
  ```

### Checkpoint state on exit

| Exit | `status` | `phase` | `pendingGate` | Trigger |
|------|---------|---------|--------------|---------|
| 0    | `done` | `done` | `null` | Path A; autonomous B ≤ 3 warnings; resume proceed-to-done |
| 0    | `running` | `fix-issues` | `null` | Autonomous B > 3; autonomous C3; resume fix |
| 1    | `error` | `evaluate-review` | `null` | No review file; plan_issue=true; unfixable; aborted |
| 2    | `needs-decision` | `evaluate-review` | `warnings-gate` | Human mode Path B |
| 2    | `needs-decision` | `evaluate-review` | `fix-approval` | Human mode Path C3 |

> **Re-entry after fix cycle (Phase 9)**: Phase 9 increments `retryCount` in the
> checkpoint and transitions to Phase 5 (Cleanup). After Cleanup and Simplify
> run, the supervisor transitions to Phase 7 (Triage Review), which then
> transitions here. On re-entry, Step 1 detects that the fix cycle produced
> new code newer than the last review and triggers a fresh `/code-review`. The
> rest of the phase body is identical.
>
> **Max retries**: Phase 9 owns the retry counter check. Phase 8 does not
> inspect `retryCount` — it routes on review content alone.
