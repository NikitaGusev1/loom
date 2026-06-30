import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { reduce, replay } from './reducer.js';
import { initialState } from './initial.js';
import type { DecompositionDAG, ExecutorConfig, ExecutionState, TaskUsage } from '../types.js';
import type { DagEvent } from '../events/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const V = 1 as const;

const ts = '2024-01-01T00:00:00.000Z';
const ts1 = '2024-01-01T00:00:01.000Z';
const ts2 = '2024-01-01T00:00:02.000Z';
const ts3 = '2024-01-01T00:00:03.000Z';
const ts4 = '2024-01-01T00:00:04.000Z';
const ts5 = '2024-01-01T00:00:05.000Z';

const makeConfig = (): ExecutorConfig => ({
  provider: 'claude',
  defaultModel: 'claude-sonnet-4-6',
  heavyModel: 'claude-opus-4-8',
  maxTurns: 50,
  permissionMode: 'bypassPermissions',
  dagPath: '/test/dag.json',
  dryRun: false,
});

const makeDAG = (): DecompositionDAG => ({
  meta: {
    id: 'test-dag',
    source: {
      type: 'description',
      title: 'Test DAG',
      description: 'Test',
      figmaUrls: [],
      acceptanceCriteria: [],
    },
    createdAt: ts,
    gitCommit: 'abc123',
    branch: 'main',
    qualityReport: { iterations: 1, checksRun: [], allPassed: true },
  },
  tasks: [
    {
      id: 'task-a',
      name: 'Task A',
      description: 'First task',
      dependencies: [],
      contracts: { inputs: {}, outputs: {} },
      context: { files: [] },
      completionCriteria: { automated: [], manual: [] },
      estimatedScope: 'single-component',
      weight: 'standard',
    },
    {
      id: 'task-b',
      name: 'Task B',
      description: 'Second task',
      dependencies: ['task-a'],
      contracts: { inputs: {}, outputs: {} },
      context: { files: [] },
      completionCriteria: { automated: [], manual: [] },
      estimatedScope: 'single-component',
      weight: 'standard',
    },
  ],
  executionLayers: [
    { layer: 0, description: 'Layer 0', taskIds: ['task-a'] },
    { layer: 1, description: 'Layer 1', taskIds: ['task-b'] },
  ],
});

const makeUsage = (): TaskUsage => ({
  inputTokens: 1000,
  outputTokens: 200,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  costUSD: 0.01,
  numTurns: 3,
  durationMs: 5000,
  durationApiMs: 4000,
});

const makeExecutionState = (): ExecutionState => ({
  dagPath: '/test/dag.json',
  status: 'completed',
  startedAt: ts,
  completedAt: ts4,
  currentLayer: 0,
  config: makeConfig(),
  layers: {},
  tasks: {},
});

const dag = makeDAG();
const config = makeConfig();
const init = () => initialState(dag, config);

// ---------------------------------------------------------------------------
// Per-kind unit tests — dag-level events
// ---------------------------------------------------------------------------

describe('reduce — dag.started', () => {
  it('sets status to running and startedAt from event ts', () => {
    const event: DagEvent = {
      kind: 'dag.started',
      schemaVersion: V,
      ts,
      dagPath: '/test/dag.json',
      dagId: 'test-dag',
      branch: 'main',
      resume: false,
    };
    const next = reduce(init(), event);
    assert.equal(next.status, 'running');
    assert.equal(next.startedAt, ts);
  });
});

describe('reduce — dag.completed', () => {
  it('sets status completed and completedAt when finalState.status is not failed', () => {
    const event: DagEvent = {
      kind: 'dag.completed',
      schemaVersion: V,
      ts: ts4,
      dagPath: '/test/dag.json',
      dagId: 'test-dag',
      totalTasks: 2,
      succeededTasks: 2,
      failedTasks: 0,
      durationMs: 4000,
      finalState: { ...makeExecutionState(), status: 'completed' },
    };
    const next = reduce(init(), event);
    assert.equal(next.status, 'completed');
    assert.equal(next.completedAt, ts4);
  });

  it('sets status failed when finalState.status is failed', () => {
    const event: DagEvent = {
      kind: 'dag.completed',
      schemaVersion: V,
      ts: ts4,
      dagPath: '/test/dag.json',
      dagId: 'test-dag',
      totalTasks: 2,
      succeededTasks: 1,
      failedTasks: 1,
      durationMs: 4000,
      finalState: { ...makeExecutionState(), status: 'failed' },
    };
    const next = reduce(init(), event);
    assert.equal(next.status, 'failed');
  });
});

