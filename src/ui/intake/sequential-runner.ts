import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runCodexCli } from '../../codex-cli.js';
import { isPidAlive } from '../../pid.js';
import { appendRunLog, getRunLogPath, listCheckpoints, readCheckpoint, writeCheckpoint } from './persistence.js';
import { redactIntakeOutput } from './redaction.js';
import type { SequentialProvider, UiSequentialCheckpoint, UiSequentialPhase } from './types.js';

interface QueueEntry {
  checkpoint: UiSequentialCheckpoint;
  controller: AbortController;
}

const git = (cwd: string, args: string[]): string | null => {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
};

const phaseFromOutput = (line: string, current: UiSequentialPhase): UiSequentialPhase => {
  const phases: UiSequentialPhase[] = ['triage', 'plan', 'implement', 'verify', 'review', 'done'];
  let proposed = current;
  if (/review/i.test(line)) proposed = 'review';
  else if (/verif|test|typecheck|lint/i.test(line)) proposed = 'verify';
  else if (/implement|edit|write/i.test(line)) proposed = 'implement';
  return phases.indexOf(proposed) > phases.indexOf(current) ? proposed : current;
};

const hasProjectChanges = (projectPath: string): boolean => {
  const status = git(projectPath, ['status', '--porcelain', '--untracked-files=all']) ?? '';
  return status.split('\n').some((line) => line && !line.slice(3).startsWith('.dag-executor/'));
};

export class CodexSequentialProvider implements SequentialProvider {
  async run(options: {
    projectPath: string;
    planPath: string;
    signal: AbortSignal;
    onOutput: (line: string) => void;
  }): Promise<void> {
    const prompt = `Use the loom:auto-implement skill to execute this approved plan sequentially: ${options.planPath}. Force --no-dag --inline --mode autonomous. Complete implementation, verification, and review.`;
    await runCodexCli(prompt, {
      model: 'gpt-5.6-terra',
      reasoningEffort: 'medium',
      cwd: options.projectPath,
      signal: options.signal,
      onOutput: options.onOutput,
    });
  }
}

export class SequentialRunner {
  private queue: QueueEntry[] = [];
  private active: QueueEntry | null = null;

  constructor(
    private readonly projectPath: string,
    private readonly provider: SequentialProvider = new CodexSequentialProvider(),
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly id: () => string = () => `run-${randomUUID()}`,
  ) {}

  recover(): void {
    for (const checkpoint of listCheckpoints(this.projectPath)) {
      if (checkpoint.status === 'queued' && !this.queue.some((entry) => entry.checkpoint.id === checkpoint.id)) {
        this.queue.push({ checkpoint, controller: new AbortController() });
      } else if (checkpoint.status === 'running') {
        this.patch(checkpoint, {
          status: 'blocked',
          completedAt: this.now(),
          error: 'Runner process ended before a terminal checkpoint',
          recoveryRequired: hasProjectChanges(this.projectPath),
        });
      }
    }
    this.pump();
  }

  enqueue(itemId: string, proposalRevision: number, planPath: string): UiSequentialCheckpoint {
    const existing = listCheckpoints(this.projectPath).find(
      (run) => run.itemId === itemId && run.proposalRevision === proposalRevision,
    );
    if (existing) return existing;
    const ts = this.now();
    const runId = this.id();
    const checkpoint: UiSequentialCheckpoint = {
      schemaVersion: 1,
      id: runId,
      itemId,
      proposalRevision,
      mode: 'sequential',
      status: 'queued',
      phase: 'plan',
      createdAt: ts,
      updatedAt: ts,
      startedAt: null,
      completedAt: null,
      planPath,
      logPath: getRunLogPath(this.projectPath, runId),
      provider: 'codex',
      model: 'gpt-5.6-terra',
      pid: null,
      baseCommit: git(this.projectPath, ['rev-parse', 'HEAD']),
      terminalCommit: null,
      changedFiles: [],
      verification: null,
      reviewVerdict: null,
      error: null,
      recoveryRequired: false,
    };
    writeCheckpoint(this.projectPath, checkpoint);
    this.queue.push({ checkpoint, controller: new AbortController() });
    this.pump();
    return checkpoint;
  }

