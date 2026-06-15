import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { exec } from './exec.js';

const WORKTREE_DIR = '.worktrees';

const getWorktreePath = (taskId: string): string => resolve(WORKTREE_DIR, taskId);

const getBranchName = (taskId: string): string => `dag/${taskId}`;

// ---------------------------------------------------------------------------
// Lock file management
// ---------------------------------------------------------------------------

/**
 * Acquires a lock file at <dagPath>.lock.
 *
 * Lock format: {pid: number, startedAt: string} JSON.
 * Stale detection: reads existing lock, calls process.kill(pid, 0) — throws
 * ESRCH if the PID is dead, at which point we reclaim with a warning.
 *
 * Cleanup is registered on process.on('exit') AND process.on('SIGINT').
 * NOTE: Twice-Ctrl+C (force-kill before exit handler fires) leaves a dangling
 * .lock file — this is expected. A future --clean-stale-worktrees flag is the
 * intended remedy (out of scope for this task).
 *
 * Returns a release function that removes the lock file.
 * Throws if another live process holds the lock.
 */
export const acquireLock = (dagPath: string): (() => void) => {
  const lockPath = `${dagPath}.lock`;

  if (existsSync(lockPath)) {
    let existingPid: number | undefined;
    try {
      const raw = readFileSync(lockPath, 'utf-8');
      existingPid = (JSON.parse(raw) as { pid: number }).pid;
    } catch {
      // Corrupt lock file — treat as stale and reclaim
    }

    if (existingPid !== undefined) {
      let pidAlive = false;
      try {
        process.kill(existingPid, 0); // throws ESRCH if dead
        pidAlive = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
          // Unexpected error (e.g. EPERM) — treat as live to be safe
          pidAlive = true;
        }
      }

      if (pidAlive) {
        throw new Error(
          `Lock conflict: dag-executor is already running on "${dagPath}" (PID ${existingPid}). ` +
            `If that process is not running, delete "${lockPath}" manually.`,
        );
      }

      // PID is dead — stale lock, safe to reclaim
      process.stderr.write(
        `[dag-executor] Warning: stale lock found for PID ${existingPid} — reclaiming "${lockPath}"\n`,
      );
    }
  }

  const lockData = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
  writeFileSync(lockPath, lockData, 'utf-8');

  const release = (): void => {
    try {
      rmSync(lockPath);
    } catch {
      // Already removed or never existed — ignore
    }
  };

  process.on('exit', release);
  process.on('SIGINT', release);

  return release;
};

// ---------------------------------------------------------------------------
// Worktree management
// ---------------------------------------------------------------------------

export interface CreateWorktreeSafeOptions {
  /** Task IDs for which existing unmerged branches may be force-reset. */
  forceResetIds?: string[];
}

/**
 * Creates a git worktree for taskId branching from baseBranch.
 * Includes an unmerged-branch guard: refuses to clobber a branch that has
 * unmerged commits vs baseBranch unless taskId is in forceResetIds.
 *
 * NOTE: Dangling worktrees after twice-Ctrl+C are expected; a future
 * --clean-stale-worktrees flag is the intended remedy (out of scope here).
 */