describe('reduce — dag.paused', () => {
  it('sets status paused and updates currentLayer', () => {
    const event: DagEvent = {
      kind: 'dag.paused',
      schemaVersion: V,
      ts,
      dagPath: '/test/dag.json',
      dagId: 'test-dag',
      reason: 'user-pause',
      currentLayer: 1,
    };
    const next = reduce(init(), event);
    assert.equal(next.status, 'paused');
    assert.equal(next.currentLayer, 1);
  });

  it('stores backlog blocked-task metadata when present', () => {
    const event: DagEvent = {
      kind: 'dag.paused',
      schemaVersion: V,
      ts,
      dagPath: '/test/dag.json',
      dagId: 'test-dag',
      reason: 'No ready backlog tasks',
      currentLayer: 1,
      blockedTasks: [
        {
          taskId: 'task-b',
          kind: 'dependency-blocked',
          blockedBy: ['task-a'],
          rootFailures: ['task-a'],
          reason: 'depends on blocked task(s): task-a',
        },
      ],
    };
    const next = reduce(init(), event);
    assert.deepEqual(next.blockedTasks, event.blockedTasks);
  });
});

describe('reduce — dag.aborted', () => {
  it('sets status failed and completedAt', () => {
    const event: DagEvent = {
      kind: 'dag.aborted',
      schemaVersion: V,
      ts: ts1,
      dagPath: '/test/dag.json',
      dagId: 'test-dag',
      reason: 'SIGINT received',
      signal: 'SIGINT',
    };
    const next = reduce(init(), event);
    assert.equal(next.status, 'failed');
    assert.equal(next.completedAt, ts1);
  });
});

describe('reduce — dag.base-moved', () => {
  it('is informational — returns same state reference', () => {
    const state = init();
    const event: DagEvent = {
      kind: 'dag.base-moved',
      schemaVersion: V,
      ts,
      dagPath: '/test/dag.json',
      dagId: 'test-dag',
      previousCommit: 'abc',
      newCommit: 'def',
      branch: 'main',
    };
    const next = reduce(state, event);
    assert.deepEqual(next, state);
  });
});

// ---------------------------------------------------------------------------
// Per-kind unit tests — layer-level events
// ---------------------------------------------------------------------------

describe('reduce — layer.started', () => {
  it('sets currentLayer, layer startedAt, and preserves taskCount from initial', () => {
    const event: DagEvent = {
      kind: 'layer.started',
      schemaVersion: V,
      ts,
      dagId: 'test-dag',
      layer: 0,
      taskIds: ['task-a'],
    };
    const next = reduce(init(), event);
    assert.equal(next.currentLayer, 0);
    assert.equal(next.layers['0'].startedAt, ts);
    assert.equal(next.layers['0'].completedAt, null);
    assert.equal(next.layers['0'].taskCount, 1);
  });

  it('falls back to event.taskIds.length for taskCount when layer not pre-initialized', () => {
    const state = { ...init(), layers: {} };
    const event: DagEvent = {
      kind: 'layer.started',
      schemaVersion: V,
      ts,
      dagId: 'test-dag',
      layer: 5,
      taskIds: ['x', 'y', 'z'],
    };
    const next = reduce(state, event);
    assert.equal(next.layers['5'].taskCount, 3);
  });
});

describe('reduce — layer.completed', () => {
  it('sets completedAt on the layer and advances currentLayer past it', () => {
    const state = { ...init(), layers: { '0': { startedAt: ts, completedAt: null, taskCount: 1 } } };
    const event: DagEvent = {
      kind: 'layer.completed',
      schemaVersion: V,
      ts: ts1,
      dagId: 'test-dag',
      layer: 0,
      taskIds: ['task-a'],
      durationMs: 1000,
    };
    const next = reduce(state, event);
    assert.equal(next.layers['0'].completedAt, ts1);
    assert.equal(next.currentLayer, 1);
  });
});

describe('reduce — layer.completed-with-failures', () => {
  it('sets completedAt on the layer and advances currentLayer past it', () => {
    const state = { ...init(), layers: { '0': { startedAt: ts, completedAt: null, taskCount: 1 } } };
    const event: DagEvent = {
      kind: 'layer.completed-with-failures',
      schemaVersion: V,
      ts: ts1,
      dagId: 'test-dag',
      layer: 0,
      taskIds: ['task-a'],
      failedTaskIds: ['task-a'],
      durationMs: 1000,
    };
    const next = reduce(state, event);
    assert.equal(next.layers['0'].completedAt, ts1);
    assert.equal(next.currentLayer, 1);
  });
});

