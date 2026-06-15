// DAG Event types — discriminated union on `kind`
// Every event carries schemaVersion and ts (ISO-8601) at the top level.

import type { TaskUsage, TaskState, ExecutionState } from '../types.js';
import type { VerifyKind } from '../verify/detect.js';

export const DAG_EVENT_SCHEMA_VERSION = 1 as const;

/** Cap on filesModified array in task.completed events.
 *  POSIX O_APPEND atomicity is only guaranteed up to 512 bytes on macOS,
 *  so we truncate long arrays and set truncated:true. */
export const FILES_MODIFIED_CAP = 20 as const;

// ---------------------------------------------------------------------------
// Base
// ---------------------------------------------------------------------------

interface EventBase<K extends string> {
  kind: K;
  schemaVersion: typeof DAG_EVENT_SCHEMA_VERSION;
  ts: string; // ISO-8601
}

// ---------------------------------------------------------------------------
// DAG-level events
// ---------------------------------------------------------------------------

export interface DagStartedEvent extends EventBase<'dag.started'> {
  dagPath: string;
  dagId: string;
  branch: string;
  resume: boolean;
}

export interface DagCompletedEvent extends EventBase<'dag.completed'> {
  dagPath: string;
  dagId: string;
  totalTasks: number;
  succeededTasks: number;
  failedTasks: number;
  durationMs: number;
  finalState: ExecutionState;
}

export interface DagPausedEvent extends EventBase<'dag.paused'> {
  dagPath: string;
  dagId: string;
  reason: string;
  currentLayer: number;
}

export interface DagAbortedEvent extends EventBase<'dag.aborted'> {
  dagPath: string;
  dagId: string;
  reason: string;
  signal: 'SIGINT' | 'SIGTERM' | 'abort' | string;
}

export interface DagBaseMovedEvent extends EventBase<'dag.base-moved'> {
  dagPath: string;
  dagId: string;
  previousCommit: string;
  newCommit: string;
  branch: string;
}

// ---------------------------------------------------------------------------
// Layer-level events
// ---------------------------------------------------------------------------

export interface LayerStartedEvent extends EventBase<'layer.started'> {
  dagId: string;
  layer: number;
  taskIds: string[];
}

export interface LayerCompletedEvent extends EventBase<'layer.completed'> {
  dagId: string;
  layer: number;
  taskIds: string[];
  durationMs: number;
}

export interface LayerCompletedWithFailuresEvent extends EventBase<'layer.completed-with-failures'> {
  dagId: string;
  layer: number;
  taskIds: string[];
  failedTaskIds: string[];
  durationMs: number;
}

export interface LayerFailedEvent extends EventBase<'layer.failed'> {
  dagId: string;
  layer: number;
  taskIds: string[];
  failedTaskIds: string[];
  reason: string;
}

// ---------------------------------------------------------------------------
// Task-level events
// ---------------------------------------------------------------------------

export interface TaskStartedEvent extends EventBase<'task.started'> {
  dagId: string;
  taskId: string;
  taskName: string;
  layer: number;
  worktreePath?: string;
  worktreeBranch?: string;
}

export interface TaskCompletedEvent extends EventBase<'task.completed'> {
  dagId: string;
  taskId: string;
  taskName: string;
  layer: number;
  durationMs: number;
  usage: TaskUsage;
  filesModified: string[];
  /** True when filesModified was truncated to FILES_MODIFIED_CAP entries */
  truncated?: boolean;
  finalState: TaskState;
}

export interface TaskFailedEvent extends EventBase<'task.failed'> {
  dagId: string;
  taskId: string;
  taskName: string;
  layer: number;
  error: string;
  durationMs: number;
  usage?: TaskUsage;
  finalState: TaskState;
}

export interface TaskTimeoutEvent extends EventBase<'task.timeout'> {
  dagId: string;
  taskId: string;
  taskName: string;
  layer: number;
  timeoutMs: number;
  durationMs: number;
  usage?: TaskUsage;
  finalState: TaskState;
}

// Emitted when a task's session produced changes that FAIL verification (test /
// lint / typecheck) and the bounded in-worktree fix re-invokes were exhausted.
// Deliberately distinct from task.failed/task.timeout: the retry policy classifies
// it permanent (never transient-retried) and the executor leaves the worktree
// unmerged. `verificationKind` is the first failing check; `error` lists all.
export interface TaskVerificationFailedEvent extends EventBase<'task.verification-failed'> {
  dagId: string;
  taskId: string;
  taskName: string;
  layer: number;
  verificationKind: VerifyKind;
  error: string;
  durationMs: number;
  usage?: TaskUsage;
  finalState: TaskState;
}

// Emitted when the merged-whole (Tier-2) gate fails on a layer's merged main.
// The run pauses (dag.paused) rather than auto-repairing.
export interface LayerVerificationFailedEvent extends EventBase<'layer.verification-failed'> {
  dagId: string;
  layer: number;
  taskIds: string[];
  verificationKind: VerifyKind;
  reason: string;
  durationMs: number;
}

export interface TaskRetryEvent extends EventBase<'task.retry'> {
  dagId: string;
  taskId: string;
  taskName: string;
  layer: number;
  attempt: number;
  delayMs?: number;
  reason: string;
  previousError?: string;
}

export interface TaskResetEvent extends EventBase<'task.reset'> {
  dagId: string;
  taskId: string;
  taskName: string;
  layer: number;
  previousStatus: TaskState['status'];
  reason: string;
}

// ---------------------------------------------------------------------------
// Worktree events
// ---------------------------------------------------------------------------

export interface WorktreeCreatedEvent extends EventBase<'worktree.created'> {
  dagId: string;
  taskId: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
}

export interface WorktreeMergedEvent extends EventBase<'worktree.merged'> {
  dagId: string;
  taskId: string;
  worktreePath: string;
  branch: string;
  targetBranch: string;
  filesChanged: string[];
}

// ---------------------------------------------------------------------------
// Contract events
// ---------------------------------------------------------------------------

export interface ContractBrokenEvent extends EventBase<'contract.broken'> {
  dagId: string;
  taskId: string;
  inputName: string;
  expectedFrom: string;
  outputName: string;
  outputType: string;
  reason: string;
}

// ---------------------------------------------------------------------------
// Discriminated union
// ---------------------------------------------------------------------------

export type DagEvent =
  | DagStartedEvent
  | DagCompletedEvent
  | DagPausedEvent
  | DagAbortedEvent
  | DagBaseMovedEvent
  | LayerStartedEvent
  | LayerCompletedEvent
  | LayerCompletedWithFailuresEvent
  | LayerFailedEvent
  | TaskStartedEvent
  | TaskCompletedEvent
  | TaskFailedEvent
  | TaskTimeoutEvent
  | TaskVerificationFailedEvent
  | LayerVerificationFailedEvent
  | TaskRetryEvent
  | TaskResetEvent
  | WorktreeCreatedEvent
  | WorktreeMergedEvent
  | ContractBrokenEvent;