  cancel(runId: string): UiSequentialCheckpoint {
    if (this.active?.checkpoint.id === runId) {
      this.active.controller.abort(new Error('Cancelled by user'));
      return this.active.checkpoint;
    }
    const index = this.queue.findIndex((entry) => entry.checkpoint.id === runId);
    if (index < 0) throw new Error(`Sequential run "${runId}" not found`);
    const [entry] = this.queue.splice(index, 1);
    entry.checkpoint = this.patch(entry.checkpoint, {
      status: 'cancelled',
      completedAt: this.now(),
      error: 'Cancelled by user',
    });
    return entry.checkpoint;
  }

  stop(): void {
    this.active?.controller.abort(new Error('UI server shutting down'));
    for (const entry of this.queue) {
      entry.checkpoint = this.patch(entry.checkpoint, {
        status: 'cancelled',
        completedAt: this.now(),
        error: 'UI server shutting down',
      });
    }
    this.queue = [];
  }

  private patch(checkpoint: UiSequentialCheckpoint, patch: Partial<UiSequentialCheckpoint>): UiSequentialCheckpoint {
    const next = { ...checkpoint, ...patch, updatedAt: this.now() };
    writeCheckpoint(this.projectPath, next);
    return next;
  }

  private pump(): void {
    if (this.active || this.queue.length === 0) return;
    const releaseLease = this.acquireLease();
    if (!releaseLease) {
      setTimeout(() => this.pump(), 1_000).unref();
      return;
    }
    this.active = this.queue.shift() ?? null;
    if (!this.active) {
      releaseLease();
      return;
    }
    const latest = readCheckpoint(this.projectPath, this.active.checkpoint.id);
    if (latest.status !== 'queued') {
      this.active = null;
      releaseLease();
      this.pump();
      return;
    }
    this.active.checkpoint = latest;
    void this.execute(this.active).finally(() => {
      releaseLease();
      this.active = null;
      this.pump();
    });
  }

  private acquireLease(): (() => void) | null {
    const path = join(this.projectPath, '.dag-executor', 'intake', 'sequential.lock');
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) {
      try {
        const existing = JSON.parse(readFileSync(path, 'utf-8')) as { pid?: number };
        if (typeof existing.pid === 'number' && isPidAlive(existing.pid)) return null;
        unlinkSync(path);
      } catch {
        // Another process may still be filling a newly-created lock file.
        return null;
      }
    }
    try {
      const fd = openSync(path, 'wx');
      writeFileSync(fd, JSON.stringify({ pid: process.pid, acquiredAt: this.now() }));
      closeSync(fd);
      return () => {
        try {
          unlinkSync(path);
        } catch {
          // Already released or reclaimed.
        }
      };
    } catch {
      return null;
    }
  }

  private async execute(entry: QueueEntry): Promise<void> {
    const started = this.now();
    entry.checkpoint = this.patch(entry.checkpoint, { status: 'running', phase: 'implement', startedAt: started });
    try {
      await this.provider.run({
        projectPath: this.projectPath,
        planPath: entry.checkpoint.planPath,
        signal: entry.controller.signal,
        onOutput: (raw) => {
          const line = redactIntakeOutput(raw);
          appendRunLog(this.projectPath, entry.checkpoint.id, line);
          const phase = phaseFromOutput(line, entry.checkpoint.phase);
          if (phase !== entry.checkpoint.phase) entry.checkpoint = this.patch(entry.checkpoint, { phase });
        },
      });
      const changedFiles = (
        git(this.projectPath, ['diff', '--name-only', entry.checkpoint.baseCommit ?? 'HEAD', 'HEAD']) ?? ''
      )
        .split('\n')
        .filter(Boolean);
      entry.checkpoint = this.patch(entry.checkpoint, {
        status: 'completed',
        phase: 'done',
        completedAt: this.now(),
        terminalCommit: git(this.projectPath, ['rev-parse', 'HEAD']),
        changedFiles,
        verification: 'passed',
        reviewVerdict: 'complete',
      });
    } catch (error) {
      const cancelled = entry.controller.signal.aborted;
      const dirty = hasProjectChanges(this.projectPath);
      entry.checkpoint = this.patch(entry.checkpoint, {
        status: cancelled ? 'cancelled' : 'failed',
        completedAt: this.now(),
        error: error instanceof Error ? error.message : String(error),
        recoveryRequired: dirty,
      });
    }
  }
}
