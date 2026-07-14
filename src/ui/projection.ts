import { existsSync, readFileSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { analyzeBacklogReadiness } from '../backlog-readiness.js';
import { getEventLogPath, readEvents } from '../events/log.js';
import type { DagEvent } from '../events/types.js';
import { decide, type Decision } from '../policy/retry.js';
import { getStatePath } from '../state.js';
import { replay } from '../state/reducer.js';
import type {
  BacklogBlockedTask,
  DAGTask,
  DecompositionDAG,
  ExecutionState,
  ExecutorConfig,
  TaskStatus,
} from '../types.js';
import { validateDAG } from '../validation.js';
import type { UiBacklogGroups, UiDagDetail, UiDagStatus, UiError, UiTaskDetail, UiTaskSummary } from './types.js';

const RECENT_EVENT_LIMIT = 50;

const toMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const displayConfig = (dagPath: string): ExecutorConfig => ({
  provider: 'codex',
  defaultModel: 'default',
  heavyModel: 'heavy',
  maxTurns: 1,
  permissionMode: 'bypassPermissions',
  dagPath,
  dryRun: false,
});

const loadDag = (dagPath: string): DecompositionDAG => validateDAG(JSON.parse(readFileSync(dagPath, 'utf-8')));

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isTaskStatus = (value: unknown): value is TaskStatus =>
  value === 'pending' || value === 'in-progress' || value === 'completed' || value === 'failed';

const isExecutionStatus = (value: unknown): value is ExecutionState['status'] =>
  value === 'running' || value === 'paused' || value === 'completed' || value === 'failed';

const isValidDerivedState = (value: unknown, dagPath: string): value is ExecutionState => {
  if (!isObject(value)) return false;
  if (value.derived !== true) return false;
  if (value.dagPath !== dagPath) return false;
  if (!isExecutionStatus(value.status)) return false;
  if (typeof value.startedAt !== 'string') return false;
  if (typeof value.currentLayer !== 'number') return false;
  if (!isObject(value.config) || !isObject(value.layers) || !isObject(value.tasks)) return false;

  return Object.values(value.tasks).every((taskState) => isObject(taskState) && isTaskStatus(taskState.status));
};

const readState = (statePath: string, dagPath: string, errors: UiError[]): ExecutionState | null => {
  if (!existsSync(statePath)) return null;

  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf-8'));
    if (isValidDerivedState(parsed, dagPath)) return parsed;
    errors.push({ scope: 'state', path: statePath, message: 'State cache is not a valid derived execution state' });
  } catch (err) {
    errors.push({ scope: 'state', path: statePath, message: toMessage(err) });
  }

  return null;
};

const readEventLog = (eventLogPath: string, errors: UiError[]): DagEvent[] => {
  try {
    return readEvents(eventLogPath);
  } catch (err) {
    errors.push({ scope: 'events', path: eventLogPath, message: toMessage(err) });
    return [];
  }
};

const pendingProjectionState = (dag: DecompositionDAG, dagPath: string): ExecutionState => {
  const tasks: ExecutionState['tasks'] = {};
  for (const task of dag.tasks) tasks[task.id] = { status: 'pending' };

  const layers: ExecutionState['layers'] = {};
  for (const layer of dag.executionLayers) {
    layers[String(layer.layer)] = {
      startedAt: null,
      completedAt: null,
      taskCount: layer.taskIds.length,
    };
  }

  return {
    dagPath,
    status: 'running',
    startedAt: '',
    currentLayer: 0,
    config: displayConfig(dagPath),
    layers,
    tasks,
  };
};

const resolveState = (
  dag: DecompositionDAG,
  dagPath: string,
  events: DagEvent[],
  errors: UiError[],
): ExecutionState | null => {
  const state = readState(getStatePath(dagPath), dagPath, errors);
  if (state) return state;
  if (events.length === 0) return null;

  try {
    return replay(events, dag, displayConfig(dagPath));
  } catch (err) {
    errors.push({ scope: 'events', path: getEventLogPath(dagPath), message: toMessage(err) });
    return null;
  }
};

const layerByTask = (dag: DecompositionDAG): Map<string, number> => {
  const layers = new Map<string, number>();
  for (const layer of dag.executionLayers) {
    for (const taskId of layer.taskIds) layers.set(taskId, layer.layer);
  }
  return layers;
};

const decisionsFor = (dag: DecompositionDAG, events: DagEvent[]): Map<string, Decision> =>
  new Map(dag.tasks.map((task) => [task.id, decide(events, task.id)]));

const blockedTasksFor = (
  dag: DecompositionDAG,
  state: ExecutionState,
  events: DagEvent[],
): {
  readyTaskIds: Set<string>;
  blockedByTaskId: Map<string, BacklogBlockedTask>;
  blockedTasks: BacklogBlockedTask[];
} => {
  const readiness = analyzeBacklogReadiness(dag, state, decisionsFor(dag, events));
  const blockedByTaskId = new Map<string, BacklogBlockedTask>();

  for (const blockedTask of state.blockedTasks ?? []) blockedByTaskId.set(blockedTask.taskId, blockedTask);
  for (const blockedTask of readiness.blocked) blockedByTaskId.set(blockedTask.taskId, blockedTask);

  return {
    readyTaskIds: new Set(readiness.ready.map((task) => task.id)),
    blockedByTaskId,
    blockedTasks: [...blockedByTaskId.values()],
  };
};