describe('reduce — layer.failed', () => {
  it('sets completedAt on the layer', () => {
    const state = { ...init(), layers: { '0': { startedAt: ts, completedAt: null, taskCount: 1 } } };
    const event: DagEvent = {
      kind: 'layer.failed',
      schemaVersion: V,
      ts: ts1,
      dagId: 'test-dag',
      layer: 0,
      taskIds: ['task-a'],
      failedTaskIds: ['task-a'],
      reason: 'all tasks failed',
    };
    const next = reduce(state, event);
    assert.equal(next.layers['0'].completedAt, ts1);
  });
});

// ---------------------------------------------------------------------------
// Per-kind unit tests — task-level events
// ---------------------------------------------------------------------------

describe('reduce — task.started', () => {
  it('sets status in-progress, startedAt, worktreePath, worktreeBranch', () => {
    const event: DagEvent = {
      kind: 'task.started',
      schemaVersion: V,
      ts,
      dagId: 'test-dag',
      taskId: 'task-a',
      taskName: 'Task A',
      layer: 0,
      worktreePath: '/wt/task-a',
      worktreeBranch: 'task-a-branch',
    };
    const next = reduce(init(), event);
    assert.equal(next.tasks['task-a'].status, 'in-progress');
    assert.equal(next.tasks['task-a'].startedAt, ts);
    assert.equal(next.tasks['task-a'].worktreePath, '/wt/task-a');
    assert.equal(next.tasks['task-a'].worktreeBranch, 'task-a-branch');
  });
});

describe('reduce — task.completed', () => {
  it('sets status completed, completedAt, filesModified, usage', () => {
    const usage = makeUsage();
    const state = {
      ...init(),
      tasks: { 'task-a': { status: 'in-progress' as const, startedAt: ts } },
    };
    const event: DagEvent = {
      kind: 'task.completed',
      schemaVersion: V,
      ts: ts1,
      dagId: 'test-dag',
      taskId: 'task-a',
      taskName: 'Task A',
      layer: 0,
      durationMs: 1000,
      usage,
      filesModified: ['src/a.ts'],
      finalState: { status: 'completed', completedAt: ts1 },
    };
    const next = reduce(state, event);
    assert.equal(next.tasks['task-a'].status, 'completed');
    assert.equal(next.tasks['task-a'].completedAt, ts1);
    assert.deepEqual(next.tasks['task-a'].filesModified, ['src/a.ts']);
    assert.deepEqual(next.tasks['task-a'].usage, usage);
  });
});

describe('reduce — task.failed', () => {
  it('sets status failed, completedAt, error message, and optional usage', () => {
    const usage = makeUsage();
    const state = {
      ...init(),
      tasks: { 'task-a': { status: 'in-progress' as const, startedAt: ts } },
    };
    const event: DagEvent = {
      kind: 'task.failed',
      schemaVersion: V,
      ts: ts1,
      dagId: 'test-dag',
      taskId: 'task-a',
      taskName: 'Task A',
      layer: 0,
      error: 'agent crashed',
      durationMs: 1000,
      usage,
      finalState: { status: 'failed', completedAt: ts1, error: 'agent crashed' },
    };
    const next = reduce(state, event);
    assert.equal(next.tasks['task-a'].status, 'failed');
    assert.equal(next.tasks['task-a'].completedAt, ts1);
    assert.equal(next.tasks['task-a'].error, 'agent crashed');
    assert.deepEqual(next.tasks['task-a'].usage, usage);
  });
});

describe('reduce — task.timeout', () => {
  it('sets status failed with formatted timeout error string', () => {
    const state = {
      ...init(),
      tasks: { 'task-a': { status: 'in-progress' as const, startedAt: ts } },
    };
    const event: DagEvent = {
      kind: 'task.timeout',
      schemaVersion: V,
      ts: ts1,
      dagId: 'test-dag',
      taskId: 'task-a',
      taskName: 'Task A',
      layer: 0,
      timeoutMs: 60000,
      durationMs: 60000,
      finalState: { status: 'failed', completedAt: ts1 },
    };
    const next = reduce(state, event);
    assert.equal(next.tasks['task-a'].status, 'failed');
    assert.equal(next.tasks['task-a'].completedAt, ts1);
    assert.equal(next.tasks['task-a'].error, 'timeout after 60000ms');
  });
});

