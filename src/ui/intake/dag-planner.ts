import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { runCodexCli } from '../../codex-cli.js';
import { validateDAG } from '../../validation.js';
import type { UiInboxItem } from '../types.js';
import type { UiTriageResult } from './types.js';

export interface DagProposal {
  planPath: string;
  dagPath: string;
  proposalSnapshotPath: string;
  proposalRevision: number;
  summary: string;
  rationale: string;
  risk: UiTriageResult['risk'];
  taskCount: number;
  layerCount: number;
  affectedFiles: string[];
  affectedFilesOverflow: number;
}

export interface DagPlanner {
  propose(projectPath: string, item: UiInboxItem, triage: UiTriageResult): Promise<DagProposal>;
}

export const buildDagPlannerPrompt = (item: UiInboxItem, triage: UiTriageResult): string =>
  `Use loom:explore only if clarification is needed, then loom:plan-from-spec and loom:decompose to create an approved plan and validated DAG for this project request. Do not implement it. Loom may also keep durable copies in its central artifact repository, but the UI requires project-local artifacts: copy or reuse the final plan and DAG under this project's .claude/ai directory and return those project-local paths. Return JSON only as {"planPath":"...","dagPath":"..."}. Request: ${JSON.stringify(item.body)}. Clarification transcript: ${JSON.stringify(item.clarificationMessages ?? [])}. Triage: ${JSON.stringify(triage)}`;

const within = (projectPath: string, path: string): string => {
  const absolute = resolve(projectPath, path);
  if (relative(resolve(projectPath), absolute).startsWith('..')) throw new Error('DAG proposal path escapes project');
  return absolute;
};

const MAX_AFFECTED_FILES = 50;

type DagTask = Record<string, unknown>;
type ValidatedDag = Record<string, unknown>;

const tasksFor = (dag: ValidatedDag): DagTask[] => {
  const tasks = Array.isArray(dag.tasks) ? dag.tasks : Array.isArray(dag.nodes) ? dag.nodes : [];
  return tasks.filter((task): task is DagTask => typeof task === 'object' && task !== null);
};

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

const layerCountFor = (dag: ValidatedDag, tasks: DagTask[]): number => {
  if (Array.isArray(dag.layers)) return dag.layers.length;
  if (tasks.length === 0) return 0;

  const ids = new Set(tasks.map((task, index) => typeof task.id === 'string' ? task.id : String(index)));
  const remaining = new Map(tasks.map((task, index) => {
    const id = typeof task.id === 'string' ? task.id : String(index);
    const dependencies = strings(task.dependsOn ?? task.dependencies).filter((dependency) => ids.has(dependency));
    return [id, dependencies] as const;
  }));
  let layers = 0;
  while (remaining.size > 0) {
    const ready = [...remaining].filter(([, dependencies]) => dependencies.every((dependency) => !remaining.has(dependency)));
    if (ready.length === 0) return layers + 1;
    for (const [id] of ready) remaining.delete(id);
    layers += 1;
  }
  return layers;
};

export const deriveDagProposal = (
  projectPath: string,
  item: UiInboxItem,
  triage: UiTriageResult,
  artifactPaths: Pick<DagProposal, 'planPath' | 'dagPath'>,
  dag: ValidatedDag,
): DagProposal => {
  const tasks = tasksFor(dag);
  const files = [...new Set([
    ...strings(dag.affectedFiles),
    ...tasks.flatMap((task) => strings(task.affectedFiles ?? task.files)),
  ])].sort();
  const proposalSnapshotPath = join(
    projectPath,
    '.claude',
    'ai',
    `proposal-${item.id}-r${triage.proposalRevision}.json`,
  );

  return {
    ...artifactPaths,
    proposalSnapshotPath,
    proposalRevision: triage.proposalRevision,
    summary: triage.summary,
    rationale: triage.rationale,
    risk: triage.risk,
    taskCount: tasks.length,
    layerCount: layerCountFor(dag, tasks),
    affectedFiles: files.slice(0, MAX_AFFECTED_FILES),
    affectedFilesOverflow: Math.max(0, files.length - MAX_AFFECTED_FILES),
  };
};

export const persistDagProposal = (proposal: DagProposal): void => {
  mkdirSync(resolve(proposal.proposalSnapshotPath, '..'), { recursive: true });
  writeFileSync(proposal.proposalSnapshotPath, `${JSON.stringify(proposal, null, 2)}\n`);
};

export class CodexDagPlanner implements DagPlanner {
  async propose(projectPath: string, item: UiInboxItem, triage: UiTriageResult): Promise<DagProposal> {
    const prompt = buildDagPlannerPrompt(item, triage);
    const result = await runCodexCli(prompt, {
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high',
      cwd: projectPath,
    });
    const parsed = JSON.parse(result.trace.lastAssistantText) as DagProposal;
    const artifactPaths = { planPath: within(projectPath, parsed.planPath), dagPath: within(projectPath, parsed.dagPath) };
    const dag = JSON.parse(readFileSync(artifactPaths.dagPath, 'utf-8')) as ValidatedDag;
    validateDAG(dag);
    const proposal = deriveDagProposal(projectPath, item, triage, artifactPaths, dag);
    persistDagProposal(proposal);
    return proposal;
  }
}
