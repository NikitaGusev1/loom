import type { DecompositionDAG, ExecutionState, TaskStatus } from '../types.js';

export interface ReadyState {
  /** taskId -> count of dependencies not yet completed. */
  unmetDeps: Map<string, number>;
  /** Runnable task ids: not completed, not failed, and all deps complete. */
  ready: string[];
  /** In-progress-at-crash task ids that should be reset and re-run. */
  inFlightToReset: string[];
  /** Failed task ids whose deps are complete; caller decides retryable vs permanent. */
  failedRunnable: string[];
}

export const buildChildren = (dag: DecompositionDAG): Map<string, string[]> => {
  const children = new Map<string, string[]>();
  for (const task of dag.tasks) children.set(task.id, []);
  for (const task of dag.tasks) {
    for (const depId of new Set(task.dependencies)) {
      const list = children.get(depId);
      if (list) list.push(task.id);
      else children.set(depId, [task.id]);
    }
  }
  return children;
};

export const initialUnmetDeps = (dag: DecompositionDAG): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const task of dag.tasks) counts.set(task.id, new Set(task.dependencies).size);
  return counts;
};

export const reconstructReadyState = (state: ExecutionState, dag: DecompositionDAG): ReadyState => {
  const statusOf = (id: string): TaskStatus => state.tasks[id]?.status ?? 'pending';
  const isDone = (id: string): boolean => statusOf(id) === 'completed';

  const unmetDeps = new Map<string, number>();
  const ready: string[] = [];
  const inFlightToReset: string[] = [];
  const failedRunnable: string[] = [];

  for (const task of dag.tasks) {
    const deps = new Set(task.dependencies);
    let unmet = 0;
    for (const depId of deps) if (!isDone(depId)) unmet += 1;
    unmetDeps.set(task.id, unmet);

    const status = statusOf(task.id);
    if (status === 'in-progress') inFlightToReset.push(task.id);

    if (status !== 'completed' && status !== 'failed' && unmet === 0) ready.push(task.id);
    if (status === 'failed' && unmet === 0) failedRunnable.push(task.id);
  }

  return { unmetDeps, ready, inFlightToReset, failedRunnable };
};

export const markCompleted = (
  unmetDeps: Map<string, number>,
  children: Map<string, string[]>,
  taskId: string,
): string[] => {
  const newlyReady: string[] = [];
  for (const childId of children.get(taskId) ?? []) {
    const remaining = (unmetDeps.get(childId) ?? 0) - 1;
    unmetDeps.set(childId, remaining);
    if (remaining === 0) newlyReady.push(childId);
  }
  return newlyReady;
};
