import { existsSync, readFileSync } from 'node:fs';
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_EXECUTOR_MODELS, MODEL_CONTEXT_WINDOW, ZERO_USAGE } from './consts.js';
import { getDagPathFromEventLog, readRequiredEvents } from './events/log.js';
import type { DagEvent, DagPauseCause } from './events/types.js';
import type { DAGTask, DecompositionDAG } from './types.js';

export type Weight = DAGTask['weight'] | 'unknown';
export type TaskStatusMetric = 'completed' | 'failed' | 'timeout' | 'verification-failed';
export type PauseCause = DagPauseCause | 'other';

export interface TaskMetrics {
  id: string;
  weight: Weight;
  layer: number;
  status: TaskStatusMetric;
  workMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  ctxFootprintTokens: number;
  contextWindowBudget: number;
  ctxFootprintPctOfBudget: number;
  costUSD: number;
  numTurns: number;
}

export interface LayerMetrics {
  layer: number;
  layerDurationMs: number;
  parallelWorkMs: number;
  serialWorkMs: number;
  barrierGapMs: number | null;
  parallelEfficiency: number;
}

export interface Coordination {
  totalBarrierGapMs: number;
  totalParallelWorkMs: number;
  coordinationFraction: number | null;
}

export interface PerWeightBucket {
  n: number;
  medianWorkMs: number;
  medianCostUSD: number;
  medianCtxFootprintTokens: number;
  medianCtxFootprintPctOfBudget: number;
}

export type PerWeight = Record<DAGTask['weight'], PerWeightBucket>;

export interface RunMetrics {
  dagId: string;
  eventLogPath: string;
  dagPath: string | null;
  terminal: 'completed' | 'paused' | 'aborted' | 'incomplete';
  pauseCause: PauseCause | null;
  resumeCount: number;
  taskCount: number;
  layerCount: number;
  contractBreakCount: number;
  totalCostUSD: number;
  wallClockMs: number | null;
  tasks: TaskMetrics[];
  layers: LayerMetrics[];
  coordination: Coordination;
  perWeight?: PerWeight;
}

export type RunCoreMetrics = Omit<RunMetrics, 'eventLogPath' | 'dagPath'>;

export interface Aggregate {
  runCount: number;
  completedCount: number;
  pausedCount: number;
  pauseCauseDistribution: Record<string, number>;
  medianTaskCtxFootprintPctOfBudget: number;
  medianCoordinationFraction: number;
  contractBreakRate: number;
  resumeRate: number;
  perWeight: PerWeight;
}

export interface MetricsReport {
  runs: RunMetrics[];
  aggregate?: Aggregate;
}

const WEIGHTS: DAGTask['weight'][] = ['trivial', 'standard', 'heavy'];
const LAYER_TERMINAL_KINDS = ['layer.completed', 'layer.completed-with-failures'] as const;
const TASK_TERMINAL_KINDS = ['task.completed', 'task.failed', 'task.timeout', 'task.verification-failed'] as const;

type LayerTerminalEvent = Extract<DagEvent, { kind: (typeof LAYER_TERMINAL_KINDS)[number] }>;
type TaskTerminalEvent = Extract<DagEvent, { kind: (typeof TASK_TERMINAL_KINDS)[number] }>;
type TaskCompletedEvent = Extract<DagEvent, { kind: 'task.completed' }>;

const isLayerTerminal = (event: DagEvent): event is LayerTerminalEvent =>
  (LAYER_TERMINAL_KINDS as readonly string[]).includes(event.kind);
const isTaskTerminal = (event: DagEvent): event is TaskTerminalEvent =>
  (TASK_TERMINAL_KINDS as readonly string[]).includes(event.kind);

const median = (nums: number[]): number => {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
};

const mean = (nums: number[]): number => (nums.length === 0 ? 0 : nums.reduce((sum, n) => sum + n, 0) / nums.length);

const STATUS_BY_KIND: Record<TaskTerminalEvent['kind'], TaskStatusMetric> = {
  'task.completed': 'completed',
  'task.failed': 'failed',
  'task.timeout': 'timeout',
  'task.verification-failed': 'verification-failed',
};

