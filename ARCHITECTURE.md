# dag-executor — Architecture

Living document describing the post-Phase-1 (v2) execution path and load-bearing invariants. There is no v1/failure-model branch; the flags `--failure-model`, `--migrate-state`, and `--validate-events` have been removed.

---

## End-to-End Flow

### 1. CLI (`src/index.ts`)

The entry point parses positional and keyword arguments:

| Argument                         | Purpose                                              |
| -------------------------------- | ---------------------------------------------------- |
| `<dag.json>`                     | Path to the decomposition DAG                        |
| `--resume`                       | Re-enter from last saved layer                       |
| `--rerun=id1,id2`                | Reset specific tasks to pending and re-execute       |
| `--dry-run`                      | Print layer/task plan with cost estimates, then exit |
| `--model=opus\|sonnet\|haiku`    | Override default + heavy model                       |
| `--force-worktree-reset=id1,id2` | Force-recreate worktrees for listed tasks            |
| `--slots`                        | Print machine-wide slot snapshot and exit            |
| `--memory=<path>`                | Use a specific curated project memory file           |
| `--no-memory`                    | Disable curated project memory prompt injection      |

After parsing, it reads the DAG file, validates it with Zod (`validateDAG`), builds an `ExecutorConfig`, installs a cooperative SIGINT handler (first Ctrl-C sets AbortController; second force-exits), then calls `executeDAG`.

### 2. State Initialisation

`executeDAG` (`src/executor.ts`) reconstructs or creates execution state before touching the git tree:

- **Fresh run** — `createState(dag, config)` builds all tasks as `pending`, all layers empty.
- **`--resume`** — `loadStateFromEvents(dagPath, dag, config)`:
  1. Derives the event log path (`dag.events.jsonl`).
  2. `readEvents` reads the JSONL file line by line.
  3. `replay` folds every event through the pure `reduce` function starting from `initialState` — reconstructing the full in-memory state without touching `.state.json`.
- **`--rerun`** — same replay as `--resume`, then emits `task.reset` for each listed task ID, which rewinds `currentLayer` to the earliest reset task's layer.

The dag-level lock (`acquireLock`) is claimed at this point to prevent concurrent invocations on the same `dagPath`.

### 3. Baseline Capture

Before entering the layer loop, the executor captures:

```
baseBranch   = git branch --show-current
baseCommitSha = git rev-parse HEAD   (mutable — updated after each trivial batch and after each merge)
```

`dag.started` is emitted via `emitHelper` (see Invariant d).

### 4. Layer Loop

`dag.executionLayers` is iterated in ascending `layer` order. Layers numbered below `state.currentLayer` are skipped (resume skip-ahead).

**Empty-tasks fast path** — if every task in a layer is already `completed`:

- Check for pending-merge tasks (completed but never merged on a prior interrupted run). If found, `mergeLayerWorktrees` is called immediately, then `baseCommitSha` is updated.
- Emit `layer.completed` and continue.

**Active layer** — emit `layer.started`, verify all declared dependencies are `completed`, then split the layer's tasks by weight.

### 5a. Trivial Batch (weight = `'trivial'`)

All trivial tasks in the layer are collected and sent as a single batched Claude Code session running in `process.cwd()` (the main branch, no worktree):

