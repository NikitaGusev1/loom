import { resolve, relative } from 'node:path';
import { readInbox } from '../inbox.js';
import { listCheckpoints, readRunLogTail } from './persistence.js';
import type { UiDagRunSummary, UiRunDetail, UiRunSummary, UiSequentialRunSummary } from './types.js';

/**
 * This module deliberately treats a queue execution as the unit of work.  A DAG
 * definition is only intent; showing it here used to make unstarted work look
 * like a run.
 */
type RecordLike = Record<string, unknown>;
type CheckpointReader = (projectPath: string, executionId: string) => RecordLike | null | undefined;

const asRecord = (value: unknown): RecordLike | null =>
  value !== null && typeof value === 'object' ? (value as RecordLike) : null;

const stringValue = (record: RecordLike | null, ...keys: string[]): string | null => {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
};

const isContainedPath = (projectPath: string, candidate: unknown): boolean => {
  if (typeof candidate !== 'string' || candidate.length === 0) return true;
  const project = resolve(projectPath);
  const target = resolve(project, candidate);
  const pathFromProject = relative(project, target);
  return pathFromProject === '' || (!pathFromProject.startsWith('..') && !pathFromProject.includes('/../'));
};

const hasOnlyContainedPaths = (projectPath: string, value: RecordLike | null): boolean =>
  [
    'dagPath',
    'sourceDagPath',
    'definitionPath',
    'executionPath',
    'snapshotPath',
    'checkpointPath',
    'planPath',
    'logPath',
  ].every((key) => isContainedPath(projectPath, value?.[key]));

const status = (value: unknown): UiSequentialRunSummary['status'] => {
  if (value === 'completed' || value === 'failed' || value === 'running' || value === 'blocked') return value;
  if (value === 'paused') return 'blocked';
  return 'queued';
};

const queueRecords = (value: unknown): RecordLike[] => {
  if (Array.isArray(value)) return value.map(asRecord).filter((item): item is RecordLike => item !== null);
  const record = asRecord(value);
  const items = record?.items ?? record?.queueItems;
  if (Array.isArray(items)) return items.map(asRecord).filter((item): item is RecordLike => item !== null);
  return record ? [record] : [];
};

const executionId = (queueItem: RecordLike): string | null => stringValue(queueItem, 'executionId', 'runId', 'id');

const itemId = (queueItem: RecordLike): string | null => stringValue(queueItem, 'itemId', 'inboxItemId', 'proposalId');

const legacyRuns = (projectPath: string): UiSequentialRunSummary[] => {
  const inbox = readInbox(projectPath);
  const items = new Map(inbox.items.map((item) => [item.id, item]));
  return listCheckpoints(projectPath)
    .filter((checkpoint) => hasOnlyContainedPaths(projectPath, checkpoint as unknown as RecordLike))
    .map((checkpoint) => ({
      id: checkpoint.id,
      itemId: checkpoint.itemId,
      title: items.get(checkpoint.itemId)?.body ?? checkpoint.itemId,
      mode: 'sequential' as const,
      status: checkpoint.status,
      createdAt: checkpoint.createdAt,
      updatedAt: checkpoint.updatedAt,
      phase: checkpoint.phase,
      provider: checkpoint.provider,
      changedFileCount: checkpoint.changedFiles.length,
      verification: checkpoint.verification,
      reviewVerdict: checkpoint.reviewVerdict,
      recoveryRequired: checkpoint.recoveryRequired,
    }));
};

/**
 * List actual queue executions.  `queueItems` accepts either the queue array or
 * its `{ items }` envelope so callers can pass the correlation client's result
 * unchanged.  Checkpoints remain a read-only compatibility fallback only when
 * there is no queue evidence at all.
 */
