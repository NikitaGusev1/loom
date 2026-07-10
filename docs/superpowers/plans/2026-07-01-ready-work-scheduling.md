# Ready-Work Scheduling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `dag-executor --backlog` start newly unblocked work as soon as each dependency completes, without waiting for unrelated ready tasks from the same scheduling round.

**Architecture:** Keep the classic layered executor in `src/executor.ts` unchanged as the fallback. Replace the backlog executor's ready-set barrier with a live in-process queue: start ready work, wait for the next task outcome with `Promise.race`, immediately merge successful work, run merged-main verification, recompute readiness, and start newly unblocked tasks while unrelated existing tasks continue. Reuse the existing worktree-per-task path, retry policy, event log, reducer, `analyzeBacklogReadiness`, and `runQuery`'s global slot semaphore.

**Tech Stack:** TypeScript ESM, Node 22 `node:test`, event-sourced reducer, existing git worktree helpers, existing verification helpers.

---

## Current Code Map

- Modify: `src/backlog-executor.ts`
  - Owns `--backlog` execution today.
  - Current barrier: it computes `ready`, creates worktrees for all ready tasks, waits for the entire `activeTasks` batch with `Promise.allSettled`, merges successful tasks as a group, then loops.
  - Desired change: keep `running` task attempts in a map and process whichever attempt settles next.
- Create: `src/backlog-scheduler.ts`
  - Small pure helpers for queue decisions and no-ready pause summaries.
  - Keeps unit-testable scheduling rules out of the executor's I/O-heavy loop.
- Create: `src/backlog-scheduler.test.ts`
  - Covers "do not re-start active tasks", "start downstream when dependency completes while another task is active", and "format blocked pause reason".
- Modify: `src/backlog-readiness.test.ts`
  - Add coverage for `in-progress` tasks being eligible on resume when dependencies are complete.
- Modify: `README.md`
  - Update backlog-mode description from round-based execution to live ready-work scheduling.
- Modify: `DAY_RUN_BACKLOG.md`
  - Mark entry 8 complete after implementation and verification.

## Behavioral Invariants

- `src/executor.ts` remains the strict layered implementation.
- `src/backlog-executor.ts` remains selected only when `--backlog` is passed through `src/index.ts`.
- Each standard/heavy/trivial backlog task still runs in a task worktree. Do not use `executeTrivialBatch` in backlog mode.
- The cross-process semaphore remains enforced at `runQuery` in `src/executor/session.ts`; do not add a second concurrency limiter.
- A successful task is merged before its dependents are considered ready.
- Tier-2 merged-main verification runs after every successful merge batch. In live scheduling this means after each task success or after resume pending-merge cleanup.
- On quota, stop launching new tasks, drain already-running tasks, merge any successes that finish, then pause with quota metadata.
- Permanent task failures block only dependency descendants; independent ready work continues.
- Resume remains event-log-only. In-progress tasks from a crashed process are treated as startable again if dependencies are complete, and `createWorktreeSafe` preserves the existing unmerged-branch safety guard.

---

### Task 1: Add Pure Scheduler Helpers

**Files:**
- Create: `src/backlog-scheduler.ts`
- Create: `src/backlog-scheduler.test.ts`

- [x] **Step 1: Write the failing scheduler tests**

Create `src/backlog-scheduler.test.ts`:

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseStartableBacklogTasks,
  summarizeBlockedBacklogPause,
  shouldPauseForNoReadyWork,
} from './backlog-scheduler.js';
import type { BacklogBlockedTask, DAGTask } from './types.js';

const task = (id: string, dependencies: string[] = []): DAGTask => ({
  id,
  name: id,
  description: id,
  dependencies,
  contracts: { inputs: {}, outputs: {} },
  context: { files: [] },
  completionCriteria: { automated: [], manual: [] },
  estimatedScope: 'single-component',
  weight: 'standard',
});

describe('chooseStartableBacklogTasks', () => {
  it('excludes tasks that are already running', () => {
    const ready = [task('active'), task('newly-ready')];
    const startable = chooseStartableBacklogTasks(ready, new Set(['active']));

    assert.deepEqual(
      startable.map((t) => t.id),
      ['newly-ready'],
    );
  });

  it('allows a downstream task to start while an unrelated task is still running', () => {
    const ready = [task('child', ['fast-parent']), task('unrelated-slow')];
    const startable = chooseStartableBacklogTasks(ready, new Set(['unrelated-slow']));

    assert.deepEqual(
      startable.map((t) => t.id),
      ['child'],
    );
  });
});

