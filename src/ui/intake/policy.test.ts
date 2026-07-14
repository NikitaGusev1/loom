import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decideIntake, requiresMandatoryApproval } from './policy.js';
import { DEFAULT_INTAKE_POLICY, type UiTriageResult } from './types.js';

const triage = (patch: Partial<UiTriageResult> = {}): UiTriageResult => ({
  version: 1,
  status: 'complete',
  relevance: 'relevant',
  complexity: 'small',
  risk: 'low',
  confidence: 0.9,
  summary: 'Narrow change',
  rationale: 'Clearly scoped',
  needsClarification: false,
  questions: [],
  estimatedFiles: ['src/a.ts'],
  proposedAction: 'execute-sequential',
  evaluatedAt: 'now',
  proposalRevision: 1,
  ...patch,
});
const context = {
  isGitRepository: true,
  gitClean: true,
  activeMutationLease: false,
  overlappingFiles: [],
  todoBody: 'Fix typo',
  clarificationRounds: 0,
};

describe('decideIntake', () => {
  it('auto-runs only qualifying easy work at the threshold', () => {
    assert.equal(decideIntake(triage({ confidence: 0.85 }), DEFAULT_INTAKE_POLICY, context).kind, 'execute-sequential');
    assert.equal(decideIntake(triage({ confidence: 0.849 }), DEFAULT_INTAKE_POLICY, context).kind, 'awaiting-approval');
  });
  it('holds ambiguous and medium work', () => {
    assert.equal(
      decideIntake(triage({ needsClarification: true }), DEFAULT_INTAKE_POLICY, context).kind,
      'awaiting-clarification',
    );
    assert.equal(
      decideIntake(triage({ complexity: 'medium' }), DEFAULT_INTAKE_POLICY, context).kind,
      'awaiting-approval',
    );
  });
  it('forces a DAG approval proposal after three clarification rounds', () => {
    const decision = decideIntake(
      triage({ needsClarification: true, proposedAction: 'clarify' }),
      DEFAULT_INTAKE_POLICY,
      { ...context, clarificationRounds: 3 },
    );
    assert.equal(decision.kind, 'awaiting-approval');
    assert.equal(decision.kind === 'awaiting-approval' ? decision.forcedAction : undefined, 'propose-dag');
  });
  it('requires approval for deterministic risk categories and dirty projects', () => {
    assert.equal(requiresMandatoryApproval('Install a new authentication package'), true);
    assert.equal(
      decideIntake(triage(), DEFAULT_INTAKE_POLICY, { ...context, gitClean: false }).kind,
      'awaiting-approval',
    );
    assert.equal(
      decideIntake(triage(), DEFAULT_INTAKE_POLICY, {
        ...context,
        clarificationRounds: 1,
        clarificationAnswers: ['Deploy it to production'],
      }).kind,
      'awaiting-approval',
    );
  });
  it('trusts transcript-aware triage after an ambiguous referent is answered', () => {
    assert.equal(
      decideIntake(triage(), DEFAULT_INTAKE_POLICY, {
        ...context,
        todoBody: 'move it to done',
        clarificationRounds: 1,
        clarificationAnswers: ['The todo card'],
      }).kind,
      'execute-sequential',
    );
  });
  it('does not execute the ambiguous news-app fixture', () => {
    const result = decideIntake(triage(), DEFAULT_INTAKE_POLICY, {
      ...context,
      todoBody: 'test todo - move it to done after seeing it',
    });
    assert.equal(result.kind, 'awaiting-clarification');
  });
});
