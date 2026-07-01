import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeBacklogReadiness } from './backlog-readiness.js';
import type { DAGTask, DecompositionDAG, ExecutionState } from './types.js';
import type { Decision } from './policy/retry.js';

const task = (id: string, dependencies: string[] = []): DAGTask => ({
  id,
  name: id,
  description: id,
  dependencies,
  contracts: { inputs: {}, outputs: {} },
  context: { files: [] },
  completionCriteria: { automated: [], manual: [] },
  estimatedScope: 'single-component',
  weight: 'standard',
});

const dag = (tasks: DAGTask[]): DecompositionDAG => ({
  meta: {
    id: 'test-dag',
    source: {
      type: 'description',
      title: 'test',
      description: '',
      figmaUrls: [],
      acceptanceCriteria: [],
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    gitCommit: 'abc123',
    branch: 'main',
    qualityReport: { iterations: 1, checksRun: [], allPassed: true },
  },
  tasks,
  executionLayers: [{ layer: 0, description: 'all', taskIds: tasks.map((t) => t.id) }],
});

const state = (tasks: ExecutionState['tasks']): ExecutionState => ({
  dagPath: '/tmp/dag.json',
  status: 'running',
  startedAt: '',
  currentLayer: 0,
  config: {
    provider: 'codex',
    defaultModel: 'default',
    heavyModel: 'heavy',
    maxTurns: 1,
    permissionMode: 'bypassPermissions',
    dagPath: '/tmp/dag.json',
    dryRun: false,
  },
  layers: { '0': { startedAt: null, completedAt: null, taskCount: Object.keys(tasks).length } },
  tasks,
});

const decisions = (entries: Array<[string, Decision]>): ReadonlyMap<string, Decision> => new Map(entries);

describe('analyzeBacklogReadiness', () => {
  it('keeps independent tasks ready when another branch is permanently blocked', () => {
    const result = analyzeBacklogReadiness(
      dag([task('failed-root'), task('blocked-child', ['failed-root']), task('independent')]),
      state({
        'failed-root': { status: 'failed', error: 'fatal' },
        'blocked-child': { status: 'pending' },
        independent: { status: 'pending' },
      }),
      decisions([['failed-root', { kind: 'permanent', reason: 'non-transient' }]]),
    );

    assert.deepEqual(
      result.ready.map((readyTask) => readyTask.id),
      ['independent'],
    );
    assert.deepEqual(result.blocked, [
      {
        taskId: 'failed-root',
        kind: 'permanent-failure',
        blockedBy: [],
        rootFailures: ['failed-root'],
        reason: 'non-transient',
      },
      {
        taskId: 'blocked-child',
        kind: 'dependency-blocked',
        blockedBy: ['failed-root'],
        rootFailures: ['failed-root'],
        reason: 'depends on blocked task(s): failed-root',
      },
    ]);
  });

  it('keeps retryable failed tasks runnable when their dependencies are complete', () => {
    const result = analyzeBacklogReadiness(
      dag([task('dependency'), task('retryable', ['dependency'])]),
      state({
        dependency: { status: 'completed' },
        retryable: { status: 'failed', error: 'ECONNRESET' },
      }),
      decisions([['retryable', { kind: 'retry', delayMs: 30_000 }]]),
    );

    assert.deepEqual(
      result.ready.map((readyTask) => readyTask.id),
      ['retryable'],
    );
    assert.deepEqual(result.blocked, []);
  });

  it('treats in-progress tasks as ready on resume when dependencies are complete', () => {
    const result = analyzeBacklogReadiness(
      dag([task('dependency'), task('interrupted', ['dependency'])]),
      state({
        dependency: { status: 'completed' },
        interrupted: { status: 'in-progress', worktreeBranch: 'dag/interrupted' },
      }),
      decisions([]),
    );

    assert.deepEqual(
      result.ready.map((readyTask) => readyTask.id),
      ['interrupted'],
    );
    assert.deepEqual(result.blocked, []);
  });

  it('reports transitive dependency-blocked tasks when no runnable work remains', () => {
    const result = analyzeBacklogReadiness(
      dag([task('failed-root'), task('middle', ['failed-root']), task('leaf', ['middle'])]),
      state({
        'failed-root': { status: 'failed', error: 'fatal' },
        middle: { status: 'pending' },
        leaf: { status: 'pending' },
      }),
      decisions([['failed-root', { kind: 'permanent', reason: 'verification-failed' }]]),
    );

    assert.deepEqual(result.ready, []);
    assert.deepEqual(
      result.blocked.map((blockedTask) => [blockedTask.taskId, blockedTask.kind, blockedTask.blockedBy]),
      [
        ['failed-root', 'permanent-failure', []],
        ['middle', 'dependency-blocked', ['failed-root']],
        ['leaf', 'dependency-blocked', ['middle']],
      ],
    );
    assert.deepEqual(result.blocked[2].rootFailures, ['failed-root']);
  });
});