describe('shouldPauseForNoReadyWork', () => {
  it('does not pause while a task is still running', () => {
    assert.equal(shouldPauseForNoReadyWork([], new Set(['slow-task'])), false);
  });

  it('pauses when no ready tasks and no running tasks remain', () => {
    assert.equal(shouldPauseForNoReadyWork([], new Set()), true);
  });
});

describe('summarizeBlockedBacklogPause', () => {
  it('summarizes direct permanent failures and dependency-blocked tasks', () => {
    const blocked: BacklogBlockedTask[] = [
      {
        taskId: 'failed-root',
        kind: 'permanent-failure',
        blockedBy: [],
        rootFailures: ['failed-root'],
        reason: 'non-transient',
      },
      {
        taskId: 'blocked-child',
        kind: 'dependency-blocked',
        blockedBy: ['failed-root'],
        rootFailures: ['failed-root'],
        reason: 'depends on blocked task(s): failed-root',
      },
    ];

    assert.equal(
      summarizeBlockedBacklogPause(blocked),
      'No ready backlog tasks; permanent failures: failed-root; dependency-blocked: blocked-child',
    );
  });
});
```

- [x] **Step 2: Run the new test to verify it fails**

Run:

```bash
npm run build && node --test build/backlog-scheduler.test.js
```

Expected: TypeScript build fails because `src/backlog-scheduler.ts` does not exist.

- [x] **Step 3: Implement the scheduler helpers**

Create `src/backlog-scheduler.ts`:

```ts
import type { BacklogBlockedTask, DAGTask } from './types.js';

export const chooseStartableBacklogTasks = (
  ready: readonly DAGTask[],
  activeTaskIds: ReadonlySet<string>,
): DAGTask[] => ready.filter((task) => !activeTaskIds.has(task.id));

export const shouldPauseForNoReadyWork = (
  ready: readonly DAGTask[],
  activeTaskIds: ReadonlySet<string>,
): boolean => ready.length === 0 && activeTaskIds.size === 0;

