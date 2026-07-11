import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDagDetail, loadTaskDetail } from './projection.js';
import type { DagEvent } from '../events/types.js';

let projectDir: string;
let dagPath: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'dag-ui-projection-'));
  dagPath = join(projectDir, 'work.json');
  writeFileSync(dagPath, JSON.stringify(dagJson()));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

const dagJson = () => ({
  meta: {
    id: 'work',
    source: {
      type: 'description',
      title: 'Work DAG',
      description: '',
      figmaUrls: [],
      acceptanceCriteria: [],
    },
    createdAt: '2026-07-10T00:00:00.000Z',
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
      context: { files: ['src/a.ts'] },
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
      context: { files: ['src/b.ts'] },
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

const event = (event: DagEvent): string => JSON.stringify(event) + '\n';

describe('loadDagDetail', () => {
  it('uses a valid derived state snapshot for progress and groups', () => {
    writeFileSync(
      join(projectDir, 'work.state.json'),
      JSON.stringify({
        derived: true,
        dagPath,
        status: 'running',
        startedAt: '2026-07-10T00:00:00.000Z',
        currentLayer: 1,
        config: {
          provider: 'codex',
          defaultModel: 'default',
          heavyModel: 'heavy',
          maxTurns: 1,
          permissionMode: 'bypassPermissions',
          dagPath,
          dryRun: false,
        },
        layers: {},
        tasks: {
          'task-a': { status: 'completed', filesModified: ['src/a.ts'], merged: true },
          'task-b': { status: 'in-progress', worktreePath: '/tmp/wt', worktreeBranch: 'dag/task-b' },
        },
      }),
    );

    const detail = loadDagDetail(projectDir, dagPath);

    assert.equal(detail.status, 'running');
    assert.equal(detail.progress.completedTasks, 1);
    assert.equal(detail.progress.runningTasks, 1);
    assert.deepEqual(
      detail.backlog.done.map((task) => task.id),
      ['task-a'],
    );
    assert.deepEqual(
      detail.backlog.running.map((task) => task.id),
      ['task-b'],
    );
  });

  it('falls back to replaying events when state is missing', () => {
    writeFileSync(
      join(projectDir, 'work.events.jsonl'),
      [
        event({
          kind: 'dag.started',
          schemaVersion: 1,
          ts: '2026-07-10T00:00:00.000Z',
          dagPath,
          dagId: 'work',
          branch: 'main',
          resume: false,
        }),
        event({
          kind: 'task.completed',
          schemaVersion: 1,
          ts: '2026-07-10T00:01:00.000Z',
          dagId: 'work',
          taskId: 'task-a',
          taskName: 'Task A',
          layer: 0,
          durationMs: 60_000,
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            costUSD: 0.01,
            numTurns: 1,
            durationMs: 60_000,
            durationApiMs: 50_000,
          },
          filesModified: ['src/a.ts'],
          finalState: { status: 'completed' },
        }),
      ].join(''),
    );

    const detail = loadDagDetail(projectDir, dagPath);

    assert.equal(detail.progress.completedTasks, 1);
    assert.equal(detail.recentEvents.length, 2);
  });

  it('reports malformed event logs as DAG errors', () => {
    writeFileSync(join(projectDir, 'work.events.jsonl'), '{"kind":"dag.started"\n');

    const detail = loadDagDetail(projectDir, dagPath);

    assert.equal(
      detail.errors.some((error) => error.scope === 'events'),
      true,
    );
  });
});

describe('loadTaskDetail', () => {
  it('returns selected task definition, state, and related events', () => {
    writeFileSync(
      join(projectDir, 'work.events.jsonl'),
      event({
        kind: 'task.started',
        schemaVersion: 1,
        ts: '2026-07-10T00:00:00.000Z',
        dagId: 'work',
        taskId: 'task-b',
        taskName: 'Task B',
        layer: 1,
        worktreePath: '/tmp/wt',
        worktreeBranch: 'dag/task-b',
      }),
    );

    const detail = loadTaskDetail(projectDir, dagPath, 'task-b');

    assert.equal(detail.task.id, 'task-b');
    assert.equal(detail.description, 'Second task');
    assert.deepEqual(detail.files, ['src/b.ts']);
    assert.equal(detail.events.length, 1);
  });
});
