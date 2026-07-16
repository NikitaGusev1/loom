import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildDagPlannerPrompt, deriveDagProposal, persistDagProposal } from './dag-planner.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

describe('DAG proposals', () => {
  it('persists an actual-DAG-derived snapshot for the triage revision', () => {
    const projectPath = mkdtempSync(join(tmpdir(), 'dag-proposal-'));
    try {
      const item = {
        id: 'todo-1', createdAt: 'now', updatedAt: 'now', body: 'Improve intake', status: 'open', source: 'ui',
        linkedDagPath: null, linkedTaskId: null,
      } satisfies UiInboxItem;
      const triage = {
        version: 1, status: 'complete', relevance: 'relevant', complexity: 'medium', risk: 'medium', confidence: 0.9,
        summary: 'Improve intake', rationale: 'Clear scope', needsClarification: false, questions: [], estimatedFiles: [],
        proposedAction: 'propose-dag', evaluatedAt: 'now', proposalRevision: 3,
      } satisfies UiTriageResult;
      const proposal = deriveDagProposal(projectPath, item, triage, { planPath: '/plan', dagPath: '/dag' }, {
        tasks: [
          { id: 'first', files: ['src/a.ts', 'src/b.ts'] },
          { id: 'second', dependsOn: ['first'], affectedFiles: ['src/b.ts', 'src/c.ts'] },
        ],
      });

      persistDagProposal(proposal);
      assert.equal(proposal.proposalRevision, 3);
      assert.equal(proposal.taskCount, 2);
      assert.equal(proposal.layerCount, 2);
      assert.deepEqual(proposal.affectedFiles, ['src/a.ts', 'src/b.ts', 'src/c.ts']);
      assert.deepEqual(JSON.parse(readFileSync(proposal.proposalSnapshotPath, 'utf8')), proposal);
    } finally {
      rmSync(projectPath, { recursive: true, force: true });
    }
  });
});
