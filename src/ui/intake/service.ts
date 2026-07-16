import { randomUUID } from 'node:crypto';
import { collectIntakeContext } from './context.js';
import { buildSequentialPlan } from './plan.js';
import {
  acquireIntakeJobLease,
  readCheckpoint,
  setIntakePolicy,
  StaleProposalError,
  updateInboxFile,
  updateInboxItem,
  updateIntakeJob,
  writePlan,
} from './persistence.js';
import { decideIntake } from './policy.js';
import { SequentialRunner } from './sequential-runner.js';
import { buildTriagePrompt, CodexTriageProvider, parseTriageResult } from './triage.js';
import { readInbox } from '../inbox.js';
import type { TriageProvider, UiIntakeJob, UiIntakePolicy, UiTriageResult } from './types.js';
import { CodexDagPlanner, type DagPlanner } from './dag-planner.js';
import { SupervisorQueueClient } from '../../supervisor-queue.js';
import { isPidAlive } from '../../pid.js';
import type { IntakeDecision } from './policy.js';

type CorrelatedQueueItem = {
  id: string;
  sourceItemId?: string | null;
  proposalRevision?: number | null;
  runId?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  updatedAt?: string | null;
  error?: string | null;
  status?: string | null;
  pullRequest?: { status?: string | null } | null;
};

type CorrelatedSupervisorQueue = {
  add: ((...args: unknown[]) => Promise<CorrelatedQueueItem | void>) & {
    length: number;
  };
  list: () => CorrelatedQueueItem[];
  cancel: (id: string) => Promise<void>;
};

type ProposalCorrelation = {
  sourceItemId: string;
  proposalRevision: number;
};

const actionableError = (prefix: string, error: unknown): string => {
  const detail = error instanceof Error ? error.message : String(error);
  return `${prefix}: ${detail}`.slice(0, 500);
};

const matchesCorrelation = (queueItem: CorrelatedQueueItem, itemId: string, revision: number): boolean =>
  queueItem.sourceItemId === itemId && queueItem.proposalRevision === revision;

const proposalCorrelation = (item: {
  id: string;
  triage?: { proposalRevision: number } | null;
  proposal?: Partial<ProposalCorrelation> | null;
}): ProposalCorrelation | null => {
  const proposalRevision = item.proposal?.proposalRevision ?? item.triage?.proposalRevision;
  if (proposalRevision === undefined) return null;
  return { sourceItemId: item.proposal?.sourceItemId ?? item.id, proposalRevision };
};

const enqueueCorrelated = async (
  queue: CorrelatedSupervisorQueue,
  dagPath: string,
  correlation: ProposalCorrelation,
): Promise<CorrelatedQueueItem> => {
  const added =
    queue.add.length >= 3
      ? await queue.add(dagPath, correlation.sourceItemId, correlation.proposalRevision)
      : await queue.add(dagPath, correlation);
  const queueItem =
    added ??
    queue
      .list()
      .find((candidate) => matchesCorrelation(candidate, correlation.sourceItemId, correlation.proposalRevision));
  if (!queueItem || !matchesCorrelation(queueItem, correlation.sourceItemId, correlation.proposalRevision)) {
    throw new Error('Supervisor queue did not preserve the approved item and proposal revision correlation');
  }
  return queueItem;
};

const statusProjection = (
  queueItem: CorrelatedQueueItem,
): 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | null => {
  if (queueItem.pullRequest?.status === 'merged') return 'completed';
  if (queueItem.pullRequest?.status === 'closed') return 'failed';
  if (queueItem.pullRequest?.status) return 'running';
  switch (queueItem.status) {
    case 'queued':
    case 'running':
    case 'completed':
    case 'failed':
    case 'cancelled':
      return queueItem.status;
    default:
      return null;
  }
};

const approvalFor = (decision: IntakeDecision, revision: number, now: string) => {
  if (decision.kind === 'execute-sequential') {
    return { status: 'not-required' as const, proposalRevision: revision, decidedAt: now };
  }
  if (decision.kind === 'awaiting-approval') {
    return { status: 'pending' as const, proposalRevision: revision, decidedAt: null };
  }
  return null;
};

