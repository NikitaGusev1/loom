import { randomUUID } from 'node:crypto';
import { collectIntakeContext } from './context.js';
import { buildSequentialPlan } from './plan.js';
import {
  acquireIntakeJobLease,
  addIntakeJob,
  readCheckpoint,
  setIntakePolicy,
  updateInboxItem,
  updateIntakeJob,
  writePlan,
} from './persistence.js';
import { decideIntake } from './policy.js';
import { SequentialRunner } from './sequential-runner.js';
import { buildTriagePrompt, CodexTriageProvider, parseTriageResult } from './triage.js';
import { readInbox } from '../inbox.js';
import type { TriageProvider, UiIntakePolicy, UiTriageResult } from './types.js';
import { CodexDagPlanner, type DagPlanner } from './dag-planner.js';
import { SupervisorQueueClient } from '../../supervisor-queue.js';
import { isPidAlive } from '../../pid.js';
import type { IntakeDecision } from './policy.js';

const approvalFor = (decision: IntakeDecision, revision: number, now: string) => {
  if (decision.kind === 'execute-sequential') {
    return { status: 'not-required' as const, proposalRevision: revision, decidedAt: now };
  }
  if (decision.kind === 'awaiting-approval') {
    return { status: 'pending' as const, proposalRevision: revision, decidedAt: null };
  }
  return null;
};

export class IntakeService {
  private stopped = false;
  private triageControllers = new Map<string, AbortController>();
  readonly runner: SequentialRunner;

  constructor(
    readonly projectPath: string,
    private readonly triageProvider: TriageProvider = new CodexTriageProvider(),
    runner?: SequentialRunner,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly id: () => string = () => randomUUID(),
    private readonly dagPlanner: DagPlanner = new CodexDagPlanner(),
    private readonly supervisorQueue: SupervisorQueueClient = new SupervisorQueueClient(projectPath),
  ) {
    this.runner = runner ?? new SequentialRunner(projectPath);
  }

  start(): void {
    const file = readInbox(this.projectPath);
    const recoverableItems = new Set(
      file.jobs
        .filter((job) => job.kind === 'triage' && (job.status === 'queued' || job.status === 'claimed'))
        .map((job) => job.itemId),
    );
    for (const item of file.items) {
      if (item.status === 'open' && !item.intakeStatus && !recoverableItems.has(item.id)) this.enqueueTriage(item.id);
    }
    for (const job of file.jobs) {
      if (
        job.kind === 'triage' &&
        (job.status === 'queued' || (job.status === 'claimed' && !isPidAlive(job.ownerPid ?? 0)))
      ) {
        queueMicrotask(() => void this.processTriage(job.id, job.itemId, job.proposalRevision));
      }
    }
    this.runner.recover();
    this.reconcile();
  }

  reconcile(): void {
    const file = readInbox(this.projectPath);
    for (const item of file.items) {
      if (!item.linkedRunId) continue;
      try {
        const checkpoint = readCheckpoint(this.projectPath, item.linkedRunId);
        const intakeStatus = checkpoint.status;
        if (item.intakeStatus === intakeStatus && item.executionCompletedAt === checkpoint.completedAt) continue;
        updateInboxItem(this.projectPath, item.id, (value) => ({
          ...value,
          intakeStatus,
          executionStartedAt: checkpoint.startedAt,
          executionCompletedAt: checkpoint.completedAt,
          lastError: checkpoint.error,
          updatedAt: checkpoint.updatedAt,
        }));
      } catch {
        // A partially-created run is surfaced by its existing item status.
      }
    }
  }

  enqueueTriage(itemId: string): void {
    if (this.stopped) throw new Error('Intake service is stopped');
    const item = readInbox(this.projectPath).items.find((candidate) => candidate.id === itemId);
    if (!item) throw new Error(`Inbox item "${itemId}" not found`);
    const revision = (item.triage?.proposalRevision ?? 0) + 1;
    const jobId = `job-${this.id()}`;
    const ts = this.now();
    const persistedJob = addIntakeJob(this.projectPath, {
      id: jobId,
      itemId,
      kind: 'triage',
      status: 'queued',
      proposalRevision: revision,
      idempotencyKey: `${itemId}:${revision}:triage`,
      createdAt: ts,
      updatedAt: ts,
      ownerPid: null,
      leaseAt: null,
      attempts: 0,
      error: null,
    });
    updateInboxItem(this.projectPath, itemId, (value) => ({
      ...value,
      intakeStatus: 'triaging',
      lastError: null,
      updatedAt: ts,
    }));
    if (persistedJob.id === jobId) queueMicrotask(() => void this.processTriage(jobId, itemId, revision));
  }

  clarify(itemId: string, revision: number, answer: string): void {
    const trimmed = answer.trim();
    if (!trimmed) throw new Error('Clarification answer is required');
    updateInboxItem(
      this.projectPath,
      itemId,
      (item) => ({ ...item, body: `${item.body}\n\nClarification: ${trimmed}`, updatedAt: this.now() }),
      revision,
    );
    this.enqueueTriage(itemId);
  }

  async approve(itemId: string, revision: number): Promise<void> {
    const item = updateInboxItem(
      this.projectPath,
      itemId,
      (value) => ({
        ...value,
        approval: { status: 'approved', proposalRevision: revision, decidedAt: this.now() },
        updatedAt: this.now(),
      }),
      revision,
    );
    if (item.triage?.proposedAction === 'execute-sequential') {
      const context = collectIntakeContext(this.projectPath);
      if (!context.git.isRepository || !context.git.clean) {
        throw new Error('Sequential execution requires a clean git repository');
      }
      this.startSequential(item.id, item.triage);
      return;
    }
    if (item.linkedDagPath) {
      await this.supervisorQueue.add(item.linkedDagPath);
      updateInboxItem(this.projectPath, itemId, (value) => ({
        ...value,
        status: 'converted',
        intakeStatus: 'queued',
        updatedAt: this.now(),
      }));
      return;
    }
    throw new Error('Approved item has no executable proposal');
  }

