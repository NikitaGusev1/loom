import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInboxItem } from '../inbox.js';
import {
  StaleProposalError,
  addIntakeJob,
  appendRunLog,
  readRunLogTail,
  updateInboxItem,
  writeCheckpoint,
  writePlan,
} from './persistence.js';
import type { UiIntakeJob, UiSequentialCheckpoint } from './types.js';

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'dag-ui-intake-persistence-'));
});
afterEach(() => rmSync(projectDir, { recursive: true, force: true }));

describe('intake persistence', () => {
  it('checks proposal revisions when updating items', () => {
    const item = createInboxItem(projectDir, 'Work', { id: () => 'todo-1' });
    updateInboxItem(projectDir, item.id, (value) => ({
      ...value,
      triage: {
        version: 1,
        status: 'complete',
        relevance: 'relevant',
        complexity: 'small',
        risk: 'low',
        confidence: 0.9,
        summary: 'Work',
        rationale: 'Narrow',
        needsClarification: false,
        questions: [],
        estimatedFiles: [],
        proposedAction: 'execute-sequential',
        evaluatedAt: '2026-07-11T00:00:00.000Z',
        proposalRevision: 2,
      },
    }));
    assert.throws(() => updateInboxItem(projectDir, item.id, (value) => value, 1), StaleProposalError);
  });

  it('deduplicates jobs and bounds log tails', () => {
    const job: UiIntakeJob = {
      id: 'job-1',
      itemId: 'todo-1',
      kind: 'triage',
      status: 'queued',
      proposalRevision: 0,
      idempotencyKey: 'todo-1:0:triage',
      createdAt: 'now',
      updatedAt: 'now',
      ownerPid: null,
      leaseAt: null,
      attempts: 0,
      error: null,
    };
    addIntakeJob(projectDir, job);
    addIntakeJob(projectDir, { ...job, id: 'job-2' });
    for (let i = 0; i < 250; i += 1) appendRunLog(projectDir, 'run-1', `line-${i}`);
    const tail = readRunLogTail(projectDir, 'run-1');
    assert.equal(tail.length, 200);
    assert.equal(tail.at(-1), 'line-249');
  });

  it('writes plans and validated checkpoints under the project', () => {
    assert.match(writePlan(projectDir, 'todo-1', '# Plan'), /\.dag-executor\/intake\/plans/);
    const checkpoint: UiSequentialCheckpoint = {
      schemaVersion: 1,
      id: 'run-1',
      itemId: 'todo-1',
      proposalRevision: 1,
      mode: 'sequential',
      status: 'queued',
      phase: 'plan',
      createdAt: 'now',
      updatedAt: 'now',
      startedAt: null,
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
    };
    writeCheckpoint(projectDir, checkpoint);
    assert.throws(() => writeCheckpoint(projectDir, { ...checkpoint, id: '../../outside' }));
    assert.throws(() => readRunLogTail(projectDir, '../../../../outside'), /escapes project/);
  });
});