describe('reduce — task.retry', () => {
  it('sets status in-progress and clears error', () => {
    const state = {
      ...init(),
      tasks: { 'task-a': { status: 'failed' as const, completedAt: ts, error: 'crashed' } },
    };
    const event: DagEvent = {
      kind: 'task.retry',
      schemaVersion: V,
      ts: ts1,
      dagId: 'test-dag',
      taskId: 'task-a',
      taskName: 'Task A',
      layer: 0,
      attempt: 1,
      reason: 'transient error',
      previousError: 'crashed',
    };
    const next = reduce(state, event);
    assert.equal(next.tasks['task-a'].status, 'in-progress');
    assert.equal(next.tasks['task-a'].error, undefined);
  });
});

describe('reduce — task.reset', () => {
  it('rewinds task to pending, discarding all prior fields', () => {
    const state = {
      ...init(),
      tasks: {
        'task-a': {
          status: 'failed' as const,
          error: 'crashed',
          usage: makeUsage(),
          filesModified: ['src/foo.ts'],
          startedAt: ts,
          completedAt: ts1,
        },
      },
    };
    const event: DagEvent = {
      kind: 'task.reset',
      schemaVersion: V,
      ts: ts2,
      dagId: 'test-dag',
      taskId: 'task-a',
      taskName: 'Task A',
      layer: 0,
      previousStatus: 'failed',
      reason: 'manual reset',
    };
    const next = reduce(state, event);
    assert.deepEqual(next.tasks['task-a'], { status: 'pending' });
  });

  it('rewinds currentLayer to event.layer when currentLayer is ahead', () => {
    const state = { ...init(), currentLayer: 3 };
    const event: DagEvent = {
      kind: 'task.reset',
      schemaVersion: V,
      ts: ts2,
      dagId: 'test-dag',
      taskId: 'task-a',
      taskName: 'Task A',
      layer: 1,
      previousStatus: 'completed',
      reason: 'rerun',
    };
    const next = reduce(state, event);
    assert.equal(next.currentLayer, 1);
  });

  it('does not rewind currentLayer when event.layer is ahead of current', () => {
    const state = init();
    const event: DagEvent = {
      kind: 'task.reset',
      schemaVersion: V,
      ts: ts2,
      dagId: 'test-dag',
      taskId: 'task-a',
      taskName: 'Task A',
      layer: 2,
      previousStatus: 'completed',
      reason: 'rerun',
    };
    const next = reduce(state, event);
    assert.equal(next.currentLayer, 0);
  });
});

// ---------------------------------------------------------------------------
// Per-kind unit tests — worktree events
// ---------------------------------------------------------------------------

describe('reduce — worktree.created', () => {
  it('sets worktreePath and worktreeBranch on the task', () => {
    const event: DagEvent = {
      kind: 'worktree.created',
      schemaVersion: V,
      ts,
      dagId: 'test-dag',
      taskId: 'task-a',
      worktreePath: '/wt/task-a',
      branch: 'task-a-branch',
      baseBranch: 'main',
    };
    const next = reduce(init(), event);
    assert.equal(next.tasks['task-a'].worktreePath, '/wt/task-a');
    assert.equal(next.tasks['task-a'].worktreeBranch, 'task-a-branch');
  });
});

describe('reduce — worktree.merged', () => {
  it('marks the task merged so a resume can distinguish merged from completed-only', () => {
    const state = init();
    const event: DagEvent = {
      kind: 'worktree.merged',
      schemaVersion: V,
      ts,
      dagId: 'test-dag',
      taskId: 'task-a',
      worktreePath: '/wt/task-a',
      branch: 'task-a-branch',
      targetBranch: 'main',
      filesChanged: ['src/foo.ts'],
    };
    const next = reduce(state, event);
    assert.equal(next.tasks['task-a'].merged, true);
  });
});

// ---------------------------------------------------------------------------
// Per-kind unit tests — contract events
// ---------------------------------------------------------------------------

describe('reduce — contract.broken', () => {
  it('is informational — state unchanged', () => {
    const state = init();
    const event: DagEvent = {
      kind: 'contract.broken',
      schemaVersion: V,
      ts,
      dagId: 'test-dag',
      taskId: 'task-b',
      inputName: 'reduce',
      expectedFrom: 'task-a',
      outputName: 'reduce',
      outputType: 'function',
      reason: 'export not found',
    };
    assert.deepEqual(reduce(state, event), state);
  });
});

