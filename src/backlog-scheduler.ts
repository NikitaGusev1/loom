import type { BacklogBlockedTask, DAGTask } from './types.js';

export const chooseStartableBacklogTasks = (ready: readonly DAGTask[], activeTaskIds: ReadonlySet<string>): DAGTask[] =>
  ready.filter((task) => !activeTaskIds.has(task.id));

export const shouldPauseForNoReadyWork = (ready: readonly DAGTask[], activeTaskIds: ReadonlySet<string>): boolean =>
  ready.length === 0 && activeTaskIds.size === 0;

export const summarizeBlockedBacklogPause = (blocked: readonly BacklogBlockedTask[]): string => {
  const directFailures = blocked.filter((task) => task.kind === 'permanent-failure').map((task) => task.taskId);
  const dependencyBlocked = blocked.filter((task) => task.kind === 'dependency-blocked').map((task) => task.taskId);

  return (
    `No ready backlog tasks; permanent failures: ${directFailures.join(', ') || 'none'}; ` +
    `dependency-blocked: ${dependencyBlocked.join(', ') || 'none'}`
  );
};
