---
description: Thin chat-side launcher, monitor, and gate-router for the /auto-implement supervisor loop
argument-hint: <plan-path> [--mode human|autonomous] [--models judgment=opus,mechanical=sonnet] [--slug <run-id>]
phase: orchestration
disable-model-invocation: true
---

# Auto Run

Thin launcher, monitor, and gate-router for the `/auto-implement` supervisor loop. This **is** the default substrate of `/auto-implement` — that skill delegates here for any DAG-mode plan (invoke `/auto-run` directly, or let `/auto-implement` route to it). The chat session does exactly three things and no more:

1. **Launch** — create the initial checkpoint and background the supervisor
2. **Monitor** — poll the compact checkpoint (status, phase, pendingGate, counts only)
3. **Gate** — surface `needs-decision` gates to the human, write `decision`, flip `status → running`

**Context discipline**: Before checkpoint initialization, the launcher may read plan frontmatter, invoke `/decompose --plan`, and ingest only `task_count`, `max_width`, and `has_heavy` to ensure the run is DAG-capable. After launch it holds no implementation work and never reads plan bodies, review bodies, diffs, or supervisor logs; monitoring ingests compact checkpoint fields only.

**Model philosophy**: Model is chosen by reasoning need, not window size. Opus 4.8 and Sonnet both have 200k context — model determines reasoning quality. Judgment phases get Opus 4.8; mechanical phases get Sonnet. User overrides apply at launch time.

---

## Step 1 — Parse Arguments

Parse `$ARGUMENTS` to extract:

- **Plan path** (required): the first positional argument ending in `.md`
- **Mode**: `autonomous` if not specified; `human` only if `--mode human` or `--human` appears
- **Forced execution mode**: explicit `dag` when `--dag` appears; otherwise unspecified. Direct `--no-dag` is unsupported because this launcher is DAG-only. For a new checkpoint, persist unspecified as `null`; for resume, an omitted flag reuses the stored value.
- **Judgment model** (default `claude-opus-4-8`): from `--models judgment=<value>`
- **Mechanical model** (default `claude-sonnet-4-6`): from `--models mechanical=<value>`
- **Slug**: from `--slug <value>` if present; otherwise derived from the plan filename by stripping the `plan-` prefix and `.md` suffix (e.g. `plan-2026-06-04-vmm-7218.md` → `2026-06-04-vmm-7218`)

If no plan path is found in `$ARGUMENTS`, stop and ask the user to supply one.

---

## Step 2 — Resolve Absolute Paths

All paths passed to the supervisor, checkpoint helper, and the `nohup` launch command **must be absolute**. The Bash tool does not persist `cwd` between invocations.

Run one Bash call to resolve and export all paths:

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
CKPT_PATH="$REPO_ROOT/.claude/ai/auto-run-${SLUG}.json"
LOGFILE="$REPO_ROOT/.claude/ai/auto-run-logs/auto-run-${SLUG}-launcher.log"
# Supervisor ships in the dag-executor plugin; resolve the absolute path from
# the PATH-visible bin/ wrapper so nohup gets a stable target.
SUPERVISOR="$(command -v dag-auto-run-supervisor)" || { echo "ERROR: dag-auto-run-supervisor not on PATH — is the dag-executor plugin installed and enabled?"; exit 1; }

