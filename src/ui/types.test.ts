import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { UiInboxItem, UiDagListItem, UiTaskSummary } from './types.js';

describe('ui shared types', () => {
  it('models inbox items, DAG list rows, and task summaries', () => {
    const inbox: UiInboxItem = {
      id: 'ui-todo-20260710-000001',
      createdAt: '2026-07-10T00:00:00.000Z',
      updatedAt: '2026-07-10T00:00:00.000Z',
      body: 'Show quota pauses clearly',
      status: 'open',
      source: 'ui',
      linkedDagPath: null,
      linkedTaskId: null,
      clarificationRounds: 1,
      clarificationMessages: [
        { id: 'm1', role: 'loom', content: 'Which view?', createdAt: 'now', proposalRevision: 1 },
      ],
    };
    const dag: UiDagListItem = {
      path: '/repo/work.json',
      relativePath: 'work.json',
      eventLogPath: '/repo/work.events.jsonl',
      statePath: '/repo/work.state.json',
      id: 'work',
      title: 'Work DAG',
      status: 'running',
      totalTasks: 2,
      completedTasks: 1,
      failedTasks: 0,
      runningTasks: 1,
      updatedAt: '2026-07-10T00:00:00.000Z',
      errors: [],
    };
    const task: UiTaskSummary = {
      id: 'task-a',
      name: 'Task A',
      status: 'running',
      layer: 0,
      dependencies: [],
      blockedBy: [],
      rootFailures: [],
    };

    assert.equal(inbox.status, 'open');
    assert.equal(inbox.clarificationMessages?.[0].role, 'loom');
    assert.equal(dag.completedTasks, 1);
    assert.equal(task.status, 'running');
  });
});
