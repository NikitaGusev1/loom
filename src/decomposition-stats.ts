import { readFileSync } from 'node:fs';
import { validateDAG } from './validation.js';
import type { DecompositionDAG } from './types.js';

/**
 * The three inputs the mode-selection phase needs to decide DAG vs sequential.
 * Derived deterministically from the validated DAG so the headless mechanical
 * phase never has to eyeball the JSON (see BACKLOG "Supervised /auto-run
 * hardening" #3: a model misread `has_heavy` and flipped the verdict).
 *
 * Inputs ONLY — the thresholds (>=8 / >=3 / has_heavy) stay authoritative in
 * skills/auto-implement/SKILL.md. This never emits a verdict.
 */
export interface DecompositionStats {
  task_count: number;
  max_width: number;
  has_heavy: boolean;
}

export const computeDecompositionStats = (dag: DecompositionDAG): DecompositionStats => ({
  task_count: dag.tasks.length,
  max_width: dag.executionLayers.reduce((max, layer) => Math.max(max, layer.taskIds.length), 0),
  has_heavy: dag.tasks.some((task) => task.weight === 'heavy'),
});

/** Read + JSON.parse + validate (same path the executor uses on load) + derive. Throws on any failure. */
export const decompositionStatsFromFile = (path: string): DecompositionStats =>
  computeDecompositionStats(validateDAG(JSON.parse(readFileSync(path, 'utf-8'))));
