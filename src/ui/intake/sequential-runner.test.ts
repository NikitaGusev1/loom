import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCheckpoint, readRunLogTail, writeCheckpoint } from './persistence.js';
import { SequentialRunner } from './sequential-runner.js';
import type { SequentialProvider } from './types.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sequential-runner-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const waitFor = async (predicate: () => boolean): Promise<void> => {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out');
};

describe('SequentialRunner', () => {
  it('runs FIFO, records progress, and redacts logs', async () => {
    const order: string[] = [];
    const provider: SequentialProvider = {
      run: async ({ planPath, onOutput }) => {
        order.push(planPath);
        onOutput('Implement TOKEN=secret-value');
      },
    };
    let id = 0;
    const runner = new SequentialRunner(
      dir,
      provider,
      () => '2026-07-11T00:00:00.000Z',
      () => `run-${++id}`,
    );
    const first = runner.enqueue('todo-1', 1, 'plan-1');
    const second = runner.enqueue('todo-2', 1, 'plan-2');
    await waitFor(() => readCheckpoint(dir, second.id).status === 'completed');
    assert.deepEqual(order, ['plan-1', 'plan-2']);
    assert.match(readRunLogTail(dir, first.id)[0], /\[REDACTED\]/);
  });

  it('deduplicates a proposal revision', () => {
    const provider: SequentialProvider = { run: async () => {} };
    const runner = new SequentialRunner(dir, provider, undefined, () => 'run-1');
    const first = runner.enqueue('todo-1', 2, 'plan');
    const second = runner.enqueue('todo-1', 2, 'plan');
    assert.equal(second.id, first.id);
  });

  it('recovers a persisted queued run', async () => {
    const provider: SequentialProvider = { run: async () => {} };
    const pending = {
      schemaVersion: 1 as const,
      id: 'run-recover',
      itemId: 'todo-1',
      proposalRevision: 1,
      mode: 'sequential' as const,
      status: 'queued' as const,
      phase: 'plan' as const,
      createdAt: 'now',
      updatedAt: 'now',
      startedAt: null,
      completedAt: null,
      planPath: 'plan',
      logPath: 'log',
      provider: 'codex' as const,
      model: 'account-default',
      pid: null,
      baseCommit: null,
      terminalCommit: null,
      changedFiles: [],
      verification: null,
      reviewVerdict: null,
      error: null,
      recoveryRequired: false,
    };
    writeCheckpoint(dir, pending);
    const recovered = new SequentialRunner(dir, provider);
    recovered.recover();
    await waitFor(() => readCheckpoint(dir, pending.id).status === 'completed');
    recovered.stop();
  });
});
