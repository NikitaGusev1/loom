import type { BacklogBlockedTask, DAGTask, DecompositionDAG, ExecutionState } from './types.js';
import type { Decision } from './policy/retry.js';
import { isBacklogTaskIntegrated } from './backlog-scheduler.js';

interface BacklogReadiness {
  ready: DAGTask[];
  blocked: BacklogBlockedTask[];
}

const unique = (items: string[]): string[] => [...new Set(items)];

export const analyzeBacklogReadiness = (
  dag: DecompositionDAG,
  state: ExecutionState,
  decisions: ReadonlyMap<string, Decision>,
): BacklogReadiness => {
  const taskById = new Map(dag.tasks.map((task) => [task.id, task]));
  const finished = (id: string): boolean => state.tasks[id]?.status === 'completed';
  const dependencySatisfied = (id: string): boolean => isBacklogTaskIntegrated(state.tasks[id]);
  const blockedMemo = new Map<string, BacklogBlockedTask | null>();

  const blockedFor = (taskId: string, visiting = new Set<string>()): BacklogBlockedTask | null => {
    if (blockedMemo.has(taskId)) return blockedMemo.get(taskId) ?? null;
    if (finished(taskId)) {
      blockedMemo.set(taskId, null);
      return null;
    }

    const task = taskById.get(taskId);
    if (!task || visiting.has(taskId)) {
      blockedMemo.set(taskId, null);
      return null;
    }

    const decision = decisions.get(taskId);
    if (state.tasks[taskId]?.status === 'failed' && decision?.kind === 'permanent') {
      const blocked: BacklogBlockedTask = {
        taskId,
        kind: 'permanent-failure',
        blockedBy: [],
        rootFailures: [taskId],
        reason: decision.reason,
      };
      blockedMemo.set(taskId, blocked);
      return blocked;
    }

    visiting.add(taskId);
    const dependencyBlockers = task.dependencies
      .map((depId) => blockedFor(depId, visiting))
      .filter((blocked): blocked is BacklogBlockedTask => blocked !== null);
    visiting.delete(taskId);

    if (dependencyBlockers.length === 0) {
      blockedMemo.set(taskId, null);
      return null;
    }

    const blockedBy = dependencyBlockers.map((blockedTask) => blockedTask.taskId);
    const blocked: BacklogBlockedTask = {
      taskId,
      kind: 'dependency-blocked',
      blockedBy,
      rootFailures: unique(dependencyBlockers.flatMap((blockedTask) => blockedTask.rootFailures)),
      reason: `depends on blocked task(s): ${blockedBy.join(', ')}`,
    };
    blockedMemo.set(taskId, blocked);
    return blocked;
  };

  const ready: DAGTask[] = [];
  const blocked: BacklogBlockedTask[] = [];

  for (const task of dag.tasks) {
    if (finished(task.id)) continue;
    const blockedTask = blockedFor(task.id);
    if (blockedTask) {
      blocked.push(blockedTask);
      continue;
    }
    if (task.dependencies.every(dependencySatisfied)) ready.push(task);
  }

  return { ready, blocked };
};