export const summarizeBlockedBacklogPause = (blocked: readonly BacklogBlockedTask[]): string => {
  const directFailures = blocked.filter((task) => task.kind === 'permanent-failure').map((task) => task.taskId);
  const dependencyBlocked = blocked.filter((task) => task.kind === 'dependency-blocked').map((task) => task.taskId);

  return (
    `No ready backlog tasks; permanent failures: ${directFailures.join(', ') || 'none'}; ` +
    `dependency-blocked: ${dependencyBlocked.join(', ') || 'none'}`
  );
};
```

- [x] **Step 4: Run the scheduler test to verify it passes**

Run:

```bash
npm run build && node --test build/backlog-scheduler.test.js
```

Expected: PASS for `backlog-scheduler.test.js`.

- [x] **Step 5: Commit**

```bash
git add src/backlog-scheduler.ts src/backlog-scheduler.test.ts
git commit -m "test: add backlog scheduler helpers"
```

---

### Task 2: Cover Resume Eligibility For In-Progress Backlog Tasks

**Files:**
- Modify: `src/backlog-readiness.test.ts`

- [x] **Step 1: Add the readiness test**

Append this test inside the existing `describe('analyzeBacklogReadiness', () => {` block in `src/backlog-readiness.test.ts`:

```ts
  it('treats in-progress tasks as ready on resume when dependencies are complete', () => {
    const result = analyzeBacklogReadiness(
      dag([task('dependency'), task('interrupted', ['dependency'])]),
      state({
        dependency: { status: 'completed' },
        interrupted: { status: 'in-progress', worktreeBranch: 'dag/interrupted' },
      }),
      decisions([]),
    );

    assert.deepEqual(
      result.ready.map((readyTask) => readyTask.id),
      ['interrupted'],
    );
    assert.deepEqual(result.blocked, []);
  });
```

- [x] **Step 2: Run the readiness test**

Run:

```bash
npm run build && node --test build/backlog-readiness.test.js
```

Expected: PASS. This documents the current resume behavior that the live scheduler relies on.

- [x] **Step 3: Commit**

```bash
git add src/backlog-readiness.test.ts
git commit -m "test: document backlog resume readiness"
```

---

### Task 3: Refactor Backlog Task Attempts Into A Single-Task Runner

**Files:**
- Modify: `src/backlog-executor.ts`

- [x] **Step 1: Add outcome types near `BacklogOptions`**

In `src/backlog-executor.ts`, add these types after `interface BacklogOptions`:

```ts
type BacklogTaskOutcome =
  | { kind: 'succeeded'; task: DAGTask }
  | { kind: 'retry'; task: DAGTask; delayMs: number }
  | { kind: 'quota'; task: DAGTask; reason: string; quota: QuotaLimitMetadata }
  | { kind: 'permanent'; task: DAGTask; reason: string };
```

- [x] **Step 2: Extract the per-attempt body inside `executeBacklog`**

Inside `executeBacklog`, after `mergeCompleted`, add this local helper. It deliberately closes over `state`, `emit`, `dagId`, `baseBranch`, `verifyCommands`, `signal`, `projectMemory`, and `layerFor` so it can reuse existing event-state plumbing without adding a wide dependency injection layer.

```ts
  const runBacklogTaskAttempt = async (
    task: DAGTask,
    worktreePath: string,
    retryAttempts: Map<string, number>,
  ): Promise<BacklogTaskOutcome> => {
    const { usage, trace, failed } = await executeTaskPasses({
      task,
      config,
      state,
      log,
      cwd: worktreePath,
      emit,
      dagId,
      layerNum: layerFor(task.id),
      verifyCommands,
      signal,
      projectMemory,
    });
    if (failed) {
      const decision = decide(readEvents(eventLogPath), task.id);
      if (decision.kind === 'quota') {
        return {
          kind: 'quota',
          task,
          reason: `Quota limit reached while running ${task.id}: ${decision.reason}`,
          quota: decision.quota,
        };
      }
      if (decision.kind === 'retry') {
        const attempt = (retryAttempts.get(task.id) ?? 0) + 1;
        retryAttempts.set(task.id, attempt);
        emitTaskRetry({
          task,
          ts: new Date().toISOString(),
          dagId,
          layer: layerFor(task.id),
          emit,
          attempt,
          delayMs: decision.delayMs,
          reason: state.tasks[task.id]?.error ?? 'unknown',
          previousError: state.tasks[task.id]?.error,
        });
        return { kind: 'retry', task, delayMs: decision.delayMs };
      }
      if (decision.kind === 'permanent') {
        return { kind: 'permanent', task, reason: decision.reason };
      }
      return { kind: 'succeeded', task };
    }

    const filesModified = await getFilesModified(worktreePath, baseBranch);
    const ts = new Date().toISOString();
    const durationMs = durationSinceStart(state.tasks[task.id]?.startedAt, ts);
    const settle = await settleNoOpGate({
      task,
      cwd: worktreePath,
      declaredOutputs: resolveOutputFiles(task),
      trace,
      usage,
      state,
      ts,
      durationMs,
      dagId,
      layer: layerFor(task.id),
      emit,
      log,
    });
    if (!settle.ok) {
      const decision = decide(readEvents(eventLogPath), task.id);
      if (decision.kind === 'retry') {
        const attempt = (retryAttempts.get(task.id) ?? 0) + 1;
        retryAttempts.set(task.id, attempt);
        emitTaskRetry({
          task,
          ts: new Date().toISOString(),
          dagId,
          layer: layerFor(task.id),
          emit,
          attempt,
          delayMs: decision.delayMs,
          reason: state.tasks[task.id]?.error ?? 'unknown',
          previousError: state.tasks[task.id]?.error,
        });
        return { kind: 'retry', task, delayMs: decision.delayMs };
      }
      if (decision.kind === 'quota') {
        return {
          kind: 'quota',
          task,
          reason: `Quota limit reached while running ${task.id}: ${decision.reason}`,
          quota: decision.quota,
        };
      }
      if (decision.kind === 'permanent') {
        return { kind: 'permanent', task, reason: decision.reason };
      }
      return { kind: 'succeeded', task };
    }

    emitTaskCompleted({
      task,
      state,
      ts,
      durationMs,
      dagId,
      layer: layerFor(task.id),
      usage,
      filesModified,
      emit,
    });
    if (usage) log.taskUsage(task.id, usage as TaskUsage);
    return { kind: 'succeeded', task };
  };
```

- [x] **Step 3: Build to catch extraction mistakes**

Run:

```bash
npm run build
```

Expected: PASS. Behavior is not changed yet because the old loop still runs.

- [x] **Step 4: Commit**

```bash
git add src/backlog-executor.ts
git commit -m "refactor: extract backlog task attempt runner"
```

---

### Task 4: Replace The Ready-Set Barrier With A Live Queue

**Files:**
- Modify: `src/backlog-executor.ts`

- [x] **Step 1: Import scheduler helpers**

Add imports near the existing `analyzeBacklogReadiness` import:

```ts
import {
  chooseStartableBacklogTasks,
  shouldPauseForNoReadyWork,
  summarizeBlockedBacklogPause,
} from './backlog-scheduler.js';
```

- [x] **Step 2: Replace the current scheduling body**

Replace the current loop body from `for (;;) {` through the end of the ready batch processing block with this live-queue version:

```ts
  const running = new Map<string, Promise<BacklogTaskOutcome>>();
  const retryAttempts = new Map<string, number>();
  let quotaPause: { reason: string; quota: QuotaLimitMetadata } | undefined;

  const startTask = async (task: DAGTask, existingWorktreePath?: string, existingWorktreeBranch?: string): Promise<void> => {
    const wt =
      existingWorktreePath && existingWorktreeBranch
        ? { path: existingWorktreePath, branch: existingWorktreeBranch }
        : await createWorktreeSafe(task.id, baseBranch, {
            forceResetIds: config.forceWorktreeResetTaskIds,
          });

    const ts = new Date().toISOString();
    if (!existingWorktreePath) {
      emit({
        kind: 'worktree.created',
        schemaVersion: DAG_EVENT_SCHEMA_VERSION,
        ts,
        dagId,
        taskId: task.id,
        worktreePath: wt.path,
        branch: wt.branch,
        baseBranch,
      });
    }
    emitTaskStarted({
      task,
      ts,
      dagId,
      layer: layerFor(task.id),
      emit,
      worktreePath: wt.path,
      worktreeBranch: wt.branch,
    });
    saveState(statePath, state);

    running.set(task.id, runBacklogTaskAttempt(task, wt.path, retryAttempts));
  };

  const startRetry = (task: DAGTask, delayMs: number): void => {
    const taskState = state.tasks[task.id];
    const worktreePath = taskState?.worktreePath;
    const worktreeBranch = taskState?.worktreeBranch;
    if (!worktreePath || !worktreeBranch) {
      throw new Error(`Cannot retry ${task.id}: missing worktree metadata`);
    }
    running.set(
      task.id,
      new Promise<BacklogTaskOutcome>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (signal?.aborted) {
            reject(new Error('signal aborted'));
            return;
          }
          emitTaskStarted({
            task,
            ts: new Date().toISOString(),
            dagId,
            layer: layerFor(task.id),
            emit,
            worktreePath,
            worktreeBranch,
          });
          resolve(runBacklogTaskAttempt(task, worktreePath, retryAttempts));
        }, delayMs);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new Error('signal aborted'));
          },
          { once: true },
        );
      }),
    );
  };

  for (;;) {
    if (signal?.aborted) return pause('signal aborted');

    const pendingMerge = dag.tasks
      .filter((task) => state.tasks[task.id]?.status === 'completed' && state.tasks[task.id]?.merged !== true)
      .map((task) => task.id);
    const pausedAfterMerge = await mergeCompleted(pendingMerge);
    if (pausedAfterMerge) return pausedAfterMerge;

    const completedCount = dag.tasks.filter((task) => state.tasks[task.id]?.status === 'completed').length;
    if (completedCount === dag.tasks.length) break;

    const events = readEvents(eventLogPath);
    const decisions = new Map(dag.tasks.map((task) => [task.id, decide(events, task.id)]));
    const { ready, blocked } = analyzeBacklogReadiness(dag, state, decisions);

    if (!quotaPause) {
      const startable = chooseStartableBacklogTasks(ready, new Set(running.keys()));
      for (const task of startable) {
        log.info(`Backlog starting: ${task.id}`);
        await startTask(task);
      }
    }

    if (shouldPauseForNoReadyWork(ready, new Set(running.keys()))) {
      if (blocked.length === 0) return pause('No ready backlog tasks');
      return pause(summarizeBlockedBacklogPause(blocked), blocked);
    }

    if (running.size === 0) {
      if (quotaPause) return pause(`${quotaPause.reason}. Resume with --resume after the limit resets.`, undefined, quotaPause.quota);
      continue;
    }

    let settled: { taskId: string; outcome: BacklogTaskOutcome };
    try {
      settled = await Promise.race(
        [...running.entries()].map(([taskId, promise]) => promise.then((outcome) => ({ taskId, outcome }))),
      );
    } catch (err) {
      if (signal?.aborted) return pause('signal aborted');
      throw err;
    }
    running.delete(settled.taskId);

    if (settled.outcome.kind === 'succeeded') {
      const pausedAfterTaskMerge = await mergeCompleted([settled.outcome.task.id]);
      if (pausedAfterTaskMerge) return pausedAfterTaskMerge;
      saveState(statePath, state);
    } else if (settled.outcome.kind === 'retry') {
      log.warn(`Task ${settled.outcome.task.id} will retry after ${settled.outcome.delayMs}ms`);
      startRetry(settled.outcome.task, settled.outcome.delayMs);
    } else if (settled.outcome.kind === 'quota') {
      quotaPause = { reason: settled.outcome.reason, quota: settled.outcome.quota };
      log.warn(`${settled.outcome.reason}; draining ${running.size} already-running task(s) before pause`);
    } else {
      log.error(`Task ${settled.outcome.task.id} permanently failed (${settled.outcome.reason})`);
    }
  }
