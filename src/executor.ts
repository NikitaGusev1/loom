// executeDAG — the ready-work loop. A task starts as soon as its dependencies
// complete (no layer barrier); each producer merges eagerly through a serialized
// writer lane so a consumer branches off a base that already contains it. Layers
// are retained only as Tier-2 verification checkpoints (fired when a layer's last
// task lands), not as start gates; input contracts verify per-edge at unblock.
// Any failure (base-moved, merge conflict, broken contract, Tier-2, all-permanent,
// quota) pauses (exit 2, resumable with --resume).
//
// Scheduling bookkeeping lives in src/scheduler/ (ready, writer-lane); the
// per-task execution path and shared plumbing live in src/executor/ (session,
// git-ops, noop-gate, task-passes, deps).

import { existsSync } from 'node:fs';
import type {
  ExecutionState,
  ExecuteOptions,
  DAGTask,
  TaskUsage,
  ExecutionLayer,
  QuotaLimitMetadata,
} from './types.js';
import type { DagEvent, DagPauseCause } from './events/types.js';
import { exec } from './exec.js';
import { createState, loadStateFromEvents, saveState, getStatePath, emitHelper } from './state.js';
import { acquireLock } from './worktree.js';
import { createConsumerInputVerifier, resolveOutputFiles } from './contracts.js';
import { buildChildren, markCompleted, reconstructReadyState } from './scheduler/ready.js';
import { createWriterLane, landWorktree, type LandWorktreeDeps } from './scheduler/writer-lane.js';
import { MAX_GLOBAL_SLOTS } from './consts.js';
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
import { getCurrentBranch, getHeadSha } from './executor/git-ops.js';
import { describeProjectMemory, loadProjectMemory } from './memory.js';
import { defaultExecutorDeps, type ExecutorDeps } from './executor/deps.js';

