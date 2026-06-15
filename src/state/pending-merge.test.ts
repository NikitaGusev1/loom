import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pendingMergeTaskIds } from './pending-merge.js';
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

describe('pendingMergeTaskIds', () => {
  it('returns completed worktree tasks that were never merged', () => {
    const state = baseState({
      a: { status: 'completed', worktreeBranch: 'dag/a' },
      b: { status: 'completed', worktreeBranch: 'dag/b', merged: true },
    });
    assert.deepEqual(pendingMergeTaskIds(['a', 'b'], state), ['a']);
  });

  it('excludes trivial tasks (no worktree branch) even when completed', () => {
    const state = baseState({ t: { status: 'completed' } });
    assert.deepEqual(pendingMergeTaskIds(['t'], state), []);
  });

  it('excludes failed worktree tasks', () => {
    const state = baseState({ f: { status: 'failed', worktreeBranch: 'dag/f' } });
    assert.deepEqual(pendingMergeTaskIds(['f'], state), []);
  });

  it('excludes already-merged tasks', () => {
    const state = baseState({ m: { status: 'completed', worktreeBranch: 'dag/m', merged: true } });
    assert.deepEqual(pendingMergeTaskIds(['m'], state), []);
  });

  it('returns empty for a fully-settled layer', () => {
    const state = baseState({
      a: { status: 'completed', worktreeBranch: 'dag/a', merged: true },
      t: { status: 'completed' },
    });
    assert.deepEqual(pendingMergeTaskIds(['a', 't'], state), []);
  });

  it('scopes to the requested layer set only', () => {
    const state = baseState({
      a: { status: 'completed', worktreeBranch: 'dag/a' },
      other: { status: 'completed', worktreeBranch: 'dag/other' },
    });
    assert.deepEqual(pendingMergeTaskIds(['a'], state), ['a']);
  });

  it('handles missing task entries gracefully', () => {
    assert.deepEqual(pendingMergeTaskIds(['ghost'], baseState({})), []);
  });
});
