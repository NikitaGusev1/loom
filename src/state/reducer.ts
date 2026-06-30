// Pure event reducer for DAG execution state.
// No I/O, no Date.now(), no process.env, no fs, no console.

import type { ExecutionState, DecompositionDAG, ExecutorConfig } from '../types.js';
import type { DagEvent } from '../events/types.js';
import { initialState } from './initial.js';

const clearBlockedTasks = (state: ExecutionState): ExecutionState => {
  const { blockedTasks: _blockedTasks, ...rest } = state;
  return rest;
};

// ---------------------------------------------------------------------------
// reduce
// ---------------------------------------------------------------------------

/**
 * Pure reducer: apply a single event to execution state.
 * All time-sensitive fields (startedAt, completedAt, durationMs) come from
 * the event payload — never from Date.now().
 */
export const reduce = (state: ExecutionState, event: DagEvent): ExecutionState => {
  switch (event.kind) {
    // -------------------------------------------------------------------------
    // DAG-level
    // -------------------------------------------------------------------------

    case 'dag.started': {
      return {
        ...clearBlockedTasks(state),
        status: 'running',
        startedAt: event.ts,
      };
    }

    case 'dag.completed': {
      return {
        ...clearBlockedTasks(state),
        status: event.finalState.status === 'failed' ? 'failed' : 'completed',
        completedAt: event.ts,
      };
    }

    case 'dag.paused': {
      return {
        ...clearBlockedTasks(state),
        status: 'paused',
        currentLayer: event.currentLayer,
        ...(event.blockedTasks ? { blockedTasks: event.blockedTasks } : {}),
      };
    }

    case 'dag.aborted':
      return {
        ...state,
        status: 'failed',
        completedAt: event.ts,
      };

    case 'dag.base-moved':
      // Informational — no state mutation needed beyond recording the event.
      return state;

    // -------------------------------------------------------------------------
    // Layer-level
    // -------------------------------------------------------------------------

    case 'layer.started': {
      const key = String(event.layer);
      return {
        ...state,
        currentLayer: event.layer,
        layers: {
          ...state.layers,
          [key]: {
            ...state.layers[key],
            startedAt: event.ts,
            completedAt: null,
            taskCount: state.layers[key]?.taskCount ?? event.taskIds.length,
          },
        },
      };
    }

    case 'layer.completed':
    case 'layer.completed-with-failures': {
      // layer.failed is split out below — terminal-failure does not advance currentLayer.
      const key = String(event.layer);
      return {
        ...state,
        currentLayer: Math.max(state.currentLayer, event.layer + 1),
        layers: {
          ...state.layers,
          [key]: {
            ...state.layers[key],
            completedAt: event.ts,
          },
        },
      };
    }

    case 'layer.failed': {
      const key = String(event.layer);
      return {
        ...state,
        layers: {
          ...state.layers,
          [key]: {
            ...state.layers[key],
            completedAt: event.ts,
          },
        },
      };
    }

    case 'layer.verification-failed':
      // Informational. The run pauses via dag.paused (same as contract.broken);
      // do NOT advance currentLayer or mark the layer complete — on --resume the
      // loop re-enters this layer and re-runs the Tier-2 gate.
      return state;

    // -------------------------------------------------------------------------
    // Task-level
    // -------------------------------------------------------------------------

    case 'task.started':
      return {
        ...state,
        tasks: {
          ...state.tasks,
          [event.taskId]: {
            ...state.tasks[event.taskId],
            status: 'in-progress',
            startedAt: event.ts,
            worktreePath: event.worktreePath,
            worktreeBranch: event.worktreeBranch,
          },
        },
      };

    case 'task.completed':
      return {
        ...state,
        tasks: {
          ...state.tasks,
          [event.taskId]: {
            ...state.tasks[event.taskId],
            status: 'completed',
            completedAt: event.ts,
            filesModified: event.filesModified,
            usage: event.usage,
          },
        },
      };

    case 'task.failed':
      // error category distinguishable from timeout by event.kind
      return {
        ...state,
        tasks: {
          ...state.tasks,
          [event.taskId]: {
            ...state.tasks[event.taskId],
            status: 'failed',
            completedAt: event.ts,
            error: event.error,
            usage: event.usage,
          },
        },
      };

    case 'task.timeout':
      // Separate category from task.failed — retry policy reads event.kind
      return {
        ...state,
        tasks: {
          ...state.tasks,
          [event.taskId]: {
            ...state.tasks[event.taskId],
            status: 'failed',
            completedAt: event.ts,
            error: `timeout after ${event.timeoutMs}ms`,
            usage: event.usage,
          },
        },
      };

    case 'task.verification-failed':
      // Distinct category from task.failed/task.timeout — the retry policy reads
      // event.kind and classifies this permanent. Task lands 'failed' so the
      // executor excludes its worktree from the merge.
      return {
        ...state,
        tasks: {
          ...state.tasks,
          [event.taskId]: {
            ...state.tasks[event.taskId],
            status: 'failed',
            completedAt: event.ts,
            error: event.error,
            usage: event.usage,
          },
        },
      };

    case 'task.retry':
      return {
        ...state,
        tasks: {
          ...state.tasks,
          [event.taskId]: {
            ...state.tasks[event.taskId],
            status: 'in-progress',
            error: undefined,
          },
        },
      };

    case 'task.reset':
      // Rewind currentLayer so the loop re-enters the earliest reset task's layer.
      return {
        ...state,
        currentLayer: Math.min(state.currentLayer, event.layer),
        tasks: {
          ...state.tasks,
          [event.taskId]: {
            status: 'pending',
          },
        },
      };

    // -------------------------------------------------------------------------
    // Worktree events
    // -------------------------------------------------------------------------

    case 'worktree.created':
      return {
        ...state,
        tasks: {
          ...state.tasks,
          [event.taskId]: {
            ...state.tasks[event.taskId],
            worktreePath: event.worktreePath,
            worktreeBranch: event.branch,
          },
        },
      };

    case 'worktree.merged':
      // Record the merge on the task so a resume can tell a merged layer apart
      // from one whose tasks completed but whose worktrees were never merged.
      return {
        ...state,
        tasks: {
          ...state.tasks,
          [event.taskId]: {
            ...state.tasks[event.taskId],
            merged: true,
          },
        },
      };

    // -------------------------------------------------------------------------
    // Contract events
    // -------------------------------------------------------------------------

    case 'contract.broken':
      // Informational — broken contract details logged elsewhere
      return state;

    // -------------------------------------------------------------------------
    // Exhaustiveness guard
    // -------------------------------------------------------------------------

    default: {
      const _exhaustive: never = event;
      throw new Error(`Unhandled DagEvent kind: ${(_exhaustive as DagEvent).kind}`);
    }
  }
};

// ---------------------------------------------------------------------------
// replay
// ---------------------------------------------------------------------------

/**
 * Convenience: fold an array of events over initialState.
 * Callers supply dag + config so initialState can be constructed.
 */
export const replay = (events: DagEvent[], dag: DecompositionDAG, config: ExecutorConfig): ExecutionState =>
  events.reduce(reduce, initialState(dag, config));