mkdir -p "$REPO_ROOT/.claude/ai"
mkdir -p "$REPO_ROOT/.claude/ai/auto-run-logs"
```

Use these variables verbatim in every subsequent Bash call. Never use `./` or `~` in paths passed to the supervisor or checkpoint helper.

## Step 2.5 — Ensure Decomposition Before Checkpoint Init

This bounded, idempotent preflight is the only plan-reading exception in the launcher:

1. If `CKPT_PATH` already exists, read only `runId`, `planPath`, `planDigest`, `decompositionDigest`, `phase`, `mode`, `forceMode`, `status`, and `dagPath`. Resolve stored `planPath` against `REPO_ROOT` and require its canonical path to equal the requested plan. Require a non-empty `runId` and recognized status. When both digest fields exist, require SHA-256 of the current files to match them. When both are absent on a legacy checkpoint, first complete all canonical path, statistics, and readiness checks below, then atomically backfill both digests before resume; if only one digest exists, hard-stop as corrupt partial migration. When the invocation explicitly supplies `--dag`, require stored `forceMode` to match; when omitted, reuse the stored value. Hard-stop on conflict; a predictable slug must never select another plan's checkpoint.
   - Resolve the plan's current `decomposition_path` canonically and require it to remain inside `REPO_ROOT`, equal canonical checkpoint `dagPath` when that field is present, and match immutable `decompositionDigest`. This binds a same-plan checkpoint to the exact validated artifact.
   - When `dagPath` is present, require the bound artifact to pass both `dag-executor --decomposition-stats` and `dag-executor --dag-readiness`; reuse it without mutating the plan or replacing the checkpoint.
   - When `dagPath` is null only in pre-selection phase `validate-plan` or `mode-selection`, validate the bound plan-linked artifact and preserve the existing checkpoint. A null path in any later phase is corrupt state and must hard-stop.
2. For a new checkpoint, or a resumable pre-selection checkpoint without `dagPath`, read `decomposition_path` from plan frontmatter. Reuse it only if `dag-executor --decomposition-stats "$DECOMP_PATH"` succeeds.
3. If absent or invalid, invoke `/decompose --plan <plan-path>`, re-read the linked path, and run `--decomposition-stats` again.
4. If no valid path exists after generation, stop before Step 5. Missing or invalid evidence is a hard error, never zero-valued sequential statistics.
5. If `--dag` was supplied, require `--dag-readiness` and select DAG regardless of automatic thresholds. Otherwise apply the authoritative thresholds from `auto-implement` to the validated JSON result.
   - If measured mode is sequential, do **not** initialize or launch the DAG-only supervisor. Return: `Measured mode is sequential; run /auto-implement <plan-path> --inline, or use --dag only after an execution-ready decomposition passes dag-readiness.`
   - If measured mode is DAG, require `dag-executor --dag-readiness "$DECOMP_PATH"` to pass, then continue.

Log `Decomposition: reused|generated — path=<path>` and the standard measured mode line. Never load the decomposition body into chat context.
For a new run, compute SHA-256 `planDigest` after the final frontmatter link is written and `decompositionDigest` from the validated project-local JSON; persist both at checkpoint init.
Legacy digest backfill is a one-time migration, not permission to replace either value after it exists.

---

## Step 3 — Build Models Map

Construct the `models` JSON object keyed by **phase name**. The supervisor resolves model as `models[phase] || models.default || "sonnet"`.

Defaults by phase role:

| Phase name       | Role       | Default model       |
|------------------|------------|---------------------|
| `validate-plan`  | judgment   | `claude-opus-4-8`   |
| `mode-selection` | mechanical | `claude-sonnet-4-6` |
| `mode-selected`  | implement  | `claude-sonnet-4-6` |
| `reviewing`      | mechanical | `claude-sonnet-4-6` |
| `figma-verified` | mechanical | `claude-sonnet-4-6` |
| `cleaned`        | mechanical | `claude-sonnet-4-6` |
| `simplified`     | judgment   | `claude-opus-4-8`   |
| `evaluate-review`| judgment   | `claude-opus-4-8`   |
| `fix-issues`     | mechanical | `claude-sonnet-4-6` |
| `default`        | fallback   | `claude-sonnet-4-6` |

The `mode-selected` key is the **dag-executor worker `--model`** for Phase 3 (Implement). The supervisor resolves `models["mode-selected"] || models.default` and passes it as `--model=` to the dag-executor CLI. It is not a `claude -p` orchestration session — it controls the worker agents that run task implementations inside worktrees.

Apply user overrides from `--models`:
- `judgment=<alias>` replaces the model for all judgment-role phases (`validate-plan`, `simplified`, `evaluate-review`)
- `mechanical=<alias>` replaces the model for all mechanical-role phases (`mode-selection`, `reviewing`, `figma-verified`, `cleaned`, `fix-issues`), the implement worker (`mode-selected`), and `default`

Accepted aliases: `opus`, `sonnet`, `haiku`, or a full model ID (e.g. `claude-opus-4-8`). These are passed through verbatim to `claude --model`.

---

## Step 4 — Derive Run ID

```bash
RUN_ID="auto-run-${SLUG}-$(date -u +%Y%m%dT%H%M%SZ)"
```

This is the stable `runId` stored in the checkpoint. It never changes after init.

---

## Step 5 — Init Checkpoint

```bash
dag-checkpoint init "$CKPT_PATH" '<initial-json>'
```

`init` is a no-op when the checkpoint already exists (idempotent — safe to call again on resume).

Initial JSON object (substitute real values before calling):

```json
{
  "runId": "<RUN_ID>",
  "planPath": "<repo-relative plan path>",
  "planDigest": "<sha256 of linked approved plan>",
  "decompositionDigest": "<sha256 of validated DAG JSON>",
  "phase": "validate-plan",
  "runMode": "<human|autonomous>",
  "forceMode": "<dag|null>",
  "mode": null,
  "status": "running",
  "retryCount": 0,
  "pendingGate": null,
  "decision": null,
  "models": {
    "validate-plan": "<judgment-model>",
    "mode-selection": "<mechanical-model>",
    "mode-selected": "<mechanical-model>",
    "reviewing": "<mechanical-model>",
    "figma-verified": "<mechanical-model>",
    "cleaned": "<mechanical-model>",
    "simplified": "<judgment-model>",
    "evaluate-review": "<judgment-model>",
    "fix-issues": "<mechanical-model>",
    "default": "<mechanical-model>"
  }
}
```

`planPath` must be stored **repo-relative** (strip `$REPO_ROOT/` prefix if the plan path is absolute). The supervisor resolves it via `resolve_repo_path`.
`forceMode` preserves a validated explicit DAG override across the launcher/Phase 2 boundary.
`planDigest` and `decompositionDigest` bind resume to the approved plan and exact validated DAG; they are immutable after init or validated legacy migration.

Fields omitted from init (supervisor writes these later): `dagPath`, `reviewPath`.

After init, dump and print a launch summary:

```
Run ID:     <runId>
Plan:       <planPath>
Mode:       <mode>
Checkpoint: <CKPT_PATH>
Models:     judgment=<alias>, mechanical=<alias>
```

---

## Step 6 — Background the Supervisor

Launch the supervisor detached so it survives across chat turns while the chat
session only monitors.

**In Claude Code (the normal case): launch via the Bash tool's background
execution — set `run_in_background: true` on the Bash call.** The command is just:

```bash
bash "$SUPERVISOR" "$CKPT_PATH" > "$LOGFILE" 2>&1
```

**Do NOT use `nohup … & disown`.** A bare-`&` background job spawned inside a
Bash tool call is reaped when that call returns — it does not survive the
tool-call boundary, so the supervisor dies before it can advance even the first
phase (observed: process gone, checkpoint frozen on `validate-plan`).
`run_in_background: true` is the only durable mechanism here: the process is
detached, persists across turns, and the harness re-notifies the chat when it
exits. The harness returns a background task ID; do not block on it.

(In a raw terminal *outside* Claude Code, the equivalent durable launch is
`nohup bash "$SUPERVISOR" "$CKPT_PATH" > "$LOGFILE" 2>&1 & disown`.)

After launch, print:

```
Supervisor launched (PID: <pid>)
Log: <LOGFILE>
```

**PREVENT**: Do not `tail`, `cat`, or otherwise read `$LOGFILE` from the chat session. The logfile is for the human to inspect after the fact. The chat session reads only the compact checkpoint via `dag-checkpoint`.

---

## Step 7 — Monitor Loop

Enter a polling loop. On each iteration:

### 7a — Read Compact Checkpoint

Read only these fields — no other file reads:

```bash
STATUS=$(dag-checkpoint get "$CKPT_PATH" status)
PHASE=$(dag-checkpoint get "$CKPT_PATH" phase)
GATE=$(dag-checkpoint get "$CKPT_PATH" pendingGate)
```

### 7b — Branch on Status

| `status`         | Action |
|------------------|--------|
| `running`        | Print progress line; sleep 15s; loop |
| `needs-decision` | Enter **Gate Routing** (Step 8) |
| `done`           | Print completion summary; exit loop |
| `aborted`        | Print abort notice; exit loop |
| `error`          | Print error notice with checkpoint + logfile paths; exit loop |

### 7c — Progress Line

While `status=running`, print on each poll:

```
[<HH:MM:SS UTC>] phase=<phase>  status=running
```

If the chat session context remaining is below ~30%, append a context note:

```
[context] ~<N>% free  (note: remaining_percentage includes a ~16.5% auto-compact buffer; true free ≈ N − 16.5%)
```

### 7d — Poll Interval

```bash
sleep 15
```

---

## Step 8 — Gate Routing

Entered whenever `status=needs-decision`. Execute in sequence:

### G1 — Read Gate Name

Gate name is already in `$GATE` from Step 7a.

### G2 — Surface Gate Prompt

Display:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
GATE: <gate-name>
Phase: <phase>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

<prompt text — see table below>

Options: continue | abort | <gate-specific options>
```

