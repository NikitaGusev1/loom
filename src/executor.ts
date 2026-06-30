// executeDAG — the layer loop. Per layer: trivial batch on main, worktree tasks
// in parallel (retry loop over the decide() policy), base-unchanged check, merge,
// Tier-2 merged-whole verification, next-layer contract check. Any failure pauses
// (exit 2, resumable with --resume).
//
// The per-task / per-batch execution paths and their shared plumbing live in
// src/executor/ (session, git-ops, noop-gate, task-passes, trivial-batch).

import { existsSync } from 'node:fs';
import type { ExecutionState, ExecuteOptions, DAGTask, TaskUsage, ExecutionLayer } from './types.js';
import type { DagEvent } from './events/types.js';
import { exec } from './exec.js';
import { createState, loadStateFromEvents, saveState, getStatePath, emitHelper } from './state.js';
import { createWorktreeSafe, mergeLayerWorktrees, acquireLock, verifyBaseUnchanged } from './worktree.js';
import { verifyLayerContracts, resolveOutputFiles } from './contracts.js';
import { createLogger } from './logger.js';
import { getEventLogPath, readEvents } from './events/log.js';
import {
  durationSinceStart,
  emitTaskStarted,
  emitTaskRetry,
  emitTaskCompleted,
  emitWorktreeMerged,
} from './events/emit.js';
import { decide } from './policy/retry.js';
import { resolveVerifyCommands } from './verify/detect.js';
import { runVerification, formatFailures, firstFailedKind } from './verify/run.js';
import { DAG_EVENT_SCHEMA_VERSION } from './events/types.js';
import { pendingMergeTaskIds } from './state/pending-merge.js';
import { executeTaskPasses } from './executor/task-passes.js';
import { executeTrivialBatch } from './executor/trivial-batch.js';
import { settleNoOpGate } from './executor/noop-gate.js';
import { getCurrentBranch, getFilesModified } from './executor/git-ops.js';
import { describeProjectMemory, loadProjectMemory } from './memory.js';

