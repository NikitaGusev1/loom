import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveOutputFiles } from './contracts.js';
import type { DAGTask } from './types.js';

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
