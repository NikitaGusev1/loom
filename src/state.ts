import { writeFileSync, renameSync, existsSync } from 'node:fs';
import type { ExecutionState, DecompositionDAG, ExecutorConfig } from './types.js';
import type { DagEvent } from './events/types.js';
import { getEventLogPath, readEvents, appendEvent } from './events/log.js';
import { replay, reduce } from './state/reducer.js';

// emitHelper — write event (durable) then update in-memory state via reducer.
// Append-then-reduce order guarantees the event log is the source of truth on
// crash. The write-side mirror of loadStateFromEvents (read events, replay).
export const emitHelper = (logPath: string, state: ExecutionState, event: DagEvent): ExecutionState => {
  appendEvent(logPath, event);
  return reduce(state, event);
};

export const getStatePath = (dagPath: string): string => dagPath.replace(/\.json$/, '.state.json');

export const createState = (dag: DecompositionDAG, config: ExecutorConfig): ExecutionState => {
  const tasks: ExecutionState['tasks'] = {};
  for (const task of dag.tasks) {
    tasks[task.id] = { status: 'pending' };
  }

  const layers: ExecutionState['layers'] = {};
  for (const layer of dag.executionLayers) {
    layers[String(layer.layer)] = {
      startedAt: null,
      completedAt: null,
      taskCount: layer.taskIds.length,
    };
  }

  return {
    dagPath: config.dagPath,
    status: 'running',
    startedAt: new Date().toISOString(),
    currentLayer: 0,
    config,
    layers,
    tasks,
  };
};

/**
 * Canonical resume path. Reads the .events.jsonl file and folds all events
 * through the pure reducer to reconstruct execution state.
 *
 * Returns null if the events file does not exist (caller must handle this).
 */
export const loadStateFromEvents = (
  dagPath: string,
  dag: DecompositionDAG,
  config: ExecutorConfig,
): ExecutionState | null => {
  const eventLogPath = getEventLogPath(dagPath);
  if (!existsSync(eventLogPath)) return null;
  const events = readEvents(eventLogPath);
  return replay(events, dag, config);
};

/**
 * Writes execution state as a cache file.
 * This file is derived from the event log and is NEVER read on resume.
 * The `derived: true` field marks it as a secondary artifact.
 */
export const saveState = (statePath: string, state: ExecutionState): void => {
  const tmp = `${statePath}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...state, derived: true }, null, 2), 'utf-8');
  renameSync(tmp, statePath);
};
