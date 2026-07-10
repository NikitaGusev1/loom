import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeAggregate, computeRunMetrics, metricsFromFiles, renderMetricsHuman } from './metrics.js';
import type { DagEvent } from './events/types.js';
import type { DAGTask, DecompositionDAG, ExecutionState, TaskUsage } from './types.js';

const V = 1 as const;
const at = (sec: number): string => new Date(Date.UTC(2026, 0, 1, 0, 0, sec)).toISOString();

const usage = (overrides: Partial<TaskUsage> = {}): TaskUsage => ({
  inputTokens: 100,
  outputTokens: 200,
  cacheReadInputTokens: 5000,
  cacheCreationInputTokens: 1000,
  costUSD: 0.5,
  numTurns: 5,
  durationMs: 1000,
  durationApiMs: 500,
  ...overrides,
});

const completedState = (overrides: Partial<ExecutionState['config']> = {}): ExecutionState => ({
  dagPath: '/t/dag.json',
  status: 'completed',
  startedAt: at(0),
  currentLayer: 0,
  config: {
    provider: 'codex',
    defaultModel: 'account-default',
    heavyModel: 'account-default',
    maxTurns: 80,
    permissionMode: 'bypassPermissions',
    dagPath: '/t/dag.json',
    dryRun: false,
    ...overrides,
  },
  layers: {},
  tasks: {},
});

const e = {
  dagStarted: (ts: string, resume = false): DagEvent => ({
    kind: 'dag.started',
    schemaVersion: V,
    ts,
    dagPath: '/t/dag.json',
    dagId: 'd',
    branch: 'main',
    resume,
  }),
  dagCompleted: (ts: string, durationMs: number, state = completedState()): DagEvent => ({
    kind: 'dag.completed',
    schemaVersion: V,
    ts,
    dagPath: '/t/dag.json',
    dagId: 'd',
    totalTasks: 0,
    succeededTasks: 0,
    failedTasks: 0,
    durationMs,
    finalState: state,
  }),
  dagPaused: (ts: string, fields: Partial<Extract<DagEvent, { kind: 'dag.paused' }>> = {}): DagEvent => ({
    kind: 'dag.paused',
    schemaVersion: V,
    ts,
    dagPath: '/t/dag.json',
    dagId: 'd',
    reason: 'paused',
    currentLayer: 0,
    ...fields,
  }),
  dagBaseMoved: (ts: string): DagEvent => ({
    kind: 'dag.base-moved',
    schemaVersion: V,
    ts,
    dagPath: '/t/dag.json',
    dagId: 'd',
    previousCommit: 'a',
    newCommit: 'b',
    branch: 'main',
  }),
  layerCompleted: (ts: string, layer: number, taskIds: string[], durationMs: number): DagEvent => ({
    kind: 'layer.completed',
    schemaVersion: V,
    ts,
    dagId: 'd',
    layer,
    taskIds,
    durationMs,
  }),
  layerVerificationFailed: (ts: string): DagEvent => ({
    kind: 'layer.verification-failed',
    schemaVersion: V,
    ts,
    dagId: 'd',
    layer: 0,
    taskIds: [],
    verificationKind: 'test',
    reason: 'failed',
    durationMs: 100,
  }),
  taskCompleted: (ts: string, taskId: string, layer: number, durationMs: number, u: TaskUsage = usage()): DagEvent => ({
    kind: 'task.completed',
    schemaVersion: V,
    ts,
    dagId: 'd',
    taskId,
    taskName: taskId,
    layer,
    durationMs,
    usage: u,
    filesModified: [],
    finalState: { status: 'completed' },
  }),
  contractBroken: (ts: string, taskId: string): DagEvent => ({
    kind: 'contract.broken',
    schemaVersion: V,
    ts,
    dagId: 'd',
    taskId,
    inputName: 'in',
    expectedFrom: 'task-x',
    outputName: 'out',
    outputType: 'file',
    reason: 'missing',
  }),
};

const dagWith = (weights: Record<string, DAGTask['weight']>): DecompositionDAG => ({
  meta: {
    id: 'd',
    source: { type: 'description', title: 'T', description: '', figmaUrls: [], acceptanceCriteria: [] },
    createdAt: at(0),
    gitCommit: 'abc',
    branch: 'main',
    qualityReport: { iterations: 1, checksRun: [], allPassed: true },
  },
  tasks: Object.entries(weights).map(([id, weight]) => ({
    id,
    name: id,
    description: '',
    dependencies: [],
    contracts: { inputs: {}, outputs: {} },
    context: { files: [] },
    completionCriteria: { automated: [], manual: [] },
    estimatedScope: 'single-component',
    weight,
  })),
  executionLayers: [],
});