const lastIndexOfKind = (events: DagEvent[], match: (kind: DagEvent['kind']) => boolean): number => {
  for (let i = events.length - 1; i >= 0; i--) {
    if (match(events[i].kind)) return i;
  }
  return -1;
};

const pauseCauseFromPreceding = (events: DagEvent[]): PauseCause | null => {
  const pausedIdx = lastIndexOfKind(events, (kind) => kind === 'dag.paused');
  if (pausedIdx === -1) return null;
  const paused = events[pausedIdx] as Extract<DagEvent, { kind: 'dag.paused' }>;
  if (paused.cause) return paused.cause;
  if (paused.quota) return 'quota';

  const prev = events[pausedIdx - 1];
  switch (prev?.kind) {
    case 'dag.base-moved':
      return 'base-moved';
    case 'layer.verification-failed':
    case 'task.verification-failed':
      return 'verification-failed';
    case 'contract.broken':
      return 'contract-broken';
    case 'layer.failed':
      return 'all-tasks-failed';
    default: {
      const reason = paused.reason.toLowerCase();
      if (reason.includes('merge conflict')) return 'merge-conflict';
      if (reason.includes('signal')) return 'signal';
      return 'other';
    }
  }
};

const splitSegments = (events: DagEvent[]): DagEvent[][] => {
  const segments: DagEvent[][] = [];
  for (const event of events) {
    if (event.kind === 'dag.started' || segments.length === 0) segments.push([]);
    segments[segments.length - 1].push(event);
  }
  return segments;
};

