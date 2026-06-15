// Helpers for emitting repeated event shapes.
// Several sites in the executor construct the same task lifecycle events
// (started/retry/completed/failed/timeout/verification-failed) and the same
// worktree.merged event; these helpers collapse that boilerplate so each shape
// (and required fields like the reducer-read worktree.merged payload) lives in
// one place.

import type { DagEvent } from './types.js';
import type { VerifyKind } from '../verify/detect.js';
import type { DAGTask, ExecutionState, TaskState, TaskUsage } from '../types.js';
import { DAG_EVENT_SCHEMA_VERSION, FILES_MODIFIED_CAP } from './types.js';
import { ZERO_USAGE } from '../consts.js';

// Compute durationMs (consumed by the task lifecycle events below) from a
// task's startedAt against the supplied end timestamp.
export const durationSinceStart = (startedAt: string | undefined, endTs: string): number =>
  startedAt ? new Date(endTs).getTime() - new Date(startedAt).getTime() : 0;

interface TaskEventBase {
  task: DAGTask;
  ts: string;
  dagId: string;
  layer: number;
  emit: (event: DagEvent) => void;
}

interface TaskFailureBase extends TaskEventBase {
  state: ExecutionState;
  durationMs: number;
}

export const emitTaskStarted = ({
  task,
  ts,
  dagId,
  layer,
  emit,
  worktreePath,
  worktreeBranch,
}: TaskEventBase & { worktreePath?: string; worktreeBranch?: string }): void => {
  emit({
    kind: 'task.started',
    schemaVersion: DAG_EVENT_SCHEMA_VERSION,
    ts,
    dagId,
    taskId: task.id,
    taskName: task.name,
    layer,
    ...(worktreePath && { worktreePath }),
    ...(worktreeBranch && { worktreeBranch }),
  });
};

export const emitTaskRetry = ({
  task,
  ts,
  dagId,
  layer,
  emit,
  attempt,
  delayMs,
  reason,
  previousError,
}: TaskEventBase & { attempt: number; delayMs: number; reason: string; previousError?: string }): void => {
  emit({
    kind: 'task.retry',
    schemaVersion: DAG_EVENT_SCHEMA_VERSION,
    ts,
    dagId,
    taskId: task.id,
    taskName: task.name,
    layer,
    attempt,
    delayMs,
    reason,
    previousError,
  });
};

/**
 * Emit a task.completed event. Caps filesModified to FILES_MODIFIED_CAP
 * (setting truncated:true) and builds finalState from the capped list, so the
 * cap and the event/finalState agreement live in one place.
 */
export const emitTaskCompleted = ({
  task,
  state,
  ts,
  durationMs,
  dagId,
  layer,
  usage,
  filesModified,
  emit,
}: TaskFailureBase & { usage?: TaskUsage; filesModified: string[] }): void => {
  const truncated = filesModified.length > FILES_MODIFIED_CAP;
  const files = truncated ? filesModified.slice(0, FILES_MODIFIED_CAP) : filesModified;
  const finalState: TaskState = {
    ...state.tasks[task.id],
    status: 'completed',
    completedAt: ts,
    filesModified: files,
    usage,
  };
  emit({
    kind: 'task.completed',
    schemaVersion: DAG_EVENT_SCHEMA_VERSION,
    ts,
    dagId,
    taskId: task.id,
    taskName: task.name,
    layer,
    durationMs,
    usage: usage ?? ZERO_USAGE,
    filesModified: files,
    ...(truncated && { truncated: true }),
    finalState,
  });
};

export const emitTaskFailed = ({
  task,
  state,
  ts,
  durationMs,
  dagId,
  layer,
  error,
  emit,
}: TaskFailureBase & { error: string }): TaskState => {
  const finalState: TaskState = { ...state.tasks[task.id], status: 'failed', completedAt: ts, error };
  emit({
    kind: 'task.failed',
    schemaVersion: DAG_EVENT_SCHEMA_VERSION,
    ts,
    dagId,
    taskId: task.id,
    taskName: task.name,
    layer,
    error,
    durationMs,
    finalState,
  });
  return finalState;
};

export const emitTaskTimeout = ({
  task,
  state,
  ts,
  durationMs,
  dagId,
  layer,
  timeoutMs,
  emit,
}: TaskFailureBase & { timeoutMs: number }): TaskState => {
  const error = `timeout after ${timeoutMs}ms`;
  const finalState: TaskState = { ...state.tasks[task.id], status: 'failed', completedAt: ts, error };
  emit({
    kind: 'task.timeout',
    schemaVersion: DAG_EVENT_SCHEMA_VERSION,
    ts,
    dagId,
    taskId: task.id,
    taskName: task.name,
    layer,
    timeoutMs,
    durationMs,
    finalState,
  });
  return finalState;
};

export const emitTaskVerificationFailed = ({
  task,
  state,
  ts,
  durationMs,
  dagId,
  layer,
  error,
  verificationKind,
  usage,
  emit,
}: TaskFailureBase & { error: string; verificationKind: VerifyKind; usage?: TaskUsage }): TaskState => {
  const finalState: TaskState = { ...state.tasks[task.id], status: 'failed', completedAt: ts, error, usage };
  emit({
    kind: 'task.verification-failed',
    schemaVersion: DAG_EVENT_SCHEMA_VERSION,
    ts,
    dagId,
    taskId: task.id,
    taskName: task.name,
    layer,
    verificationKind,
    error,
    durationMs,
    usage,
    finalState,
  });
  return finalState;
};

interface WorktreeMergedArgs {
  taskId: string;
  state: ExecutionState;
  baseBranch: string;
  dagId: string;
  ts: string;
  emit: (event: DagEvent) => void;
}

/**
 * Emit a worktree.merged event for a task whose branch was just merged into the
 * base. Worktree metadata is sourced from the event-derived task state (set by
 * worktree.created), so the in-run and resume merge paths build an identical
 * payload from one place.
 */
export const emitWorktreeMerged = ({ taskId, state, baseBranch, dagId, ts, emit }: WorktreeMergedArgs): void => {
  const t = state.tasks[taskId];
  emit({
    kind: 'worktree.merged',
    schemaVersion: DAG_EVENT_SCHEMA_VERSION,
    ts,
    dagId,
    taskId,
    worktreePath: t?.worktreePath ?? '',
    branch: t?.worktreeBranch ?? '',
    targetBranch: baseBranch,
    filesChanged: t?.filesModified ?? [],
  });
};
