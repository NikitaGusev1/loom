import type { BacklogBlockedTask, DecompositionDAG, ExecutionState, TaskStatus } from '../types.js';
import type { DagEvent } from '../events/types.js';
import type { SlotsScan } from '../slots-status.js';
import type {
  UiApproval,
  UiClarificationMessage,
  UiExecutionMode,
  UiIntakeStatus,
  UiTriageResult,
} from './intake/types.js';

export type UiInboxStatus = 'open' | 'converted' | 'archived';

/** A revision-specific, lightweight snapshot of a proposed DAG change. */
export interface UiDagProposal {
  revision: number;
  affectedFiles: string[];
}

export interface UiInboxItem {
  id: string;
  createdAt: string;
  updatedAt: string;
  body: string;
  status: UiInboxStatus;
  source: 'ui';
  linkedDagPath: string | null;
  linkedTaskId: string | null;
  linkedQueueId?: string | null;
  proposal?: UiDagProposal | null;
  intakeStatus?: UiIntakeStatus;
  triage?: UiTriageResult | null;
  approval?: UiApproval | null;
  executionMode?: UiExecutionMode | null;
  linkedPlanPath?: string | null;
  linkedRunId?: string | null;
  lastError?: string | null;
  executionStartedAt?: string | null;
  executionCompletedAt?: string | null;
  clarificationMessages?: UiClarificationMessage[];
  clarificationRounds?: number;
}

export interface UiInboxFileV1 {
  schemaVersion: 1;
  items: UiInboxItem[];
}

export type UiInboxFile = UiInboxFileV1;

export interface UiError {
  scope: 'project' | 'dag' | 'state' | 'events' | 'inbox' | 'intake' | 'run' | 'slots';
  path?: string;
  message: string;
}

export type UiDagStatus = 'not-started' | 'running' | 'paused' | 'completed' | 'failed';

export type UiDagView = 'active' | 'history' | 'archived';

export interface UiProject {
  schemaVersion: 1;
  slug: string;
  displayName: string;
  repoPath: string;
  registeredAt: string;
  updatedAt: string;
  source: 'manifest' | 'legacy-readme';
  available: boolean;
  errors: UiError[];
}

export interface UiDagListItem {
  path: string;
  relativePath: string;
  eventLogPath: string;
  statePath: string;
  id: string;
  title: string;
  status: UiDagStatus;
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  runningTasks: number;
  updatedAt: string | null;
  errors: UiError[];
}

export interface UiTaskSummary {
  id: string;
  name: string;
  status: TaskStatus | 'blocked' | 'running';
  layer: number;
  dependencies: string[];
  blockedBy: string[];
  rootFailures: string[];
}

export interface UiBacklogGroups {
  ready: UiTaskSummary[];
  running: UiTaskSummary[];
  blocked: UiTaskSummary[];
  failed: UiTaskSummary[];
  done: UiTaskSummary[];
  pending: UiTaskSummary[];
}

export interface UiDagDetail {
  dag: DecompositionDAG;
  dagPath: string;
  relativePath: string;
  state: ExecutionState | null;
  status: UiDagStatus;
  progress: {
    totalTasks: number;
    completedTasks: number;
    failedTasks: number;
    runningTasks: number;
    percent: number;
  };
  backlog: UiBacklogGroups;
  blockedTasks: BacklogBlockedTask[];
  recentEvents: DagEvent[];
  errors: UiError[];
}

export interface UiTaskDetail {
  task: UiTaskSummary;
  description: string;
  files: string[];
  worktreePath: string | null;
  worktreeBranch: string | null;
  filesModified: string[];
  usage: ExecutionState['tasks'][string]['usage'];
  error: string | null;
  events: DagEvent[];
}

export interface UiProjectSummary {
  slug: string;
  displayName: string;
  projectPath: string;
  dagCount: number;
  dagCounts: {
    active: number;
    history: number;
    archived: number;
    attention: number;
  };
  openInboxCount: number;
  recentActivityAt: string | null;
  recentRun: {
    mode: 'dag' | 'sequential';
    status: string;
    updatedAt: string;
  } | null;
  git: UiGitStatus;
  slots: SlotsScan;
  errors: UiError[];
}

export interface UiGitStatus {
  isRepository: boolean;
  branch: string | null;
  clean: boolean;
  changedFiles: number;
  ahead: number;
  behind: number;
}