// ---------------------------------------------------------------------------
// Sequence (a): success path — 2-task DAG fully completes
// ---------------------------------------------------------------------------

describe('sequence (a): success path', () => {
  it('all tasks complete, layers timestamped, dag status completed', () => {
    const usage = makeUsage();
    const events: DagEvent[] = [
      {
        kind: 'dag.started',
        schemaVersion: V,
        ts,
        dagPath: '/test/dag.json',
        dagId: 'test-dag',
        branch: 'main',
        resume: false,
      },
      { kind: 'layer.started', schemaVersion: V, ts, dagId: 'test-dag', layer: 0, taskIds: ['task-a'] },
      { kind: 'task.started', schemaVersion: V, ts, dagId: 'test-dag', taskId: 'task-a', taskName: 'Task A', layer: 0 },
      {
        kind: 'task.completed',
        schemaVersion: V,
        ts: ts1,
        dagId: 'test-dag',
        taskId: 'task-a',
        taskName: 'Task A',
        layer: 0,
        durationMs: 1000,
        usage,
        filesModified: ['src/a.ts'],
        finalState: { status: 'completed', completedAt: ts1 },
      },
      {
        kind: 'layer.completed',
        schemaVersion: V,
        ts: ts1,
        dagId: 'test-dag',
        layer: 0,
        taskIds: ['task-a'],
        durationMs: 1000,
      },
      { kind: 'layer.started', schemaVersion: V, ts: ts2, dagId: 'test-dag', layer: 1, taskIds: ['task-b'] },
      {
        kind: 'task.started',
        schemaVersion: V,
        ts: ts2,
        dagId: 'test-dag',
        taskId: 'task-b',
        taskName: 'Task B',
        layer: 1,
      },
      {
        kind: 'task.completed',
        schemaVersion: V,
        ts: ts3,
        dagId: 'test-dag',
        taskId: 'task-b',
        taskName: 'Task B',
        layer: 1,
        durationMs: 1000,
        usage,
        filesModified: ['src/b.ts'],
        finalState: { status: 'completed', completedAt: ts3 },
      },
      {
        kind: 'layer.completed',
        schemaVersion: V,
        ts: ts3,
        dagId: 'test-dag',
        layer: 1,
        taskIds: ['task-b'],
        durationMs: 1000,
      },
      {
        kind: 'dag.completed',
        schemaVersion: V,
        ts: ts4,
        dagPath: '/test/dag.json',
        dagId: 'test-dag',
        totalTasks: 2,
        succeededTasks: 2,
        failedTasks: 0,
        durationMs: 4000,
        finalState: { ...makeExecutionState(), status: 'completed' },
      },
    ];

    const state = replay(events, dag, config);

    assert.deepEqual(state, {
      dagPath: '/test/dag.json',
      status: 'completed',
      startedAt: ts,
      completedAt: ts4,
      currentLayer: 2,
      config,
      layers: {
        '0': { startedAt: ts, completedAt: ts1, taskCount: 1 },
        '1': { startedAt: ts2, completedAt: ts3, taskCount: 1 },
      },
      tasks: {
        'task-a': {
          status: 'completed',
          startedAt: ts,
          completedAt: ts1,
          filesModified: ['src/a.ts'],
          usage,
          worktreePath: undefined,
          worktreeBranch: undefined,
        },
        'task-b': {
          status: 'completed',
          startedAt: ts2,
          completedAt: ts3,
          filesModified: ['src/b.ts'],
          usage,
          worktreePath: undefined,
          worktreeBranch: undefined,
        },
      },
    });
  });
});

// ---------------------------------------------------------------------------
// Sequence (b): single-task retry
// ---------------------------------------------------------------------------

