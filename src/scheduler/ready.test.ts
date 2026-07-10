import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { DAGTask, DecompositionDAG, ExecutionState, TaskStatus } from '../types.js';
import { buildChildren, initialUnmetDeps, reconstructReadyState, markCompleted } from './ready.js';

const makeTask = (id: string, dependencies: string[], weight: DAGTask['weight'] = 'standard'): DAGTask =>
  ({
    id,
    name: id,
    description: '',
    dependencies,
    weight,
    contracts: { inputs: {}, outputs: {} },
  }) as DAGTask;

const makeDag = (tasks: DAGTask[]): DecompositionDAG =>
  ({ tasks, executionLayers: [], meta: {} }) as unknown as DecompositionDAG;

const makeExecutionState = (statuses: Record<string, TaskStatus>): ExecutionState =>
  ({
    tasks: Object.fromEntries(Object.entries(statuses).map(([id, status]) => [id, { status }])),
  }) as ExecutionState;

const chainPlusD = (): DecompositionDAG =>
  makeDag([makeTask('A', []), makeTask('B', ['A']), makeTask('C', ['B']), makeTask('D', [])]);

describe('buildChildren', () => {
  it('builds reverse adjacency, empty arrays for leaves', () => {
    const children = buildChildren(chainPlusD());
    assert.deepEqual(children.get('A'), ['B']);
    assert.deepEqual(children.get('B'), ['C']);
    assert.deepEqual(children.get('C'), []);
    assert.deepEqual(children.get('D'), []);
  });

  it('de-dupes repeated dependencies into one edge', () => {
    const children = buildChildren(makeDag([makeTask('A', []), makeTask('B', ['A', 'A'])]));
    assert.deepEqual(children.get('A'), ['B']);
  });
});

describe('initialUnmetDeps', () => {
  it('is the indegree per task', () => {
    const counts = initialUnmetDeps(chainPlusD());
    assert.equal(counts.get('A'), 0);
    assert.equal(counts.get('B'), 1);
    assert.equal(counts.get('C'), 1);
    assert.equal(counts.get('D'), 0);
  });
});

describe('reconstructReadyState', () => {
  it('fresh run: ready = the indegree-0 tasks', () => {
    const r = reconstructReadyState(
      makeExecutionState({ A: 'pending', B: 'pending', C: 'pending', D: 'pending' }),
      chainPlusD(),
    );
    assert.deepEqual(r.ready, ['A', 'D']);
    assert.deepEqual(r.inFlightToReset, []);
    assert.equal(r.unmetDeps.get('B'), 1);
    assert.equal(r.unmetDeps.get('C'), 1);
  });

  it('resume mid-flight: completed deps unblock children and in-progress tasks reset ready', () => {
    const r = reconstructReadyState(
      makeExecutionState({ A: 'completed', B: 'pending', C: 'pending', D: 'in-progress' }),
      chainPlusD(),
    );
    assert.deepEqual(r.ready, ['B', 'D']);
    assert.deepEqual(r.inFlightToReset, ['D']);
    assert.equal(r.unmetDeps.get('B'), 0);
    assert.equal(r.unmetDeps.get('C'), 1);
  });

  it('a failed task is not ready but is surfaced as a retry candidate', () => {
    const r = reconstructReadyState(
      makeExecutionState({ A: 'failed', B: 'pending', C: 'pending', D: 'pending' }),
      chainPlusD(),
    );
    assert.deepEqual(r.ready, ['D']);
    assert.deepEqual(r.failedRunnable, ['A']);
    assert.deepEqual(r.inFlightToReset, []);
    assert.equal(r.unmetDeps.get('B'), 1);
  });

  it('a failed task with an incomplete dep is neither ready nor a retry candidate', () => {
    const r = reconstructReadyState(
      makeExecutionState({ A: 'pending', B: 'failed', C: 'pending', D: 'pending' }),
      chainPlusD(),
    );
    assert.ok(!r.failedRunnable.includes('B'));
    assert.equal(r.unmetDeps.get('B'), 1);
  });

  it('--rerun reset: a pending task whose deps are complete is ready', () => {
    const r = reconstructReadyState(
      makeExecutionState({ A: 'completed', B: 'pending', C: 'pending', D: 'completed' }),
      chainPlusD(),
    );
    assert.ok(r.ready.includes('B'));
    assert.ok(!r.ready.includes('C'));
  });
});

describe('markCompleted', () => {
  it('returns a child only when its last dependency lands', () => {
    const dag = makeDag([makeTask('A', []), makeTask('B', []), makeTask('C', ['A', 'B'])]);
    const children = buildChildren(dag);
    const unmet = initialUnmetDeps(dag);

    assert.deepEqual(markCompleted(unmet, children, 'A'), []);
    assert.equal(unmet.get('C'), 1);
    assert.deepEqual(markCompleted(unmet, children, 'B'), ['C']);
    assert.equal(unmet.get('C'), 0);
  });

  it('walks a chain one unblock at a time', () => {
    const dag = chainPlusD();
    const children = buildChildren(dag);
    const unmet = initialUnmetDeps(dag);
    assert.deepEqual(markCompleted(unmet, children, 'A'), ['B']);
    assert.deepEqual(markCompleted(unmet, children, 'B'), ['C']);
    assert.deepEqual(markCompleted(unmet, children, 'D'), []);
  });
});
