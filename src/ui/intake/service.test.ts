import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInboxItem, readInbox } from '../inbox.js';
import { SequentialRunner } from './sequential-runner.js';
import { IntakeService } from './service.js';
import type { SequentialProvider, TriageProvider } from './types.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'intake-service-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const waitFor = async (predicate: () => boolean): Promise<void> => {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out');
};

const triageValue = (patch: Record<string, unknown> = {}) => ({
  version: 1,
  status: 'complete',
  relevance: 'relevant',
  complexity: 'small',
  risk: 'low',
  confidence: 0.9,
  summary: 'Fix copy',
  rationale: 'Narrow',
  needsClarification: false,
  questions: [],
  estimatedFiles: [],
  proposedAction: 'execute-sequential',
  evaluatedAt: '2026-07-11T00:00:00.000Z',
  proposalRevision: 1,
  ...patch,
});

describe('IntakeService', () => {
  it('persists before asynchronous triage and holds ambiguity', async () => {
    let release!: () => void;
    const provider: TriageProvider = {
      triage: () =>
        new Promise((resolve) => {
          release = () =>
            resolve(triageValue({ needsClarification: true, proposedAction: 'clarify', questions: ['What is it?'] }));
        }),
    };
    const item = createInboxItem(dir, 'move it to done');
    const service = new IntakeService(dir, provider);
    service.enqueueTriage(item.id);
    assert.equal(readInbox(dir).items[0].intakeStatus, 'triaging');
    await waitFor(() => typeof release === 'function');
    release();
    await waitFor(() => readInbox(dir).items[0].intakeStatus === 'awaiting-clarification');
    assert.equal(readInbox(dir).items[0].linkedRunId, undefined);
    service.stop();
  });

  it('routes qualifying work to a sequential run without a DAG link', async () => {
    const triageProvider: TriageProvider = { triage: async () => triageValue() };
    const sequentialProvider: SequentialProvider = { run: async ({ onOutput }) => onOutput('Implement complete') };
    const runner = new SequentialRunner(dir, sequentialProvider);
    const item = createInboxItem(dir, 'Fix a typo');
    const service = new IntakeService(dir, triageProvider, runner);
    service.enqueueTriage(item.id);
    await waitFor(() => Boolean(readInbox(dir).items[0].linkedRunId));
    const updated = readInbox(dir).items[0];
    assert.equal(updated.executionMode, 'sequential');
    assert.equal(updated.linkedDagPath, null);
    assert.match(updated.linkedPlanPath ?? '', /\.plan\.md$/);
    service.stop();
  });

  it('aborts triage cancellation without a late status overwrite', async () => {
    let signal: AbortSignal | undefined;
    const provider: TriageProvider = {
      triage: (_prompt, nextSignal) =>
        new Promise((_resolve, reject) => {
          signal = nextSignal;
          nextSignal?.addEventListener('abort', () => reject(nextSignal.reason));
        }),
    };
    const item = createInboxItem(dir, 'Cancel this');
    const service = new IntakeService(dir, provider);
    service.enqueueTriage(item.id);
    await waitFor(() => Boolean(signal));
    await service.cancel(item.id);
    await waitFor(() => signal?.aborted === true);
    assert.equal(readInbox(dir).items[0].intakeStatus, 'cancelled');
    service.stop();
  });

  it('deduplicates repeated triage requests for the same revision', async () => {
    let calls = 0;
    const provider: TriageProvider = {
      triage: async () => {
        calls += 1;
        return triageValue({ needsClarification: true, proposedAction: 'clarify' });
      },
    };
    const item = createInboxItem(dir, 'Ambiguous');
    const service = new IntakeService(dir, provider);
    service.enqueueTriage(item.id);
    service.enqueueTriage(item.id);
    await waitFor(() => readInbox(dir).items[0].intakeStatus === 'awaiting-clarification');
    assert.equal(calls, 1);
    service.stop();
  });
});
