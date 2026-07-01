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
import { type Decision, decide } from './policy/retry.js';
import { resolveVerifyCommands } from './verify/detect.js';
import { runVerification, formatFailures } from './verify/run.js';
import { describeProjectMemory, loadProjectMemory } from './memory.js';
import { analyzeBacklogReadiness } from './backlog-readiness.js';

interface BacklogOptions {
  dag: DecompositionDAG;
  config: ExecutorConfig;
  signal?: AbortSignal;
  resume?: boolean;
  rerunTaskIds?: string[];
}

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
    if (ready.length === 0) {
      if (blocked.length === 0) return pause('No ready backlog tasks');

      const directFailures = blocked.filter((task) => task.kind === 'permanent-failure').map((task) => task.taskId);
      const dependencyBlocked = blocked.filter((task) => task.kind === 'dependency-blocked').map((task) => task.taskId);
      return pause(
        `No ready backlog tasks; permanent failures: ${directFailures.join(', ') || 'none'}; dependency-blocked: ${dependencyBlocked.join(', ') || 'none'}`,
        blocked,
      );
    }

    log.info(`Backlog ready: ${ready.map((task) => task.id).join(', ')}`);

    const worktrees = await Promise.all(
      ready.map(async (task) => {
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
          layer: layerFor(task.id),
          emit,
          worktreePath: wt.path,
          worktreeBranch: wt.branch,
        });
        return { task, ...wt };
      }),
    );
    saveState(statePath, state);

    const worktreeMap = new Map(worktrees.map((wt) => [wt.task.id, wt]));
    const worktreeFor = (task: DAGTask): (typeof worktrees)[number] => {
      const worktree = worktreeMap.get(task.id);
      if (!worktree) throw new Error(`Missing worktree for backlog task ${task.id}`);
      return worktree;
    };
    const succeeded = new Set<string>();
    const retryAttempts = new Map<string, number>();
    let activeTasks = [...ready];
    let quotaReason: string | undefined;
    let quota: QuotaLimitMetadata | undefined;

    while (activeTasks.length > 0 && !quotaReason) {
      const results = await Promise.allSettled(
        activeTasks.map(async (task) => {
          const wt = worktreeFor(task);
          const { usage, trace, failed } = await executeTaskPasses({
            task,
            config,
            state,
            log,
            cwd: wt.path,
            emit,
            dagId,
            layerNum: layerFor(task.id),
            verifyCommands,
            signal,
            projectMemory,
          });
          if (failed) throw new Error(state.tasks[task.id]?.error ?? 'Pass execution failed');
          return { taskId: task.id, usage, trace };
        }),
      );

      const modified = await Promise.all(
        results.map(async (result, i) => {
          if (result.status !== 'fulfilled') return [];
          return getFilesModified(worktreeFor(activeTasks[i]).path, baseBranch);
        }),
      );

      const nextRetry: Array<{ task: DAGTask; delayMs: number }> = [];
      for (const [i, result] of results.entries()) {
        const task = activeTasks[i];
        if (result.status === 'fulfilled') {
          const ts = new Date().toISOString();
          const durationMs = durationSinceStart(state.tasks[task.id]?.startedAt, ts);
          const settle = await settleNoOpGate({
            task,
            cwd: worktreeFor(task).path,
            declaredOutputs: resolveOutputFiles(task),
            trace: result.value.trace,
            usage: result.value.usage,
            state,
            ts,
            durationMs,
            dagId,
            layer: layerFor(task.id),
            emit,
            log,
          });
          if (settle.ok) {
            emitTaskCompleted({
              task,
              state,
              ts,
              durationMs,
              dagId,
              layer: layerFor(task.id),
              usage: result.value.usage,
              filesModified: modified[i],
              emit,
            });
            if (result.value.usage) log.taskUsage(task.id, result.value.usage as TaskUsage);
            succeeded.add(task.id);
            continue;
          }
        }

        const decision = decide(readEvents(eventLogPath), task.id);
        if (decision.kind === 'quota') {
          quotaReason = `Quota limit reached while running ${task.id}: ${decision.reason}`;
          quota = decision.quota;
          log.warn(quotaReason);
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
          nextRetry.push({ task, delayMs: decision.delayMs });
        } else if (decision.kind === 'permanent') {
          log.error(`Task ${task.id} permanently failed (${decision.reason})`);
        }
      }

      if (nextRetry.length > 0 && !quotaReason) {
        await new Promise<void>((resolve) => setTimeout(resolve, Math.max(...nextRetry.map((x) => x.delayMs))));
        for (const { task } of nextRetry) {
          const wt = worktreeFor(task);
          emitTaskStarted({
            task,
            ts: new Date().toISOString(),
            dagId,
            layer: layerFor(task.id),
            emit,
            worktreePath: wt.path,
            worktreeBranch: wt.branch,
          });
        }
        activeTasks = nextRetry.map((item) => item.task);
      } else {
        activeTasks = [];
      }
    }

    saveState(statePath, state);
    const pausedAfterBatchMerge = await mergeCompleted([...succeeded]);
    if (pausedAfterBatchMerge) return pausedAfterBatchMerge;
    if (quotaReason) return pause(`${quotaReason}. Resume with --resume after the limit resets.`, undefined, quota);
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
