import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeDAG } from './executor.js';
import { getEventLogPath, readEvents } from './events/log.js';
import type { DagEvent } from './events/types.js';
import type { ExecutorDeps } from './executor/deps.js';
import type { ProjectMemory } from './memory.js';
import type { DAGTask, DecompositionDAG, ExecutorConfig } from './types.js';

process.setMaxListeners(50);

let dir: string;
let dagPath: string;

const makeTask = (id: string, dependencies: string[], over: Partial<DAGTask> = {}): DAGTask => ({
  id,
  name: id,
  description: '',
  dependencies,
  contracts: { inputs: {}, outputs: {} },
  context: { files: [] },
  completionCriteria: { automated: [], manual: [] },
  estimatedScope: 'single-component',
  weight: 'standard',
  ...over,
});

const makeDag = (tasks: DAGTask[], layers: Array<{ layer: number; taskIds: string[] }>): DecompositionDAG =>
  ({
    meta: {
      id: 'ready-test',
      source: {
        type: 'description',
        title: 'Ready test',
        description: '',
        figmaUrls: [],
        acceptanceCriteria: [],
      },
      createdAt: new Date().toISOString(),
      gitCommit: 'test',
      branch: 'test',
      qualityReport: { iterations: 1, checksRun: [], allPassed: true },
    },
    tasks,
    executionLayers: layers.map((layer) => ({ ...layer, description: '' })),
  }) as DecompositionDAG;

const makeConfig = (over: Partial<ExecutorConfig> = {}): ExecutorConfig => ({
  provider: 'codex',
  defaultModel: 'account-default',
  heavyModel: 'account-default',
  maxTurns: 80,
  permissionMode: 'bypassPermissions',
  dagPath,
  dryRun: false,
  disableVerification: true,
  disableMemory: true,
  ...over,
});

const baseDeps = (over: Partial<ExecutorDeps> = {}): ExecutorDeps => ({
  runTask: async () => ({ failed: false, usage: undefined, trace: undefined }),
  settleNoOp: async () => ({ ok: true }),
  createWorktree: async (taskId: string) => ({ path: join(dir, `wt-${taskId}`), branch: `task/${taskId}` }),
  mergeWorktrees: async (ids: string[], onMerged: (id: string) => void) => {
    ids.forEach(onMerged);
    return { success: true };
  },
  getFilesModified: async () => ['changed.ts'],
  verifyBaseUnchanged: async () => true,
  ...over,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dag-ready-'));
  dagPath = join(dir, 'dag.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('executeDAG ready-work loop', () => {
  it('starts consumers as soon as their dependencies land', async () => {
    const dag = makeDag(
      [makeTask('A', []), makeTask('B', ['A']), makeTask('C', ['B']), makeTask('D', [])],
      [
        { layer: 0, taskIds: ['A', 'D'] },
        { layer: 1, taskIds: ['B'] },
        { layer: 2, taskIds: ['C'] },
      ],
    );

    const started: string[] = [];
    const merged: string[] = [];
    let releaseD!: () => void;
    const dGate = new Promise<void>((resolve) => (releaseD = resolve));

    const deps = baseDeps({
      runTask: async ({ task }) => {
        started.push(task.id);
        if (task.id === 'D') await dGate;
        return { failed: false, usage: undefined, trace: undefined };
      },
      mergeWorktrees: async (ids, onMerged) => {
        ids.forEach((id) => {
          merged.push(id);
          onMerged(id);
        });
        return { success: true };
      },
    });

    const run = executeDAG({ dag, config: makeConfig(), deps });
    await waitFor(() => started.includes('C'));
    assert.ok(started.includes('B'));
    assert.ok(started.includes('C'));

    releaseD();
    const result = await run;

    assert.equal(result.status, 'completed');
    assert.equal(merged.length, 4);
    assert.equal(merged[0], 'A');
  });

  it('records base SHAs on dag.started and worktree.merged events', async () => {
    const dag = makeDag(
      [makeTask('A', []), makeTask('B', ['A'])],
      [
        { layer: 0, taskIds: ['A'] },
        { layer: 1, taskIds: ['B'] },
      ],
    );

    const result = await executeDAG({ dag, config: makeConfig(), deps: baseDeps() });
    assert.equal(result.status, 'completed');

    const events = readEvents(getEventLogPath(dagPath));
    const started = events.find((event) => event.kind === 'dag.started') as
      | Extract<DagEvent, { kind: 'dag.started' }>
      | undefined;
    assert.ok(started?.baseStartSha);

    const merged = events.filter(
      (event): event is Extract<DagEvent, { kind: 'worktree.merged' }> => event.kind === 'worktree.merged',
    );
    assert.equal(merged.length, 2);
    assert.ok(merged.every((event) => event.baseShaBefore && event.baseShaAfter));
  });

  it('pauses with typed quota metadata when retry policy classifies a usage limit', async () => {
    const dag = makeDag([makeTask('A', [])], [{ layer: 0, taskIds: ['A'] }]);
    const deps = baseDeps({
      runTask: async ({ task, emit, layerNum }) => {
        emit({
          kind: 'task.failed',
          schemaVersion: 1,
          ts: new Date().toISOString(),
          dagId: 'ready-test',
          taskId: task.id,
          taskName: task.name,
          layer: layerNum,
          error: 'daily quota exceeded, try again tomorrow',
          durationMs: 1,
          finalState: { status: 'failed', error: 'daily quota exceeded, try again tomorrow' },
        } as DagEvent);
        return { failed: true, usage: undefined, trace: undefined };
      },
    });

    const result = await executeDAG({ dag, config: makeConfig(), deps });

    assert.equal(result.status, 'paused');
    assert.equal(result.quota?.category, 'daily');
    const paused = readEvents(getEventLogPath(dagPath)).find((event) => event.kind === 'dag.paused') as
      | Extract<DagEvent, { kind: 'dag.paused' }>
      | undefined;
    assert.equal(paused?.cause, 'quota');
    assert.equal(paused?.quota?.category, 'daily');
  });

  it('preserves local codex config and project memory in task execution', async () => {
    const memoryPath = join(dir, 'memory.md');
    writeFileSync(memoryPath, 'remember this project constraint\n');
    const dag = makeDag([makeTask('A', [])], [{ layer: 0, taskIds: ['A'] }]);
    let provider: ExecutorConfig['provider'] | undefined;
    let memory: ProjectMemory | null | undefined;

    const deps = baseDeps({
      runTask: async ({ config, projectMemory }) => {
        provider = config.provider;
        memory = projectMemory;
        return { failed: false, usage: undefined, trace: undefined };
      },
    });

    const result = await executeDAG({
      dag,
      config: makeConfig({ projectMemoryPath: memoryPath, disableMemory: false }),
      deps,
    });

    assert.equal(result.status, 'completed');
    assert.equal(provider, 'codex');
    assert.equal(memory?.content.trim(), 'remember this project constraint');
  });
});

const waitFor = async (condition: () => boolean, timeoutMs = 3000): Promise<void> => {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};