export const executeDAG = async (options: ExecuteOptions): Promise<ExecutionState> => {
  const { dag, config, signal, resume, rerunTaskIds } = options;
  const log = createLogger();
  const statePath = getStatePath(config.dagPath);
  const eventLogPath = getEventLogPath(config.dagPath);
  const dagId = dag.meta.id;
  const taskMap = new Map<string, DAGTask>(dag.tasks.map((t) => [t.id, t]));
  const projectMemory = loadProjectMemory({
    cwd: process.cwd(),
    path: config.projectMemoryPath,
    disabled: config.disableMemory,
  });

  let state: ExecutionState;

  if (rerunTaskIds && rerunTaskIds.length > 0) {
    for (const id of rerunTaskIds) {
      if (!taskMap.has(id)) {
        throw new Error(`Rerun task "${id}" not found in DAG. Available: ${[...taskMap.keys()].join(', ')}`);
      }
    }

    const replayedState = loadStateFromEvents(config.dagPath, dag, config);
    if (replayedState === null) {
      if (existsSync(statePath)) {
        throw new Error(
          '--rerun requires an event log from a previous execution. No event log found — start a fresh run first.',
        );
      }
      throw new Error('--rerun requires an existing event log from a previous execution');
    }
    state = replayedState;

    for (const id of rerunTaskIds) {
      const prevStatus = state.tasks[id]?.status ?? 'pending';
      const taskLayer = dag.executionLayers.find((l) => l.taskIds.includes(id))?.layer;
      if (taskLayer === undefined) {
        throw new Error(`Task "${id}" exists in DAG but is not assigned to any execution layer`);
      }
      log.info(`Reset task ${id} to pending`);
      state = emitHelper(eventLogPath, state, {
        kind: 'task.reset',
        schemaVersion: DAG_EVENT_SCHEMA_VERSION,
        ts: new Date().toISOString(),
        dagId,
        taskId: id,
        taskName: taskMap.get(id)?.name ?? id,
        layer: taskLayer,
        previousStatus: prevStatus,
        reason: 'rerun',
      });
    }

    log.info(`Rerunning ${rerunTaskIds.length} task(s) from Layer ${state.currentLayer}`);
  } else if (resume) {
    const replayedState = loadStateFromEvents(config.dagPath, dag, config);
    if (replayedState === null) {
      // Events file missing — nothing to resume
      if (existsSync(statePath)) {
        process.stderr.write('Error: Cannot resume — no event log found. Start a fresh run (omit --resume).\n');
        process.exit(1);
      }
      // Nothing to resume — start fresh
      state = createState(dag, config);
    } else {
      state = replayedState;
      log.info(`Resuming from Layer ${state.currentLayer}`);
    }
  } else {
    if (existsSync(statePath)) {
      log.warn('Existing state file found. Starting fresh (use --resume to continue).');
    }
    state = createState(dag, config);
  }
  state.status = 'running';
  const startLayer = state.currentLayer;

  // Acquire dag-level lock to prevent concurrent invocations on the same dagPath.
  acquireLock(config.dagPath);

  // Local emit closure: append-then-reduce, reassigns outer `state` atomically.
  const emit = (event: DagEvent): void => {
    state = emitHelper(eventLogPath, state, event);
  };

  // Centralizes emit(dag.paused) → saveState ordering: no pause site can
  // drift out of sync with the reducer's derived state.
  const pauseDag = (reason: string, currentLayer: number): ExecutionState => {
    emit({
      kind: 'dag.paused',
      schemaVersion: DAG_EVENT_SCHEMA_VERSION,
      ts: new Date().toISOString(),
      dagPath: config.dagPath,
      dagId,
      reason,
      currentLayer,
    });
    saveState(statePath, state);
    return state;
  };

  const [baseBranch, { stdout: baseCommitRaw }, { stdout: statusOutput }] = await Promise.all([
    getCurrentBranch(),
    exec('git', ['rev-parse', 'HEAD']),
    exec('git', ['status', '--porcelain']),
  ]);
  // Mutable: the trivial batch commits directly on the base branch, legitimately
  // advancing HEAD, so we re-record it after each batch (see the trivial block).
  let baseCommitSha = baseCommitRaw.trim();

  // Resolve the target repo's verification commands ONCE (cwd = repo root, where
  // package.json lives). The same resolved set is reused for Tier-1 (worktrees)
  // and Tier-2 (merged main); run.ts does the per-cwd node_modules check. Empty
  // when --no-verify or nothing detected → both gates become no-ops.
  const verifyCommands = resolveVerifyCommands(process.cwd(), config.verifyCommands, config.disableVerification);
  if (config.disableVerification) {
    log.info('Verification: disabled (--no-verify).');
  } else {
    const resolved = (['test', 'lint', 'typecheck'] as const).filter((k) => verifyCommands[k]);
    const absent = (['test', 'lint', 'typecheck'] as const).filter((k) => !verifyCommands[k]);
    log.info(
      `Verification: ${resolved.length ? resolved.join(', ') + ' detected' : 'none detected'}` +
        `${absent.length ? ` (skipping: ${absent.join(', ')})` : ''}.`,
    );
  }
  const memoryStatus = describeProjectMemory(projectMemory, config.disableMemory);
  if (memoryStatus) log.info(memoryStatus);

  // Tier-2 merged-whole verification for a layer (post-merge, on main, where
  // node_modules exists). Returns a pause state on failure, null on pass/skip.
  // Shared by the normal post-merge path AND the resume no-work branch — a Tier-2
  // pause replays as all-tasks-completed, so the resumed layer hits the no-work
  // branch and MUST re-run this gate there or it would advance over broken main.
  const runLayerTier2 = async (lyr: ExecutionLayer, startMs: number): Promise<ExecutionState | null> => {
    if (Object.keys(verifyCommands).length === 0) return null; // empty ⇒ disabled or nothing detected
    // Tier-2 is the MERGED-WHOLE backstop: run each detected check against the whole
    // of merged main (changedFiles:[] ⇒ scoped commands fall back to their script's
    // own default target). NOT scoped to per-task filesModified — that field is
    // display-capped (FILES_MODIFIED_CAP) and can be empty for behavioral tasks or a
    // degraded git diff, so scoping here both missed files beyond the cap and skipped
    // layers entirely, and it could never catch cross-file interaction regressions.
    const tier2 = await runVerification({
      commands: verifyCommands,
      changedFiles: [],
      cwd: process.cwd(),
      weight: 'heavy',
      signal,
      log,
    });
    if (tier2.results.length > 0 && tier2.results.every((r) => r.status === 'skipped')) {
      // Every check skipped on merged main (where deps SHOULD exist) — a green result
      // would mean nothing was verified. Surface it loudly rather than silently passing.
      log.warn(`Layer ${lyr.layer}: Tier-2 ran 0 checks (all skipped) — merged main NOT verified.`);
    }
    if (tier2.ok) return null;
    emit({
      kind: 'layer.verification-failed',
      schemaVersion: DAG_EVENT_SCHEMA_VERSION,
      ts: new Date().toISOString(),
      dagId,
      layer: lyr.layer,
      taskIds: lyr.taskIds,
      verificationKind: firstFailedKind(tier2.results),
      reason: formatFailures(tier2).slice(0, 2000),
      durationMs: Math.max(0, Date.now() - startMs),
    });
    log.error(`Layer ${lyr.layer} failed merged-whole verification. State saved. Resume with --resume after fixing.`);
    return pauseDag(`Layer ${lyr.layer} failed merged-whole verification`, lyr.layer);
  };

  const dagStartMs = Date.now();
  emit({
    kind: 'dag.started',
    schemaVersion: DAG_EVENT_SCHEMA_VERSION,
    ts: new Date().toISOString(),
    dagPath: config.dagPath,
    dagId,
    branch: baseBranch,
    resume: resume ?? false,
  });

  log.info(`Base branch: ${baseBranch}`);
  log.info(`Base commit: ${baseCommitSha.slice(0, 8)}`);
  if (statusOutput.trim()) {
    log.warn('Working tree has uncommitted changes. Merges may fail.');
    log.warn('Consider committing or stashing changes before execution.');
  }

  const totalTasks = dag.tasks.length;
  const totalLayers = dag.executionLayers.length;
  log.info(
    `DAG: ${totalTasks} tasks across ${totalLayers} layers ` +
      `(${config.provider}: default=${config.defaultModel}, heavy=${config.heavyModel})`,
  );
  for (const layer of dag.executionLayers) {
    const taskNames = layer.taskIds.map((id) => taskMap.get(id)?.name ?? id).join(', ');
    log.info(`  Layer ${layer.layer}: ${layer.taskIds.length} task(s) — ${taskNames}`);
  }

  const lastLayerNum = dag.executionLayers[dag.executionLayers.length - 1].layer;
  let layerStartMs = 0;

  for (const layer of dag.executionLayers) {
    if (layer.layer < startLayer) continue;

    if (signal?.aborted) {
      log.warn('Interrupted between layers. State saved.');
      return pauseDag('signal aborted', layer.layer);
    }

    const allLayerTasks = layer.taskIds.map((id) => taskMap.get(id)).filter((t): t is DAGTask => t !== undefined);
    const tasks = allLayerTasks.filter((t) => state.tasks[t.id]?.status !== 'completed');

    if (tasks.length === 0) {
      // Both arms settle a no-work layer with a single layer.completed (no
      // layer.started) so the reducer advances currentLayer past it; they share
      // the emit/save/continue tail below. The merge-conflict path early-returns.
      const pendingMerge = pendingMergeTaskIds(layer.taskIds, state);

      if (pendingMerge.length > 0) {
        // Resume gap: a prior run completed these tasks but paused before their
        // worktrees were merged (interrupted, killed, or a false base-moved abort).
        // The branches persist on disk — merge them now instead of skipping the
        // layer, which would leave the base tree (and downstream layers' verify)
        // missing their changes. A base that diverged since the prior run surfaces
        // as a merge conflict below.
        log.warn(`Layer ${layer.layer}: ${pendingMerge.length} task(s) completed but never merged — merging on resume`);
        // onMerged must persist per task — see mergeLayerWorktrees doc (resume idempotency).
        const resumeMerge = await mergeLayerWorktrees(pendingMerge, (taskId) => {
          log.success(`Merged ${taskId}`);
          emitWorktreeMerged({ taskId, state, baseBranch, dagId, ts: new Date().toISOString(), emit });
        });
        if (!resumeMerge.success) {
          log.error(`Merge conflict in ${resumeMerge.failedAt}: ${resumeMerge.conflict}`);
          return pauseDag(`Merge conflict in ${resumeMerge.failedAt}: ${resumeMerge.conflict}`, layer.layer);
        }
        // Re-merging on resume advanced HEAD; re-record the base so later
        // layers' base-moved guard compares against our own merge commits,
        // not the pre-merge sha. External movement is still detected.
        const { stdout: postResumeMergeHead } = await exec('git', ['rev-parse', 'HEAD']);
        baseCommitSha = postResumeMergeHead.trim();
      } else {
        log.info(`Layer ${layer.layer}: all tasks already completed, skipping`);
      }

      // Re-run Tier-2 here too: a prior Tier-2 pause replays as all-tasks-completed
      // and lands in this no-work branch, so the gate must fire again or a resume
      // would advance over still-broken merged main. Skips cleanly when nothing
      // changed or verification is off.
      const pausedOnResume = await runLayerTier2(layer, Date.now());
      if (pausedOnResume) return pausedOnResume;

      emit({
        kind: 'layer.completed',
        schemaVersion: DAG_EVENT_SCHEMA_VERSION,
        ts: new Date().toISOString(),
        dagId,
        layer: layer.layer,
        taskIds: layer.taskIds,
        durationMs: 0,
      });
      saveState(statePath, state);
      continue;
    }

    log.info(`Starting Layer ${layer.layer}: ${layer.description}`);
    layerStartMs = Date.now();
    emit({
      kind: 'layer.started',
      schemaVersion: DAG_EVENT_SCHEMA_VERSION,
      ts: new Date().toISOString(),
      dagId,
      layer: layer.layer,
      taskIds: layer.taskIds,
    });

    for (const task of tasks) {
      for (const depId of task.dependencies) {
        if (state.tasks[depId]?.status !== 'completed') {
          throw new Error(`Dependency ${depId} not completed for task ${task.id}`);
        }
      }
    }

    // Split tasks by weight
    const trivialTasks = tasks.filter((t) => t.weight === 'trivial');
    const nonTrivialTasks = tasks.filter((t) => t.weight !== 'trivial');

    // v2 partial-layer state (set inside non-trivial block, read at layer.completed)
    let layerCompletedWithFailures = false;
    let layerPermanentFailedTaskIds: string[] = [];

    // --- Run trivial tasks first on main branch ---
    if (trivialTasks.length > 0) {
      const batchResult = await executeTrivialBatch({
        tasks: trivialTasks,
        config,
        state,
        log,
        baseCommitSha,
        emit,
        dagId,
        layerNum: layer.layer,
        signal,
        verifyCommands,
        projectMemory,
      });
      if (!batchResult.success) {
        log.error(`Layer ${layer.layer} trivial batch failed. State saved. Resume with --resume.`);
        return pauseDag(`Layer ${layer.layer} trivial batch failed`, layer.layer);
      }
      // The batch committed on the base branch, advancing HEAD. Re-record the
      // base so the post-merge base-moved guard (and later layers' guards) don't
      // trip on the executor's own commit. External movement between here and the
      // merge is still detected against this updated sha.
      const { stdout: postTrivialHead } = await exec('git', ['rev-parse', 'HEAD']);
      baseCommitSha = postTrivialHead.trim();
      saveState(statePath, state);
    }

    // --- Run non-trivial tasks ---
    if (nonTrivialTasks.length > 0) {
      // Always route through a worktree: running on cwd triggers a silent no-op in the SDK
      // session — agent reports completion without calling Write, leaving the tree clean.
      const worktrees = await Promise.all(
        nonTrivialTasks.map(async (task) => {
          const wt = await createWorktreeSafe(task.id, baseBranch, {
            forceResetIds: config.forceWorktreeResetTaskIds,
          });
          const ts = new Date().toISOString();
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
          emitTaskStarted({
            task,
            ts,
            dagId,
            layer: layer.layer,
            emit,
            worktreePath: wt.path,
            worktreeBranch: wt.branch,
          });
          return { task, ...wt };
        }),
      );
      saveState(statePath, state);

      // --- Partial-layer continuation with retry loop ---
      const worktreeMap = new Map(worktrees.map((wt) => [wt.task.id, wt]));
      const succeededTaskIds = new Set<string>();
      const permanentFailedIds = new Set<string>();
      const retryAttempts = new Map<string, number>();
      let quotaPauseReason: string | undefined;
      let activeTasks = [...nonTrivialTasks];
      let completedInLayer = 0;
      const layerTotal = nonTrivialTasks.length;

      log.info(`Spawning ${layerTotal} parallel session(s)...`);

      while (activeTasks.length > 0) {
        const activeResults = await Promise.allSettled(
          activeTasks.map(async (task) => {
            const { path: worktreePath } = worktreeMap.get(task.id)!;
            const taskLog = log.child(`Layer ${layer.layer}`).child(task.id);
            taskLog.info(`Spawning session in ${worktreePath}`);

            const { usage, trace, failed } = await executeTaskPasses({
              task,
              config,
              state,
              log,
              cwd: worktreePath,
              emit,
              dagId,
              layerNum: layer.layer,
              verifyCommands,
              signal,
              projectMemory,
            });
            if (failed) throw new Error(state.tasks[task.id]?.error ?? 'Pass execution failed');

            if (usage) {
              log.taskUsage(task.id, usage);
            }
            return { taskId: task.id, usage, trace };
          }),
        );

        const filesModifiedPerTask = await Promise.all(
          activeResults.map((r, i) =>
            r.status === 'fulfilled'
              ? getFilesModified(worktreeMap.get(activeTasks[i].id)!.path, baseBranch)
              : Promise.resolve([]),
          ),
        );

        const nextRetryTasks: Array<{ task: DAGTask; delayMs: number }> = [];

        for (const [i, result] of activeResults.entries()) {
          const task = activeTasks[i];
          const taskId = task.id;

          if (result.status === 'fulfilled') {
            const filesModifiedForTask = filesModifiedPerTask[i];
            const fileOutputPaths = resolveOutputFiles(task);
            const ts = new Date().toISOString();
            const durationMs = durationSinceStart(state.tasks[taskId]?.startedAt, ts);

            const settle = await settleNoOpGate({
              task,
              cwd: worktreeMap.get(taskId)!.path,
              declaredOutputs: fileOutputPaths,
              trace: result.value.trace,
              usage: result.value.usage,
              state,
              ts,
              durationMs,
              dagId,
              layer: layer.layer,
              emit,
              log,
            });

            if (settle.ok) {
              // Genuine success
              completedInLayer += 1;
              log.progress(completedInLayer, layerTotal, `Layer ${layer.layer} — ${taskId} done`);
              log.success(`Task ${taskId} completed (${filesModifiedForTask.length} files modified)`);

              emitTaskCompleted({
                task,
                state,
                ts,
                durationMs,
                dagId,
                layer: layer.layer,
                usage: result.value.usage,
                filesModified: filesModifiedForTask,
                emit,
              });
              succeededTaskIds.add(taskId);
              continue;
            }

            // Silent no-op: settleNoOpGate already emitted task.failed.
            // Fall through to decide().
          }

          // Task failed (rejected promise or no-op) — consult retry policy
          const events = readEvents(eventLogPath);
          const decision = decide(events, taskId);

          if (decision.kind === 'retry') {
            const attempt = (retryAttempts.get(taskId) ?? 0) + 1;
            retryAttempts.set(taskId, attempt);
            emitTaskRetry({
              task,
              ts: new Date().toISOString(),
              dagId,
              layer: layer.layer,
              emit,
              attempt,
              delayMs: decision.delayMs,
              reason: state.tasks[taskId]?.error ?? 'unknown',
              previousError: state.tasks[taskId]?.error,
            });
            nextRetryTasks.push({ task, delayMs: decision.delayMs });
            log.warn(`Task ${taskId} will retry (attempt ${attempt}) after ${decision.delayMs}ms`);
          } else if (decision.kind === 'quota') {
            quotaPauseReason = `Quota limit reached while running ${taskId}: ${decision.reason}`;
            permanentFailedIds.add(taskId);
            log.warn(quotaPauseReason);
          } else if (decision.kind === 'permanent') {
            permanentFailedIds.add(taskId);
            log.error(`Task ${taskId} permanently failed (${decision.reason})`);
          } else {
            // 'succeeded' — no terminal failure event found; treat as success
            succeededTaskIds.add(taskId);
          }
        }

        if (nextRetryTasks.length > 0) {
          const maxDelayMs = Math.max(...nextRetryTasks.map((x) => x.delayMs));
          await new Promise<void>((resolve) => setTimeout(resolve, maxDelayMs));

          // Emit task.started for each retry task (reuse existing worktree)
          for (const { task } of nextRetryTasks) {
            const wt = worktreeMap.get(task.id)!;
            emitTaskStarted({
              task,
              ts: new Date().toISOString(),
              dagId,
              layer: layer.layer,
              emit,
              worktreePath: wt.path,
              worktreeBranch: wt.branch,
            });
          }
          activeTasks = nextRetryTasks.map((x) => x.task);
        } else {
          activeTasks = [];
        }
      }

      saveState(statePath, state);

      const hasAnyPermanentFailure = permanentFailedIds.size > 0;
      const hasAnySuccess = succeededTaskIds.size > 0;

      if (quotaPauseReason && !hasAnySuccess) {
        log.warn(`${quotaPauseReason}. State saved. Resume with --resume after the limit resets.`);
        return pauseDag(quotaPauseReason, layer.layer);
      }

      if (hasAnyPermanentFailure && !hasAnySuccess) {
        // All tasks permanently failed — emit layer.failed and pause
        emit({
          kind: 'layer.failed',
          schemaVersion: DAG_EVENT_SCHEMA_VERSION,
          ts: new Date().toISOString(),
          dagId,
          layer: layer.layer,
          taskIds: layer.taskIds,
          failedTaskIds: [...permanentFailedIds],
          reason: 'All tasks in layer failed permanently',
        });
        log.error(`Layer ${layer.layer} all tasks permanently failed. State saved. Resume with --resume.`);
        return pauseDag(`Layer ${layer.layer} failed — all tasks failed permanently`, layer.layer);
      }

      if (hasAnyPermanentFailure) {
        // Some succeeded, some permanently failed — flag for layer.completed-with-failures
        layerCompletedWithFailures = true;
        layerPermanentFailedTaskIds = [...permanentFailedIds];
      }

      // Verify base branch hasn't moved before merging
      const baseUnchanged = await verifyBaseUnchanged(baseBranch, baseCommitSha);
      if (!baseUnchanged) {
        const { stdout: currentHeadRaw } = await exec('git', ['rev-parse', 'HEAD']);
        const currentHead = currentHeadRaw.trim();
        emit({
          kind: 'dag.base-moved',
          schemaVersion: DAG_EVENT_SCHEMA_VERSION,
          ts: new Date().toISOString(),
          dagPath: config.dagPath,
          dagId,
          previousCommit: baseCommitSha,
          newCommit: currentHead,
          branch: baseBranch,
        });
        log.error(
          `Base branch "${baseBranch}" moved during execution ` +
            `(was ${baseCommitSha.slice(0, 8)}, now ${currentHead.slice(0, 8)}). ` +
            `Merge aborted. Resolve the conflict and resume with --resume.`,
        );
        return pauseDag(
          `Base branch "${baseBranch}" moved from ${baseCommitSha.slice(0, 8)} to ${currentHead.slice(0, 8)} — aborting merge`,
          layer.layer,
        );
      }

      // Merge only succeeded tasks' worktrees
      const succeededWorktrees = worktrees.filter((wt) => succeededTaskIds.has(wt.task.id));
      if (succeededWorktrees.length > 0) {
        log.info(
          `Merging Layer ${layer.layer} worktrees (${succeededWorktrees.length} of ${nonTrivialTasks.length})...`,
        );
        // onMerged must persist per task — see mergeLayerWorktrees doc (resume idempotency).
        const mergeResult = await mergeLayerWorktrees(
          succeededWorktrees.map((wt) => wt.task.id),
          (taskId) => {
            log.success(`Merged ${taskId}`);
            emitWorktreeMerged({ taskId, state, baseBranch, dagId, ts: new Date().toISOString(), emit });
          },
        );

        if (!mergeResult.success) {
          log.error(`Merge conflict in ${mergeResult.failedAt}: ${mergeResult.conflict}`);
          return pauseDag(`Merge conflict in ${mergeResult.failedAt}: ${mergeResult.conflict}`, layer.layer);
        }

        // Worktree merges advanced HEAD; re-record the base so the next
        // layer's base-moved guard compares against our own merge commits,
        // not the pre-merge sha. External movement is still detected.
        const { stdout: postMergeHead } = await exec('git', ['rev-parse', 'HEAD']);
        baseCommitSha = postMergeHead.trim();
      }

      if (quotaPauseReason) {
        log.warn(`${quotaPauseReason}. Merged completed work; resume with --resume after the limit resets.`);
        return pauseDag(quotaPauseReason, layer.layer);
      }
    }

    // Layer cost summary
    const layerUsages = tasks
      .map((t) => ({ taskId: t.id, usage: state.tasks[t.id]?.usage }))
      .filter((e): e is { taskId: string; usage: TaskUsage } => e.usage !== null && e.usage !== undefined);
    if (layerUsages.length > 0) {
      log.layerCostSummary(layer.layer, layerUsages);
    }

    // --- Tier-2: merged-whole verification on main (replaces runPostExecution) ---
    // Runs for EVERY layer including the last (outside the contract guard below,
    // which skips the last layer). cwd = main checkout, which HAS node_modules, so
    // the JS checks Tier-1 skipped in deps-less worktrees actually run here. On
    // failure: record layer.verification-failed and PAUSE (no auto-fix).
    const paused = await runLayerTier2(layer, layerStartMs);
    if (paused) return paused;

    // Contract verification between layers (skip for last layer)
    if (layer.layer !== lastLayerNum) {
      const completedTaskIds = Object.entries(state.tasks)
        .filter(([, t]) => t.status === 'completed')
        .map(([id]) => id);
      const nextLayer = dag.executionLayers.find((l) => l.layer === layer.layer + 1);
      if (nextLayer) {
        const verification = await verifyLayerContracts(completedTaskIds, nextLayer.taskIds, dag);
        if (!verification.passed) {
          log.error('Contract verification reported issues:');
          for (const broken of verification.brokenContracts) {
            log.error(`  ${broken.taskId}: missing ${broken.outputName} (${broken.reason})`);
            emit({
              kind: 'contract.broken',
              schemaVersion: DAG_EVENT_SCHEMA_VERSION,
              ts: new Date().toISOString(),
              dagId,
              taskId: broken.taskId,
              inputName: broken.inputName,
              expectedFrom: broken.expectedFrom,
              outputName: broken.outputName,
              outputType: broken.outputType,
              reason: broken.reason,
            });
          }
          log.error(
            `Layer ${layer.layer} produced incomplete outputs. State saved. Resume with --resume after fixing.`,
          );
          return pauseDag('Contract verification failed', layer.layer);
        }
      }
    }

    if (layerCompletedWithFailures) {
      emit({
        kind: 'layer.completed-with-failures',
        schemaVersion: DAG_EVENT_SCHEMA_VERSION,
        ts: new Date().toISOString(),
        dagId,
        layer: layer.layer,
        taskIds: layer.taskIds,
        failedTaskIds: layerPermanentFailedTaskIds,
        durationMs: Date.now() - layerStartMs,
      });
    } else {
      emit({
        kind: 'layer.completed',
        schemaVersion: DAG_EVENT_SCHEMA_VERSION,
        ts: new Date().toISOString(),
        dagId,
        layer: layer.layer,
        taskIds: layer.taskIds,
        durationMs: Date.now() - layerStartMs,
      });
    }
    saveState(statePath, state);
    const layerFiles = tasks.reduce((n, t) => n + (state.tasks[t.id]?.filesModified?.length ?? 0), 0);
    log.success(`Layer ${layer.layer} complete — ${tasks.length} task(s), ${layerFiles} file(s) modified`);
  }

  // Per-layer Tier-2 verification (above) replaced the old single post-execution
  // pass: it runs after every layer's merge (not just once at the end), pauses on
  // failure instead of merely warning, and uses detected commands (not yarn).

  state.status = 'completed';
  state.completedAt = new Date().toISOString();
  saveState(statePath, state);

  const allUsages = Object.entries(state.tasks).flatMap(([id, t]) => (t.usage ? [{ id, usage: t.usage }] : []));
  log.dagCostSummary(allUsages);

  const succeededTasks = Object.values(state.tasks).filter((t) => t.status === 'completed').length;
  const failedTasks = Object.values(state.tasks).filter((t) => t.status === 'failed').length;
  emit({
    kind: 'dag.completed',
    schemaVersion: DAG_EVENT_SCHEMA_VERSION,
    ts: new Date().toISOString(),
    dagPath: config.dagPath,
    dagId,
    totalTasks: dag.tasks.length,
    succeededTasks,
    failedTasks,
    durationMs: Date.now() - dagStartMs,
    finalState: state,
  });

  return state;
};
