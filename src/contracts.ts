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

const checkConsumerInputs = (
  consumerId: string,
  taskMap: Map<string, DAGTask>,
  completedTaskIds?: Set<string>,
): BrokenContract[] => {
  const brokenContracts: BrokenContract[] = [];
  const consumer = taskMap.get(consumerId);
  if (!consumer) return brokenContracts;

  for (const [inputName, input] of Object.entries(consumer.contracts.inputs)) {
    if (completedTaskIds && !completedTaskIds.has(input.source)) {
      brokenContracts.push({
        taskId: consumerId,
        inputName,
        expectedFrom: input.source,
        outputName: inputName,
        outputType: input.type ?? 'unknown',
        reason: `Source task "${input.source}" is not completed`,
      });
      continue;
    }

    const producer = taskMap.get(input.source);
    const output = producer?.contracts.outputs[inputName];
    if (!output) {
      brokenContracts.push({
        taskId: consumerId,
        inputName,
        expectedFrom: input.source,
        outputName: inputName,
        outputType: input.type ?? 'unknown',
        reason: producer
          ? `Source task "${input.source}" does not produce output "${inputName}"`
          : `Input source "${input.source}" is not a known task`,
      });
      continue;
    }

    if (isFileOutput(output)) {
      if (!existsSync(output.path)) {
        brokenContracts.push({
          taskId: consumerId,
          inputName,
          expectedFrom: input.source,
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
          taskId: consumerId,
          inputName,
          expectedFrom: input.source,
          outputName: inputName,
          outputType: output.exportKind,
          reason: `Export "${output.exportName}" (${output.exportKind}) not found in "${output.file}"`,
        });
      }
    }
  }

  return brokenContracts;
};

export const createConsumerInputVerifier = (
  taskMap: Map<string, DAGTask>,
): ((consumerId: string) => ContractVerificationResult) => {
  return (consumerId) => {
    const brokenContracts = checkConsumerInputs(consumerId, taskMap);
    return { passed: brokenContracts.length === 0, brokenContracts };
  };
};

export const verifyLayerContracts = async (
  completedTaskIds: string[],
  nextLayerTaskIds: string[],
  dag: DecompositionDAG,
): Promise<ContractVerificationResult> => {
  const brokenContracts: BrokenContract[] = [];
  const taskMap = new Map(dag.tasks.map((t) => [t.id, t]));
  const completed = new Set(completedTaskIds);

  for (const nextTaskId of nextLayerTaskIds) {
    brokenContracts.push(...checkConsumerInputs(nextTaskId, taskMap, completed));
  }

  return {
    passed: brokenContracts.length === 0,
    brokenContracts,
  };
};
