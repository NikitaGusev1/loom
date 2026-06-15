import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildTaskCommitMessage, buildBatchCommitMessage } from './commit-message.js';
import type { DAGTask } from '../types.js';

const makeTask = (over: Partial<DAGTask>): DAGTask =>
  ({
    id: 'task-1',
    name: 'Add semaphore reclaim',
    description: 'Reclaim stale slot files from dead PIDs on poll.',
    weight: 'standard',
    dependencies: [],
    contracts: { inputs: {}, outputs: {} },
    context: { files: [] },
    completionCriteria: { automated: [], manual: [] },
    estimatedScope: 'single-component',
    ...over,
  }) as unknown as DAGTask;

describe('buildTaskCommitMessage', () => {
  it('name as subject, description as body, id as trailer', () => {
    const msg = buildTaskCommitMessage(makeTask({}));
    assert.equal(msg, 'Add semaphore reclaim\n\nReclaim stale slot files from dead PIDs on poll.\n\ntask-id: task-1');
  });

  it('omits the body block when description is empty', () => {
    const msg = buildTaskCommitMessage(makeTask({ description: '   ' }));
    assert.equal(msg, 'Add semaphore reclaim\n\ntask-id: task-1');
  });

  it('falls back to the id when name is empty', () => {
    const msg = buildTaskCommitMessage(makeTask({ name: '', description: '' }));
    assert.equal(msg, 'task-1\n\ntask-id: task-1');
  });

  it('truncates an over-long subject to 72 chars with an ellipsis', () => {
    const name = 'x'.repeat(100);
    const subject = buildTaskCommitMessage(makeTask({ name, description: '' })).split('\n')[0];
    assert.equal(subject.length, 72);
    assert.ok(subject.endsWith('…'));
  });

  it('collapses multi-line names into a single subject line', () => {
    const subject = buildTaskCommitMessage(makeTask({ name: 'line one\nline two', description: '' })).split('\n')[0];
    assert.equal(subject, 'line one line two');
  });
});

describe('buildBatchCommitMessage', () => {
  it('summary subject + one bulleted line per task with its id', () => {
    const tasks = [makeTask({ id: 'a', name: 'First' }), makeTask({ id: 'b', name: 'Second' })];
    assert.equal(buildBatchCommitMessage(tasks), 'trivial batch: 2 tasks\n\n- First (a)\n- Second (b)');
  });

  it('singular task count', () => {
    const msg = buildBatchCommitMessage([makeTask({ id: 'a', name: 'Only' })]);
    assert.equal(msg, 'trivial batch: 1 task\n\n- Only (a)');
  });

  it('verify-fix variant labels the subject', () => {
    const msg = buildBatchCommitMessage([makeTask({ id: 'a', name: 'Only' })], { verifyFix: true });
    assert.equal(msg, 'trivial batch verify-fix: 1 task\n\n- Only (a)');
  });
});
