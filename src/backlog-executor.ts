// Backlog executor - dependency-driven worker loop.
//
// Unlike the classic layer executor, this mode does not stop at layer barriers.
// It repeatedly finds tasks whose dependencies are completed, runs the ready set
// in worktrees, merges successes, and persists every transition to the same
// event log used by --resume.

import { existsSync } from 'node:fs';
import type {
  BacklogBlockedTask,
  DAGTask,
  DecompositionDAG,
  ExecutorConfig,
  ExecutionState,
  QuotaLimitMetadata,
  TaskUsage,
} from './types.js';
import type { DagEvent } from './events/types.js';
import { DAG_EVENT_SCHEMA_VERSION } from './events/types.js';
import { createState, emitHelper, getStatePath, loadStateFromEvents, saveState } from './state.js';
import { getEventLogPath, readEvents } from './events/log.js';
import { createLogger } from './logger.js';
import { exec } from './exec.js';
import { createWorktreeSafe, mergeLayerWorktrees, acquireLock, verifyBaseUnchanged } from './worktree.js';
import { getCurrentBranch, getFilesModified } from './executor/git-ops.js';
import { executeTaskPasses } from './executor/task-passes.js';
import { settleNoOpGate } from './executor/noop-gate.js';
import { resolveOutputFiles } from './contracts.js';
import {
  durationSinceStart,
  emitTaskCompleted,
  emitTaskRetry,
  emitTaskStarted,
  emitWorktreeMerged,
} from './events/emit.js';
import { decide } from './policy/retry.js';
import { resolveVerifyCommands } from './verify/detect.js';
import { runVerification, formatFailures } from './verify/run.js';
import { describeProjectMemory, loadProjectMemory } from './memory.js';
import { analyzeBacklogReadiness } from './backlog-readiness.js';
import {
  chooseStartableBacklogTasks,
  reusableBacklogWorktree,
  shouldPauseForNoReadyWork,
  summarizeBlockedBacklogPause,
  waitForNextBacklogOutcome,
} from './backlog-scheduler.js';

interface BacklogOptions {
  dag: DecompositionDAG;
  config: ExecutorConfig;
  signal?: AbortSignal;
  resume?: boolean;
  rerunTaskIds?: string[];
}

type BacklogTaskOutcome =
  | { kind: 'succeeded'; task: DAGTask }
  | { kind: 'retry'; task: DAGTask; delayMs: number }
  | { kind: 'quota'; task: DAGTask; reason: string; quota: QuotaLimitMetadata }
  | { kind: 'permanent'; task: DAGTask; reason: string };

const taskLayerMap = (dag: DecompositionDAG): Map<string, number> => {
  const layers = new Map<string, number>();
  for (const layer of dag.executionLayers) {
    for (const taskId of layer.taskIds) layers.set(taskId, layer.layer);
  }
  return layers;
};

const currentLayerFor = (dag: DecompositionDAG, state: ExecutionState, layers: ReadonlyMap<string, number>): number => {
  let minLayer = dag.executionLayers[dag.executionLayers.length - 1]?.layer ?? 0;
  for (const task of dag.tasks) {
    if (state.tasks[task.id]?.status === 'completed') continue;
    minLayer = Math.min(minLayer, layers.get(task.id) ?? 0);
  }
  return minLayer;
};