1. Emit `task.started` for each task.
2. `buildBatchedTrivialPrompt(tasks)` — single compound prompt.
3. `runQuery` with `TRIVIAL_TOOLS` (no `Agent` tool) and a shared deadline covering all tasks.
4. On success: `autoCommit` scoped to declared file paths + contract outputs.
5. `git rev-parse HEAD` → update `baseCommitSha` (the batch advanced HEAD on the main branch).
6. Per-task no-op check: if a task declared file outputs but none appear in `filesModified`, emit `task.failed` instead of `task.completed`.
7. Emit `task.completed` or `task.failed` per task.
8. **Tier-1 verification** (after the no-op loop settles, when no task permanently no-op'd): run the detected checks (`src/verify/`) against the batch's committed changes on main; on failure, re-invoke the batch session up to `VERIFICATION_MAX_FIX_ATTEMPTS` with the errors (committing each fixup). Exhaustion → emit `task.verification-failed` per task and return failure.
9. If any task failed (no-op or verification): `pauseDag` (state saved, resume with `--resume`). The committed work stays on main — there is no worktree to discard.

### 5b. Non-Trivial Worktree Tasks (weight = `'standard'` | `'heavy'`)

Each non-trivial task gets an isolated git worktree:

1. `createWorktreeSafe(task.id, baseBranch, { forceResetIds })` — creates or force-resets the worktree on a branch named after the task ID.
2. Emit `worktree.created` + `task.started`.

All worktrees are then executed concurrently (`Promise.allSettled`):

#### Slot Claim

Inside `runQuery`, before spawning the Claude Code session:

```
releaseSlot = await acquireSlot(taskId, { signal })
```

`acquireSlot` (see Invariant a) blocks here until a machine-wide slot is free, then claims it atomically via `O_CREAT|O_EXCL` on a file in `~/.dag-executor/slots/`.

#### Spawn

`streamClaudeCli` (`src/claude-cli.ts`) spawns the `claude` binary as a child process — `claude -p --output-format stream-json --verbose` — and yields parsed NDJSON messages. The prompt is fed over stdin (avoids `ARG_MAX` and the CLI's 3s no-stdin stall). Flags:

- child `cwd` set to the worktree path
- `--model` chosen by weight (`heavyModel` for `'heavy'`, `defaultModel` otherwise)
- `--max-budget-usd` from `WEIGHT_BUDGET_USD[weight]` — the hard runaway-cost guard
- `--max-turns` from `WEIGHT_MAX_TURNS[weight]` — best-effort (the CLI does not document this flag)
- `--permission-mode` from `config.permissionMode` + `--dangerously-skip-permissions`
- `--allowedTools = ALLOWED_TOOLS` (includes `Agent`)
- `--setting-sources user,project,local`, `--no-session-persistence`
- the `claude_code` system prompt is the CLI default (no flag needed)

The result event carries the same telemetry the Agent SDK exposed — `modelUsage` (camelCase, per-model), `total_cost_usd`, `num_turns`, `duration_ms`, `duration_api_ms` — folded into `TaskUsage`. (The repo previously called the Agent SDK's `query()`; the binary is the same runtime the SDK wrapped, so the swap removed a dependency without changing behavior.) The slot is released in a `finally` block whether the session succeeds, fails, or times out.

#### Tier-1 Verification Gate

After the session returns, *before* `autoCommit`, `executeTaskPasses` runs the detected checks (`src/verify/`) against the worktree's uncommitted changes (`runVerifyFixLoop`). On failure it re-invokes the session **in the same worktree** up to `VERIFICATION_MAX_FIX_ATTEMPTS` (2) with the failing output appended. If still failing, it emits `task.verification-failed` and returns `failed` **without committing** — so the caller's `throw` routes through `decide` to `permanentFailedIds`, and the worktree is excluded from the merge. A fresh worktree has no `node_modules`, so JS checks **skip** here (never false-fail); Tier-2 on merged main is the backstop. Skipped entirely under `--no-verify` or when no command was detected.

#### Deadline

`createTaskDeadline({ deadlineMs: WEIGHT_DEADLINE_MS[weight] })` wraps an `AbortSignal`. If the session exceeds the weight-specific deadline, the signal fires and `runQuery` throws. The executor detects `deadline.wasDeadlineAbort()` and emits `task.timeout` instead of `task.failed`. (Fix re-invokes share the task's deadline.)

#### Retry Loop

After all parallel sessions settle:

1. For each fulfilled result, check `filesModified`. A task with declared file outputs that produced zero modifications emits `task.failed` (silent no-op).
2. For each failed/timed-out/no-op task, `decide(readEvents(eventLogPath), taskId)` consults the event log and returns:
   - `retry` — re-queue with `delayMs`; emit `task.retry`; reuse existing worktree; emit `task.started`; run the session again.
   - `permanent` — add to `permanentFailedIds`.
   - `succeeded` — treat as success (terminal success event found in log).

The loop repeats with `activeTasks = nextRetryTasks` until empty.

If all tasks in the layer permanently failed → emit `layer.failed` → `pauseDag`.  
If some succeeded and some permanently failed → `layerCompletedWithFailures = true` (continues to merge the successes).

### 6. Base-Unchanged Check

Before merging any worktree back into the main branch:

```
verifyBaseUnchanged(baseBranch, baseCommitSha)
```

Resolves the current HEAD of `baseBranch` and compares it against `baseCommitSha`. If they differ (an external push occurred while tasks were running), emit `dag.base-moved` → `pauseDag`. The operator must manually rebase/merge the new commits and resume.

### 7. Merge

`mergeLayerWorktrees(succeededTaskIds)` merges each succeeded task's branch into the main branch one by one. On conflict: emit the conflict info → `pauseDag`.

After a successful merge, `git rev-parse HEAD` → update `baseCommitSha` so the next layer's base-unchanged check compares against the executor's own merge commits, not the pre-merge SHA.

Emit `worktree.merged` per task.

### 7.5. Tier-2 Merged-Whole Verification

After the merge (and base re-record), for **every** layer including the last — i.e. *outside* the next-layer contract guard below — the executor runs the detected checks (`src/verify/`) against the **whole** of merged main (`changedFiles: []`, so scoped commands fall back to their script's own default target; `process.cwd()` has `node_modules`, so the JS checks Tier-1 skipped in deps-less worktrees actually run here). Deliberately NOT scoped to per-task `filesModified` — that field is display-capped and can be empty, and scoping could never catch cross-file interaction regressions. On failure: emit `layer.verification-failed` → `pauseDag` (no auto-fix — a human fixes and `--resume` re-enters the layer to re-run the gate). Skipped under `--no-verify` or when nothing was detected; if every check skips on merged main, a loud warning is logged instead of a silent pass. This replaced the old `runPostExecution`.

### 8. Contract Verification

Between every pair of adjacent layers (skipped after the final layer), `verifyLayerContracts` checks that every input contract of the next layer's tasks is satisfied by the completed tasks' outputs:

- **File output** — `existsSync(output.path)`.
- **Export output** — regex scan for `export (const|function|interface|type|class) name` in the declared file.
- **Behavioral output** — no static artifact; always passes.

On any broken contract: emit `contract.broken` → `pauseDag`.

### 9. Layer Completion

Emit `layer.completed` (or `layer.completed-with-failures`), call `saveState`, and continue to the next layer.

### 10. Finalisation

Set `state.status = 'completed'`, `saveState`, emit `dag.completed`, print cost summary, exit 0.

---

## The Five Load-Bearing Invariants

### Invariant (a) — Slot semaphore bounds RAM **across processes**, not in-process

`acquireSlot` in `src/semaphore.ts` uses **filesystem-level mutual exclusion**: `openSync(slotPath, 'wx')` (`O_CREAT | O_EXCL`) is atomic on POSIX — exactly one racing process wins any given slot file. Slot files live in `~/.dag-executor/slots/`, visible to every `dag-executor` process on the machine.

This is the single chokepoint that prevents OOM when multiple terminal windows run parallel DAGs simultaneously. An in-process `p-limit` would only cap concurrency within one Node.js process and would be invisible to other windows.

Crash safety: each slot file records the holder's PID. On the next poll cycle, `reclaimStale` calls `isPidAlive(pid)` (sending signal 0) and deletes any slot whose owner is dead. The exit/SIGINT/SIGTERM handlers also release all held slots synchronously.

### Invariant (b) — One worktree per task, force-recreated → layer-level idempotency on resume

`createWorktreeSafe(task.id, baseBranch, { forceResetIds })` always creates (or force-resets) the worktree on a branch named for the task. On resume, the existing branch is reused exactly, so a re-run of a failed task starts from the same base as the first attempt — no accumulated partial state from a crashed prior session contaminates the retry.

`--force-worktree-reset=id1,id2` explicitly destroys and recreates the worktree/branch for the listed tasks, enabling a clean retry without wiping the whole DAG.

### Invariant (c) — Base branch verified unchanged before any merge

`verifyBaseUnchanged(baseBranch, baseCommitSha)` is called immediately before `mergeLayerWorktrees`. It compares the _recorded_ `baseCommitSha` (captured at DAG start, updated after each trivial batch and after each merge) against the live `git rev-parse HEAD` of `baseBranch`.

If they differ — an external commit landed on the base branch while tasks were running — the executor emits `dag.base-moved` and pauses instead of merging. This prevents silent history corruption from merge-on-diverged-base.

`baseCommitSha` is mutable within a run: the trivial batch commits directly on the main branch, and each layer's merge advances HEAD. Both update `baseCommitSha` immediately so the next layer's guard sees the executor's own commits as the new baseline.

### Invariant (d) — Events appended THEN reduced — log is the source of truth

Every state mutation goes through `emitHelper`:

```ts
export const emitHelper = (logPath, state, event) => {
  appendEvent(logPath, event); // 1. write to disk (durable)
  return reduce(state, event); // 2. update in-memory state
};
```

`appendEvent` uses `appendFileSync` — a synchronous kernel write. If the process crashes between step 1 and step 2, the event is already on disk. On resume, `replay` re-derives the correct state from the log.

The in-memory `state` is never more authoritative than the event log. It is a transient projection — the log is the system of record.

### Invariant (e) — `.state.json` is a derived cache, **never read on the normal path**

`saveState` writes `<dag>.state.json` with a `"derived": true` marker and uses a `rename`-after-write pattern for atomicity. It is a human-readable snapshot for debugging and progress monitoring only.

`loadStateFromEvents` (`src/state.ts`) ignores `.state.json` entirely — it reads `.events.jsonl` and calls `replay`. Even if `.state.json` is stale, corrupted, or manually edited, it has no effect on execution. The `--resume` and `--rerun` paths both go through `loadStateFromEvents`, ensuring the replay from the event log is the only resume mechanism.

---

## Data Flow Summary

```
CLI args
  │
  ▼
validateDAG (Zod)
  │
  ▼
loadStateFromEvents / createState
  │
  ▼
acquireLock (dag-level)
  │
  ▼
emit dag.started
  │
  ▼  ┌──────────────────────────────────────────────────────────┐
  │  │  Layer N                                                  │
  │  │                                                           │
  │  │  trivial tasks ──► executeTrivialBatch                   │
  │  │                       single SDK session on main branch  │
  │  │                       autoCommit → update baseCommitSha  │
  │  │                       Tier-1 verify (fix ≤2) → pause     │
  │  │                                                           │
  │  │  non-trivial tasks                                        │
  │  │    │                                                      │
  │  │    ├─► createWorktreeSafe (one per task)                 │
  │  │    │                                                      │
  │  │    └─► parallel Promise.allSettled                       │
  │  │          │                                               │
  │  │          ├─► acquireSlot (cross-process file semaphore)  │
  │  │          ├─► streamClaudeCli (claude -p) in worktree cwd │
  │  │          ├─► Tier-1 verify (fix ≤2) → verification-failed│
  │  │          ├─► deadline AbortSignal → process-group kill   │
  │  │          └─► retry loop (decide → retry | permanent)     │
  │  │                                                           │
  │  │  verifyBaseUnchanged ──► pause on base-moved             │
  │  │  mergeLayerWorktrees ──► update baseCommitSha            │
  │  │  Tier-2 verify merged main ──► pause on layer.verif-fail │
  │  │  verifyLayerContracts ──► pause on broken contract       │
  │  │                                                           │
  │  │  emit layer.completed / layer.completed-with-failures    │
  │  │  saveState                                               │
  │  └──────────────────────────────────────────────────────────┘
  │
  ▼
emit dag.completed → saveState → exit 0
```

Every arrow that produces a state mutation goes through `emitHelper`: append to `.events.jsonl`, then fold through `reduce`.
