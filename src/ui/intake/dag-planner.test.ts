import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildDagPlannerPrompt } from './dag-planner.js';
import type { UiInboxItem } from '../types.js';
import type { UiTriageResult } from './types.js';

describe('buildDagPlannerPrompt', () => {
  it('keeps the concise request and gives agents the clarification transcript', () => {
    const item = {
      id: 'todo-1',
      createdAt: 'now',
      updatedAt: 'now',
      body: 'Improve intake',
      status: 'open',
      source: 'ui',
      linkedDagPath: null,
      linkedTaskId: null,
      clarificationMessages: [
        { id: 'm1', role: 'loom', content: 'Which surface?', createdAt: 'now', proposalRevision: 1 },
        { id: 'm2', role: 'user', content: 'The web UI', createdAt: 'now', proposalRevision: 1 },
      ],
    } satisfies UiInboxItem;
    const triage = {
      version: 1,
      status: 'complete',
      relevance: 'relevant',
      complexity: 'medium',
      risk: 'low',
      confidence: 0.9,
      summary: 'Improve intake',
      rationale: 'Clear after clarification',
      needsClarification: false,
      questions: [],
      estimatedFiles: ['src/ui/assets.ts'],
      proposedAction: 'propose-dag',
      evaluatedAt: 'now',
      proposalRevision: 2,
    } satisfies UiTriageResult;

    const prompt = buildDagPlannerPrompt(item, triage);
    assert.match(prompt, /Improve intake/);
    assert.match(prompt, /Which surface\?/);
    assert.match(prompt, /The web UI/);
    assert.match(prompt, /project-local artifacts/);
  });
});
