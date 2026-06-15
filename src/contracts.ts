import { readFileSync, existsSync } from 'node:fs';
import type {
  BrokenContract,
  ContractOutput,
  ContractVerificationResult,
  DAGTask,
  DecompositionDAG,
  ExportKind,
  ExportOutput,
} from './types.js';
import { isExportOutput, isFileOutput } from './types.js';

export const resolveOutputFiles = (task: DAGTask): string[] => {
  const paths = new Set<string>();
  for (const out of Object.values(task.contracts.outputs)) {
    if (isFileOutput(out)) paths.add(out.path);
    else if (isExportOutput(out)) paths.add(out.file);
  }
  return [...paths];
};

const constPattern = (name: string): RegExp => new RegExp(`export\\s+const\\s+${name}\\b`);

// Accept both `export function name(...)` and `export const name = (...) =>`/`export const name = function`.
const functionPattern = (name: string): RegExp =>
  new RegExp(`export\\s+(?:(?:async\\s+)?function\\s+${name}\\b|const\\s+${name}\\b)`);

const EXPORT_PATTERNS: Record<ExportKind, (name: string) => RegExp> = {
  interface: (name) => new RegExp(`export\\s+interface\\s+${name}\\b`),
  type: (name) => new RegExp(`export\\s+type\\s+${name}\\b`),
  class: (name) => new RegExp(`export\\s+(abstract\\s+)?class\\s+${name}\\b`),
  function: functionPattern,
  component: constPattern,
  const: constPattern,
};

const exportExists = (out: ExportOutput): boolean => {
  try {
    const content = readFileSync(out.file, 'utf-8');
    return EXPORT_PATTERNS[out.exportKind](out.exportName).test(content);
  } catch {
    return false;
  }
};

interface OutputBinding {
  producerId: string;
  output: ContractOutput;
}

export const verifyLayerContracts = async (
  completedTaskIds: string[],
  nextLayerTaskIds: string[],
  dag: DecompositionDAG,
): Promise<ContractVerificationResult> => {
  const brokenContracts: BrokenContract[] = [];
  const taskMap = new Map(dag.tasks.map((t) => [t.id, t]));

  const outputMap = new Map<string, OutputBinding>();
  for (const taskId of completedTaskIds) {
    const task = taskMap.get(taskId);
    if (!task) continue;
    for (const [outputName, output] of Object.entries(task.contracts.outputs)) {
      outputMap.set(outputName, { producerId: taskId, output });
    }
  }

  for (const nextTaskId of nextLayerTaskIds) {
    const nextTask = taskMap.get(nextTaskId);
    if (!nextTask) continue;

    for (const [inputName, input] of Object.entries(nextTask.contracts.inputs)) {
      const binding = outputMap.get(inputName);
      if (!binding) {
        brokenContracts.push({
          taskId: nextTaskId,
          inputName,
          expectedFrom: input.source,
          outputName: inputName,
          outputType: input.type ?? 'unknown',
          reason: `No completed task produces output "${inputName}"`,
        });
        continue;
      }

      const { output, producerId } = binding;

      if (isFileOutput(output)) {
        if (!existsSync(output.path)) {
          brokenContracts.push({
            taskId: nextTaskId,
            inputName,
            expectedFrom: producerId,
            outputName: inputName,
            outputType: `file:${output.mediaType ?? 'other'}`,
            reason: `File "${output.path}" does not exist`,
          });
        }
        continue;
      }

      if (isExportOutput(output)) {
        if (!exportExists(output)) {
          brokenContracts.push({
            taskId: nextTaskId,
            inputName,
            expectedFrom: producerId,
            outputName: inputName,
            outputType: output.exportKind,
            reason: `Export "${output.exportName}" (${output.exportKind}) not found in "${output.file}"`,
          });
        }
        continue;
      }

      // behavioral outputs have no static artifact to verify
    }
  }

  return {
    passed: brokenContracts.length === 0,
    brokenContracts,
  };
};
