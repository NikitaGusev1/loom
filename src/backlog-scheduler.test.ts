import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseStartableBacklogTasks,
  summarizeBlockedBacklogPause,
  shouldPauseForNoReadyWork,
} from './backlog-scheduler.js';
import type { BacklogBlockedTask, DAGTask } from './types.js';

const task = (id: string, dependencies: string[] = []): DAGTask => ({
  id,
  name: id,
  description: id,
  dependencies,
  contracts: { inputs: {}, outputs: {} },
  context: { files: [] },
  completionCriteria: { automated: [], manual: [] },
  estimatedScope: 'single-component',
  weight: 'standard',
});

describe('chooseStartableBacklogTasks', () => {
  it('excludes tasks that are already running', () => {
    const ready = [task('active'), task('newly-ready')];
    const startable = chooseStartableBacklogTasks(ready, new Set(['active']));

    assert.deepEqual(
      startable.map((t) => t.id),
      ['newly-ready'],
    );
  });

  it('allows a downstream task to start while an unrelated task is still running', () => {
    const ready = [task('child', ['fast-parent']), task('unrelated-slow')];
    const startable = chooseStartableBacklogTasks(ready, new Set(['unrelated-slow']));

    assert.deepEqual(
      startable.map((t) => t.id),
      ['child'],
    );
  });
});

describe('shouldPauseForNoReadyWork', () => {
  it('does not pause while a task is still running', () => {
    assert.equal(shouldPauseForNoReadyWork([], new Set(['slow-task'])), false);
  });

  it('pauses when no ready tasks and no running tasks remain', () => {
    assert.equal(shouldPauseForNoReadyWork([], new Set()), true);
  });
});

describe('summarizeBlockedBacklogPause', () => {
  it('summarizes direct permanent failures and dependency-blocked tasks', () => {
    const blocked: BacklogBlockedTask[] = [
      {
        taskId: 'failed-root',
        kind: 'permanent-failure',
        blockedBy: [],
        rootFailures: ['failed-root'],
        reason: 'non-transient',
      },
      {
        taskId: 'blocked-child',
        kind: 'dependency-blocked',
        blockedBy: ['failed-root'],
        rootFailures: ['failed-root'],
        reason: 'depends on blocked task(s): failed-root',
      },
    ];

    assert.equal(
      summarizeBlockedBacklogPause(blocked),
      'No ready backlog tasks; permanent failures: failed-root; dependency-blocked: blocked-child',
    );
  });
});
