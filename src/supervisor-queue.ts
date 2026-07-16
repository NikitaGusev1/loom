import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

export interface SupervisorQueueItem {
  /** Stable identity for the queued execution. */
  id: string;
  /** Source DAG definition used by legacy queue records. */
  dagPath: string;
  status: 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'canceled';
  priority: number;
  createdAt?: string;
  updatedAt?: string;
  supervisorPid?: number;
  /** Optional identity supplied by correlated queue records. */
  executionId?: string;
  /** Optional correlation key linking this item to its originating request. */
  correlationId?: string;
  /** Optional source definition retained by correlated queue records. */
  sourceDefinition?: string;
  /**
   * Execution-generated files, keyed by their purpose. Every path is contained
   * within the registered project.
   */
  executionArtifactPaths?: Record<string, string>;
}

export interface SupervisorQueue {
  schemaVersion: 1;
  updatedAt: string;
  items: SupervisorQueueItem[];
}

export const defaultSupervisorQueuePath = (projectPath: string): string =>
  join(projectPath, '.loom-supervisor', 'queue.json');

export const readSupervisorQueue = (queuePath: string, projectPath = dirnameProjectPath(queuePath)): SupervisorQueue => {
  if (!existsSync(queuePath)) return { schemaVersion: 1, updatedAt: '', items: [] };
  const value = JSON.parse(readFileSync(queuePath, 'utf-8')) as Partial<SupervisorQueue>;
  if (value.schemaVersion !== 1 || typeof value.updatedAt !== 'string' || !Array.isArray(value.items))
    throw new Error(`Invalid supervisor queue at ${queuePath}`);
  for (const item of value.items) {
    if (!isValidQueueItem(item, projectPath)) {
      throw new Error(`Invalid supervisor queue item at ${queuePath}`);
    }
  }
  return value as SupervisorQueue;
};

export class SupervisorQueueClient {
  constructor(
    readonly projectPath: string,
    readonly queuePath = defaultSupervisorQueuePath(projectPath),
    private readonly supervisorScript = resolve(
      fileURLToPath(new URL('../scripts/loom-supervisor.cjs', import.meta.url)),
    ),
  ) {}

  list(): SupervisorQueueItem[] {
    return readSupervisorQueue(this.queuePath, this.projectPath).items;
  }

  async add(dagPath: string, priority = 0): Promise<SupervisorQueueItem> {
    const persistedIds = new Set(this.list().map(({ id }) => id));
    const resolvedDagPath = resolve(dagPath);
    await execFileAsync(
      process.execPath,
      [this.supervisorScript, '--queue-add', resolvedDagPath, `--priority=${priority}`, `--queue=${this.queuePath}`],
      { cwd: this.projectPath },
    );
    const added = this.list().filter((item) => !persistedIds.has(item.id));
    if (added.length !== 1) {
      throw new Error(`Queue add did not persist exactly one item at ${this.queuePath}`);
    }
    const item = added[0];
    try {
      await execFileAsync(
        process.execPath,
        [this.supervisorScript, '--queue-run', '--detach', `--queue=${this.queuePath}`],
        { cwd: this.projectPath },
      );
    } catch (error) {
      if (!isAlreadyRunning(error)) throw error;
    }
    return item;
  }

  async cancel(itemId: string): Promise<void> {
    await execFileAsync(
      process.execPath,
      [this.supervisorScript, '--queue-cancel', itemId, `--queue=${this.queuePath}`],
      { cwd: this.projectPath },
    );
  }
}

const isAlreadyRunning = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 4;

const validStatuses = new Set<SupervisorQueueItem['status']>([
  'queued',
  'running',
  'paused',
  'completed',
  'failed',
  'canceled',
]);

const dirnameProjectPath = (queuePath: string): string => resolve(queuePath, '..', '..');

const isValidQueueItem = (item: unknown, projectPath: string): item is SupervisorQueueItem => {
  if (!isRecord(item) || typeof item.id !== 'string' || item.id.length === 0 || typeof item.dagPath !== 'string' || item.dagPath.length === 0 ||
    !validStatuses.has(item.status as SupervisorQueueItem['status']) || !Number.isFinite(item.priority)) {
    return false;
  }
  if (!optionalString(item.createdAt) || !optionalString(item.updatedAt) ||
    !optionalNumber(item.supervisorPid) || !optionalString(item.executionId) ||
    !optionalString(item.correlationId) || !optionalString(item.sourceDefinition)) {
    return false;
  }
  return isIsolatedArtifactPaths(item.executionArtifactPaths, projectPath);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const optionalString = (value: unknown): boolean => value === undefined || (typeof value === 'string' && value.length > 0);
const optionalNumber = (value: unknown): boolean => value === undefined || (typeof value === 'number' && Number.isFinite(value));

const isIsolatedArtifactPaths = (value: unknown, projectPath: string): boolean => {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return Object.entries(value).every(([name, path]) =>
    name.length > 0 && typeof path === 'string' && path.length > 0 && isPathInsideProject(path, projectPath),
  );
};

const isPathInsideProject = (path: string, projectPath: string): boolean => {
  const projectRoot = resolve(projectPath);
  const artifactPath = resolve(projectRoot, path);
  const pathToArtifact = relative(projectRoot, artifactPath);
  return pathToArtifact !== '' && !pathToArtifact.startsWith('..') &&
    !pathToArtifact.includes(`..${process.platform === 'win32' ? '\\' : '/'}`);
};