```

- [x] **Step 3: Remove the old batch-local variables**

Remove the old batch section beginning with the line that logs `Backlog ready:` and ending with the line that pauses on `quotaReason`:

```ts
    log.info(`Backlog ready: ${ready.map((task) => task.id).join(', ')}`);
```

through:

```ts
    if (quotaReason) return pause(`${quotaReason}. Resume with --resume after the limit resets.`, undefined, quota);
```

After this removal, `src/backlog-executor.ts` should have exactly one scheduling loop, no `Promise.allSettled` over a ready batch, no `activeTasks` variable, no `worktreeMap` variable, and no batch-local `succeeded` set.

- [x] **Step 4: Build**

Run:

```bash
npm run build
```

Expected: PASS. If TypeScript reports a union narrowing issue for `settled.outcome`, assign `const outcome = settled.outcome;` before the `if` chain and narrow on `outcome.kind`.

- [x] **Step 5: Run focused tests**

Run:

```bash
node --test build/backlog-scheduler.test.js build/backlog-readiness.test.js build/state/reducer.test.js build/state/pending-merge.test.js
```

Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add src/backlog-executor.ts src/backlog-scheduler.ts src/backlog-scheduler.test.ts src/backlog-readiness.test.ts
git commit -m "feat: schedule backlog ready work live"
```