describe('computeRunMetrics', () => {
  it('computes completed-run task, layer, coordination, and weight metrics', () => {
    const m = computeRunMetrics(
      [
        e.dagStarted(at(0)),
        e.taskCompleted(at(10), 'a', 0, 9000),
        e.taskCompleted(at(12), 'b', 0, 11000),
        e.layerCompleted(at(13), 0, ['a', 'b'], 12000),
        e.dagCompleted(at(20), 20000),
      ],
      dagWith({ a: 'standard', b: 'heavy' }),
    );

    assert.equal(m.terminal, 'completed');
    assert.equal(m.wallClockMs, 20000);
    assert.equal(m.taskCount, 2);
    assert.equal(m.layerCount, 1);
    assert.equal(m.layers[0].barrierGapMs, 1000);
    assert.equal(m.coordination.totalBarrierGapMs, 1000);
    assert.equal(m.totalCostUSD, 1);
    assert.equal(m.perWeight?.standard.n, 1);
    assert.equal(m.perWeight?.heavy.n, 1);
  });

  it('uses local Codex default model context when finalState config is absent', () => {
    const m = computeRunMetrics(
      [
        e.dagStarted(at(0)),
        e.taskCompleted(at(10), 'a', 0, 9000, usage({ cacheCreationInputTokens: 50000, inputTokens: 0 })),
        e.dagPaused(at(12)),
      ],
      dagWith({ a: 'standard' }),
    );

    assert.equal(m.tasks[0].contextWindowBudget, 250_000);
    assert.equal(m.tasks[0].ctxFootprintPctOfBudget, 0.2);
  });

  it('reads typed pause cause directly', () => {
    const m = computeRunMetrics([e.dagStarted(at(0)), e.dagPaused(at(1), { cause: 'signal' })]);
    assert.equal(m.terminal, 'paused');
    assert.equal(m.pauseCause, 'signal');
  });

  it('classifies legacy quota metadata as quota pause cause', () => {
    const m = computeRunMetrics([
      e.dagStarted(at(0)),
      e.dagPaused(at(1), { quota: { category: 'daily', reason: 'daily limit' } }),
    ]);
    assert.equal(m.pauseCause, 'quota');
  });

  it('reconstructs old pause causes from preceding events', () => {
    assert.equal(computeRunMetrics([e.dagStarted(at(0)), e.dagBaseMoved(at(1)), e.dagPaused(at(2))]).pauseCause, 'base-moved');
    assert.equal(
      computeRunMetrics([e.dagStarted(at(0)), e.layerVerificationFailed(at(1)), e.dagPaused(at(2))]).pauseCause,
      'verification-failed',
    );
    assert.equal(
      computeRunMetrics([e.dagStarted(at(0)), e.contractBroken(at(1), 'b'), e.dagPaused(at(2))]).contractBreakCount,
      1,
    );
  });
});

describe('computeAggregate', () => {
  it('aggregates terminal counts, pause distribution, and rates', () => {
    const run1 = computeRunMetrics([
      e.dagStarted(at(0)),
      e.taskCompleted(at(10), 'a', 0, 9000),
      e.layerCompleted(at(11), 0, ['a'], 9500),
      e.dagCompleted(at(12), 12000),
    ]);
    const run2 = computeRunMetrics([e.dagStarted(at(0)), e.dagBaseMoved(at(1)), e.dagPaused(at(2))]);

    const agg = computeAggregate([run1, run2]);
    assert.equal(agg.runCount, 2);
    assert.equal(agg.completedCount, 1);
    assert.equal(agg.pausedCount, 1);
    assert.deepEqual(agg.pauseCauseDistribution, { 'base-moved': 1 });
  });
});

describe('metricsFromFiles', () => {
  it('reads logs, joins sibling DAGs when present, and renders a human report', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metrics-test-'));
    try {
      const logPath = join(dir, 'decomposition-r1.events.jsonl');
      const dagPath = join(dir, 'decomposition-r1.json');
      const events = [
        e.dagStarted(at(0)),
        e.taskCompleted(at(10), 'a', 0, 9000),
        e.layerCompleted(at(11), 0, ['a'], 9500),
        e.dagCompleted(at(12), 12000),
      ];
      writeFileSync(logPath, events.map((event) => JSON.stringify(event)).join('\n') + '\n');
      writeFileSync(dagPath, JSON.stringify(dagWith({ a: 'standard' })));

      const report = metricsFromFiles([logPath]);
      assert.equal(report.runs.length, 1);
      assert.equal(report.runs[0].dagPath, dagPath);
      assert.equal(report.runs[0].tasks[0].weight, 'standard');
      assert.match(renderMetricsHuman(report), /run\s+term\s+tsk/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('adds aggregate for multiple logs and throws for missing or empty logs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metrics-test-'));
    try {
      const log1 = join(dir, 'one.events.jsonl');
      const log2 = join(dir, 'two.events.jsonl');
      writeFileSync(log1, `${JSON.stringify(e.dagStarted(at(0)))}\n${JSON.stringify(e.dagPaused(at(1)))}\n`);
      writeFileSync(log2, `${JSON.stringify(e.dagStarted(at(0)))}\n${JSON.stringify(e.dagPaused(at(1)))}\n`);
      const report = metricsFromFiles([log1, log2]);
      assert.equal(report.aggregate?.runCount, 2);

      assert.throws(() => metricsFromFiles([join(dir, 'missing.events.jsonl')]), /event log not found/);
      const empty = join(dir, 'empty.events.jsonl');
      writeFileSync(empty, '');
      assert.throws(() => metricsFromFiles([empty]), /event log is empty/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
