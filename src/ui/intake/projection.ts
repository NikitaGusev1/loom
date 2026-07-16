import { discoverDags } from '../discovery.js';
import { readInbox } from '../inbox.js';
import { listCheckpoints, readRunLogTail } from './persistence.js';
import type { UiDagRunSummary, UiRunDetail, UiRunSummary, UiSequentialRunSummary } from './types.js';

const dagRunStatus = (status: string): UiDagRunSummary['status'] => {
  if (status === 'completed' || status === 'failed' || status === 'running') return status;
  if (status === 'paused') return 'blocked';
  return 'queued';
};

export const listRuns = (projectPath: string, discoveredDags = discoverDags(projectPath).dags): UiRunSummary[] => {
  const inbox = readInbox(projectPath);
  const items = new Map(inbox.items.map((item) => [item.id, item]));
  const sequential: UiSequentialRunSummary[] = listCheckpoints(projectPath).map((checkpoint) => ({
    id: checkpoint.id,
    itemId: checkpoint.itemId,
    title: items.get(checkpoint.itemId)?.body ?? checkpoint.itemId,
    mode: 'sequential',
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
  const dags: UiDagRunSummary[] = discoveredDags.map((dag) => ({
    id: `dag:${dag.path}`,
    itemId: inbox.items.find((item) => item.linkedDagPath === dag.path)?.id ?? null,
    title: dag.title,
    mode: 'dag',
    status: dagRunStatus(dag.status),
    createdAt: dag.updatedAt ?? '',
    updatedAt: dag.updatedAt ?? '',
    dagPath: dag.path,
    completedTasks: dag.completedTasks,
    totalTasks: dag.totalTasks,
  }));
  return [...sequential, ...dags].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
};

export const loadRunDetail = (projectPath: string, runId: string): UiRunDetail => {
  const summary = listRuns(projectPath).find((run) => run.id === runId);
  if (!summary) throw new Error(`Run "${runId}" not found`);
  if (summary.mode === 'dag') return { summary, dagPath: summary.dagPath };
  const checkpoint = listCheckpoints(projectPath).find((run) => run.id === runId);
  if (!checkpoint) throw new Error(`Run "${runId}" not found`);
  return { summary, checkpoint, recentLog: readRunLogTail(projectPath, runId) };
};
