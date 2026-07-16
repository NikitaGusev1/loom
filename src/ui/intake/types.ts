import { z } from 'zod';
import type { UiInboxItem } from '../types.js';

export const intakeStatusSchema = z.enum([
  'open',
  'triaging',
  'awaiting-clarification',
  'awaiting-approval',
  'queued',
  'running',
  'completed',
  'failed',
  'blocked',
  'cancelled',
  'deferred',
]);
export type UiIntakeStatus = z.infer<typeof intakeStatusSchema>;

export const clarificationMessageSchema = z.object({
  id: z.string().min(1),
  role: z.enum(['loom', 'user']),
  content: z.string().min(1),
  createdAt: z.string(),
  proposalRevision: z.number().int().positive(),
});
export type UiClarificationMessage = z.infer<typeof clarificationMessageSchema>;

export const triageResultSchema = z.object({
  version: z.literal(1),
  status: z.literal('complete'),
  relevance: z.enum(['relevant', 'adjacent', 'unrelated', 'unknown']),
  complexity: z.enum(['trivial', 'small', 'medium', 'large', 'unknown']),
  risk: z.enum(['low', 'elevated', 'high']),
  confidence: z.number().finite().min(0).max(1),
  summary: z.string().min(1),
  rationale: z.string().min(1),
  needsClarification: z.boolean(),
  questions: z.array(z.string().min(1)),
  estimatedFiles: z.array(z.string()),
  proposedAction: z.enum(['execute-sequential', 'propose-dag', 'clarify', 'defer', 'reject']),
  evaluatedAt: z.string(),
  proposalRevision: z.number().int().positive(),
});
export type UiTriageResult = z.infer<typeof triageResultSchema>;

export const approvalSchema = z.object({
  status: z.enum(['not-required', 'pending', 'approved', 'rejected']),
  proposalRevision: z.number().int().positive(),
  decidedAt: z.string().nullable(),
});
export type UiApproval = z.infer<typeof approvalSchema>;

export const executionModeSchema = z.enum(['sequential', 'dag']);
export type UiExecutionMode = z.infer<typeof executionModeSchema>;
export const sequentialPhaseSchema = z.enum(['triage', 'plan', 'implement', 'verify', 'review', 'done']);
export type UiSequentialPhase = z.infer<typeof sequentialPhaseSchema>;
export const runStatusSchema = z.enum(['queued', 'running', 'completed', 'failed', 'blocked', 'cancelled']);
export type UiRunStatus = z.infer<typeof runStatusSchema>;

export const intakePolicySchema = z.object({
  autoRunEnabled: z.boolean(),
  confidenceThreshold: z.number().finite().min(0).max(1),
  triageProvider: z.literal('codex'),
});
export type UiIntakePolicy = z.infer<typeof intakePolicySchema>;

export const intakeJobSchema = z.object({
  id: z.string().min(1),
  itemId: z.string().min(1),
  kind: z.enum(['triage', 'sequential', 'dag']),
  status: z.enum(['queued', 'claimed', 'completed', 'failed', 'cancelled']),
  proposalRevision: z.number().int().nonnegative(),
  idempotencyKey: z.string().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
  ownerPid: z.number().int().positive().nullable(),
  leaseAt: z.string().nullable(),
  attempts: z.number().int().nonnegative(),
  error: z.string().nullable(),
});
export type UiIntakeJob = z.infer<typeof intakeJobSchema>;

export interface UiInboxFileV2 {
  schemaVersion: 2;
  items: UiInboxItem[];
  jobs: UiIntakeJob[];
  policy: UiIntakePolicy;
}

export const sequentialCheckpointSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'Checkpoint ID must be a safe filename'),
  itemId: z.string().min(1),
  proposalRevision: z.number().int().positive(),
  mode: z.literal('sequential'),
  status: runStatusSchema,
  phase: sequentialPhaseSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  planPath: z.string(),
  logPath: z.string(),
  provider: z.enum(['codex', 'claude']),
  model: z.string(),
  pid: z.number().int().positive().nullable(),
  baseCommit: z.string().nullable(),
  terminalCommit: z.string().nullable(),
  changedFiles: z.array(z.string()),
  verification: z.string().nullable(),
  reviewVerdict: z.string().nullable(),
  error: z.string().nullable(),
  recoveryRequired: z.boolean(),
});
export type UiSequentialCheckpoint = z.infer<typeof sequentialCheckpointSchema>;

interface UiRunBase {
  id: string;
  itemId: string | null;
  title: string;
  mode: UiExecutionMode;
  status: UiRunStatus;
  createdAt: string;
  updatedAt: string;
}

export interface UiSequentialRunSummary extends UiRunBase {
  mode: 'sequential';
  phase: UiSequentialPhase;
  provider: 'codex' | 'claude';
  changedFileCount: number;
  verification: string | null;
  reviewVerdict: string | null;
  recoveryRequired: boolean;
}

export interface UiDagRunSummary extends UiRunBase {
  mode: 'dag';
  dagPath: string;
  completedTasks: number;
  totalTasks: number;
}

export type UiRunSummary = UiSequentialRunSummary | UiDagRunSummary;
export type UiRunDetail =
  | { summary: UiSequentialRunSummary; checkpoint: UiSequentialCheckpoint; recentLog: string[] }
  | { summary: UiDagRunSummary; dagPath: string };

export interface TriageProvider {
  triage(prompt: string, signal?: AbortSignal): Promise<unknown>;
}

export interface SequentialProvider {
  run(options: {
    projectPath: string;
    planPath: string;
    signal: AbortSignal;
    onOutput: (line: string) => void;
  }): Promise<void>;
}

export const DEFAULT_INTAKE_POLICY: UiIntakePolicy = {
  autoRunEnabled: true,
  confidenceThreshold: 0.85,
  triageProvider: 'codex',
};
