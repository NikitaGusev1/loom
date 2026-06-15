import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { emitWorktreeMerged } from './emit.js';
import type { DagEvent, WorktreeMergedEvent } from './types.js';
import type { ExecutionState } from '../types.js';

const baseState = (tasks: ExecutionState['tasks']): ExecutionState => ({
  dagPath: '/t/dag.json',
  status: 'running',
  startedAt: '',
  currentLayer: 0,
  config: {} as ExecutionState['config'],
  layers: {},
  tasks,
});

const capture = () => {
  const events: DagEvent[] = [];
  return { events, emit: (e: DagEvent) => events.push(e) };
};

describe('emitWorktreeMerged', () => {
  it('emits a worktree.merged event sourced from task state', () => {
    const state = baseState({
      a: { status: 'completed', worktreePath: '/wt/a', worktreeBranch: 'dag/a', filesModified: ['src/x.ts'] },
    });
    const { events, emit } = capture();
    emitWorktreeMerged({ taskId: 'a', state, baseBranch: 'main', dagId: 'd1', ts: 'T', emit });

    assert.equal(events.length, 1);
    const e = events[0] as WorktreeMergedEvent;
    assert.equal(e.kind, 'worktree.merged');
    assert.equal(e.taskId, 'a');
    assert.equal(e.worktreePath, '/wt/a');
    assert.equal(e.branch, 'dag/a');
    assert.equal(e.targetBranch, 'main');
    assert.equal(e.dagId, 'd1');
    assert.equal(e.ts, 'T');
    assert.deepEqual(e.filesChanged, ['src/x.ts']);
  });

  it('defaults missing worktree metadata to empty values', () => {
    const state = baseState({ a: { status: 'completed' } });
    const { events, emit } = capture();
    emitWorktreeMerged({ taskId: 'a', state, baseBranch: 'main', dagId: 'd1', ts: 'T', emit });

    const e = events[0] as WorktreeMergedEvent;
    assert.equal(e.worktreePath, '');
    assert.equal(e.branch, '');
    assert.deepEqual(e.filesChanged, []);
  });
});
