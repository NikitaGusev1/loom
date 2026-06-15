// DAG Schema Types (mirrors task-decomposer.md JSON schema)

export interface DAGMeta {
  id: string;
  source: {
    type: 'jira' | 'description';
    jiraKey?: string;
    title: string;
    description: string;
    figmaUrls: string[];
    acceptanceCriteria: string[];
  };
  createdAt: string;
  gitCommit: string;
  branch: string;
  qualityReport: {
    iterations: number;
    checksRun: string[];
    allPassed: boolean;
    details?: Record<string, { passed: boolean; notes: string }>;
  };
}

export type FileMediaType = 'json' | 'markdown' | 'yaml' | 'text' | 'typescript' | 'shell' | 'other';

export interface FileOutput {
  kind: 'file';
  path: string;
  mediaType?: FileMediaType;
  description: string;
}

export type ExportKind = 'type' | 'interface' | 'const' | 'function' | 'class' | 'component';

export interface ExportOutput {
  kind: 'export';
  file: string;
  exportName: string;
  exportKind: ExportKind;
  description: string;
}

export interface BehavioralOutput {
  kind: 'behavioral';
  description: string;
}

export type ContractOutput = FileOutput | ExportOutput | BehavioralOutput;

export const isFileOutput = (o: ContractOutput): o is FileOutput => o.kind === 'file';
export const isExportOutput = (o: ContractOutput): o is ExportOutput => o.kind === 'export';

export interface TaskContracts {
  inputs: Record<string, { type?: string; source: string }>;
  outputs: Record<string, ContractOutput>;
}

export interface FigmaRef {
  nodeId?: string;
  url?: string;
  hints?: string[];
}

export interface TaskContext {
  files: string[];
  figmaRef?: FigmaRef;
  layoutSpec?: string;
  figmaTokens?: Record<string, string>;
  conventions?: string[];
  relatedPatterns?: Array<{ file: string; relevance: string }>;
}

export interface CompletionCriteria {
  automated: string[];
  manual: string[];
}

export interface DAGTask {
  id: string;
  name: string;
  description: string;
  dependencies: string[];
  contracts: TaskContracts;
  context: TaskContext;
  completionCriteria: CompletionCriteria;
  estimatedScope: 'single-component' | 'multi-file' | 'cross-module';
  weight: 'trivial' | 'standard' | 'heavy';
}

export interface ExecutionLayer {
  layer: number;
  description: string;
  taskIds: string[];
}

export interface DecompositionDAG {
  meta: DAGMeta;
  tasks: DAGTask[];
  executionLayers: ExecutionLayer[];
}

// Execution State Types

export type TaskStatus = 'pending' | 'in-progress' | 'completed' | 'failed';
export type ExecutionStatus = 'running' | 'paused' | 'completed' | 'failed';

export interface TaskUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
  numTurns: number;
  durationMs: number;
  durationApiMs: number;
}

export interface TaskState {
  status: TaskStatus;
  startedAt?: string;
  completedAt?: string;
  worktreePath?: string;
  worktreeBranch?: string;
  filesModified?: string[];
  error?: string;
  usage?: TaskUsage;
  /** Set once the task's worktree has been merged into the base branch. */
  merged?: boolean;
}

export interface LayerState {
  startedAt: string | null;
  completedAt: string | null;
  taskCount: number;
}

export interface ExecutionState {
  dagPath: string;
  status: ExecutionStatus;
  startedAt: string;
  completedAt?: string;
  currentLayer: number;
  config: ExecutorConfig;
  layers: Record<string, LayerState>;
  tasks: Record<string, TaskState>;
  /** Marks a state.json written by saveState as a derived cache artifact. */
  derived?: true;
}

// Configuration

export interface ExecutorConfig {
  provider: 'codex' | 'claude';
  defaultModel: string;
  heavyModel: string;
  maxTurns: number;
  permissionMode: 'bypassPermissions';
  dagPath: string;
  dryRun: boolean;
  forceWorktreeResetTaskIds?: string[];
  /** CLI/config overrides for verification commands (always win over detection). */
  verifyCommands?: { test?: string; lint?: string; typecheck?: string };
  /** `--no-verify` — disables both verification tiers entirely. */
  disableVerification?: boolean;
}

export interface ExecuteOptions {
  dag: DecompositionDAG;
  config: ExecutorConfig;
  signal?: AbortSignal;
  resume?: boolean;
  rerunTaskIds?: string[];
}

// Contract Verification

export interface BrokenContract {
  taskId: string;
  inputName: string;
  expectedFrom: string;
  outputName: string;
  outputType: string;
  reason: string;
}

export interface ContractVerificationResult {
  passed: boolean;
  brokenContracts: BrokenContract[];
}

export { WEIGHT_MAX_TURNS, WEIGHT_DEADLINE_MS } from './consts.js';