Gate name → prompt:

| Gate name              | Prompt text |
|------------------------|-------------|
| `post-impl-pause`      | DAG implementation paused. Review partial output and decide whether to resume or abort. |
| `plan-not-approved`    | Plan lacks `status: approved`. Confirm you want to proceed, or abort to fix the plan first. |
| `plan-needs-revision`  | Plan reviewer found gaps. Review findings in the supervisor log, then confirm proceed or abort. |
| `warnings-gate`        | Review passed with warnings. Proceed to done (warnings noted), or trigger a fix cycle. |
| `fix-approval`         | Human mode: approve the fix cycle for a REJECTED review. Proceed to fix or abort. |
| `supervisor-halt`      | Supervisor triggered /handoff. Check logfile for halt reason. Decide abort or (if recoverable) continue. |
| `phase-error-<phase>`  | Phase `<phase>` reported a hard error (exit 1) and the supervisor halted. Inspect the logfile for the failure, then abort or (if repaired) continue. |
| `phase-pause-<phase>`  | Phase `<phase>` paused unexpectedly. Check logfile. Decide continue or abort. |
| `sequential-not-supported` | Defensive legacy/corrupt-checkpoint guard: supervised Phase 2 resolved sequential even though the launcher only starts measured DAG runs. Abort and restart through `/auto-implement <plan> --inline`; do not manufacture a DAG merely to clear the gate. |