describe('sequence (b): single-task retry', () => {
  it('task.failed → task.retry → task.completed: final status completed, error cleared', () => {
    const usage = makeUsage();
    const events: DagEvent[] = [
      {
        kind: 'dag.started',
        schemaVersion: V,
        ts,
        dagPath: '/test/dag.json',
        dagId: 'test-dag',
        branch: 'main',
        resume: false,
      },
      { kind: 'layer.started', schemaVersion: V, ts, dagId: 'test-dag', layer: 0, taskIds: ['task-a'] },
      { kind: 'task.started', schemaVersion: V, ts, dagId: 'test-dag', taskId: 'task-a', taskName: 'Task A', layer: 0 },
      {
        kind: 'task.failed',
        schemaVersion: V,
        ts: ts1,
        dagId: 'test-dag',
        taskId: 'task-a',
        taskName: 'Task A',
        layer: 0,
        error: 'agent crashed',
        durationMs: 1000,
        finalState: { status: 'failed', completedAt: ts1, error: 'agent crashed' },
      },
      {
        kind: 'task.retry',
        schemaVersion: V,
        ts: ts2,
        dagId: 'test-dag',
        taskId: 'task-a',
        taskName: 'Task A',
        layer: 0,
        attempt: 1,
        reason: 'transient error',
        previousError: 'agent crashed',
      },
      {
        kind: 'task.completed',
        schemaVersion: V,
        ts: ts3,
        dagId: 'test-dag',
        taskId: 'task-a',
        taskName: 'Task A',
        layer: 0,
        durationMs: 1000,
        usage,
        filesModified: [],
        finalState: { status: 'completed', completedAt: ts3 },
      },
    ];

    const state = replay(events, dag, config);

    assert.equal(state.tasks['task-a'].status, 'completed');
    assert.equal(state.tasks['task-a'].completedAt, ts3);
    assert.equal(state.tasks['task-a'].error, undefined);
  });

  it('task.failed → terminal (no retry): task stays failed, dag fails', () => {
    const events: DagEvent[] = [
      {
        kind: 'dag.started',
        schemaVersion: V,
        ts,
        dagPath: '/test/dag.json',
        dagId: 'test-dag',
        branch: 'main',
        resume: false,
      },
      { kind: 'layer.started', schemaVersion: V, ts, dagId: 'test-dag', layer: 0, taskIds: ['task-a'] },
      { kind: 'task.started', schemaVersion: V, ts, dagId: 'test-dag', taskId: 'task-a', taskName: 'Task A', layer: 0 },
      {
        kind: 'task.failed',
        schemaVersion: V,
        ts: ts1,
        dagId: 'test-dag',
        taskId: 'task-a',
        taskName: 'Task A',
        layer: 0,
        error: 'fatal error',
        durationMs: 1000,
        finalState: { status: 'failed', completedAt: ts1, error: 'fatal error' },
      },
      {
        kind: 'layer.failed',
        schemaVersion: V,
        ts: ts1,
        dagId: 'test-dag',
        layer: 0,
        taskIds: ['task-a'],
        failedTaskIds: ['task-a'],
        reason: 'all tasks failed',
      },
      {
        kind: 'dag.completed',
        schemaVersion: V,
        ts: ts2,
        dagPath: '/test/dag.json',
        dagId: 'test-dag',
        totalTasks: 2,
        succeededTasks: 0,
        failedTasks: 1,
        durationMs: 2000,
        finalState: { ...makeExecutionState(), status: 'failed' },
      },
    ];

    const state = replay(events, dag, config);

    assert.equal(state.tasks['task-a'].status, 'failed');
    assert.equal(state.tasks['task-a'].error, 'fatal error');
    assert.equal(state.status, 'failed');
  });
});

// ---------------------------------------------------------------------------
// Sequence (c): layer pause-and-resume
// ---------------------------------------------------------------------------

