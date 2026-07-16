import { existsSync, readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import type {
  SupervisorCheckpointReadResult,
  SupervisorQueueItem,
  UiDagTaskProgress,
  UiRunStatus,
  UiSupervisorCheckpoint,
} from './types.js';

const MAX_DIAGNOSTICS = 4;
const MAX_DIAGNOSTIC_LENGTH = 240;
const SAFE_QUEUE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface ReadSupervisorCheckpointOptions {
  /** Root of the registered project. Defaults to queueItem.projectPath. */
  projectPath?: string;
  /** Allows callers and tests to provide an already-loaded checkpoint. */
  checkpoint?: unknown;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function string(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function diagnostic(target: string[], message: string): void {
  if (target.length < MAX_DIAGNOSTICS) target.push(message.slice(0, MAX_DIAGNOSTIC_LENGTH));
}

function isContained(projectPath: string, candidate: string): boolean {
  const root = resolve(projectPath);
  const resolved = resolve(root, candidate);
  const pathToCandidate = relative(root, resolved);
  return (
    pathToCandidate === '' ||
    (!pathToCandidate.startsWith('..') && !pathToCandidate.includes(`..${String.fromCharCode(47)}`))
  );
}

function artifactValue(queueItem: SupervisorQueueItem): unknown {
  const artifacts = queueItem.executionArtifacts;
  if (!isRecord(artifacts) || !SAFE_QUEUE_ID.test(queueItem.id)) return undefined;
  return artifacts[queueItem.id];
}

function artifactPath(queueItem: SupervisorQueueItem): string | null {
  const artifact = artifactValue(queueItem);
  if (typeof artifact === 'string') return artifact;
  if (isRecord(artifact)) return string(artifact.checkpointPath) ?? string(artifact.path);
  return string(queueItem.checkpointPath);
}

function artifactCheckpoint(queueItem: SupervisorQueueItem): unknown {
  const artifact = artifactValue(queueItem);
  if (isRecord(artifact) && 'checkpoint' in artifact) return artifact.checkpoint;
  return queueItem.checkpoint;
}

/** Maps supervisor/DAG spellings to the lifecycle vocabulary used by the UI. */
export function projectDagExecutionStatus(status: unknown): UiRunStatus {
  switch (typeof status === 'string' ? status.trim().toLowerCase() : '') {
    case 'queued':
    case 'pending':
    case 'waiting':
    case 'created':
      return 'queued';
    case 'running':
    case 'in_progress':
    case 'in-progress':
    case 'active':
      return 'running';
    case 'completed':
    case 'complete':
    case 'succeeded':
    case 'success':
      return 'completed';
    case 'failed':
    case 'error':
      return 'failed';
    case 'blocked':
    case 'paused':
    case 'needs_attention':
      return 'blocked';
    case 'cancelled':
    case 'canceled':
    case 'aborted':
      return 'cancelled';
    default:
      return 'queued';
  }
}

function taskProgress(checkpoint: UnknownRecord): UiDagTaskProgress {
  const tasks = Array.isArray(checkpoint.tasks) ? checkpoint.tasks : null;
  const total = number(checkpoint.totalTasks) ?? tasks?.length ?? 0;
  const completed =
    number(checkpoint.completedTasks) ??
    tasks?.filter((task) => isRecord(task) && projectDagExecutionStatus(task.status) === 'completed').length ??
    0;
  return { completed: Math.max(0, Math.min(completed, total)), total: Math.max(0, total) };
}

function parseCheckpoint(value: unknown, diagnostics: string[]): UiSupervisorCheckpoint | null {
  if (!isRecord(value)) {
    diagnostic(diagnostics, 'Checkpoint is missing or is not an object.');
    return null;
  }
  const id = string(value.id) ?? string(value.runId);
  if (!id) {
    diagnostic(diagnostics, 'Checkpoint is missing its run ID.');
    return null;
  }
  const pr = isRecord(value.pullRequest) ? value.pullRequest : isRecord(value.pr) ? value.pr : null;
  return {
    id,
    status: projectDagExecutionStatus(value.status),
    createdAt: string(value.createdAt),
    updatedAt: string(value.updatedAt),
    dagPath: string(value.dagPath) ?? string(value.definitionPath),
    taskProgress: taskProgress(value),
    pullRequest: pr
      ? { number: number(pr.number), url: string(pr.url) ?? string(pr.htmlUrl), status: string(pr.status) }
      : null,
  };
}

/**
 * Reads only UI-facing checkpoint fields. File-backed artifacts and source definitions
 * must resolve below the selected registered project; invalid inputs return diagnostics
 * while retaining the queue-derived status.
 */
export function readSupervisorCheckpoint(
  queueItem: SupervisorQueueItem,
  options: ReadSupervisorCheckpointOptions = {},
): SupervisorCheckpointReadResult {
  const diagnostics: string[] = [];
  const queueStatus = projectDagExecutionStatus(queueItem.status);
  const projectPath = options.projectPath ?? queueItem.projectPath;
  const sourceCandidate = string(queueItem.sourceDefinitionPath) ?? string(queueItem.sourcePath);
  let sourcePath: string | null = null;
  let checkpointPath: string | null = null;

  if (!SAFE_QUEUE_ID.test(queueItem.id)) diagnostic(diagnostics, 'Queue item ID is not safe for artifact lookup.');
  if (sourceCandidate) {
    if (!projectPath || !isContained(projectPath, sourceCandidate))
      diagnostic(diagnostics, 'Source definition path is outside the selected project.');
    else sourcePath = resolve(projectPath, sourceCandidate);
  }

  let rawCheckpoint = options.checkpoint ?? artifactCheckpoint(queueItem);
  const candidate = artifactPath(queueItem);
  if (candidate) {
    if (!projectPath || !isContained(projectPath, candidate)) {
      diagnostic(diagnostics, 'Checkpoint path is outside the selected project.');
    } else {
      checkpointPath = resolve(projectPath, candidate);
      if (rawCheckpoint === undefined) {
        if (!existsSync(checkpointPath)) diagnostic(diagnostics, 'Checkpoint file does not exist.');
        else {
          try {
            rawCheckpoint = JSON.parse(readFileSync(checkpointPath, 'utf8')) as unknown;
          } catch {
            diagnostic(diagnostics, 'Checkpoint file could not be parsed.');
          }
        }
      }
    }
  }

  const checkpoint = parseCheckpoint(rawCheckpoint, diagnostics);
  return { checkpoint, status: checkpoint?.status ?? queueStatus, diagnostics, checkpointPath, sourcePath };
}
