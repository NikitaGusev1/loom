import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInboxItem, readInbox } from '../inbox.js';
import { SequentialRunner } from './sequential-runner.js';
import { IntakeService } from './service.js';
import { addIntakeJob, updateInboxItem } from './persistence.js';
import type { DagPlanner } from './dag-planner.js';
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
    const updated = readInbox(dir).items[0];
    assert.equal(updated.linkedRunId, undefined);
    assert.equal(updated.clarificationMessages?.[0].content, 'What is it?');
    service.stop();
  });

  it('persists one answer per revision without changing the todo body', async () => {
    let calls = 0;
    const prompts: string[] = [];
    const provider: TriageProvider = {
      triage: async (prompt) => {
        prompts.push(prompt);
        calls += 1;
        return calls === 1
          ? triageValue({ needsClarification: true, proposedAction: 'clarify', questions: ['Which surface?'] })
          : triageValue({ risk: 'elevated' });
      },
    };
    const item = createInboxItem(dir, 'Improve intake');
    const service = new IntakeService(dir, provider);
    service.enqueueTriage(item.id);
    await waitFor(() => readInbox(dir).items[0].intakeStatus === 'awaiting-clarification');
    service.clarify(item.id, 1, 'The web UI');
    assert.throws(() => service.clarify(item.id, 1, 'Duplicate'), /no longer awaiting clarification/);
    await waitFor(() => readInbox(dir).items[0].intakeStatus === 'awaiting-approval');
    const updated = readInbox(dir).items[0];
    assert.equal(updated.body, 'Improve intake');
    assert.equal(updated.clarificationRounds, 1);
    assert.equal(updated.clarificationMessages?.filter((message) => message.role === 'user').length, 1);
    assert.match(prompts[1], /The web UI/);
    service.stop();
  });

  it('links a DAG proposal when clarification is exhausted', async () => {
    let resolvePlanner!: () => void;
    let plannerStarted = false;
    const planner: DagPlanner = {
      propose: async () => {
        plannerStarted = true;
        await new Promise<void>((resolve) => {
          resolvePlanner = resolve;
        });
        return { planPath: `${dir}/plan.md`, dagPath: `${dir}/dag.json` };
      },
    };
    const provider: TriageProvider = {
      triage: async () =>
        triageValue({ needsClarification: true, proposedAction: 'clarify', questions: ['One more detail?'] }),
    };
    const item = createInboxItem(dir, 'Ambiguous feature');
    updateInboxItem(dir, item.id, (value) => ({ ...value, clarificationRounds: 3 }));
    const service = new IntakeService(dir, provider, undefined, undefined, undefined, planner);
    service.enqueueTriage(item.id);
    await waitFor(() => plannerStarted);
    const planning = readInbox(dir).items[0];
    assert.equal(planning.intakeStatus, 'triaging');
    assert.equal(planning.approval, null);
    assert.equal(planning.linkedDagPath, null);
    resolvePlanner();
    await waitFor(() => Boolean(readInbox(dir).items[0].linkedDagPath));
    const updated = readInbox(dir).items[0];
    assert.equal(updated.intakeStatus, 'awaiting-approval');
    assert.equal(updated.triage?.proposedAction, 'propose-dag');
    assert.equal(updated.linkedDagPath, `${dir}/dag.json`);
    assert.equal(updated.clarificationMessages, undefined);
    service.stop();
  });

  it('persists a rationale fallback when triage omits its question', async () => {
    const provider: TriageProvider = {
      triage: async () =>
        triageValue({
          needsClarification: true,
          proposedAction: 'clarify',
          questions: [],
          rationale: 'the target view is unclear.',
        }),
    };
    const item = createInboxItem(dir, 'Improve this');
    const service = new IntakeService(dir, provider);
    service.enqueueTriage(item.id);
    await waitFor(() => readInbox(dir).items[0].intakeStatus === 'awaiting-clarification');
    assert.equal(
      readInbox(dir).items[0].clarificationMessages?.[0].content,
      'Could you clarify: the target view is unclear?',
    );
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

  it('deduplicates repeated triage requests and recovered questions for the same revision', async () => {
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
    assert.equal(readInbox(dir).items[0].clarificationMessages?.filter((message) => message.role === 'loom').length, 1);
    service.stop();

    updateInboxItem(dir, item.id, (value) => ({ ...value, intakeStatus: 'triaging' }));
    addIntakeJob(dir, {
      id: 'job-recovered',
      itemId: item.id,
      kind: 'triage',
      status: 'queued',
      proposalRevision: 1,
      idempotencyKey: `${item.id}:1:triage-recovery`,
      createdAt: '2026-07-11T00:00:00.000Z',
      updatedAt: '2026-07-11T00:00:00.000Z',
      ownerPid: null,
      leaseAt: null,
      attempts: 0,
      error: null,
    });
    const recovered = new IntakeService(dir, provider);
    recovered.start();
    await waitFor(() => readInbox(dir).jobs.some((job) => job.id === 'job-recovered' && job.status === 'completed'));
    assert.equal(readInbox(dir).items[0].clarificationMessages?.filter((message) => message.role === 'loom').length, 1);
    recovered.stop();
  });
});