const clarificationQuestion = (triage: UiTriageResult): string => {
  const explicit = triage.questions[0]?.trim();
  if (explicit) return explicit;
  const rationale = triage.rationale.trim().replace(/[.?!]+$/, '');
  return `Could you clarify: ${rationale || 'what outcome should Loom target'}?`;
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
    let queueItems: CorrelatedQueueItem[];
    try {
      queueItems = (this.supervisorQueue as unknown as CorrelatedSupervisorQueue).list();
    } catch {
      queueItems = [];
    }
    for (const item of file.items) {
      const correlation = proposalCorrelation(item);
      const linkedQueueItemId = (item as typeof item & { linkedQueueItemId?: string | null }).linkedQueueItemId;
      const queueItem = !correlation
        ? undefined
        : queueItems.find(
            (candidate) =>
              (linkedQueueItemId ? candidate.id === linkedQueueItemId : true) &&
              matchesCorrelation(candidate, correlation.sourceItemId, correlation.proposalRevision),
          );
      if (queueItem) {
        const status = statusProjection(queueItem);
        const linkedRunId = queueItem.runId ?? item.linkedRunId;
        try {
          const checkpoint = linkedRunId ? readCheckpoint(this.projectPath, linkedRunId) : null;
          const intakeStatus = status ?? checkpoint?.status ?? item.intakeStatus;
          if (
            item.linkedRunId === linkedRunId &&
            linkedQueueItemId === queueItem.id &&
            item.intakeStatus === intakeStatus &&
            item.executionCompletedAt === (checkpoint?.completedAt ?? queueItem.completedAt ?? null)
          ) {
            continue;
          }
          updateInboxItem(this.projectPath, item.id, (value) => ({
            ...value,
            linkedQueueItemId: queueItem.id,
            linkedRunId,
            intakeStatus,
            executionStartedAt: checkpoint?.startedAt ?? queueItem.startedAt ?? value.executionStartedAt,
            executionCompletedAt: checkpoint?.completedAt ?? queueItem.completedAt ?? value.executionCompletedAt,
            lastError: checkpoint?.error ?? queueItem.error ?? null,
            updatedAt: checkpoint?.updatedAt ?? queueItem.updatedAt ?? this.now(),
          }));
        } catch {
          // A queue item may be claimed before its supervisor checkpoint is persisted.
          if (status && (item.intakeStatus !== status || linkedQueueItemId !== queueItem.id)) {
            updateInboxItem(this.projectPath, item.id, (value) => ({
              ...value,
              linkedQueueItemId: queueItem.id,
              intakeStatus: status,
              executionStartedAt: queueItem.startedAt ?? value.executionStartedAt,
              executionCompletedAt: queueItem.completedAt ?? value.executionCompletedAt,
              lastError: queueItem.error ?? null,
              updatedAt: queueItem.updatedAt ?? this.now(),
            }));
          }
        }
        continue;
      }
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
    const job: UiIntakeJob = {
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
    };
    let persistedJobId = jobId;
    updateInboxFile(this.projectPath, (file) => {
      const existing = file.jobs.find((candidate) => candidate.idempotencyKey === job.idempotencyKey);
      if (existing) persistedJobId = existing.id;
      let found = false;
      const items = file.items.map((value) => {
        if (value.id !== itemId) return value;
        found = true;
        return { ...value, intakeStatus: 'triaging' as const, lastError: null, updatedAt: ts };
      });
      if (!found) throw new Error(`Inbox item "${itemId}" not found`);
      return { ...file, items, jobs: existing ? file.jobs : [...file.jobs, job] };
    });
    if (persistedJobId === jobId) queueMicrotask(() => void this.processTriage(jobId, itemId, revision));
  }

  clarify(itemId: string, revision: number, answer: string): void {
    const trimmed = answer.trim();
    if (!trimmed) throw new Error('Clarification answer is required');
    updateInboxItem(
      this.projectPath,
      itemId,
      (item) => {
        if (item.intakeStatus !== 'awaiting-clarification') {
          throw new StaleProposalError(`Inbox item "${itemId}" is no longer awaiting clarification`);
        }
        return {
          ...item,
          intakeStatus: 'triaging',
          clarificationMessages: [
            ...(item.clarificationMessages ?? []),
            {
              id: `message-${this.id()}`,
              role: 'user',
              content: trimmed,
              createdAt: this.now(),
              proposalRevision: revision,
            },
          ],
          clarificationRounds: (item.clarificationRounds ?? 0) + 1,
          updatedAt: this.now(),
        };
      },
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
      const queue = this.supervisorQueue as unknown as CorrelatedSupervisorQueue;
      const correlation = proposalCorrelation(item);
      if (!correlation || correlation.sourceItemId !== itemId || correlation.proposalRevision !== revision) {
        throw new StaleProposalError(`Inbox item "${itemId}" has no proposal for revision ${revision}`);
      }
      try {
        const existing = queue
          .list()
          .find((candidate) => matchesCorrelation(candidate, correlation.sourceItemId, correlation.proposalRevision));
        const queueItem = existing ?? (await enqueueCorrelated(queue, item.linkedDagPath, correlation));
        updateInboxItem(
          this.projectPath,
          itemId,
          (value) => ({
            ...value,
            status: 'converted',
            intakeStatus: 'queued',
            linkedQueueItemId: queueItem.id,
            lastError: null,
            updatedAt: this.now(),
          }),
          revision,
        );
      } catch (error) {
        try {
          updateInboxItem(
            this.projectPath,
            itemId,
            (value) => ({
              ...value,
              intakeStatus: 'failed',
              lastError: actionableError('Unable to queue approved execution', error),
              updatedAt: this.now(),
            }),
            revision,
          );
        } catch (persistError) {
          if (!(persistError instanceof StaleProposalError)) throw persistError;
        }
        throw error;
      }
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
    const correlation = proposalCorrelation(item);
    const linkedQueueItemId = (item as typeof item & { linkedQueueItemId?: string | null }).linkedQueueItemId;
    if (correlation) {
      const queueItem = (this.supervisorQueue as unknown as CorrelatedSupervisorQueue)
        .list()
        .find(
          (candidate) =>
            (linkedQueueItemId ? candidate.id === linkedQueueItemId : true) &&
            matchesCorrelation(candidate, correlation.sourceItemId, correlation.proposalRevision),
        );
      if (queueItem) {
        try {
          await (this.supervisorQueue as unknown as CorrelatedSupervisorQueue).cancel(queueItem.id);
        } catch (error) {
          updateInboxItem(this.projectPath, itemId, (value) => ({
            ...value,
            lastError: actionableError('Unable to cancel execution', error),
            updatedAt: this.now(),
          }));
          throw error;
        }
      }
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
      const raw = await this.triageProvider.triage(
        buildTriagePrompt(item.body, context, revision, item.clarificationMessages),
        controller.signal,
      );
      if (controller.signal.aborted || this.stopped) return;
      const triage = parseTriageResult(raw, revision);
      const decision = decideIntake(triage, file.policy, {
        isGitRepository: context.git.isRepository,
        gitClean: context.git.clean,
        activeMutationLease: false,
        overlappingFiles: [],
        todoBody: item.body,
        clarificationRounds: item.clarificationRounds,
        clarificationAnswers: (item.clarificationMessages ?? [])
          .filter((message) => message.role === 'user')
          .map((message) => message.content),
      });
      const forcedAction = decision.kind === 'awaiting-approval' ? decision.forcedAction : undefined;
      const effectiveTriage: UiTriageResult = forcedAction
        ? {
            ...triage,
            needsClarification: false,
            proposedAction: forcedAction,
            rationale: decision.kind === 'awaiting-approval' ? decision.reason : triage.rationale,
          }
        : triage;
      const intakeStatus = decision.kind === 'execute-sequential' ? 'queued' : decision.kind;
      const needsDagProposal =
        decision.kind === 'awaiting-approval' && effectiveTriage.proposedAction === 'propose-dag';
      updateInboxItem(this.projectPath, itemId, (value) => ({
        ...value,
        triage: effectiveTriage,
        intakeStatus: needsDagProposal ? 'triaging' : intakeStatus,
        executionMode: effectiveTriage.proposedAction === 'propose-dag' ? 'dag' : 'sequential',
        approval: needsDagProposal ? null : approvalFor(decision, revision, this.now()),
        ...(decision.kind === 'awaiting-clarification' && {
          clarificationMessages: (() => {
            const messages = value.clarificationMessages ?? [];
            const question = clarificationQuestion(triage);
            const duplicate = messages.some(
              (message) => message.role === 'loom' && message.proposalRevision === revision,
            );
            return duplicate
              ? messages
              : [
                  ...messages,
                  {
                    id: `message-${this.id()}`,
                    role: 'loom' as const,
                    content: question,
                    createdAt: this.now(),
                    proposalRevision: revision,
                  },
                ];
          })(),
        }),
        updatedAt: this.now(),
        lastError: null,
      }));
      if (needsDagProposal) {
        const proposal = await this.dagPlanner.propose(this.projectPath, item, effectiveTriage);
        updateInboxItem(
          this.projectPath,
          itemId,
          (value) => ({
            ...value,
            linkedPlanPath: proposal.planPath,
            linkedDagPath: proposal.dagPath,
            proposal: {
              ...proposal,
              sourceItemId: itemId,
              proposalRevision: revision,
            },
            executionMode: 'dag',
            intakeStatus: 'awaiting-approval',
            approval: approvalFor(decision, revision, this.now()),
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
      if (decision.kind === 'execute-sequential') this.startSequential(itemId, effectiveTriage);
    } catch (error) {
      if (controller.signal.aborted) return;
      const message = actionableError('Triage failed', error);
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
