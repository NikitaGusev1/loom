import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConsumerInputVerifier, resolveOutputFiles, verifyLayerContracts } from './contracts.js';
import type { DAGTask, DecompositionDAG } from './types.js';

const makeTask = (outputs: DAGTask['contracts']['outputs']): DAGTask =>
  ({
    id: 'test-task',
    name: 'Test task',
    description: '',
    weight: 'standard',
    dependencies: [],
    contracts: { inputs: {}, outputs },
    context: { files: [] },
    completionCriteria: { automated: [], manual: [] },
    estimatedScope: 'single-component',
  }) as unknown as DAGTask;

describe('resolveOutputFiles', () => {
  it('mixed kinds yield file∪export paths', () => {
    const task = makeTask({
      myFile: { kind: 'file', path: 'src/foo.ts', description: 'a file' },
      myExport: {
        kind: 'export',
        file: 'src/bar.ts',
        exportName: 'Bar',
        exportKind: 'const',
        description: 'an export',
      },
      myBehavior: { kind: 'behavioral', description: 'no artifact' },
    });
    const result = resolveOutputFiles(task);
    assert.deepEqual(result.sort(), ['src/bar.ts', 'src/foo.ts']);
  });

  it('same path as both file and export appears once (deduped)', () => {
    const task = makeTask({
      asFile: { kind: 'file', path: 'src/shared.ts', description: 'file output' },
      asExport: {
        kind: 'export',
        file: 'src/shared.ts',
        exportName: 'Shared',
        exportKind: 'interface',
        description: 'export output',
      },
    });
    const result = resolveOutputFiles(task);
    assert.deepEqual(result, ['src/shared.ts']);
  });

  it('behavioral-only outputs yield empty array', () => {
    const task = makeTask({
      b1: { kind: 'behavioral', description: 'behavior one' },
      b2: { kind: 'behavioral', description: 'behavior two' },
    });
    const result = resolveOutputFiles(task);
    assert.deepEqual(result, []);
  });
});

const dagTask = (
  id: string,
  dependencies: string[],
  inputs: DAGTask['contracts']['inputs'],
  outputs: DAGTask['contracts']['outputs'],
): DAGTask =>
  ({
    id,
    name: id,
    description: '',
    weight: 'standard',
    dependencies,
    contracts: { inputs, outputs },
    context: { files: [] },
    completionCriteria: { automated: [], manual: [] },
    estimatedScope: 'single-component',
  }) as DAGTask;

const dag = (tasks: DAGTask[]): DecompositionDAG =>
  ({
    meta: {
      id: 'd',
      source: { type: 'description', title: 'T', description: '', figmaUrls: [], acceptanceCriteria: [] },
      createdAt: '2026-01-01T00:00:00.000Z',
      gitCommit: 'abc',
      branch: 'main',
      qualityReport: { iterations: 1, checksRun: [], allPassed: true },
    },
    tasks,
    executionLayers: [],
  }) as DecompositionDAG;

describe('createConsumerInputVerifier', () => {
  it('routes each input through its declared source producer', () => {
    const dir = mkdtempSync(join(tmpdir(), 'contracts-'));
    try {
      const unrelatedPath = join(dir, 'unrelated.ts');
      writeFileSync(unrelatedPath, 'content');
      const sourceMissingPath = join(dir, 'source-missing.ts');
      const source = dagTask(
        'source',
        [],
        {},
        { shared: { kind: 'file', path: sourceMissingPath, description: 'missing source output' } },
      );
      const unrelated = dagTask(
        'unrelated',
        [],
        {},
        { shared: { kind: 'file', path: unrelatedPath, description: 'same output name, wrong source' } },
      );
      const consumer = dagTask('consumer', ['source'], { shared: { source: 'source', type: 'file' } }, {});

      const verify = createConsumerInputVerifier(new Map([source, unrelated, consumer].map((task) => [task.id, task])));
      const result = verify('consumer');

      assert.equal(result.passed, false);
      assert.equal(result.brokenContracts.length, 1);
      assert.equal(result.brokenContracts[0].expectedFrom, 'source');
      assert.match(result.brokenContracts[0].reason, /does not exist/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes behavioral outputs because they have no static artifact', () => {
    const source = dagTask('source', [], {}, { behavior: { kind: 'behavioral', description: 'done' } });
    const consumer = dagTask('consumer', ['source'], { behavior: { source: 'source' } }, {});
    const verify = createConsumerInputVerifier(new Map([source, consumer].map((task) => [task.id, task])));

    assert.deepEqual(verify('consumer'), { passed: true, brokenContracts: [] });
  });
});

describe('verifyLayerContracts', () => {
  it('requires the declared source task to be completed', async () => {
    const source = dagTask('source', [], {}, { out: { kind: 'behavioral', description: 'done' } });
    const consumer = dagTask('consumer', ['source'], { out: { source: 'source' } }, {});

    const result = await verifyLayerContracts([], ['consumer'], dag([source, consumer]));

    assert.equal(result.passed, false);
    assert.equal(result.brokenContracts[0].reason, 'Source task "source" is not completed');
  });

  it('does not satisfy an input from an unrelated same-named output', async () => {
    const source = dagTask('source', [], {}, {});
    const unrelated = dagTask('unrelated', [], {}, { out: { kind: 'behavioral', description: 'wrong source' } });
    const consumer = dagTask('consumer', ['source'], { out: { source: 'source' } }, {});

    const result = await verifyLayerContracts(['source', 'unrelated'], ['consumer'], dag([source, unrelated, consumer]));

    assert.equal(result.passed, false);
    assert.match(result.brokenContracts[0].reason, /does not produce output "out"/);
    assert.equal(result.brokenContracts[0].expectedFrom, 'source');
  });
});