export const computeRunMetrics = (events: DagEvent[], dag?: DecompositionDAG | null): RunCoreMetrics => {
  const dagId = events.find((event) => event.kind === 'dag.started')?.dagId ?? events[0]?.dagId ?? '';
  const resumeCount = events.filter((event) => event.kind === 'dag.started' && event.resume).length;

  const lifecycleIdx = lastIndexOfKind(
    events,
    (kind) => kind === 'dag.completed' || kind === 'dag.paused' || kind === 'dag.aborted',
  );
  const lastLifecycle =
    lifecycleIdx === -1
      ? undefined
      : (events[lifecycleIdx] as Extract<DagEvent, { kind: 'dag.completed' | 'dag.paused' | 'dag.aborted' }>);
  const terminal: RunMetrics['terminal'] = lastLifecycle
    ? ({ 'dag.completed': 'completed', 'dag.paused': 'paused', 'dag.aborted': 'aborted' } as const)[lastLifecycle.kind]
    : 'incomplete';
  const completed = lastLifecycle?.kind === 'dag.completed' ? lastLifecycle : undefined;
  const wallClockMs = completed?.durationMs ?? null;
  const pauseCause = terminal === 'paused' ? pauseCauseFromPreceding(events) : null;

  const models = completed?.finalState?.config ?? DEFAULT_EXECUTOR_MODELS;
  const weightOf = dag ? new Map(dag.tasks.map((task) => [task.id, task.weight])) : null;
  const windowFor = (weight: Weight): number => {
    if (weight === 'unknown') return DEFAULT_CONTEXT_WINDOW;
    const model = weight === 'heavy' ? models.heavyModel : models.defaultModel;
    return MODEL_CONTEXT_WINDOW[model] ?? DEFAULT_CONTEXT_WINDOW;
  };

  const lastTerminalByTask = new Map<string, TaskTerminalEvent>();
  for (const event of events) {
    if (isTaskTerminal(event)) lastTerminalByTask.set(event.taskId, event);
  }

  const tasks: TaskMetrics[] = [...lastTerminalByTask.values()].map((event) => {
    const usage = event.usage ?? ZERO_USAGE;
    const weight: Weight = weightOf?.get(event.taskId) ?? 'unknown';
    const ctxFootprintTokens = usage.cacheCreationInputTokens + usage.inputTokens;
    const contextWindowBudget = windowFor(weight);
    return {
      id: event.taskId,
      weight,
      layer: event.layer,
      status: STATUS_BY_KIND[event.kind],
      workMs: event.durationMs,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
      ctxFootprintTokens,
      contextWindowBudget,
      ctxFootprintPctOfBudget: ctxFootprintTokens / contextWindowBudget,
      costUSD: usage.costUSD,
      numTurns: usage.numTurns,
    };
  });

  const layerMap = new Map<number, LayerMetrics>();
  for (const segment of splitSegments(events)) {
    const segTasks = segment.filter((event): event is TaskCompletedEvent => event.kind === 'task.completed');
    for (const terminalEvent of segment) {
      if (!isLayerTerminal(terminalEvent)) continue;
      const layerTasks = segTasks.filter((task) => task.layer === terminalEvent.layer);
      const durations = layerTasks.map((task) => task.durationMs);
      const parallelWorkMs = durations.length ? Math.max(...durations) : 0;
      const serialWorkMs = durations.reduce((sum, duration) => sum + duration, 0);
      const barrierGapMs = layerTasks.length
        ? Date.parse(terminalEvent.ts) - Math.max(...layerTasks.map((task) => Date.parse(task.ts)))
        : null;
      layerMap.set(terminalEvent.layer, {
        layer: terminalEvent.layer,
        layerDurationMs: terminalEvent.durationMs,
        parallelWorkMs,
        serialWorkMs,
        barrierGapMs,
        parallelEfficiency: serialWorkMs ? parallelWorkMs / serialWorkMs : 0,
      });
    }
  }
  const layers = [...layerMap.values()].sort((a, b) => a.layer - b.layer);

  const gaps = layers.map((layer) => layer.barrierGapMs).filter((gap): gap is number => gap !== null);
  const totalBarrierGapMs = gaps.reduce((sum, gap) => sum + gap, 0);
  const totalParallelWorkMs = layers.reduce((sum, layer) => sum + layer.parallelWorkMs, 0);
  const coordDenom = totalBarrierGapMs + totalParallelWorkMs;
  const coordination: Coordination = {
    totalBarrierGapMs,
    totalParallelWorkMs,
    coordinationFraction: gaps.length === 0 || coordDenom === 0 ? null : totalBarrierGapMs / coordDenom,
  };

  const run: RunCoreMetrics = {
    dagId,
    terminal,
    pauseCause,
    resumeCount,
    taskCount: tasks.length,
    layerCount: layers.length,
    contractBreakCount: events.filter((event) => event.kind === 'contract.broken').length,
    totalCostUSD: tasks.reduce((sum, task) => sum + task.costUSD, 0),
    wallClockMs,
    tasks,
    layers,
    coordination,
  };

  if (dag) run.perWeight = buildPerWeight(tasks);
  return run;
};

const buildPerWeight = (tasks: TaskMetrics[]): PerWeight => {
  const out = {} as PerWeight;
  for (const weight of WEIGHTS) {
    const bucket = tasks.filter((task) => task.weight === weight);
    out[weight] = {
      n: bucket.length,
      medianWorkMs: median(bucket.map((task) => task.workMs)),
      medianCostUSD: median(bucket.map((task) => task.costUSD)),
      medianCtxFootprintTokens: median(bucket.map((task) => task.ctxFootprintTokens)),
      medianCtxFootprintPctOfBudget: median(bucket.map((task) => task.ctxFootprintPctOfBudget)),
    };
  }
  return out;
};

export const computeAggregate = (runs: RunCoreMetrics[]): Aggregate => {
  const allTasks = runs.flatMap((run) => run.tasks);
  const coordFractions = runs
    .map((run) => run.coordination.coordinationFraction)
    .filter((fraction): fraction is number => fraction !== null);
  const pauseCauseDistribution: Record<string, number> = {};
  for (const run of runs) {
    if (run.pauseCause) pauseCauseDistribution[run.pauseCause] = (pauseCauseDistribution[run.pauseCause] ?? 0) + 1;
  }

  return {
    runCount: runs.length,
    completedCount: runs.filter((run) => run.terminal === 'completed').length,
    pausedCount: runs.filter((run) => run.terminal === 'paused').length,
    pauseCauseDistribution,
    medianTaskCtxFootprintPctOfBudget: median(allTasks.map((task) => task.ctxFootprintPctOfBudget)),
    medianCoordinationFraction: median(coordFractions),
    contractBreakRate: mean(runs.map((run) => run.contractBreakCount)),
    resumeRate: mean(runs.map((run) => run.resumeCount)),
    perWeight: buildPerWeight(allTasks.filter((task) => task.weight !== 'unknown')),
  };
};

