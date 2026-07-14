import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
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
});
