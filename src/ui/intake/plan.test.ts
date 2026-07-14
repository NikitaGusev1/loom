import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildSequentialPlan } from './plan.js';

describe('buildSequentialPlan', () => {
  it('creates an approved sequential plan without decomposition metadata', () => {
    const plan = buildSequentialPlan(
      '/repo',
      {
        id: 'todo',
        createdAt: 'now',
        updatedAt: 'now',
        body: 'Fix copy',
        status: 'open',
        source: 'ui',
        linkedDagPath: null,
        linkedTaskId: null,
      },
      {
        version: 1,
        status: 'complete',
        relevance: 'relevant',
        complexity: 'small',
        risk: 'low',
        confidence: 0.9,
        summary: 'Fix copy',
        rationale: 'Narrow',
        needsClarification: false,
        questions: [],
        estimatedFiles: ['src/a.ts'],
        proposedAction: 'execute-sequential',
        evaluatedAt: '2026-07-11T00:00:00.000Z',
        proposalRevision: 1,
      },
    );
    assert.match(plan, /execution_mode: sequential/);
    assert.doesNotMatch(plan, /decomposition_path/);
  });
});