const loadSiblingDag = (
  eventLogPath: string,
  events: DagEvent[],
): { dag: DecompositionDAG | null; dagPath: string | null } => {
  const candidates = [
    getDagPathFromEventLog(eventLogPath),
    events.find((event) => event.kind === 'dag.started')?.dagPath,
  ].filter((path): path is string => Boolean(path));

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      return { dag: JSON.parse(readFileSync(path, 'utf-8')) as DecompositionDAG, dagPath: path };
    } catch {
      // Metrics can still be computed without DAG annotations.
    }
  }
  return { dag: null, dagPath: null };
};

const pct = (n: number | null): string => (n === null ? '-' : `${(n * 100).toFixed(0)}%`);

export const renderMetricsHuman = (report: MetricsReport): string => {
  const lines: string[] = [];
  lines.push(
    `${'run'.padEnd(46)} ${'term'.padEnd(10)} ${'tsk'.padStart(3)} ${'lyr'.padStart(3)} ${'coord'.padStart(5)} ${'ctx%'.padStart(5)} ${'cbrk'.padStart(4)} ${'rsm'.padStart(3)}  cost`,
  );
  lines.push('-'.repeat(96));
  for (const run of report.runs) {
    const medCtx = median(run.tasks.map((task) => task.ctxFootprintPctOfBudget));
    const name = run.dagId.replace(/^decomp-/, '');
    lines.push(
      `${name.slice(0, 46).padEnd(46)} ${(run.pauseCause ? `${run.terminal}:${run.pauseCause}` : run.terminal).slice(0, 10).padEnd(10)} ${String(run.taskCount).padStart(3)} ${String(run.layerCount).padStart(3)} ${pct(run.coordination.coordinationFraction).padStart(5)} ${pct(medCtx).padStart(5)} ${String(run.contractBreakCount).padStart(4)} ${String(run.resumeCount).padStart(3)}  $${run.totalCostUSD.toFixed(2)}`,
    );
  }
  if (report.aggregate) {
    const aggregate = report.aggregate;
    lines.push('-'.repeat(96));
    lines.push(
      `CORPUS: ${aggregate.runCount} runs (${aggregate.completedCount} completed, ${aggregate.pausedCount} paused) | ` +
        `median coord ${pct(aggregate.medianCoordinationFraction)} | median ctx ${pct(aggregate.medianTaskCtxFootprintPctOfBudget)} | ` +
        `contract-breaks/run ${aggregate.contractBreakRate.toFixed(1)} | resumes/run ${aggregate.resumeRate.toFixed(1)}`,
    );
    lines.push(`pause causes: ${JSON.stringify(aggregate.pauseCauseDistribution)}`);
    for (const weight of WEIGHTS) {
      const bucket = aggregate.perWeight[weight];
      if (bucket.n > 0) {
        lines.push(
          `  ${weight.padEnd(9)} n=${String(bucket.n).padStart(3)} | median work ${(bucket.medianWorkMs / 1000).toFixed(0)}s | median ctx ${pct(bucket.medianCtxFootprintPctOfBudget)} | median cost $${bucket.medianCostUSD.toFixed(2)}`,
        );
      }
    }
  }
  return lines.join('\n');
};

export const metricsFromFiles = (paths: string[]): MetricsReport => {
  const runs: RunMetrics[] = paths.map((eventLogPath) => {
    const events = readRequiredEvents(eventLogPath);
    const { dag, dagPath } = loadSiblingDag(eventLogPath, events);
    return { ...computeRunMetrics(events, dag), eventLogPath, dagPath };
  });
  return runs.length > 1 ? { runs, aggregate: computeAggregate(runs) } : { runs };
};
