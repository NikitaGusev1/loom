import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInboxItem } from '../inbox.js';
import { writeCheckpoint } from './persistence.js';
import { listRuns, loadRunDetail } from './projection.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'run-projection-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('run projection', () => {
  it('projects sequential checkpoints with their todo title', () => {
    createInboxItem(dir, 'Fix the title', { id: () => 'todo-1' });
    writeCheckpoint(dir, {
      schemaVersion: 1,
      id: 'run-1',
      itemId: 'todo-1',
      proposalRevision: 1,
      mode: 'sequential',
      status: 'running',
      phase: 'implement',
      createdAt: 'a',
      updatedAt: 'b',
      startedAt: 'a',
      completedAt: null,
      planPath: 'plan',
      logPath: 'log',
      provider: 'codex',
      model: 'account-default',
      pid: null,
      baseCommit: null,
      terminalCommit: null,
      changedFiles: [],
      verification: null,
      reviewVerdict: null,
      error: null,
      recoveryRequired: false,
    });
    const runs = listRuns(dir);
    assert.equal(runs[0].title, 'Fix the title');
    assert.equal(loadRunDetail(dir, 'run-1').summary.mode, 'sequential');
  });
});
