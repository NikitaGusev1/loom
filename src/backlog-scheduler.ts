import type { BacklogBlockedTask, DAGTask, TaskState } from './types.js';

export type SettledBacklogOutcome<T> =
  | { status: 'fulfilled'; taskId: string; outcome: T }
  | { status: 'rejected'; taskId: string; reason: unknown };

export const chooseStartableBacklogTasks = (ready: readonly DAGTask[], activeTaskIds: ReadonlySet<string>): DAGTask[] =>
  ready.filter((task) => !activeTaskIds.has(task.id));

export const pendingMergeBacklogTaskIds = (
  tasks: readonly DAGTask[],
  taskStates: Readonly<Record<string, TaskState | undefined>>,
  activeTaskIds: ReadonlySet<string>,
): string[] =>
  tasks
    .filter((task) => {
      const taskState = taskStates[task.id];
      return taskState?.status === 'completed' && taskState.merged !== true && !activeTaskIds.has(task.id);
    })
    .map((task) => task.id);

export const isBacklogTaskIntegrated = (taskState: TaskState | undefined): boolean =>
  taskState?.status === 'completed' && (taskState.merged === true || !taskState.worktreeBranch);

export const allBacklogTasksIntegrated = (
  tasks: readonly DAGTask[],
  taskStates: Readonly<Record<string, TaskState | undefined>>,
): boolean => tasks.every((task) => isBacklogTaskIntegrated(taskStates[task.id]));

export const connectBacklogPauseAbort = (
  externalSignal: AbortSignal | undefined,
  controller: AbortController,
  reason: unknown,
): void => {
  if (!externalSignal) return;
  const abort = (): void => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  if (externalSignal.aborted) abort();
  else externalSignal.addEventListener('abort', abort, { once: true });
};

export const reusableBacklogWorktree = (
  taskState: Partial<TaskState> | undefined,
): { path: string; branch: string } | undefined => {
  if (!taskState?.worktreePath || !taskState.worktreeBranch) return undefined;
  return { path: taskState.worktreePath, branch: taskState.worktreeBranch };
};

export const shouldPauseForNoReadyWork = (ready: readonly DAGTask[], activeTaskIds: ReadonlySet<string>): boolean =>
  ready.length === 0 && activeTaskIds.size === 0;

export const observeBacklogOutcome = <T>(taskId: string, promise: Promise<T>): Promise<SettledBacklogOutcome<T>> =>
  promise.then(
    (outcome) => ({ status: 'fulfilled' as const, taskId, outcome }),
    (reason: unknown) => ({ status: 'rejected' as const, taskId, reason }),
  );

export const waitForNextBacklogOutcome = async <T>(
  running: ReadonlyMap<string, Promise<SettledBacklogOutcome<T>>>,
): Promise<SettledBacklogOutcome<T>> => {
  if (running.size === 0) throw new Error('Cannot wait for backlog outcome with no running tasks');
  return Promise.race(running.values());
};

export const stopRunningBacklogTasks = async <T>(
  running: Map<string, Promise<T>>,
  controller: AbortController,
  reason: unknown,
): Promise<void> => {
  if (running.size === 0) return;
  if (!controller.signal.aborted) controller.abort(reason);
  await Promise.allSettled([...running.values()]);
  running.clear();
};

export const summarizeBlockedBacklogPause = (blocked: readonly BacklogBlockedTask[]): string => {
  const directFailures = blocked.filter((task) => task.kind === 'permanent-failure').map((task) => task.taskId);
  const dependencyBlocked = blocked.filter((task) => task.kind === 'dependency-blocked').map((task) => task.taskId);

  return (
    `No ready backlog tasks; permanent failures: ${directFailures.join(', ') || 'none'}; ` +
    `dependency-blocked: ${dependencyBlocked.join(', ') || 'none'}`
  );
};
