import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

export interface SupervisorQueueItem {
  id: string;
  dagPath: string;
  status: 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'canceled';
  priority: number;
  createdAt?: string;
  updatedAt?: string;
  supervisorPid?: number;
}

export interface SupervisorQueue {
  schemaVersion: 1;
  updatedAt: string;
  items: SupervisorQueueItem[];
}

export const defaultSupervisorQueuePath = (projectPath: string): string =>
  join(projectPath, '.loom-supervisor', 'queue.json');

export const readSupervisorQueue = (queuePath: string): SupervisorQueue => {
  if (!existsSync(queuePath)) return { schemaVersion: 1, updatedAt: '', items: [] };
  const value = JSON.parse(readFileSync(queuePath, 'utf-8')) as Partial<SupervisorQueue>;
  if (value.schemaVersion !== 1 || !Array.isArray(value.items))
    throw new Error(`Invalid supervisor queue at ${queuePath}`);
  for (const item of value.items) {
    if (!item || typeof item.id !== 'string' || typeof item.dagPath !== 'string' || typeof item.priority !== 'number') {
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
    return readSupervisorQueue(this.queuePath).items;
  }

  async add(dagPath: string, priority = 0): Promise<void> {
    await execFileAsync(
      process.execPath,
      [this.supervisorScript, '--queue-add', resolve(dagPath), `--priority=${priority}`, `--queue=${this.queuePath}`],
      { cwd: this.projectPath },
    );
    try {
      await execFileAsync(
        process.execPath,
        [this.supervisorScript, '--queue-run', '--detach', `--queue=${this.queuePath}`],
        { cwd: this.projectPath },
      );
    } catch (error) {
      if (!isAlreadyRunning(error)) throw error;
    }
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
