import assert from 'node:assert/strict';
import test from 'node:test';
import { projectDagExecutionStatus, readSupervisorCheckpoint } from './supervisor-checkpoint.js';

test('maps DAG lifecycle spellings into UI run statuses', () => {
  assert.equal(projectDagExecutionStatus('pending'), 'queued');
  assert.equal(projectDagExecutionStatus('in_progress'), 'running');
  assert.equal(projectDagExecutionStatus('succeeded'), 'completed');
  assert.equal(projectDagExecutionStatus('error'), 'failed');
  assert.equal(projectDagExecutionStatus('canceled'), 'cancelled');
  assert.equal(projectDagExecutionStatus('unrecognized'), 'queued');
});

test('projects bounded UI checkpoint and pull request fields from queue artifacts', () => {
  const result = readSupervisorCheckpoint({
    id: 'queue-17',
    projectPath: '/projects/selected',
    status: 'running',
    executionArtifacts: {
      'queue-17': {
        checkpoint: {
          id: 'run-9', status: 'succeeded', createdAt: '2026-01-01', updatedAt: '2026-01-02',
          tasks: [{ status: 'succeeded' }, { status: 'running' }],
          pullRequest: { number: 91, htmlUrl: 'https://example.test/pr/91', status: 'open', ignored: true },
          ignored: { nested: true },
        },
      },
    },
  });
  assert.deepEqual(result.checkpoint, {
    id: 'run-9', status: 'completed', createdAt: '2026-01-01', updatedAt: '2026-01-02', dagPath: null,
    taskProgress: { completed: 1, total: 2 },
    pullRequest: { number: 91, url: 'https://example.test/pr/91', status: 'open' },
  });
  assert.equal(result.status, 'completed');
});

test('rejects escaping source and checkpoint paths without hiding queue status', () => {
  const result = readSupervisorCheckpoint({
    id: 'queue-18', projectPath: '/projects/selected', status: 'running',
    sourceDefinitionPath: '../other/dag.json', checkpointPath: '../other/checkpoint.json',
  });
  assert.equal(result.checkpoint, null);
  assert.equal(result.status, 'running');
  assert.equal(result.checkpointPath, null);
  assert.equal(result.sourcePath, null);
  assert.equal(result.diagnostics.length, 3);
  assert.match(result.diagnostics.join(' '), /outside the selected project/);
});

test('malformed checkpoints return bounded diagnostics and queue state', () => {
  const result = readSupervisorCheckpoint({ id: 'queue-19', status: 'blocked', checkpoint: { status: 'running' } });
  assert.equal(result.checkpoint, null);
  assert.equal(result.status, 'blocked');
  assert.equal(result.diagnostics.length, 1);
  assert.match(result.diagnostics[0] ?? '', /run ID/);
});