For any unrecognized gate name, surface: `Supervisor paused at gate "<gate-name>". Inspect the checkpoint/log and decide: continue | abort`.

### G3 — Await Human Decision

Wait for the human to type their response. Accept any text:
- `continue`, `yes`, `proceed` → decision value: `continue`
- `abort`, `stop` → decision value: `abort`
- `skip` → decision value: `skip`
- Any other text → pass through verbatim as the decision value

### G4 — Write Decision (THIS FIELD ONLY)

```bash
dag-checkpoint set "$CKPT_PATH" decision "<decision-value>"
```

**Anti-clobber**: The chat session writes ONLY the `decision` field at this step. Do NOT write `phase`, `pendingGate`, `models`, `planPath`, `dagPath`, `mode`, `runMode`, `retryCount`, `reviewPath`, or any other field. Those are owned by the supervisor, `/auto-run` init, and headless phases.

### G5 — Flip Status → Running

```bash
dag-checkpoint merge "$CKPT_PATH" '{"status":"running"}'
```

This is the only status transition the chat session may write, and only in this one case (`needs-decision → running`). Never write any other status value here.

### G6 — Confirm and Resume Polling

Print:

```
Decision recorded: <decision-value>
Supervisor resuming...
```

Return to Step 7 (monitor loop).

---

## Human-Initiated Abort

If the human types `abort` or `stop` outside a gate prompt while the supervisor is running:

1. Print: `Aborting run <runId>...`
2. Write abort status — this is the only other status write the chat session may perform:

```bash
dag-checkpoint merge "$CKPT_PATH" '{"status":"aborted"}'
```

3. The supervisor's park loop detects `status=aborted` and exits cleanly.
4. Print: `Run aborted. Checkpoint preserved at: <CKPT_PATH>`

---

## Terminal Output Templates

### `status=done`

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Run complete: <runId>
Checkpoint: <CKPT_PATH>

Next step: /create-pr
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### `status=aborted`

```
Run aborted: <runId>
Checkpoint preserved at: <CKPT_PATH>
```

### `status=error`

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Run halted: <runId>
Checkpoint: <CKPT_PATH>
Supervisor log: <LOGFILE>

The supervisor invoked /handoff. Inspect the log for the halt reason.
To dump checkpoint: dag-checkpoint dump <CKPT_PATH>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## Anti-Clobber Summary

| Field            | Chat may write?     | When                                   |
|------------------|---------------------|----------------------------------------|
| `decision`       | YES                 | Step G4 — after human confirms a gate  |
| `status=running` | YES (one case only) | Step G5 — `needs-decision → running`   |
| `status=aborted` | YES (one case only) | Human-initiated abort only             |
| All other fields | **NO**              | Never — supervisor/phases own them     |

---

## Example Usage

### Default (human mode, default models):

```
/auto-run .claude/ai/plan-2026-06-04-vmm-7218.md
```

### Autonomous mode:

```
/auto-run .claude/ai/plan-2026-06-04-vmm-7218.md --mode autonomous
```

### Override models at launch:

```
/auto-run .claude/ai/plan-2026-06-04-vmm-7218.md --models judgment=claude-opus-4-8,mechanical=claude-sonnet-4-6
```

### Autonomous + custom slug:

```
/auto-run .claude/ai/plan-2026-06-04-vmm-7218.md --mode autonomous --slug vmm-7218-run2
```

### Lightweight run (all phases on sonnet):

```
/auto-run .claude/ai/plan-2026-06-04-vmm-7218.md --models judgment=claude-sonnet-4-6,mechanical=claude-sonnet-4-6
```
