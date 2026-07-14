import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildTriagePrompt, parseTriageResult } from './triage.js';

const value = {
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
  proposalRevision: 99,
};

describe('triage provider boundary', () => {
  it('parses fenced JSON and owns the proposal revision', () => {
    const parsed = parseTriageResult('```json\n' + JSON.stringify(value) + '\n```', 3);
    assert.equal(parsed.proposalRevision, 3);
  });
  it('rejects malformed output and emits a bounded-context prompt', () => {
    assert.throws(() => parseTriageResult('not json', 1));
    assert.match(
      buildTriagePrompt(
        'Fix typo',
        {
          projectPath: '/p',
          projectName: 'p',
          guidance: [],
          files: [],
          openTodos: [],
          dags: [],
          git: { isRepository: true, clean: true, branch: 'main' },
          activeSequentialFiles: [],
        },
        1,
      ),
      /execute-sequential/,
    );
  });

  it('includes prior answers and limits clarification to one material question', () => {
    const prompt = buildTriagePrompt(
      'Improve intake',
      {
        projectPath: '/p',
        projectName: 'p',
        guidance: [],
        files: [],
        openTodos: [],
        dags: [],
        git: { isRepository: true, clean: true, branch: 'main' },
        activeSequentialFiles: [],
      },
      2,
      [
        { id: 'm1', role: 'loom', content: 'Which surface?', createdAt: 'now', proposalRevision: 1 },
        { id: 'm2', role: 'user', content: 'Web UI', createdAt: 'now', proposalRevision: 1 },
      ],
    );
    assert.match(prompt, /Web UI/);
    assert.match(prompt, /exactly one concise primary question/);
    assert.match(prompt, /requires approval rather than clarification/);
  });
});