---

### Task 5: Add A Stubbed Smoke Test For Lumpy DAG Scheduling

**Files:**
- Modify: `scripts/loom-supervisor-smoke.sh`

- [x] **Step 1: Add a smoke case that asserts backlog mode is still passed through**

Add a small smoke scenario near the existing backlog assertions in `scripts/loom-supervisor-smoke.sh` that uses a lumpy DAG shape:

```bash
cat > "$TMP/lumpy-dag.json" <<'JSON'
{
  "meta": {
    "id": "lumpy",
    "source": {
      "type": "description",
      "title": "lumpy",
      "description": "",
      "figmaUrls": [],
      "acceptanceCriteria": []
    },
    "createdAt": "2026-01-01T00:00:00.000Z",
    "gitCommit": "abc123",
    "branch": "main",
    "qualityReport": {
      "iterations": 1,
      "checksRun": [],
      "allPassed": true
    }
  },
  "tasks": [
    {
      "id": "fast-parent",
      "name": "fast-parent",
      "description": "",
      "dependencies": [],
      "contracts": { "inputs": {}, "outputs": {} },
      "context": { "files": [] },
      "completionCriteria": { "automated": [], "manual": [] },
      "estimatedScope": "single-component",
      "weight": "standard"
    },
    {
      "id": "slow-unrelated",
      "name": "slow-unrelated",
      "description": "",
      "dependencies": [],
      "contracts": { "inputs": {}, "outputs": {} },
      "context": { "files": [] },
      "completionCriteria": { "automated": [], "manual": [] },
      "estimatedScope": "single-component",
      "weight": "heavy"
    },
    {
      "id": "child",
      "name": "child",
      "description": "",
      "dependencies": ["fast-parent"],
      "contracts": { "inputs": {}, "outputs": {} },
      "context": { "files": [] },
      "completionCriteria": { "automated": [], "manual": [] },
      "estimatedScope": "single-component",
      "weight": "standard"
    }
  ],
  "executionLayers": [
    { "layer": 0, "description": "roots", "taskIds": ["fast-parent", "slow-unrelated"] },
    { "layer": 1, "description": "child", "taskIds": ["child"] }
  ]
}
JSON
```

