// Pure resume-gap predicate. No I/O.

import type { ExecutionState } from '../types.js';

/**
 * Layer tasks that completed in a prior run but whose worktree was never merged
 * into the base branch — the resume gap. A task needs merging iff it is
 * `completed`, ran in a worktree (`worktreeBranch` is set), and is not yet
 * `merged`. Trivial tasks commit directly on the base branch and never get a
 * worktree, so they are excluded automatically; failed tasks are too (only
 * completed tasks ever merge).
 */
export const pendingMergeTaskIds = (layerTaskIds: string[], state: ExecutionState): string[] =>
  layerTaskIds.filter((id) => {
    const t = state.tasks[id];
    return t?.status === 'completed' && !!t.worktreeBranch && !t.merged;
  });
