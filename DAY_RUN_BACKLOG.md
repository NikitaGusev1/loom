# Day-Run Autonomy Backlog

Working backlog for making Loom safe and useful for all-day autonomous executor runs.

## Current Baseline

`loom-supervisor` can supervise one DAG in backlog mode:

- runs `dag-executor <dag> --backlog`;
- resumes after process crashes;
- waits and retries quota / usage-limit pauses;
- stops on ordinary pauses that need human judgment;
- writes `<dag>.supervisor.json`;
- writes attempt logs under `<dag-dir>/.loom-supervisor/logs/`.

This is enough for short unattended runs, but not yet enough to confidently leave it running all day.

## Backlog

### 1. Detached Day-Run Command — Complete

Add a command such as `loom-day-run <dag>` or `loom-supervisor --detach <dag>`.

Status: complete. Initial implementation landed with `loom-day-run`, `loom-supervisor --detach`, duplicate-run protection, macOS `caffeinate` support, and `loom-supervisor --stop`.

Acceptance criteria:

- Starts the supervisor in the background.
- Uses `caffeinate` on macOS when available so the machine does not sleep mid-run.
- Writes PID, checkpoint, and log paths.
- Refuses to start a duplicate supervisor for the same DAG unless explicitly forced.
- Provides a clear command for stopping the run.

### 2. Status / Monitor Command — Complete

Add `loom-status <dag>` or `loom-supervisor --status <dag>`.

Status: complete. Added `loom-supervisor --status <dag>` and `loom-status <dag>`, backed by the supervisor checkpoint, DAG state, and latest `dag.paused` event reason.

Acceptance criteria:

- Shows supervisor state: running, waiting, paused, completed, stopped, or aborted.
- Shows current attempt, last exit code, last log path, and next retry time.
- Shows DAG task counts: completed, failed, pending, blocked.
- Shows the latest pause reason when paused.
- Exits non-zero when the run is blocked or missing.

### 3. Stronger Preflight Checks — Complete

Add preflight validation before day-run mode starts.

Status: complete. `loom-supervisor` now validates the DAG, checks `dag-executor`, provider CLI, and `git`, probes git worktree creation, detects stale DAG locks and supervisor PID files, blocks dirty repos unless `--allow-dirty-repo` is passed, and runs a cheap provider `--version` smoke check.

Acceptance criteria:

- Confirms DAG file exists and validates.
- Confirms `dag-executor`, `codex`, and `git` are available.
- Confirms the target repo can create worktrees.
- Detects stale DAG locks and stale supervisor PID files.
- Warns or blocks on dirty repo state unless explicitly allowed.
- Runs a cheap provider smoke check when possible.

### 4. Human-Readable Handoff Summary — Complete

Write a summary file at the end of every supervisor stop.

Status: complete.

Acceptance criteria:

- Records completed, merged, failed, blocked, and pending tasks.
- Includes last log path and checkpoint path.
- Includes exact resume command.
- Includes likely next human action for common blockers.
- Uses stable Markdown so it can be pasted into a new Codex session.

### 5. Continue Past Independent Blockers — Complete

Improve backlog semantics so one permanently failed task does not unnecessarily stop unrelated ready work.

Status: complete. Implemented in `src/backlog-readiness.ts`; pause events/state now include blocked-task metadata for direct permanent failures and dependency-blocked descendants.

Acceptance criteria:

- Distinguishes dependency-blocking failures from independent failures.
- Continues running ready tasks that do not depend on blocked tasks.
- Emits blocked-task metadata into state / handoff.
- Stops only when no runnable task remains.
- Preserves current safety behavior for merge conflicts, base branch movement, and verification failures.

### 6. Better Quota / Limit Detection

Make quota handling less dependent on a narrow regex over pause reason text.

Status: complete. Retry policy now classifies quota pauses with structured metadata (`category`, `reason`, optional `resetAt` / `retryAfterMs`), `dag.paused` and derived state preserve it, and `loom-supervisor` prefers that metadata when deciding quota waits and checkpointing `nextRunAt`.

Acceptance criteria:

- Preserves structured quota decisions from retry policy through DAG pause state.
- Covers daily, weekly, monthly, usage, credit, token, and account limit wording.
- Records next retry time in the supervisor checkpoint.
- Avoids tight retry loops when the provider gives no reset time.

### 7. Queue Beyond One DAG

Introduce a persistent task queue above individual DAG files.

Acceptance criteria:

- Tracks multiple DAGs or task groups.
- Lets workers take the next runnable item.
- Persists queue state across restarts.
- Supports pause, resume, cancel, and priority.
- Can run for a full day without relying on one chat context.

## Recommended Order

1. Detached day-run command.
2. Status / monitor command.
3. Preflight checks.
4. Handoff summary.
5. Continue past independent blockers.
6. Better quota metadata.
7. Multi-DAG queue.