Then run the existing supervisor path with this DAG and assert the recorded invocation includes `--backlog`.

- [x] **Step 2: Run the smoke harness**

Run:

```bash
npm run build && npm run smoke:loom
```

Expected: PASS. This validates the supervisor still invokes backlog mode for a lumpy DAG. The live scheduling behavior itself is covered by the TypeScript tests and the executor code path.

- [x] **Step 3: Commit**

```bash
git add scripts/loom-supervisor-smoke.sh
git commit -m "test: add lumpy backlog smoke fixture"
```

---

### Task 6: Update Documentation And Backlog Status

**Files:**
- Modify: `README.md`
- Modify: `DAY_RUN_BACKLOG.md`

- [x] **Step 1: Update README backlog wording**

In `README.md`, update the overview text that describes `--backlog` so it says:

```markdown
Backlog mode (`--backlog`) uses dependency-driven ready-work scheduling: each task still runs in its own worktree and is merged through the same safety gates, but newly unblocked tasks can start as soon as their dependencies merge instead of waiting for unrelated same-round work.
```

Place it in the overview or execution-model section near the existing event-sourced execution description.

- [x] **Step 2: Mark entry 8 complete**

In `DAY_RUN_BACKLOG.md`, change entry 8:

```markdown
Status: complete. Backlog mode now uses live ready-work scheduling: successful work is merged and verified as each task finishes, dependencies are recomputed immediately, and newly unblocked work can start while unrelated long-running tasks continue. The classic layered executor remains available by omitting `--backlog`.
```

Keep the original acceptance criteria below it.

- [x] **Step 3: Run full verification**

Run:

```bash
npm test
```

Expected: PASS.

Run:

```bash
npm run lint
```

Expected: PASS.

- [x] **Step 4: Commit**

```bash
git add README.md DAY_RUN_BACKLOG.md
git commit -m "docs: mark ready-work scheduling complete"
```

---

## Self-Review Checklist

- Spec coverage:
  - Starts downstream work after dependency completion: Task 4 processes one settled task, merges it, recomputes readiness, and starts newly ready tasks while other tasks remain in `running`.
  - Preserves global slot limit: no new limiter is introduced; `runQuery` still owns `acquireSlot`.
  - Preserves worktree isolation: every backlog task still uses `createWorktreeSafe` and `executeTaskPasses` with a worktree cwd.
  - Keeps permanent failures blocking only descendants: `analyzeBacklogReadiness` remains the source of truth.
  - Preserves merge safety and verification: `mergeCompleted` still calls `verifyBaseUnchanged`, `mergeLayerWorktrees`, updates `baseCommitSha`, and runs merged verification.
  - Emits resumable event/state data: existing `task.started`, `task.completed`, `task.failed`, `worktree.created`, `worktree.merged`, `dag.paused`, `blockedTasks`, and `quota` metadata remain in use.
  - Keeps layered execution available: `executeDAG` is untouched and `src/index.ts` still routes only `--backlog` to `executeBacklog`.
- Placeholder scan:
  - No unresolved placeholder markers or unnamed test commands are present.
- Type consistency:
  - `BacklogTaskOutcome.kind` values are `succeeded`, `retry`, `quota`, and `permanent`.
  - Scheduler helper names in tests match exports from `src/backlog-scheduler.ts`.
  - `QuotaLimitMetadata`, `DAGTask`, and `TaskUsage` are already imported by `src/backlog-executor.ts`.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-01-ready-work-scheduling.md`. Two execution options:

**1. Subagent-Driven (recommended)** - dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
