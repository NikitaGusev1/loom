import type { BacklogBlockedTask, DAGTask, TaskState } from './types.js';

export type SettledBacklogOutcome<T> =
  | { status: 'fulfilled'; taskId: string; outcome: T }
  | { status: 'rejected'; taskId: string; reason: unknown };

export const chooseStartableBacklogTasks = (ready: readonly DAGTask[], activeTaskIds: ReadonlySet<string>): DAGTask[] =>
  ready.filter((task) => !activeTaskIds.has(task.id));

export const reusableBacklogWorktree = (
  taskState: Partial<TaskState> | undefined,
): { path: string; branch: string } | undefined => {
  if (!taskState?.worktreePath || !taskState.worktreeBranch) return undefined;
  return { path: taskState.worktreePath, branch: taskState.worktreeBranch };
};

export const shouldPauseForNoReadyWork = (ready: readonly DAGTask[], activeTaskIds: ReadonlySet<string>): boolean =>
  ready.length === 0 && activeTaskIds.size === 0;

export const waitForNextBacklogOutcome = async <T>(
  running: ReadonlyMap<string, Promise<T>>,
): Promise<SettledBacklogOutcome<T>> => {
  if (running.size === 0) throw new Error('Cannot wait for backlog outcome with no running tasks');
  return Promise.race(
    [...running.entries()].map(([taskId, promise]) =>
      promise.then(
        (outcome) => ({ status: 'fulfilled' as const, taskId, outcome }),
        (reason: unknown) => ({ status: 'rejected' as const, taskId, reason }),
      ),
    ),
  );
};

export const summarizeBlockedBacklogPause = (blocked: readonly BacklogBlockedTask[]): string => {
  const directFailures = blocked.filter((task) => task.kind === 'permanent-failure').map((task) => task.taskId);
  const dependencyBlocked = blocked.filter((task) => task.kind === 'dependency-blocked').map((task) => task.taskId);

  return (
    `No ready backlog tasks; permanent failures: ${directFailures.join(', ') || 'none'}; ` +
    `dependency-blocked: ${dependencyBlocked.join(', ') || 'none'}`
  );
};