const normalizeStatus = (status: TaskStatus): UiTaskSummary['status'] =>
  status === 'in-progress' ? 'running' : status;

const taskSummary = (
  task: DAGTask,
  state: ExecutionState,
  layers: ReadonlyMap<string, number>,
  blockedByTaskId: ReadonlyMap<string, BacklogBlockedTask>,
  status?: UiTaskSummary['status'],
): UiTaskSummary => {
  const blocked = blockedByTaskId.get(task.id);
  const taskState = state.tasks[task.id] ?? { status: 'pending' };

  return {
    id: task.id,
    name: task.name,
    status: status ?? normalizeStatus(taskState.status),
    layer: layers.get(task.id) ?? -1,
    dependencies: task.dependencies,
    blockedBy: blocked?.blockedBy ?? [],
    rootFailures: blocked?.rootFailures ?? [],
  };
};

const emptyBacklog = (): UiBacklogGroups => ({
  ready: [],
  running: [],
  blocked: [],
  failed: [],
  done: [],
  pending: [],
});

const buildBacklog = (
  dag: DecompositionDAG,
  state: ExecutionState,
  events: DagEvent[],
): { backlog: UiBacklogGroups; blockedTasks: BacklogBlockedTask[] } => {
  const backlog = emptyBacklog();
  const layers = layerByTask(dag);
  const { readyTaskIds, blockedByTaskId, blockedTasks } = blockedTasksFor(dag, state, events);

  for (const task of dag.tasks) {
    const taskState = state.tasks[task.id] ?? { status: 'pending' };
    const summary = taskSummary(task, state, layers, blockedByTaskId);

    if (taskState.status === 'completed') {
      backlog.done.push(summary);
    } else if (taskState.status === 'in-progress') {
      backlog.running.push(summary);
    } else if (blockedByTaskId.has(task.id)) {
      backlog.blocked.push(taskSummary(task, state, layers, blockedByTaskId, 'blocked'));
    } else if (readyTaskIds.has(task.id)) {
      backlog.ready.push(summary);
    } else if (taskState.status === 'failed') {
      backlog.failed.push(summary);
    } else {
      backlog.pending.push(summary);
    }
  }

  return { backlog, blockedTasks };
};

const progressFor = (dag: DecompositionDAG, state: ExecutionState | null): UiDagDetail['progress'] => {
  const taskStates = dag.tasks.map((task) => state?.tasks[task.id]?.status ?? 'pending');
  const completedTasks = taskStates.filter((status) => status === 'completed').length;
  const failedTasks = taskStates.filter((status) => status === 'failed').length;
  const runningTasks = taskStates.filter((status) => status === 'in-progress').length;
  const totalTasks = dag.tasks.length;

  return {
    totalTasks,
    completedTasks,
    failedTasks,
    runningTasks,
    percent: totalTasks === 0 ? 0 : Math.round((completedTasks / totalTasks) * 100),
  };
};

const statusFor = (state: ExecutionState | null): UiDagStatus => state?.status ?? 'not-started';

const recentEventsFor = (events: DagEvent[]): DagEvent[] => events.slice(-RECENT_EVENT_LIMIT).reverse();

const hasTaskId = (event: DagEvent): event is DagEvent & { taskId: string } => 'taskId' in event;

interface DagProjection {
  detail: UiDagDetail;
  events: DagEvent[];
  projectionState: ExecutionState;
}

const loadDagProjection = (projectPath: string, dagPath: string): DagProjection => {
  const errors: UiError[] = [];
  const dag = loadDag(dagPath);
  const eventLogPath = getEventLogPath(dagPath);
  const events = readEventLog(eventLogPath, errors);
  const state = resolveState(dag, dagPath, events, errors);
  const projectionState = state ?? pendingProjectionState(dag, dagPath);
  const { backlog, blockedTasks } = buildBacklog(dag, projectionState, events);

  return {
    detail: {
      dag,
      dagPath,
      relativePath: relative(projectPath, dagPath).split(sep).join('/'),
      state,
      status: statusFor(state),
      progress: progressFor(dag, state),
      backlog,
      blockedTasks,
      recentEvents: recentEventsFor(events),
      errors,
    },
    events,
    projectionState,
  };
};

export const loadDagDetail = (projectPath: string, dagPath: string): UiDagDetail =>
  loadDagProjection(projectPath, dagPath).detail;

export const loadTaskDetail = (projectPath: string, dagPath: string, taskId: string): UiTaskDetail => {
  const { detail, events, projectionState } = loadDagProjection(projectPath, dagPath);
  const task = detail.dag.tasks.find((candidate) => candidate.id === taskId);
  if (!task) throw new Error(`Unknown task "${taskId}"`);

  const layers = layerByTask(detail.dag);
  const { blockedByTaskId } = blockedTasksFor(detail.dag, projectionState, events);
  const taskState = projectionState.tasks[taskId];

  return {
    task: taskSummary(task, projectionState, layers, blockedByTaskId),
    description: task.description,
    files: task.context.files,
    worktreePath: taskState?.worktreePath ?? null,
    worktreeBranch: taskState?.worktreeBranch ?? null,
    filesModified: taskState?.filesModified ?? [],
    usage: taskState?.usage,
    error: taskState?.error ?? null,
    events: events.filter((event) => hasTaskId(event) && event.taskId === taskId).reverse(),
  };
};
