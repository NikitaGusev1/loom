import type { ExecutionState, DecompositionDAG, ExecutorConfig } from '../types.js';

export const initialState = (dag: DecompositionDAG, config: ExecutorConfig): ExecutionState => {
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
    startedAt: '',
    currentLayer: 0,
    config,
    layers,
    tasks,
  };
};
