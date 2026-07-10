import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateDAG } from './validation.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const makeTask = (id: string, dependencies: string[] = []) => ({
  id,
  name: `Task ${id}`,
  description: `Description for ${id}`,
  dependencies,
  contracts: {
    inputs: {},
    outputs: {
      out: { kind: 'file', path: `out/${id}.ts`, description: `Output of ${id}` },
    },
  },
  context: { files: [`src/${id}.ts`] },
  completionCriteria: { automated: [], manual: [] },
  estimatedScope: 'single-component',
  weight: 'standard',
});

const makeDag = (tasks: Array<ReturnType<typeof makeTask>>, layers: Array<{ layer: number; taskIds: string[] }>) => ({
  meta: {
    id: 'dag-test',
    source: {
      type: 'description',
      title: 'Test DAG',
      description: '',
      figmaUrls: [],
      acceptanceCriteria: [],
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    gitCommit: 'abc1234',
    branch: 'test-branch',
    qualityReport: { iterations: 1, checksRun: [], allPassed: true },
  },
  tasks,
  executionLayers: layers.map((l) => ({ ...l, description: `Layer ${l.layer}` })),
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('validateDAG happy path', () => {
  it('accepts a DAG where every dependency is in a strictly earlier layer', () => {
    const dag = makeDag(
      [makeTask('a'), makeTask('b'), makeTask('c', ['a', 'b']), makeTask('d', ['c'])],
      [
        { layer: 0, taskIds: ['a', 'b'] },
        { layer: 1, taskIds: ['c'] },
        { layer: 2, taskIds: ['d'] },
      ],
    );
    const parsed = validateDAG(dag);
    assert.equal(parsed.tasks.length, 4);
  });

  it('accepts optional projectContext and reviewVerdict metadata', () => {
    const dag = makeDag([makeTask('a')], [{ layer: 0, taskIds: ['a'] }]);
    const meta = dag.meta as typeof dag.meta & {
      projectContext?: unknown;
      reviewVerdict?: unknown;
    };
    meta.projectContext = {
      sharedComponents: 'src/components/common: Button',
      conventions: ['Use theme tokens'],
      figmaToolset: ['figma-console'],
      themeTokensDoc: '.claude/references/theme.md',
    };
    meta.reviewVerdict = {
      status: 'READY',
      reviewedAt: '2026-01-01T00:00:00.000Z',
      gitCommit: 'abc1234',
      findings: [{ id: 'F1', dimension: 'contracts', severity: 'LOW', summary: 'ok' }],
    };

    const parsed = validateDAG(dag);
    assert.equal(parsed.meta.projectContext?.themeTokensDoc, '.claude/references/theme.md');
    assert.equal(parsed.meta.reviewVerdict?.status, 'READY');
  });
});

// ---------------------------------------------------------------------------
// Input sources
// ---------------------------------------------------------------------------

describe('input sources', () => {
  it('accepts an input sourced from a declared dependency', () => {
    const a = makeTask('a');
    const b = makeTask('b', ['a']);
    b.contracts.inputs = { out: { source: 'a', type: 'file' } };
    const dag = makeDag(
      [a, b],
      [
        { layer: 0, taskIds: ['a'] },
        { layer: 1, taskIds: ['b'] },
      ],
    );

    assert.equal(validateDAG(dag).tasks.length, 2);
  });

  it('rejects an input source that is not a known task', () => {
    const b = makeTask('b');
    b.contracts.inputs = { out: { source: 'ghost', type: 'file' } };
    const dag = makeDag([b], [{ layer: 0, taskIds: ['b'] }]);

    assert.throws(() => validateDAG(dag), /input "out" has source "ghost" which is not a known task/);
  });

  it('rejects an input source that is not declared as a dependency', () => {
    const a = makeTask('a');
    const b = makeTask('b');
    b.contracts.inputs = { out: { source: 'a', type: 'file' } };
    const dag = makeDag(
      [a, b],
      [
        { layer: 0, taskIds: ['a'] },
        { layer: 1, taskIds: ['b'] },
      ],
    );

    assert.throws(() => validateDAG(dag), /must be one of the task's dependencies/);
  });
});

// ---------------------------------------------------------------------------
// Layer assignment
// ---------------------------------------------------------------------------

describe('layer assignment', () => {
  it('rejects a task missing from all execution layers', () => {
    const dag = makeDag([makeTask('a'), makeTask('b')], [{ layer: 0, taskIds: ['a'] }]);
    assert.throws(() => validateDAG(dag), /Task "b" is not assigned to any execution layer/);
  });

  it('rejects a task assigned to multiple layers', () => {
    const dag = makeDag(
      [makeTask('a'), makeTask('b')],
      [
        { layer: 0, taskIds: ['a', 'b'] },
        { layer: 1, taskIds: ['b'] },
      ],
    );
    assert.throws(() => validateDAG(dag), /Task "b" appears in multiple execution layers \(0 and 1\)/);
  });
});

// ---------------------------------------------------------------------------
// Layer ordering — the intra-layer dependency class that broke Layer 4 live
// ---------------------------------------------------------------------------

describe('layer ordering', () => {
  it('rejects an intra-layer dependency', () => {
    const dag = makeDag(
      [makeTask('a'), makeTask('smoke'), makeTask('legacy-verify', ['smoke'])],
      [
        { layer: 0, taskIds: ['a'] },
        { layer: 1, taskIds: ['smoke', 'legacy-verify'] },
      ],
    );
    assert.throws(
      () => validateDAG(dag),
      /Task "legacy-verify" \(layer 1\) depends on "smoke" \(layer 1\) — dependencies must be in a strictly earlier layer/,
    );
  });

  it('rejects a dependency on a later layer', () => {
    const dag = makeDag(
      [makeTask('a', ['b']), makeTask('b')],
      [
        { layer: 0, taskIds: ['a'] },
        { layer: 1, taskIds: ['b'] },
      ],
    );
    assert.throws(() => validateDAG(dag), /Task "a" \(layer 0\) depends on "b" \(layer 1\)/);
  });
});

// ---------------------------------------------------------------------------
// Pre-existing checks still hold
// ---------------------------------------------------------------------------

describe('reference and cycle checks', () => {
  it('rejects an unknown task in a layer', () => {
    const dag = makeDag([makeTask('a')], [{ layer: 0, taskIds: ['a', 'ghost'] }]);
    assert.throws(() => validateDAG(dag), /references unknown task "ghost"/);
  });

  it('rejects an unknown dependency', () => {
    const dag = makeDag([makeTask('a', ['ghost'])], [{ layer: 0, taskIds: ['a'] }]);
    assert.throws(() => validateDAG(dag), /depends on unknown task "ghost"/);
  });

  it('rejects a cycle', () => {
    const dag = makeDag(
      [makeTask('a', ['b']), makeTask('b', ['a'])],
      [
        { layer: 0, taskIds: ['a'] },
        { layer: 1, taskIds: ['b'] },
      ],
    );
    assert.throws(() => validateDAG(dag), /Cycle detected in DAG/);
  });
});
