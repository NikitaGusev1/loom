import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ContractOutput, DAGTask, DecompositionDAG } from './types.js';

export type DAGReadinessIssueCode =
  | 'too-few-tasks'
  | 'too-many-tasks'
  | 'task-name-multiple-concerns'
  | 'task-description-too-long'
  | 'task-too-many-files'
  | 'task-cross-module'
  | 'task-missing-inputs'
  | 'task-missing-outputs'
  | 'contract-input-missing-output'
  | 'context-missing-files'
  | 'context-file-missing'
  | 'context-missing-conventions'
  | 'behavioral-output-without-automated-check'
  | 'acceptance-criterion-uncovered';

export interface DAGReadinessIssue {
  code: DAGReadinessIssueCode;
  message: string;
  taskId?: string;
}

export interface DAGReadinessResult {
  ok: boolean;
  issues: DAGReadinessIssue[];
}

export interface DAGReadinessOptions {
  cwd: string;
}

const MAX_TASKS = 15;
const MAX_CONTEXT_FILES = 3;

const outputPath = (output: ContractOutput): string | null => {
  if (output.kind === 'file') return output.path;
  if (output.kind === 'export') return output.file;
  return null;
};

const inputProducedByDeclaredSource = (
  task: DAGTask,
  inputName: string,
  sourceId: string,
  taskById: ReadonlyMap<string, DAGTask>,
): boolean => {
  if (!task.dependencies.includes(sourceId)) return false;
  const sourceTask = taskById.get(sourceId);
  return sourceTask ? Object.hasOwn(sourceTask.contracts.outputs, inputName) : false;
};

const sentenceCount = (text: string): number =>
  text
    .split(/[.!?]+/)
    .map((part) => part.trim())
    .filter(Boolean).length;

const includesConcernJoiner = (name: string): boolean => /\band\b/i.test(name);

const normalized = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const criterionCovered = (criterion: string, tasks: DAGTask[]): boolean => {
  const needle = normalized(criterion);
  if (!needle) return true;
  const haystacks = tasks.flatMap((task) => [...task.completionCriteria.automated, ...task.completionCriteria.manual]);
  return haystacks.some((entry) => {
    const haystack = normalized(entry);
    if (!haystack) return false;
    return haystack.includes(needle) || needle.includes(haystack);
  });
};

const taskOutputPaths = (task: DAGTask): Set<string> =>
  new Set(
    Object.values(task.contracts.outputs)
      .map(outputPath)
      .filter((path): path is string => path !== null),
  );

const fileExistsOrIsCreatedByTask = (cwd: string, file: string, createdPaths: ReadonlySet<string>): boolean =>
  createdPaths.has(file) || existsSync(join(cwd, file));

export const analyzeDAGReadiness = (dag: DecompositionDAG, options: DAGReadinessOptions): DAGReadinessResult => {
  const issues: DAGReadinessIssue[] = [];
  const taskById = new Map(dag.tasks.map((task) => [task.id, task]));

  if (dag.tasks.length < 2) {
    issues.push({
      code: 'too-few-tasks',
      message: `DAG has ${dag.tasks.length} task; decomposed DAGs should have at least 2 tasks.`,
    });
  }

  if (dag.tasks.length > MAX_TASKS) {
    issues.push({
      code: 'too-many-tasks',
      message: `DAG has ${dag.tasks.length} tasks; maximum is ${MAX_TASKS}.`,
    });
  }

  for (const task of dag.tasks) {
    if (includesConcernJoiner(task.name)) {
      issues.push({
        code: 'task-name-multiple-concerns',
        taskId: task.id,
        message: `Task "${task.id}" name includes "and", which suggests multiple concerns.`,
      });
    }

    if (sentenceCount(task.description) > 3) {
      issues.push({
        code: 'task-description-too-long',
        taskId: task.id,
        message: `Task "${task.id}" description has more than 3 sentences.`,
      });
    }

    if (task.context.files.length > MAX_CONTEXT_FILES) {
      issues.push({
        code: 'task-too-many-files',
        taskId: task.id,
        message: `Task "${task.id}" has ${task.context.files.length} context files; maximum is ${MAX_CONTEXT_FILES}.`,
      });
    }

    if (task.estimatedScope === 'cross-module') {
      issues.push({
        code: 'task-cross-module',
        taskId: task.id,
        message: `Task "${task.id}" is marked cross-module; split it into smaller agent-sized tasks.`,
      });
    }

    if (task.dependencies.length > 0 && Object.keys(task.contracts.inputs).length === 0) {
      issues.push({
        code: 'task-missing-inputs',
        taskId: task.id,
        message: `Task "${task.id}" depends on other tasks but declares no contract inputs.`,
      });
    }

    if (Object.keys(task.contracts.outputs).length === 0) {
      issues.push({
        code: 'task-missing-outputs',
        taskId: task.id,
        message: `Task "${task.id}" declares no contract outputs.`,
      });
    }

    for (const [inputName, input] of Object.entries(task.contracts.inputs)) {
      if (!inputProducedByDeclaredSource(task, inputName, input.source, taskById)) {
        issues.push({
          code: 'contract-input-missing-output',
          taskId: task.id,
          message: `Task "${task.id}" input "${inputName}" is not produced by declared source "${input.source}".`,
        });
      }
    }

    if (task.context.files.length === 0) {
      issues.push({
        code: 'context-missing-files',
        taskId: task.id,
        message: `Task "${task.id}" has no scoped context files.`,
      });
    }

    const createdPaths = taskOutputPaths(task);
    for (const file of task.context.files) {
      if (!fileExistsOrIsCreatedByTask(options.cwd, file, createdPaths)) {
        issues.push({
          code: 'context-file-missing',
          taskId: task.id,
          message: `Task "${task.id}" references missing context file "${file}".`,
        });
      }
    }

    if ((task.context.conventions ?? []).length === 0) {
      issues.push({
        code: 'context-missing-conventions',
        taskId: task.id,
        message: `Task "${task.id}" has no implementation conventions in context.`,
      });
    }

    const hasBehavioralOutput = Object.values(task.contracts.outputs).some((output) => output.kind === 'behavioral');
    if (hasBehavioralOutput && task.completionCriteria.automated.length === 0) {
      issues.push({
        code: 'behavioral-output-without-automated-check',
        taskId: task.id,
        message: `Task "${task.id}" has a behavioral output but no automated completion criteria.`,
      });
    }
  }

  for (const criterion of dag.meta.source.acceptanceCriteria) {
    if (!criterionCovered(criterion, dag.tasks)) {
      issues.push({
        code: 'acceptance-criterion-uncovered',
        message: `Acceptance criterion is not covered by task completion criteria: ${criterion}`,
      });
    }
  }

  return { ok: issues.length === 0, issues };
};

export const formatDAGReadinessReport = (result: DAGReadinessResult): string => {
  if (result.ok) return 'DAG readiness passed.';
  return [
    'DAG readiness failed:',
    ...result.issues.map((issue) => {
      const task = issue.taskId ? `${issue.taskId}: ` : '';
      return `- [${issue.code}] ${task}${issue.message}`;
    }),
  ].join('\n');
};
