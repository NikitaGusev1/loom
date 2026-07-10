// Git plumbing shared by the executor paths: changed-file queries and the
// post-session auto-commit.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { exec, toErrorMessage } from '../exec.js';
import type { Logger } from '../logger.js';

export const getCurrentBranch = async (): Promise<string> => {
  const { stdout } = await exec('git', ['branch', '--show-current']);
  return stdout.trim();
};

export const getHeadSha = async (): Promise<string> => {
  const { stdout } = await exec('git', ['rev-parse', 'HEAD']);
  return stdout.trim();
};

// Union of a git diff (against `diffSpec`) and untracked files, deduped. A git
// failure degrades to "no changed files" rather than throwing.
const gitChangedFiles = async (cwd: string, diffSpec: string): Promise<string[]> => {
  try {
    const [{ stdout: diffOutput }, { stdout: untrackedOutput }] = await Promise.all([
      exec('git', ['diff', '--name-only', diffSpec], { cwd }),
      exec('git', ['ls-files', '--others', '--exclude-standard'], { cwd }),
    ]);
    const files = [...diffOutput.trim().split('\n'), ...untrackedOutput.trim().split('\n')].filter(Boolean);
    return [...new Set(files)];
  } catch {
    return [];
  }
};

// Files a worktree changed relative to the base branch (post-commit).
export const getFilesModified = (cwd: string, baseRef: string): Promise<string[]> =>
  gitChangedFiles(cwd, `${baseRef}...HEAD`);

// Uncommitted changes in a working dir vs its current HEAD (tracked edits +
// untracked files). Used by the Tier-1 gate, which runs BEFORE autoCommit — the
// session's edits are still uncommitted, so a `base...HEAD` diff would miss them.
export const getUncommittedChanges = (cwd: string): Promise<string[]> => gitChangedFiles(cwd, 'HEAD');

export const autoCommit = async (
  cwd: string,
  commitMsg: string,
  log: Logger,
  forceAdd: string[] = [],
  scopedAdd: string[] = [],
): Promise<void> => {
  try {
    // Force-add gitignored contract outputs (e.g. under .claude/ai/) so they
    // survive worktree merge — `git status` filters them otherwise.
    const existing = forceAdd.filter((p) => existsSync(join(cwd, p)));
    if (existing.length) {
      try {
        await exec('git', ['add', '-f', '--', ...existing], { cwd });
      } catch (err) {
        log.warn(`forceAdd failed for [${existing.join(', ')}]: ${toErrorMessage(err)}`);
      }
    }
    // Scope `git add` to declared paths (task.context.files ∪ contract output paths).
    // When no scoped paths exist, fall back to `git add -A` (degenerate case).
    const useScoped = scopedAdd.length > 0;
    if (useScoped) {
      const dedupedScope = [...new Set([...scopedAdd, ...forceAdd])];
      try {
        await exec('git', ['add', '--', ...dedupedScope], { cwd });
      } catch (err) {
        log.warn(`scopedAdd failed for [${dedupedScope.join(', ')}]: ${toErrorMessage(err)}`);
      }
    }
    const { stdout: statusOut } = await exec('git', ['status', '--porcelain'], { cwd });
    if (statusOut.trim()) {
      if (!useScoped) {
        await exec('git', ['add', '-A'], { cwd });
      }
      const { stdout: stagedOut } = await exec('git', ['diff', '--cached', '--name-only'], { cwd });
      if (!stagedOut.trim()) {
        log.warn(`Auto-commit skipped: scoped paths produced no staged changes (scope=[${scopedAdd.join(', ')}])`);
        return;
      }
      await exec('git', ['commit', '-m', commitMsg], { cwd });
      log.info(`Auto-committed: ${commitMsg}`);
    }
  } catch (err) {
    log.warn(`Failed to auto-commit: ${toErrorMessage(err)}`);
  }
};
