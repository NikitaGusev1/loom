import type { UiIntakePolicy, UiTriageResult } from './types.js';

export type IntakeDecision =
  | { kind: 'execute-sequential' }
  | { kind: 'awaiting-approval'; reason: string }
  | { kind: 'awaiting-clarification'; reason: string }
  | { kind: 'deferred'; reason: string };

export interface IntakeGateContext {
  isGitRepository: boolean;
  gitClean: boolean;
  activeMutationLease: boolean;
  overlappingFiles: string[];
  todoBody: string;
}

const MANDATORY_APPROVAL = [
  /\b(delete|drop|destroy|reset|force[- ]?push|rewrite history)\b/i,
  /\b(migration|schema change|database)\b/i,
  /\b(auth|authentication|authorization|permission)\b/i,
  /\b(secret|credential|api key|token)\b/i,
  /\b(install|upgrade|dependency|package)\b/i,
  /\b(publish|deploy|production|paid service|external service)\b/i,
  /\b(refactor everything|broad refactor)\b/i,
];
const AMBIGUOUS_REFERENT = /\b(move|mark|set|change)\s+(it|this|that|them)\b/i;

export const requiresMandatoryApproval = (body: string): boolean =>
  MANDATORY_APPROVAL.some((pattern) => pattern.test(body));

export const decideIntake = (
  triage: UiTriageResult,
  policy: UiIntakePolicy,
  context: IntakeGateContext,
): IntakeDecision => {
  if (AMBIGUOUS_REFERENT.test(context.todoBody)) {
    return { kind: 'awaiting-clarification', reason: 'The request has an ambiguous referent' };
  }
  if (triage.needsClarification || triage.proposedAction === 'clarify') {
    return { kind: 'awaiting-clarification', reason: triage.rationale };
  }
  if (triage.relevance === 'unrelated' || triage.proposedAction === 'reject' || triage.proposedAction === 'defer') {
    return { kind: 'deferred', reason: triage.rationale };
  }
  if (triage.proposedAction === 'propose-dag' || triage.complexity === 'medium' || triage.complexity === 'large') {
    return { kind: 'awaiting-approval', reason: 'DAG proposal requires approval' };
  }
  const blockers = [
    !policy.autoRunEnabled && 'Project auto-run is disabled',
    !context.isGitRepository && 'Project is not a git repository',
    !context.gitClean && 'Project has uncommitted changes',
    context.activeMutationLease && 'Another sequential runner owns the project lease',
    context.overlappingFiles.length > 0 && 'Estimated files overlap active work',
    requiresMandatoryApproval(context.todoBody) && 'Request matches a mandatory approval category',
    triage.relevance !== 'relevant' && 'Request is not clearly relevant',
    !['trivial', 'small'].includes(triage.complexity) && 'Request is not small',
    triage.risk !== 'low' && 'Request risk is not low',
    triage.confidence < policy.confidenceThreshold && 'Triage confidence is below threshold',
  ].filter((value): value is string => Boolean(value));
  return blockers.length === 0
    ? { kind: 'execute-sequential' }
    : { kind: 'awaiting-approval', reason: blockers.join('; ') };
};
