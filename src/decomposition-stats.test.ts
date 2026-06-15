import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeDecompositionStats, decompositionStatsFromFile } from './decomposition-stats.js';
import type { DecompositionDAG } from './types.js';

type Weight = 'trivial' | 'standard' | 'heavy';

// Minimal object shaped only for what computeDecompositionStats reads
// (tasks[].weight, tasks.length, executionLayers[].taskIds.length).
const fakeDag = (weights: Weight[], layerWidths: number[]): DecompositionDAG =>
  ({
    tasks: weights.map((weight, i) => ({ id: `t${i}`, weight })),
    executionLayers: layerWidths.map((n, layer) => ({
      layer,
      taskIds: Array.from({ length: n }, (_, j) => `t${layer}-${j}`),
    })),
  }) as unknown as DecompositionDAG;

describe('computeDecompositionStats', () => {
  it('derives the export-scope decomposition shape (5 tasks, layers 2/1/1/1, one heavy)', () => {
    // Mirrors .claude/ai/decomposition-2026-06-08-autocommit-export-gate.json —
    // the run where the mechanical phase misread has_heavy and parked the DAG.
    const dag = fakeDag(['standard', 'standard', 'heavy', 'standard', 'trivial'], [2, 1, 1, 1]);
    assert.deepEqual(computeDecompositionStats(dag), { task_count: 5, max_width: 2, has_heavy: true });
  });

  it('reports has_heavy=false when no task is heavy', () => {
    const dag = fakeDag(['standard', 'standard', 'trivial'], [3]);
    assert.deepEqual(computeDecompositionStats(dag), { task_count: 3, max_width: 3, has_heavy: false });
  });

  it('max_width is 0 when there are no layers', () => {
    const dag = fakeDag(['standard'], []);
    assert.equal(computeDecompositionStats(dag).max_width, 0);
  });
});

// A fully schema-valid DAG so decompositionStatsFromFile exercises the real
// read + JSON.parse + validateDAG + derive path. All tasks sit in layer 0 with
// no dependencies, so it passes the layering/cycle checks.
const validDag = (weights: Weight[]): unknown => ({
  meta: {
    id: 'test-dag',
    source: { type: 'description', title: 't', description: '', figmaUrls: [], acceptanceCriteria: [] },
    createdAt: '2026-06-08T00:00:00Z',
    gitCommit: 'abc',
    branch: 'main',
    qualityReport: { iterations: 0, checksRun: [], allPassed: true },
  },
  tasks: weights.map((weight, i) => ({
    id: `t${i}`,
    name: `task ${i}`,
    description: '',
    dependencies: [],
    contracts: { inputs: {}, outputs: {} },
    context: { files: [] },
    completionCriteria: { automated: [], manual: [] },
    estimatedScope: 'single-component',
    weight,
  })),
  executionLayers: [{ layer: 0, description: 'all', taskIds: weights.map((_, i) => `t${i}`) }],
});

describe('decompositionStatsFromFile', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dag-stats-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads, validates, and derives stats from a JSON file', () => {
    const path = join(dir, 'd.json');
    writeFileSync(path, JSON.stringify(validDag(['standard', 'heavy'])));
    assert.deepEqual(decompositionStatsFromFile(path), { task_count: 2, max_width: 2, has_heavy: true });
  });

  it('throws on a Zod-invalid decomposition', () => {
    const path = join(dir, 'bad.json');
    writeFileSync(path, JSON.stringify({ tasks: [], executionLayers: [] }));
    assert.throws(() => decompositionStatsFromFile(path));
  });

  it('throws on a missing file', () => {
    assert.throws(() => decompositionStatsFromFile(join(dir, 'nope.json')));
  });
});
