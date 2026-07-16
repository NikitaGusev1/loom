# Auto-Step Phase 3: Implement Contract

Phase 3 of the `/auto-step` loop. The supervisor runs the dag-executor CLI **directly** — no `codex exec` wrapper, no orchestration session, **zero orchestration context consumed**. The supervisor reads only the exit code and the run-total cost line from the logfile.

## CLI Invocation

```bash
dag-executor <dagPath> \
  --provider=codex \
  --model=<worker-model> \
  > <logfile> 2>&1
```

- `<dagPath>`: repo-relative path to `.claude/ai/decomposition-*.json`
- `--provider=codex`: required provider selection for worker sessions
- `--model=<worker-model>`: `account-default` or an explicit Codex model ID applied to both `defaultModel` and `heavyModel`
- `> <logfile> 2>&1`: redirects **both** stdout and stderr to the logfile — all dag-executor output uses `console.error` (stderr), so `2>&1` is required to capture it
- `--resume`: add when re-running after a prior exit code 2

Binary requirement: `dag-executor` must be on PATH (one-time setup: clone + `npm link` the [Visma-Manager/dag-executor](https://github.com/Visma-Manager/dag-executor) repo — see `/implement-dag` Prerequisites). Preflight via `command -v dag-executor`.

### Optional flags

| Flag | When to add |
|------|-------------|
| `--resume` | Exit code 2 on previous run and supervisor decided to continue |
| `--rerun=id1,id2` | Selective task re-execution within an existing state file |
| `--dry-run` | Pre-flight cost estimate; exits 0, no agent sessions spawned |

---

## Exit Code → Checkpoint Status Mapping

The exit code is the **only** signal the supervisor reads from the process (source: `src/index.ts` in the Visma-Manager/dag-executor repo).

| Exit code | dag-executor meaning | Supervisor action | Checkpoint `status` written |
|-----------|---------------------|-------------------|------------------------------|
| **0** | `finalState.status === 'completed'` — all layers finished successfully | Advance to next phase (e.g. review) | `running` (phase transitions to `reviewing`) |
| **1** | Error — validation failure, task failure, unexpected crash | Halt; surface logfile to human | `error` |
| **2** | `finalState.status === 'paused'` — interrupted or layer gate failed; state file present | Write `needs-decision` gate; human decides resume vs abort | `needs-decision` (`pendingGate: 'post-impl-pause'`) |

Exit code 2 is **resumable**: the dag-executor saves state after each completed layer. On resume the supervisor re-runs the same CLI invocation with `--resume` appended.

---

## Cost Extraction

The supervisor greps the run-total from the logfile after the process exits.

### Output format — what the logfile contains

All logger methods write to **stderr** via `console.error`. Three distinct cost line types appear:

**Per-task rows** (`taskUsage`, `logger.ts:68-77`) — `COST` label:
```
[HH:MM:SS] COST <taskId>: <in> in / <out> out, <N> turns, $X.XX (Xs)
```

**Per-layer summary** (`layerCostSummary`, `logger.ts:78-88`) — `COST` label:
```
[HH:MM:SS] COST Layer <N> total: <M> task(s), $X.XX (Xs)
```

**Run-total row** (`dagCostSummary`, `logger.ts:119-123`) — **no `COST` label, no timestamp**:
```
Total        <in>      <out>   <turns>  $X.XX
```
Emitted as a bare bold table row (ANSI `\x1b[1m...\x1b[0m`), after the per-task table and its closing separator line, followed by one blank line. This is the **last** line printed before exit (source: `executor.ts:1064` — `dagCostSummary` is called after `saveState`, immediately before process exit).

### Two distinct grep targets — do not conflate

| Target | What it is | How to grep |
|--------|-----------|-------------|
| **Run total** | The `Total` table row from `dagCostSummary` — aggregate across all tasks and layers | `grep "Total" <logfile> \| tail -1` |
| **Final-layer total** | The last `COST`-labeled row from `layerCostSummary` — only the last layer | `grep "COST" <logfile> \| tail -1` |

The supervisor uses the **run total** (`Total` row) for checkpoint accounting. The `Total` row contains `"Total"` (capital T); per-layer rows contain lowercase `"total"` in `"Layer N total:"` — so `grep "Total"` uniquely matches the run-total row.

```bash
RUN_COST=$(grep "Total" "$logfile" | tail -1)
```

> **Note:** ANSI escape codes (`\x1b[1m`, `\x1b[0m`) are present in the logfile because the logger does not check `isTTY`. Pass through `sed 's/\x1b\[[0-9;]*m//g'` if a clean string is needed for parsing.

---

## Checkpoint Writes

**Ownership: the supervisor — not a `/auto-step` phase body — owns ALL
implement-phase checkpoint writes.** Phase 3 has no `codex exec` session and no
fragment body: the dag-executor CLI never touches the checkpoint. Every write
below is performed by the supervisor shell around the CLI invocation, keyed off
the dag-executor exit code.

### On entry (no rename)

The phase is already `mode-selected` when the supervisor reaches Phase 3 (Phase 2
wrote it on exit 0). The supervisor does **not** rename the phase on entry — it
runs the dag-executor directly. (Phase 2 already set `retryCount: 0`; the
supervisor bumps it only on the exit-2 resume path.)

### After exit code 0 (success)

The supervisor advances `mode-selected` -> `reviewing` and resets `retryCount`:

```bash
dag-checkpoint merge <checkpointPath> \
  '{"phase":"reviewing","status":"running","retryCount":0}'
```

Write the extracted cost into a separate field if the schema supports it; otherwise log it to the supervisor's own output.

### After exit code 1 (error)

The supervisor's generic rc=1 handler owns this write — it merges
`pendingGate:"phase-error-${phase}"`, which for the implement phase resolves to:

```bash
dag-checkpoint merge <checkpointPath> \
  '{"status":"error","pendingGate":"phase-error-mode-selected"}'
```

Supervisor halts. Human inspects `<logfile>` and the dag-executor state file (`.claude/ai/decomposition-*.state.json`) before deciding whether to repair and retry.

### After exit code 2 (paused)

```bash
dag-checkpoint merge <checkpointPath> \
  '{"status":"needs-decision","pendingGate":"post-impl-pause"}'
```

Chat session reads the gate, writes `decision` (`continue` or `abort`). Supervisor on next tick:
- `continue` → re-run CLI with `--resume`, flip status back to `running`
- `abort` → write `status: aborted`, stop

---

## Worker Model vs Checkpoint `models` — Critical Distinction

These are **separate concerns**:

| Concept | Location | Purpose |
|---------|----------|---------|
| `--provider=codex --model=<model>` | CLI flags to dag-executor | Selects Codex and the account default or explicit Codex model for worker sessions in isolated worktrees. |
| `models` checkpoint field | `auto-run-<slug>.json` → `models` object | Records model assignments **per phase name** (with a `default` fallback) for the orchestration loop itself. Written by `/auto-run` at `init`. |

The `--model` flag does NOT read or write the checkpoint `models` map. The checkpoint `models` map does NOT control what the dag-executor passes to agent sessions — the supervisor reads `models["mode-selected"] || models.default` to decide which `--model=` value to pass to the implement-phase dag-executor, but they are distinct fields.

---

## Phase Summary

```
Phase 3: Implement
  - Driver:   supervisor shell (bash / node script)
  - Process:  dag-executor CLI (linked binary on PATH)
  - Context:  ZERO orchestration context consumed by the supervisor in this phase
  - Signal:   exit code only (0 / 1 / 2)
  - Cost:     grep "Total" <logfile> | tail -1
  - Duration: wall-clock time of CLI process (all parallelism internal to executor)
  - Resume:   --resume flag re-enters from last completed layer
```