export const listRuns = (
  projectPath: string,
  queueItems?: unknown,
  proposals: unknown = [],
  checkpointReader?: CheckpointReader,
): UiRunSummary[] => {
  const queue = queueRecords(queueItems);
  if (queue.length === 0) {
    return legacyRuns(projectPath).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  const inbox = readInbox(projectPath);
  const inboxItems = new Map(inbox.items.map((item) => [item.id, item]));
  const proposalByItem = new Map(
    queueRecords(proposals).map((proposal) => [stringValue(proposal, 'itemId', 'inboxItemId', 'id'), proposal]),
  );

  return queue
    .flatMap((queueItem) => {
      const id = executionId(queueItem);
      const linkedItemId = itemId(queueItem);
      const proposal = proposalByItem.get(linkedItemId) ?? null;
      const checkpoint = checkpointReader && id ? (checkpointReader(projectPath, id) ?? null) : null;
      if (
        !id ||
        !hasOnlyContainedPaths(projectPath, queueItem) ||
        !hasOnlyContainedPaths(projectPath, proposal) ||
        !hasOnlyContainedPaths(projectPath, checkpoint)
      )
        return [];

      const createdAt = stringValue(queueItem, 'createdAt', 'queuedAt', 'startedAt') ?? '';
      const updatedAt = stringValue(queueItem, 'updatedAt', 'finishedAt', 'startedAt', 'createdAt') ?? createdAt;
      const title =
        stringValue(proposal, 'title', 'body') ?? inboxItems.get(linkedItemId ?? '')?.body ?? linkedItemId ?? id;
      const progress = asRecord(checkpoint?.taskProgress);
      const completedTasks = Number(checkpoint?.completedTasks ?? progress?.completed ?? 0);
      const totalTasks = Number(checkpoint?.totalTasks ?? progress?.total ?? 0);
      const dagPath =
        stringValue(checkpoint, 'dagPath', 'definitionPath') ??
        stringValue(queueItem, 'sourceDefinitionPath', 'sourcePath', 'dagPath') ??
        stringValue(proposal, 'dagPath') ??
        '';
      const run: UiDagRunSummary = {
        id,
        itemId: linkedItemId ?? id,
        title,
        mode: 'dag',
        status: status(checkpoint?.status ?? queueItem.status),
        createdAt,
        updatedAt,
        dagPath,
        completedTasks: Number.isFinite(completedTasks) ? completedTasks : 0,
        totalTasks: Number.isFinite(totalTasks) ? totalTasks : 0,
      };
      return [run];
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
};

/** Load contained checkpoint/log detail for one execution without cross-run merging. */
export const loadRunDetail = (
  projectPath: string,
  runId: string,
  queueItems?: unknown,
  proposals: unknown = [],
  checkpointReader?: CheckpointReader,
): UiRunDetail => {
  const summary = listRuns(projectPath, queueItems, proposals, checkpointReader).find((run) => run.id === runId);
  if (!summary) throw new Error(`Run "${runId}" not found`);

  const queueItem = queueRecords(queueItems).find((item) => executionId(item) === runId) ?? null;
  const proposal =
    queueRecords(proposals).find(
      (item) => stringValue(item, 'itemId', 'inboxItemId', 'id') === itemId(queueItem ?? {}),
    ) ?? null;
  const checkpoint = checkpointReader
    ? checkpointReader(projectPath, runId)
    : listCheckpoints(projectPath).find((run) => run.id === runId);
  const checkpointRecord = checkpoint as unknown as RecordLike | undefined;
  if (checkpoint && !hasOnlyContainedPaths(projectPath, checkpointRecord ?? null))
    throw new Error(`Run "${runId}" not found`);
  const logPath = checkpoint && stringValue(checkpointRecord ?? null, 'logPath');
  const recentLog = checkpoint && isContainedPath(projectPath, logPath) ? readRunLogTail(projectPath, runId) : [];
  if (summary.mode === 'dag') {
    return {
      summary,
      dagPath: summary.dagPath,
      checkpoint,
      recentLog,
      sourceDefinition: proposal?.sourceDefinition ?? proposal?.sourceDag ?? proposal?.dag,
      executionSnapshot: queueItem?.executionSnapshot ?? queueItem?.snapshot,
      pullRequest: queueItem?.pullRequest ?? queueItem?.pr ?? checkpointRecord?.pullRequest ?? checkpointRecord?.pr,
    };
  }
  return {
    summary,
    checkpoint,
    recentLog,
  } as UiRunDetail;
};