export const createWorktreeSafe = async (
  taskId: string,
  baseBranch: string,
  opts: CreateWorktreeSafeOptions = {},
): Promise<{ path: string; branch: string }> => {
  mkdirSync(WORKTREE_DIR, { recursive: true });

  const wtPath = getWorktreePath(taskId);
  const branch = getBranchName(taskId);

  // Check whether the branch already exists and has unmerged commits
  let branchExists = false;
  try {
    await exec('git', ['rev-parse', '--verify', branch]);
    branchExists = true;
  } catch {
    // Branch does not exist — no conflict, continue
  }

  if (branchExists) {
    const { stdout } = await exec('git', ['rev-list', branch, `^${baseBranch}`]);
    const unmergedShas = stdout.trim();
    if (unmergedShas) {
      const forceAllowed = opts.forceResetIds?.includes(taskId) ?? false;
      if (!forceAllowed) {
        throw new Error(
          `Refusing to clobber branch "${branch}": it has unmerged commits vs "${baseBranch}". ` +
            `Re-run with --force-worktree-reset=${taskId} to discard them, or merge/delete the branch manually.`,
        );
      }
      process.stderr.write(
        `[dag-executor] Warning: branch "${branch}" has unmerged commits — ` +
          `force-resetting (taskId in forceResetIds)\n`,
      );
    }
  }

  // Clean up stale worktree/branch from a previous run
  try {
    await exec('git', ['worktree', 'remove', wtPath, '--force']);
  } catch {
    /* stale — ignore */
  }
  try {
    await exec('git', ['branch', '-D', branch]);
  } catch {
    /* missing — ignore */
  }

  await exec('git', ['worktree', 'add', wtPath, '-b', branch, baseBranch]);

  return { path: wtPath, branch };
};

// ---------------------------------------------------------------------------
// Base-commit guard
// ---------------------------------------------------------------------------

/**
 * Verifies that baseBranch HEAD still matches the recorded baseCommitSha.
 *
 * Returns true if unchanged; false if HEAD has moved.
 * The caller (executor) is responsible for emitting dag.base-moved and aborting.
 */
export const verifyBaseUnchanged = async (baseBranch: string, baseCommitSha: string): Promise<boolean> => {
  try {
    const { stdout } = await exec('git', ['rev-parse', `refs/heads/${baseBranch}`]);
    return stdout.trim() === baseCommitSha;
  } catch {
    // refs/heads lookup failed (detached HEAD, etc.) — fall back to plain HEAD
    try {
      const { stdout } = await exec('git', ['rev-parse', 'HEAD']);
      return stdout.trim() === baseCommitSha;
    } catch {
      return false;
    }
  }
};

// ---------------------------------------------------------------------------
// Internal merge / cleanup helpers
// ---------------------------------------------------------------------------

const mergeWorktree = async (taskId: string): Promise<{ success: boolean; conflict?: string }> => {
  const branch = getBranchName(taskId);

  try {
    await exec('git', ['merge', branch, '--no-edit']);
    return { success: true };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    try {
      await exec('git', ['merge', '--abort']);
    } catch {
      /* nothing to abort — ignore */
    }
    return { success: false, conflict: errorMessage };
  }
};

const cleanupWorktree = async (taskId: string): Promise<void> => {
  const wtPath = getWorktreePath(taskId);
  const branch = getBranchName(taskId);

  try {
    await exec('git', ['worktree', 'remove', wtPath, '--force']);
  } catch {
    /* already removed — ignore */
  }
  try {
    await exec('git', ['branch', '-D', branch]);
  } catch {
    /* already deleted — ignore */
  }
};

/**
 * Merges each task's branch into the current branch, cleaning up worktree +
 * branch per task as it goes. `onMerged` fires per task IMMEDIATELY after its
 * merge+cleanup (and for already-gone branches) — callers must persist the
 * merged state from inside the callback, not after the whole call: a later
 * conflict aborts the loop, and tasks merged before it would otherwise stay
 * `merged:false` forever (branch deleted → resume re-lists them → silent no-op).
 */
export const mergeLayerWorktrees = async (
  taskIds: string[],
  onMerged: (taskId: string) => void,
): Promise<{ success: boolean; failedAt?: string; conflict?: string }> => {
  for (const taskId of taskIds) {
    const branch = getBranchName(taskId);

    // Branch gone: the task ran on the base branch, or a prior partially-merged
    // run already merged+cleaned it. Nothing left to merge — report it merged
    // so resume stays idempotent instead of re-listing it forever.
    try {
      await exec('git', ['rev-parse', '--verify', branch]);
    } catch {
      onMerged(taskId);
      continue;
    }

    const result = await mergeWorktree(taskId);
    if (!result.success) {
      return { success: false, failedAt: taskId, conflict: result.conflict };
    }
    await cleanupWorktree(taskId);
    onMerged(taskId);
  }
  return { success: true };
};
