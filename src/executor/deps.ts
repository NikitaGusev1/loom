import { createWorktreeSafe, mergeLayerWorktrees, verifyBaseUnchanged } from '../worktree.js';
import { getFilesModified } from './git-ops.js';
import { settleNoOpGate } from './noop-gate.js';
import { executeTaskPasses } from './task-passes.js';

export interface ExecutorDeps {
  runTask: typeof executeTaskPasses;
  settleNoOp: typeof settleNoOpGate;
  createWorktree: typeof createWorktreeSafe;
  mergeWorktrees: typeof mergeLayerWorktrees;
  getFilesModified: typeof getFilesModified;
  verifyBaseUnchanged: typeof verifyBaseUnchanged;
}

export const defaultExecutorDeps: ExecutorDeps = {
  runTask: executeTaskPasses,
  settleNoOp: settleNoOpGate,
  createWorktree: createWorktreeSafe,
  mergeWorktrees: mergeLayerWorktrees,
  getFilesModified,
  verifyBaseUnchanged,
};