export const executeDAG = async (options: ExecuteOptions & { deps?: ExecutorDeps }): Promise<ExecutionState> => {
  const { dag, config, signal, resume, rerunTaskIds } = options;
  const deps = options.deps ?? defaultExecutorDeps;
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

  // Acquire dag-level lock to prevent concurrent invocations on the same dagPath.
  acquireLock(config.dagPath);

  // Local emit closure: append-then-reduce, reassigns outer `state` atomically.
  const emit = (event: DagEvent): void => {
    state = emitHelper(eventLogPath, state, event);
  };

  // Centralizes emit(dag.paused) → saveState ordering: no pause site can
  // drift out of sync with the reducer's derived state.
  const pauseDag = (
    cause: DagPauseCause,
    reason: string,
    currentLayer: number,
    quota?: QuotaLimitMetadata,
  ): ExecutionState => {
    emit({
      kind: 'dag.paused',
      schemaVersion: DAG_EVENT_SCHEMA_VERSION,
      ts: new Date().toISOString(),
      dagPath: config.dagPath,
      dagId,
      reason,
      currentLayer,
      cause,
      quota,
    });
    saveState(statePath, state);
    return state;
  };

  const [baseBranch, baseHead, { stdout: statusOutput }] = await Promise.all([
    getCurrentBranch(),
    getHeadSha(),
    exec('git', ['status', '--porcelain']),
  ]);
  // Mutable: each eager land merges onto the base branch, advancing HEAD, so we
  // re-record it after every land (see landAndRoute).
  let baseCommitSha = baseHead;

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
    return pauseDag('verification-failed', `Layer ${lyr.layer} failed merged-whole verification`, lyr.layer);
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
    baseStartSha: baseHead,
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

  // ---------------------------------------------------------------------------
  // Ready-work scheduling loop (replaces the layer-by-layer start barrier). A task
  // starts as soon as its dependencies complete; each producer merges eagerly
  // through a serialized writer lane so a consumer branches off a base that already
  // contains it; the expensive Tier-2 suite still runs per-layer (layers retained
  // as verification checkpoints, dropped as start gates); contracts verify per-edge
  // at the moment a producer unblocks a consumer.
  // ---------------------------------------------------------------------------

  type Settled =
    | { taskId: string; outcome: 'completed'; filesModified: string[]; usage?: TaskUsage }
    | { taskId: string; outcome: 'permanent'; reason: string }
    | { taskId: string; outcome: 'quota'; reason: string; quota: QuotaLimitMetadata }
    // An unexpected throw inside runOneTask (worktree-create, getFilesModified,
    // settleNoOp). Caught so the inFlight promise never rejects -- the loop converts
    // it to a resumable pause instead of letting Promise.race reject and crash.
    | { taskId: string; outcome: 'error'; error: string };

  const taskLayer = new Map<string, number>();
  const layerById = new Map<number, ExecutionLayer>();
  for (const lyr of dag.executionLayers) {
    layerById.set(lyr.layer, lyr);
    for (const id of lyr.taskIds) taskLayer.set(id, lyr.layer);
  }

  const children = buildChildren(dag);
  const { unmetDeps, ready: readySeed, inFlightToReset, failedRunnable } = reconstructReadyState(state, dag);

  // On --resume, a task that ended 'failed' may be transiently retryable: a 1st/2nd
  // task.timeout still in backoff, or a transient task.failed that crashed before its
  // in-process retry fired. Consult the retry policy per failed task: a 'retry'
  // verdict re-enters the run; a 'permanent' verdict stays excluded so the DAG pauses
  // all-tasks-failed rather than looping on doomed work.
  const retryableFailed: string[] = [];
  if (resume && failedRunnable.length > 0) {
    const priorEvents = readEvents(eventLogPath);
    for (const id of failedRunnable) {
      if (decide(priorEvents, id).kind === 'retry') retryableFailed.push(id);
    }
    if (retryableFailed.length > 0)
      log.info(`Resume: re-attempting ${retryableFailed.length} transiently-failed task(s)`);
  }

  // Crashed in-flight branches carry unmerged commits; createWorktreeSafe refuses
  // to clobber those unless force-reset. Discard them so the task re-runs clean.
  const forceResetIds = [
    ...new Set([
      ...(config.forceWorktreeResetTaskIds ?? []),
      ...inFlightToReset,
      ...(rerunTaskIds ?? []),
      ...retryableFailed,
    ]),
  ];

  const completed = new Set<string>(
    Object.entries(state.tasks)
      .filter(([, t]) => t.status === 'completed')
      .map(([id]) => id),
  );

  const layerRemaining = new Map<number, number>();
  const layerFailedIds = new Map<number, string[]>();
  for (const lyr of dag.executionLayers) {
    layerRemaining.set(lyr.layer, lyr.taskIds.filter((id) => !completed.has(id)).length);
    layerFailedIds.set(lyr.layer, []);
  }
  const layerStartedAt = new Map<number, number>();
  const layerTaskIds = (layer: number): string[] => layerById.get(layer)?.taskIds ?? [];
  const earliestIncompleteLayer = (): number => {
    let earliest = Infinity;
    for (const [layer, remaining] of layerRemaining) if (remaining > 0 && layer < earliest) earliest = layer;
    return Number.isFinite(earliest) ? earliest : state.currentLayer;
  };

  const lane = createWriterLane();
  const landDeps: LandWorktreeDeps = {
    verifyBaseUnchanged: deps.verifyBaseUnchanged,
    mergeWorktrees: deps.mergeWorktrees,
    currentHeadSha: getHeadSha,
  };
  const landAndRoute = async (taskId: string, layer: number): Promise<ExecutionState | null> => {
    const baseShaBefore = baseCommitSha;
    let land;
    try {
      land = await lane.enqueue(() =>
        landWorktree({ taskId, baseBranch, baseCommitSha, onMerged: () => {}, deps: landDeps }),
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.error(`Landing ${taskId} threw an unexpected error: ${reason}`);
      return pauseDag('unexpected-error', `Unexpected error landing ${taskId}: ${reason}`, layer);
    }
    if (land.status === 'base-moved') {
      const head = await getHeadSha();
      emit({
        kind: 'dag.base-moved',
        schemaVersion: DAG_EVENT_SCHEMA_VERSION,
        ts: new Date().toISOString(),
        dagPath: config.dagPath,
        dagId,
        previousCommit: baseCommitSha,
        newCommit: head,
        branch: baseBranch,
      });
      log.error(
        `Base branch "${baseBranch}" moved during execution (was ${baseCommitSha.slice(0, 8)}, now ${head.slice(0, 8)}). Merge aborted.`,
      );
      return pauseDag(
        'base-moved',
        `Base branch "${baseBranch}" moved from ${baseCommitSha.slice(0, 8)} to ${head.slice(0, 8)} -- aborting merge`,
        layer,
      );
    }
    if (land.status === 'conflict') {
      log.error(`Merge conflict in ${taskId}: ${land.conflict}`);
      return pauseDag('merge-conflict', `Merge conflict in ${taskId}: ${land.conflict}`, layer);
    }
    baseCommitSha = land.newSha ?? baseCommitSha;
    emitWorktreeMerged({
      taskId,
      state,
      baseBranch,
      dagId,
      ts: new Date().toISOString(),
      emit,
      baseShaBefore,
      baseShaAfter: land.newSha ?? baseCommitSha,
    });
    return null;
  };

  const worktreeMap = new Map<string, { path: string; branch: string }>();
  const retryAttempts = new Map<string, number>();

  const ready: string[] = [...readySeed, ...retryableFailed];
  const inFlight = new Map<string, Promise<Settled>>();
  const permanentFailed = new Set<string>();
  let quotaPause: { reason: string; quota: QuotaLimitMetadata; layer: number } | null = null;
  let paused: ExecutionState | null = null;

  const runOneTask = async (task: DAGTask): Promise<Settled> => {
    const taskId = task.id;
    const layerNum = taskLayer.get(taskId) ?? 0;
    try {
      return await runOneTaskInner(task, taskId, layerNum);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.error(`Task ${taskId} threw an unexpected error: ${reason}`);
      return { taskId, outcome: 'error', error: reason };
    }
  };

  const runOneTaskInner = async (task: DAGTask, taskId: string, layerNum: number): Promise<Settled> => {
    let wt = worktreeMap.get(taskId);
    if (!wt) {
      wt = await deps.createWorktree(taskId, baseBranch, { forceResetIds });
      worktreeMap.set(taskId, wt);
      emit({
        kind: 'worktree.created',
        schemaVersion: DAG_EVENT_SCHEMA_VERSION,
        ts: new Date().toISOString(),
        dagId,
        taskId,
        worktreePath: wt.path,
        branch: wt.branch,
        baseBranch,
      });
    }

    for (;;) {
      emitTaskStarted({
        task,
        ts: new Date().toISOString(),
        dagId,
        layer: layerNum,
        emit,
        worktreePath: wt.path,
        worktreeBranch: wt.branch,
      });

      const { usage, trace, failed } = await deps.runTask({
        task,
        config,
        state,
        log,
        cwd: wt.path,
        emit,
        dagId,
        layerNum,
        verifyCommands,
        signal,
        projectMemory,
        projectContext: dag.meta.projectContext,
      });

      if (!failed) {
        const filesModified = await deps.getFilesModified(wt.path, baseBranch);
        const ts = new Date().toISOString();
        const durationMs = durationSinceStart(state.tasks[taskId]?.startedAt, ts);
        const settle = await deps.settleNoOp({
          task,
          cwd: wt.path,
          declaredOutputs: resolveOutputFiles(task),
          trace,
          usage,
          state,
          ts,
          durationMs,
          dagId,
          layer: layerNum,
          emit,
          log,
        });
        if (settle.ok) {
          emitTaskCompleted({ task, state, ts, durationMs, dagId, layer: layerNum, usage, filesModified, emit });
          if (usage) log.taskUsage(taskId, usage);
          log.success(`Task ${taskId} completed (${filesModified.length} files modified)`);
          return { taskId, outcome: 'completed', filesModified, usage };
        }
      }

      const decision = decide(readEvents(eventLogPath), taskId);
      if (decision.kind === 'retry') {
        const attempt = (retryAttempts.get(taskId) ?? 0) + 1;
        retryAttempts.set(taskId, attempt);
        emitTaskRetry({
          task,
          ts: new Date().toISOString(),
          dagId,
          layer: layerNum,
          emit,
          attempt,
          delayMs: decision.delayMs,
          reason: state.tasks[taskId]?.error ?? 'unknown',
          previousError: state.tasks[taskId]?.error,
        });
        log.warn(`Task ${taskId} will retry (attempt ${attempt}) after ${decision.delayMs}ms`);
        if (decision.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, decision.delayMs));
        continue;
      }
      if (decision.kind === 'quota') {
        const reason = `Quota limit reached while running ${taskId}: ${decision.reason}`;
        log.warn(reason);
        return { taskId, outcome: 'quota', reason, quota: decision.quota };
      }
      if (decision.kind === 'permanent') {
        log.error(`Task ${taskId} permanently failed (${decision.reason})`);
        return { taskId, outcome: 'permanent', reason: decision.reason };
      }
      const ts = new Date().toISOString();
      const durationMs = durationSinceStart(state.tasks[taskId]?.startedAt, ts);
      const filesModified = await deps.getFilesModified(wt.path, baseBranch);
      emitTaskCompleted({ task, state, ts, durationMs, dagId, layer: layerNum, usage, filesModified, emit });
      if (usage) log.taskUsage(taskId, usage);
      return { taskId, outcome: 'completed', filesModified, usage };
    }
  };

  const dispatch = (): void => {
    if (quotaPause) return;
    while (inFlight.size < MAX_GLOBAL_SLOTS && ready.length > 0) {
      const taskId = ready.shift();
      if (taskId === undefined) break;
      if (completed.has(taskId) || inFlight.has(taskId)) continue;
      const task = taskMap.get(taskId);
      if (!task) continue;
      const layerNum = taskLayer.get(taskId) ?? 0;
      if (!layerStartedAt.has(layerNum)) {
        const persistedStart = state.layers[String(layerNum)]?.startedAt;
        if (persistedStart) {
          layerStartedAt.set(layerNum, Date.parse(persistedStart));
        } else {
          layerStartedAt.set(layerNum, Date.now());
          emit({
            kind: 'layer.started',
            schemaVersion: DAG_EVENT_SCHEMA_VERSION,
            ts: new Date().toISOString(),
            dagId,
            layer: layerNum,
            taskIds: layerTaskIds(layerNum),
          });
        }
      }
      inFlight.set(taskId, runOneTask(task));
    }
  };

  const emitLayerDone = async (layer: number, startMs: number): Promise<ExecutionState | null> => {
    const layerObj = layerById.get(layer);
    if (!layerObj) return null;
    const failed = layerFailedIds.get(layer) ?? [];
    if (failed.length > 0) {
      emit({
        kind: 'layer.failed',
        schemaVersion: DAG_EVENT_SCHEMA_VERSION,
        ts: new Date().toISOString(),
        dagId,
        layer,
        taskIds: layerObj.taskIds,
        failedTaskIds: failed,
        reason: `${failed.length} task(s) failed permanently: ${failed.join(', ')}`,
      });
      return null;
    }
    const tier2Pause = await runLayerTier2(layerObj, startMs);
    if (tier2Pause) return tier2Pause;
    emit({
      kind: 'layer.completed',
      schemaVersion: DAG_EVENT_SCHEMA_VERSION,
      ts: new Date().toISOString(),
      dagId,
      layer,
      taskIds: layerObj.taskIds,
      durationMs: Math.max(0, Date.now() - startMs),
    });
    const layerUsages = layerObj.taskIds
      .map((taskId) => ({ taskId, usage: state.tasks[taskId]?.usage }))
      .filter((entry): entry is { taskId: string; usage: TaskUsage } => entry.usage !== undefined);
    if (layerUsages.length > 0) log.layerCostSummary(layer, layerUsages);
    return null;
  };

  const checkpointIfLayerDone = async (layer: number): Promise<boolean> => {
    const remaining = (layerRemaining.get(layer) ?? 0) - 1;
    layerRemaining.set(layer, remaining);
    if (remaining > 0) return false;
    const pause = await emitLayerDone(layer, layerStartedAt.get(layer) ?? Date.now());
    if (pause) {
      paused = pause;
      return true;
    }
    return false;
  };

  const contractVerifier = createConsumerInputVerifier(taskMap);
  const verifyConsumerContracts = (consumerIds: Iterable<string>): ExecutionState | null => {
    for (const childId of consumerIds) {
      const verification = contractVerifier(childId);
      if (verification.passed) continue;
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
      return pauseDag('contract-broken', 'Contract verification failed', taskLayer.get(childId) ?? 0);
    }
    return null;
  };

  for (const taskId of pendingMergeTaskIds(
    dag.tasks.map((t) => t.id),
    state,
  )) {
    log.warn(`Task ${taskId} completed but never merged -- merging on resume`);
    const pause = await landAndRoute(taskId, taskLayer.get(taskId) ?? 0);
    if (pause) return pause;
  }

  if (resume) {
    for (const lyr of dag.executionLayers) {
      if (state.layers[String(lyr.layer)]?.completedAt) continue;
      if (!lyr.taskIds.every((id) => completed.has(id))) continue;
      const lowerIncomplete = dag.executionLayers.some(
        (l) => l.layer < lyr.layer && !l.taskIds.every((id) => completed.has(id)),
      );
      if (lowerIncomplete) continue;
      const persisted = state.layers[String(lyr.layer)]?.startedAt;
      const pause = await emitLayerDone(lyr.layer, persisted ? Date.parse(persisted) : Date.now());
      if (pause) return pause;
    }
  }

  if (resume && ready.length > 0) {
    const seedPause = verifyConsumerContracts(ready);
    if (seedPause) return seedPause;
  }

  while (!paused) {
    if (signal?.aborted) {
      paused = pauseDag('signal', 'signal aborted', earliestIncompleteLayer());
      break;
    }
    dispatch();
    if (inFlight.size === 0) {
      if (quotaPause) paused = pauseDag('quota', quotaPause.reason, quotaPause.layer, quotaPause.quota);
      break;
    }

    const settled = await Promise.race([...inFlight.values()]);
    inFlight.delete(settled.taskId);
    const layer = taskLayer.get(settled.taskId) ?? 0;

    if (settled.outcome === 'error') {
      paused = pauseDag(
        'unexpected-error',
        `Task ${settled.taskId} failed with an unexpected error: ${settled.error}`,
        layer,
      );
      break;
    }

    if (settled.outcome === 'quota') {
      quotaPause = { reason: settled.reason, quota: settled.quota, layer };
      if (inFlight.size === 0) paused = pauseDag('quota', settled.reason, layer, settled.quota);
      saveState(statePath, state);
      continue;
    }

    if (settled.outcome === 'permanent') {
      permanentFailed.add(settled.taskId);
      layerFailedIds.get(layer)?.push(settled.taskId);
      if (await checkpointIfLayerDone(layer)) break;
      saveState(statePath, state);
      continue;
    }

    const landPause = await landAndRoute(settled.taskId, layer);
    if (landPause) {
      paused = landPause;
      break;
    }
    completed.add(settled.taskId);

    const newlyReady = markCompleted(unmetDeps, children, settled.taskId);
    const contractPause = verifyConsumerContracts(newlyReady);
    if (contractPause) {
      paused = contractPause;
      break;
    }
    for (const id of newlyReady) ready.push(id);

    if (await checkpointIfLayerDone(layer)) break;
    saveState(statePath, state);
  }

  if (paused) return paused;

  if (completed.size < dag.tasks.length) {
    const blocked = dag.tasks.length - completed.size;
    const someFailed = [...permanentFailed][0];
    return pauseDag(
      'all-tasks-failed',
      `${permanentFailed.size} task(s) failed permanently; ${blocked} task(s) did not complete`,
      someFailed ? (taskLayer.get(someFailed) ?? 0) : earliestIncompleteLayer(),
    );
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