  async cancel(itemId: string): Promise<void> {
    const item = readInbox(this.projectPath).items.find((candidate) => candidate.id === itemId);
    if (!item) throw new Error(`Inbox item "${itemId}" not found`);
    for (const job of readInbox(this.projectPath).jobs.filter((candidate) => candidate.itemId === itemId)) {
      this.triageControllers.get(job.id)?.abort(new Error('Cancelled by user'));
      if (job.status === 'queued' || job.status === 'claimed') {
        updateIntakeJob(this.projectPath, job.id, (value) => ({
          ...value,
          status: 'cancelled',
          ownerPid: null,
          leaseAt: null,
          updatedAt: this.now(),
          error: 'Cancelled by user',
        }));
      }
    }
    if (item.linkedRunId) this.runner.cancel(item.linkedRunId);
    if (item.linkedDagPath) {
      const queueItem = this.supervisorQueue.list().find((candidate) => candidate.dagPath === item.linkedDagPath);
      if (queueItem) await this.supervisorQueue.cancel(queueItem.id);
    }
    updateInboxItem(this.projectPath, itemId, (value) => ({
      ...value,
      intakeStatus: 'cancelled',
      updatedAt: this.now(),
    }));
  }

  updatePolicy(policy: UiIntakePolicy): UiIntakePolicy {
    return setIntakePolicy(this.projectPath, policy);
  }

  stop(): void {
    this.stopped = true;
    for (const controller of this.triageControllers.values()) controller.abort(new Error('UI server shutting down'));
    this.runner.stop();
  }

  private async processTriage(jobId: string, itemId: string, revision: number): Promise<void> {
    if (this.stopped) return;
    const releaseLease = acquireIntakeJobLease(this.projectPath, jobId);
    if (!releaseLease) return;
    const controller = new AbortController();
    this.triageControllers.set(jobId, controller);
    try {
      const ts = this.now();
      updateIntakeJob(this.projectPath, jobId, (job) => ({
        ...job,
        status: 'claimed',
        ownerPid: process.pid,
        leaseAt: ts,
        attempts: job.attempts + 1,
        updatedAt: ts,
      }));
      const file = readInbox(this.projectPath);
      const item = file.items.find((candidate) => candidate.id === itemId);
      if (!item) throw new Error(`Inbox item "${itemId}" not found`);
      const context = collectIntakeContext(this.projectPath);
      const raw = await this.triageProvider.triage(buildTriagePrompt(item.body, context, revision), controller.signal);
      if (controller.signal.aborted || this.stopped) return;
      const triage = parseTriageResult(raw, revision);
      const decision = decideIntake(triage, file.policy, {
        isGitRepository: context.git.isRepository,
        gitClean: context.git.clean,
        activeMutationLease: false,
        overlappingFiles: [],
        todoBody: item.body,
      });
      const intakeStatus = decision.kind === 'execute-sequential' ? 'queued' : decision.kind;
      updateInboxItem(this.projectPath, itemId, (value) => ({
        ...value,
        triage,
        intakeStatus,
        executionMode: triage.proposedAction === 'propose-dag' ? 'dag' : 'sequential',
        approval: approvalFor(decision, revision, this.now()),
        updatedAt: this.now(),
        lastError: null,
      }));
      if (decision.kind === 'awaiting-approval' && triage.proposedAction === 'propose-dag') {
        const proposal = await this.dagPlanner.propose(this.projectPath, item, triage);
        updateInboxItem(
          this.projectPath,
          itemId,
          (value) => ({
            ...value,
            linkedPlanPath: proposal.planPath,
            linkedDagPath: proposal.dagPath,
            executionMode: 'dag',
            updatedAt: this.now(),
          }),
          revision,
        );
      }
      updateIntakeJob(this.projectPath, jobId, (job) => ({
        ...job,
        status: 'completed',
        ownerPid: null,
        leaseAt: null,
        updatedAt: this.now(),
      }));
      if (decision.kind === 'execute-sequential') this.startSequential(itemId, triage);
    } catch (error) {
      if (controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      updateInboxItem(this.projectPath, itemId, (item) => ({
        ...item,
        intakeStatus: 'failed',
        lastError: message,
        updatedAt: this.now(),
      }));
      updateIntakeJob(this.projectPath, jobId, (job) => ({
        ...job,
        status: 'failed',
        error: message,
        ownerPid: null,
        leaseAt: null,
        updatedAt: this.now(),
      }));
    } finally {
      this.triageControllers.delete(jobId);
      releaseLease();
    }
  }

  private startSequential(itemId: string, triage: UiTriageResult): void {
    const item = readInbox(this.projectPath).items.find((candidate) => candidate.id === itemId);
    if (!item) throw new Error(`Inbox item "${itemId}" not found`);
    const planPath = writePlan(this.projectPath, itemId, buildSequentialPlan(this.projectPath, item, triage));
    const checkpoint = this.runner.enqueue(itemId, triage.proposalRevision, planPath);
    updateInboxItem(this.projectPath, itemId, (value) => ({
      ...value,
      status: 'converted',
      intakeStatus: checkpoint.status === 'running' ? 'running' : 'queued',
      executionMode: 'sequential',
      linkedPlanPath: planPath,
      linkedRunId: checkpoint.id,
      executionStartedAt: checkpoint.startedAt,
      updatedAt: this.now(),
    }));
  }
}