export const executeBacklog = async ({
  dag,
  config,
  signal,
  resume,
  rerunTaskIds,
}: BacklogOptions): Promise<ExecutionState> => {
  const log = createLogger();
  const statePath = getStatePath(config.dagPath);
  const eventLogPath = getEventLogPath(config.dagPath);
  const dagId = dag.meta.id;
  const taskMap = new Map<string, DAGTask>(dag.tasks.map((t) => [t.id, t]));
  const layers = taskLayerMap(dag);
  const layerFor = (taskId: string): number => layers.get(taskId) ?? 0;
  const projectMemory = loadProjectMemory({
    cwd: process.cwd(),
    path: config.projectMemoryPath,
    disabled: config.disableMemory,
  });

  let state: ExecutionState;
  if (resume || rerunTaskIds?.length) {
    const replayed = loadStateFromEvents(config.dagPath, dag, config);
    if (replayed === null) {
      if (existsSync(statePath)) throw new Error('Cannot resume backlog - no event log found');
      state = createState(dag, config);
    } else {
      state = replayed;
    }
  } else {
    state = createState(dag, config);
  }

  if (rerunTaskIds?.length) {
    for (const id of rerunTaskIds) {
      const task = taskMap.get(id);
      if (!task) throw new Error(`Rerun task "${id}" not found in DAG`);
      state = emitHelper(eventLogPath, state, {
        kind: 'task.reset',
        schemaVersion: DAG_EVENT_SCHEMA_VERSION,
        ts: new Date().toISOString(),
        dagId,
        taskId: id,
        taskName: task.name,
        layer: layerFor(id),
        previousStatus: state.tasks[id]?.status ?? 'pending',
        reason: 'rerun',
      });
    }
  }

  state.status = 'running';
  acquireLock(config.dagPath);

  const emit = (event: DagEvent): void => {
    state = emitHelper(eventLogPath, state, event);
  };

  const pause = (reason: string, blockedTasks?: BacklogBlockedTask[], quota?: QuotaLimitMetadata): ExecutionState => {
    emit({
      kind: 'dag.paused',
      schemaVersion: DAG_EVENT_SCHEMA_VERSION,
      ts: new Date().toISOString(),
      dagPath: config.dagPath,
      dagId,
      reason,
      currentLayer: currentLayerFor(dag, state, layers),
      blockedTasks,
      quota,
    });
    saveState(statePath, state);
    return state;
  };

  const [baseBranch, { stdout: baseCommitRaw }] = await Promise.all([
    getCurrentBranch(),
    exec('git', ['rev-parse', 'HEAD']),
  ]);
  let baseCommitSha = baseCommitRaw.trim();

  const verifyCommands = resolveVerifyCommands(process.cwd(), config.verifyCommands, config.disableVerification);
  if (config.disableVerification) {
    log.info('Verification: disabled (--no-verify).');
  }
  const memoryStatus = describeProjectMemory(projectMemory, config.disableMemory);
  if (memoryStatus) log.info(memoryStatus);

  const runMergedVerification = async (): Promise<ExecutionState | null> => {
    if (Object.keys(verifyCommands).length === 0) return null;
    const result = await runVerification({
      commands: verifyCommands,
      changedFiles: [],
      cwd: process.cwd(),
      weight: 'heavy',
      signal,
      log,
    });
    if (result.ok) return null;
    return pause(`Backlog merged verification failed: ${formatFailures(result).slice(0, 2000)}`);
  };

  emit({
    kind: 'dag.started',
    schemaVersion: DAG_EVENT_SCHEMA_VERSION,
    ts: new Date().toISOString(),
    dagPath: config.dagPath,
    dagId,
    branch: baseBranch,
    resume: resume ?? false,
  });

  log.info(`Backlog mode: ${dag.tasks.length} task(s), dependency-driven execution`);

  const mergeCompleted = async (taskIds: string[]): Promise<ExecutionState | null> => {
    if (taskIds.length === 0) return null;
    const baseUnchanged = await verifyBaseUnchanged(baseBranch, baseCommitSha);
    if (!baseUnchanged) return pause(`Base branch "${baseBranch}" moved before backlog merge`);
    const merged = await mergeLayerWorktrees(taskIds, (taskId) => {
      log.success(`Merged ${taskId}`);
      emitWorktreeMerged({ taskId, state, baseBranch, dagId, ts: new Date().toISOString(), emit });
    });
    if (!merged.success) return pause(`Merge conflict in ${merged.failedAt}: ${merged.conflict}`);
    const { stdout } = await exec('git', ['rev-parse', 'HEAD']);
    baseCommitSha = stdout.trim();
    return runMergedVerification();
  };

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

  const running = new Map<string, Promise<BacklogTaskOutcome>>();
  const retryAttempts = new Map<string, number>();
  let quotaPause: { reason: string; quota: QuotaLimitMetadata } | undefined;

  const startTask = async (task: DAGTask): Promise<void> => {
    const shouldForceReset = config.forceWorktreeResetTaskIds?.includes(task.id) ?? false;
    const existingWorktree = shouldForceReset ? undefined : reusableBacklogWorktree(state.tasks[task.id]);
    const wt =
      existingWorktree ??
      (await createWorktreeSafe(task.id, baseBranch, {
        forceResetIds: config.forceWorktreeResetTaskIds,
      }));
    const ts = new Date().toISOString();
    if (!existingWorktree) {
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
      if (quotaPause)
        return pause(`${quotaPause.reason}. Resume with --resume after the limit resets.`, undefined, quotaPause.quota);
      continue;
    }

    const settled = await waitForNextBacklogOutcome(running);
    running.delete(settled.taskId);

    if (settled.status === 'rejected') {
      if (signal?.aborted) return pause('signal aborted');
      const task = taskMap.get(settled.taskId);
      if (!task) throw new Error(`Missing backlog task for settled outcome ${settled.taskId}`);
      const decision = decide(readEvents(eventLogPath), task.id);
      if (decision.kind === 'quota') {
        quotaPause = {
          reason: `Quota limit reached while running ${task.id}: ${decision.reason}`,
          quota: decision.quota,
        };
        log.warn(`${quotaPause.reason}; draining ${running.size} already-running task(s) before pause`);
      } else if (decision.kind === 'retry') {
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
        if (quotaPause) {
          log.warn(`Task ${task.id} retry deferred because quota pause is pending`);
        } else {
          log.warn(`Task ${task.id} will retry after ${decision.delayMs}ms`);
          startRetry(task, decision.delayMs);
        }
      } else if (decision.kind === 'permanent') {
        log.error(`Task ${task.id} permanently failed (${decision.reason})`);
      } else {
        throw settled.reason instanceof Error
          ? settled.reason
          : new Error(`Unexpected backlog task failure for ${task.id}: ${String(settled.reason)}`);
      }
      continue;
    }

    const outcome = settled.outcome;
    if (outcome.kind === 'succeeded') {
      const pausedAfterTaskMerge = await mergeCompleted([outcome.task.id]);
      if (pausedAfterTaskMerge) return pausedAfterTaskMerge;
      saveState(statePath, state);
    } else if (outcome.kind === 'retry') {
      if (quotaPause) {
        log.warn(`Task ${outcome.task.id} retry deferred because quota pause is pending`);
      } else {
        log.warn(`Task ${outcome.task.id} will retry after ${outcome.delayMs}ms`);
        startRetry(outcome.task, outcome.delayMs);
      }
    } else if (outcome.kind === 'quota') {
      quotaPause = { reason: outcome.reason, quota: outcome.quota };
      log.warn(`${outcome.reason}; draining ${running.size} already-running task(s) before pause`);
    } else {
      log.error(`Task ${outcome.task.id} permanently failed (${outcome.reason})`);
    }
  }

  state.status = 'completed';
  state.completedAt = new Date().toISOString();
  saveState(statePath, state);

  const succeededTasks = Object.values(state.tasks).filter((task) => task.status === 'completed').length;
  const failedTasks = Object.values(state.tasks).filter((task) => task.status === 'failed').length;
  emit({
    kind: 'dag.completed',
    schemaVersion: DAG_EVENT_SCHEMA_VERSION,
    ts: new Date().toISOString(),
    dagPath: config.dagPath,
    dagId,
    totalTasks: dag.tasks.length,
    succeededTasks,
    failedTasks,
    durationMs: 0,
    finalState: state,
  });

  return state;
};
