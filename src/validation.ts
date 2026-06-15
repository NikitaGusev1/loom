import { z } from 'zod';
import type { DecompositionDAG } from './types.js';

const dagMetaSchema = z.object({
  id: z.string().min(1),
  source: z.object({
    type: z.enum(['jira', 'description']),
    jiraKey: z.string().optional(),
    title: z.string().min(1),
    description: z.string(),
    figmaUrls: z.array(z.string()),
    acceptanceCriteria: z.array(z.string()),
  }),
  createdAt: z.string(),
  gitCommit: z.string(),
  branch: z.string(),
  qualityReport: z.object({
    iterations: z.number(),
    checksRun: z.array(z.string()),
    allPassed: z.boolean(),
    details: z
      .record(
        z.string(),
        z.object({
          passed: z.boolean(),
          notes: z.string(),
        }),
      )
      .optional(),
  }),
});

const fileOutputSchema = z.object({
  kind: z.literal('file'),
  path: z.string().min(1),
  mediaType: z.enum(['json', 'markdown', 'yaml', 'text', 'typescript', 'shell', 'other']).optional(),
  description: z.string(),
});

const exportOutputSchema = z.object({
  kind: z.literal('export'),
  file: z.string().min(1),
  exportName: z.string().min(1),
  exportKind: z.enum(['type', 'interface', 'const', 'function', 'class', 'component']),
  description: z.string(),
});

const behavioralOutputSchema = z.object({
  kind: z.literal('behavioral'),
  description: z.string(),
});

const contractOutputSchema = z.discriminatedUnion('kind', [
  fileOutputSchema,
  exportOutputSchema,
  behavioralOutputSchema,
]);

const taskContractsSchema = z.object({
  inputs: z.record(z.string(), z.object({ type: z.string().optional(), source: z.string() })),
  outputs: z.record(z.string(), contractOutputSchema),
});

const figmaRefSchema = z.object({
  nodeId: z.string().optional(),
  url: z.string().optional(),
  hints: z.array(z.string()).optional().default([]),
});

const taskContextSchema = z.object({
  files: z.array(z.string()),
  figmaRef: figmaRefSchema.optional(),
  layoutSpec: z.string().optional(),
  figmaTokens: z.record(z.string(), z.string()).optional(),
  conventions: z.array(z.string()).optional().default([]),
  relatedPatterns: z
    .array(
      z.object({
        file: z.string(),
        relevance: z.string(),
      }),
    )
    .optional()
    .default([]),
});

const completionCriteriaSchema = z.object({
  automated: z.array(z.string()),
  manual: z.array(z.string()),
});

const safeIdPattern = /^[a-zA-Z0-9_-]+$/;

const dagTaskSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(safeIdPattern, 'Task ID must contain only alphanumeric, hyphen, or underscore characters'),
  name: z.string().min(1),
  description: z.string(),
  dependencies: z.array(z.string()),
  contracts: taskContractsSchema,
  context: taskContextSchema,
  completionCriteria: completionCriteriaSchema,
  estimatedScope: z.enum(['single-component', 'multi-file', 'cross-module']),
  weight: z.enum(['trivial', 'standard', 'heavy']),
});

const executionLayerSchema = z.object({
  layer: z.number().int().min(0),
  description: z.string(),
  taskIds: z.array(z.string()).min(1),
});

const dagSchema = z.object({
  meta: dagMetaSchema,
  tasks: z.array(dagTaskSchema).min(1),
  executionLayers: z.array(executionLayerSchema).min(1),
});

export const validateDAG = (json: unknown): DecompositionDAG => {
  const parsed = dagSchema.parse(json);

  // Build task ID set for reference validation
  const taskIds = new Set(parsed.tasks.map((t) => t.id));

  // Validate all taskIds in executionLayers reference existing tasks
  for (const layer of parsed.executionLayers) {
    for (const taskId of layer.taskIds) {
      if (!taskIds.has(taskId)) {
        throw new Error(
          `Execution layer ${layer.layer} references unknown task "${taskId}". ` +
            `Available tasks: ${[...taskIds].join(', ')}`,
        );
      }
    }
  }

  // Validate all dependency references are valid task IDs
  for (const task of parsed.tasks) {
    for (const depId of task.dependencies) {
      if (!taskIds.has(depId)) {
        throw new Error(
          `Task "${task.id}" depends on unknown task "${depId}". ` + `Available tasks: ${[...taskIds].join(', ')}`,
        );
      }
    }
  }

  // Check for cycles via topological sort
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const taskMap = new Map(parsed.tasks.map((t) => [t.id, t]));

  const visit = (id: string, path: string[]): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      const cycle = [...path.slice(path.indexOf(id)), id];
      throw new Error(`Cycle detected in DAG: ${cycle.join(' → ')}`);
    }
    visiting.add(id);
    const task = taskMap.get(id)!;
    for (const dep of task.dependencies) {
      visit(dep, [...path, id]);
    }
    visiting.delete(id);
    visited.add(id);
  };

  for (const task of parsed.tasks) {
    visit(task.id, []);
  }

  // Validate layer assignment: every task appears in exactly one execution layer
  const layerByTask = new Map<string, number>();
  for (const layer of parsed.executionLayers) {
    for (const taskId of layer.taskIds) {
      const existing = layerByTask.get(taskId);
      if (existing !== undefined) {
        throw new Error(`Task "${taskId}" appears in multiple execution layers (${existing} and ${layer.layer})`);
      }
      layerByTask.set(taskId, layer.layer);
    }
  }
  for (const task of parsed.tasks) {
    if (!layerByTask.has(task.id)) {
      throw new Error(`Task "${task.id}" is not assigned to any execution layer`);
    }
  }

  // Validate layer ordering: every dependency must sit in a strictly earlier layer.
  // Intra-layer deps are unsatisfiable at runtime — the contract gate between layers
  // checks a task's inputs against COMPLETED tasks, and same-layer peers run concurrently.
  // Runs after cycle detection so a cycle reports as a cycle, not as a layering error.
  for (const task of parsed.tasks) {
    const taskLayer = layerByTask.get(task.id)!;
    for (const depId of task.dependencies) {
      const depLayer = layerByTask.get(depId)!;
      if (depLayer >= taskLayer) {
        throw new Error(
          `Task "${task.id}" (layer ${taskLayer}) depends on "${depId}" (layer ${depLayer}) — ` +
            `dependencies must be in a strictly earlier layer`,
        );
      }
    }
  }

  return parsed as DecompositionDAG;
};
