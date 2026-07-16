import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { statusProjection } from './checkpoint-projection.js';
import type { UiDagProposal } from './inbox-proposal-schema.js';
import { intakePolicySchema, sequentialCheckpointSchema, triageResultSchema } from './types.js';

describe('intake runtime contracts', () => {
  it('validates bounded triage confidence', () => {
    const value = {
      version: 1,
      status: 'complete',
      relevance: 'relevant',
      complexity: 'small',
      risk: 'low',
      confidence: 0.9,
      summary: 'Small change',
      rationale: 'Narrow project work',
      needsClarification: false,
      questions: [],
      estimatedFiles: ['src/a.ts'],
      proposedAction: 'execute-sequential',
      evaluatedAt: '2026-07-11T00:00:00.000Z',
      proposalRevision: 1,
    };
    assert.equal(triageResultSchema.parse(value).confidence, 0.9);
    assert.equal(triageResultSchema.safeParse({ ...value, confidence: 1.1 }).success, false);
  });

  it('rejects invalid policy thresholds and incomplete checkpoints', () => {
    assert.equal(
      intakePolicySchema.safeParse({ autoRunEnabled: true, confidenceThreshold: -1, triageProvider: 'codex' }).success,
      false,
    );
    assert.equal(sequentialCheckpointSchema.safeParse({ schemaVersion: 1, id: 'run' }).success, false);
  });

  it('rejects checkpoint IDs that are unsafe as filenames', () => {
    const base = {
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
    assert.equal(sequentialCheckpointSchema.safeParse(base).success, true);
    assert.equal(sequentialCheckpointSchema.safeParse({ ...base, id: '../../outside' }).success, false);
  });

  it('keeps legacy proposals and checkpoints compatible with the richer UI lifecycle', () => {
    const legacyProposal = {
      id: 'proposal-1',
      title: 'Show queue state',
    } as UiDagProposal;
    const legacyCheckpoint = {
      schemaVersion: 1,
      id: 'run-1',
      itemId: 'todo-1',
      proposalRevision: 1,
      mode: 'sequential',
      status: 'queued',
      phase: 'plan',
      createdAt: '2026-07-11T00:00:00.000Z',
      updatedAt: '2026-07-11T00:00:00.000Z',
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
    } as Parameters<typeof statusProjection>[0];

    assert.ok(legacyProposal);
    assert.equal(typeof statusProjection(legacyCheckpoint), 'string');
  });
});