describe('sequence (c): layer pause-and-resume', () => {
  it('pauses after layer 0, resumes and completes layer 1', () => {
    const usage = makeUsage();

    const phase1: DagEvent[] = [
      {
        kind: 'dag.started',
        schemaVersion: V,
        ts,
        dagPath: '/test/dag.json',
        dagId: 'test-dag',
        branch: 'main',
        resume: false,
      },
      { kind: 'layer.started', schemaVersion: V, ts, dagId: 'test-dag', layer: 0, taskIds: ['task-a'] },
      { kind: 'task.started', schemaVersion: V, ts, dagId: 'test-dag', taskId: 'task-a', taskName: 'Task A', layer: 0 },
      {
        kind: 'task.completed',
        schemaVersion: V,
        ts: ts1,
        dagId: 'test-dag',
        taskId: 'task-a',
        taskName: 'Task A',
        layer: 0,
        durationMs: 1000,
        usage,
        filesModified: [],
        finalState: { status: 'completed', completedAt: ts1 },
      },
      {
        kind: 'layer.completed',
        schemaVersion: V,
        ts: ts1,
        dagId: 'test-dag',
        layer: 0,
        taskIds: ['task-a'],
        durationMs: 1000,
      },
      {
        kind: 'dag.paused',
        schemaVersion: V,
        ts: ts2,
        dagPath: '/test/dag.json',
        dagId: 'test-dag',
        reason: 'user-pause',
        currentLayer: 1,
      },
    ];

    const paused = replay(phase1, dag, config);
    assert.equal(paused.status, 'paused');
    assert.equal(paused.currentLayer, 1);
    assert.equal(paused.tasks['task-a'].status, 'completed');
    assert.equal(paused.tasks['task-b'].status, 'pending');

    const phase2: DagEvent[] = [
      {
        kind: 'dag.started',
        schemaVersion: V,
        ts: ts3,
        dagPath: '/test/dag.json',
        dagId: 'test-dag',
        branch: 'main',
        resume: true,
      },
      { kind: 'layer.started', schemaVersion: V, ts: ts3, dagId: 'test-dag', layer: 1, taskIds: ['task-b'] },
      {
        kind: 'task.started',
        schemaVersion: V,
        ts: ts3,
        dagId: 'test-dag',
        taskId: 'task-b',
        taskName: 'Task B',
        layer: 1,
      },
      {
        kind: 'task.completed',
        schemaVersion: V,
        ts: ts4,
        dagId: 'test-dag',
        taskId: 'task-b',
        taskName: 'Task B',
        layer: 1,
        durationMs: 1000,
        usage,
        filesModified: [],
        finalState: { status: 'completed', completedAt: ts4 },
      },
      {
        kind: 'layer.completed',
        schemaVersion: V,
        ts: ts4,
        dagId: 'test-dag',
        layer: 1,
        taskIds: ['task-b'],
        durationMs: 1000,
      },
      {
        kind: 'dag.completed',
        schemaVersion: V,
        ts: ts5,
        dagPath: '/test/dag.json',
        dagId: 'test-dag',
        totalTasks: 2,
        succeededTasks: 2,
        failedTasks: 0,
        durationMs: 5000,
        finalState: { ...makeExecutionState(), status: 'completed' },
      },
    ];

    const final = replay([...phase1, ...phase2], dag, config);
    assert.equal(final.status, 'completed');
    assert.equal(final.completedAt, ts5);
    assert.equal(final.tasks['task-a'].status, 'completed');
    assert.equal(final.tasks['task-b'].status, 'completed');
  });
});

// ---------------------------------------------------------------------------
// Sequence (d): abort
// ---------------------------------------------------------------------------

describe('sequence (d): abort', () => {
  it('dag.aborted while task in-progress: dag status failed, task stays in-progress', () => {
    const events: DagEvent[] = [
      {
        kind: 'dag.started',
        schemaVersion: V,
        ts,
        dagPath: '/test/dag.json',
        dagId: 'test-dag',
        branch: 'main',
        resume: false,
      },
      { kind: 'layer.started', schemaVersion: V, ts, dagId: 'test-dag', layer: 0, taskIds: ['task-a'] },
      { kind: 'task.started', schemaVersion: V, ts, dagId: 'test-dag', taskId: 'task-a', taskName: 'Task A', layer: 0 },
      {
        kind: 'dag.aborted',
        schemaVersion: V,
        ts: ts1,
        dagPath: '/test/dag.json',
        dagId: 'test-dag',
        reason: 'SIGINT received',
        signal: 'SIGINT',
      },
    ];

    const state = replay(events, dag, config);

    assert.equal(state.status, 'failed');
    assert.equal(state.completedAt, ts1);
    // abort does not retroactively fail running tasks
    assert.equal(state.tasks['task-a'].status, 'in-progress');
  });
});

// ---------------------------------------------------------------------------
// Sequence (e): contract break
// ---------------------------------------------------------------------------

describe('sequence (e): contract break', () => {
  it('contract.broken is informational — does not mutate state after task.completed', () => {
    const usage = makeUsage();
    const baseEvents: DagEvent[] = [
      {
        kind: 'dag.started',
        schemaVersion: V,
        ts,
        dagPath: '/test/dag.json',
        dagId: 'test-dag',
        branch: 'main',
        resume: false,
      },
      { kind: 'layer.started', schemaVersion: V, ts, dagId: 'test-dag', layer: 0, taskIds: ['task-a'] },
      { kind: 'task.started', schemaVersion: V, ts, dagId: 'test-dag', taskId: 'task-a', taskName: 'Task A', layer: 0 },
      {
        kind: 'task.completed',
        schemaVersion: V,
        ts: ts1,
        dagId: 'test-dag',
        taskId: 'task-a',
        taskName: 'Task A',
        layer: 0,
        durationMs: 1000,
        usage,
        filesModified: [],
        finalState: { status: 'completed', completedAt: ts1 },
      },
      {
        kind: 'layer.completed',
        schemaVersion: V,
        ts: ts1,
        dagId: 'test-dag',
        layer: 0,
        taskIds: ['task-a'],
        durationMs: 1000,
      },
    ];

    const contractBroken: DagEvent = {
      kind: 'contract.broken',
      schemaVersion: V,
      ts: ts2,
      dagId: 'test-dag',
      taskId: 'task-b',
      inputName: 'reduce',
      expectedFrom: 'task-a',
      outputName: 'reduce',
      outputType: 'function',
      reason: 'export not found in built output',
    };

    const beforeBreak = replay(baseEvents, dag, config);
    const afterBreak = replay([...baseEvents, contractBroken], dag, config);

    assert.deepEqual(afterBreak, beforeBreak);
    assert.equal(afterBreak.tasks['task-a'].status, 'completed');
  });
});

// ---------------------------------------------------------------------------
// Verification events (Phase 2)
// ---------------------------------------------------------------------------

describe('reduce — task.verification-failed', () => {
  it('marks the task failed with error + usage (so the executor excludes its worktree from merge)', () => {
    const usage = makeUsage();
    const event: DagEvent = {
      kind: 'task.verification-failed',
      schemaVersion: V,
      ts: ts2,
      dagId: 'test-dag',
      taskId: 'task-a',
      taskName: 'Task A',
      layer: 0,
      verificationKind: 'typecheck',
      error: 'typecheck failed',
      durationMs: 5000,
      usage,
      finalState: { status: 'failed' },
    };
    const next = reduce(init(), event);
    assert.equal(next.tasks['task-a'].status, 'failed');
    assert.equal(next.tasks['task-a'].error, 'typecheck failed');
    assert.deepEqual(next.tasks['task-a'].usage, usage);
  });
});

describe('reduce — layer.verification-failed', () => {
  it('is informational — does not advance currentLayer or mark the layer complete', () => {
    const state = { ...init(), currentLayer: 0 };
    const event: DagEvent = {
      kind: 'layer.verification-failed',
      schemaVersion: V,
      ts: ts3,
      dagId: 'test-dag',
      layer: 0,
      taskIds: ['task-a'],
      verificationKind: 'test',
      reason: 'merged-whole tests failed',
      durationMs: 6000,
    };
    const next = reduce(state, event);
    assert.equal(next.currentLayer, 0);
    assert.equal(next.layers['0']?.completedAt ?? null, null);
  });
});

describe('replay round-trip — verification events fold without tripping the exhaustiveness guard', () => {
  it('a log containing both new events reconstructs cleanly', () => {
    const events: DagEvent[] = [
      {
        kind: 'dag.started',
        schemaVersion: V,
        ts,
        dagPath: '/test/dag.json',
        dagId: 'test-dag',
        branch: 'main',
        resume: false,
      },
      { kind: 'layer.started', schemaVersion: V, ts, dagId: 'test-dag', layer: 0, taskIds: ['task-a'] },
      { kind: 'task.started', schemaVersion: V, ts, dagId: 'test-dag', taskId: 'task-a', taskName: 'Task A', layer: 0 },
      {
        kind: 'task.verification-failed',
        schemaVersion: V,
        ts: ts1,
        dagId: 'test-dag',
        taskId: 'task-a',
        taskName: 'Task A',
        layer: 0,
        verificationKind: 'test',
        error: 'test failed',
        durationMs: 5000,
        finalState: { status: 'failed' },
      },
      {
        kind: 'layer.verification-failed',
        schemaVersion: V,
        ts: ts2,
        dagId: 'test-dag',
        layer: 0,
        taskIds: ['task-a'],
        verificationKind: 'test',
        reason: 'merged-whole failed',
        durationMs: 6000,
      },
      {
        kind: 'dag.paused',
        schemaVersion: V,
        ts: ts3,
        dagPath: '/test/dag.json',
        dagId: 'test-dag',
        reason: 'Tier-2 verification failed',
        currentLayer: 0,
      },
    ];
    // The whole point: replay must NOT throw "Unhandled DagEvent kind".
    const state = replay(events, dag, config);
    assert.equal(state.status, 'paused');
    assert.equal(state.tasks['task-a'].status, 'failed');
    assert.equal(state.currentLayer, 0);
  });
});
