import { execFileSync } from 'node:child_process';
import type { UiGitStatus } from './types.js';

export const parseGitStatus = (output: string): UiGitStatus => {
  const lines = output.split('\n').filter(Boolean);
  const header = lines[0]?.startsWith('## ') ? (lines.shift()?.slice(3) ?? '') : '';
  const branch = header.split('...')[0]?.split(' [')[0]?.trim() || null;
  const ahead = Number(header.match(/ahead (\d+)/)?.[1] ?? 0);
  const behind = Number(header.match(/behind (\d+)/)?.[1] ?? 0);

  return {
    isRepository: true,
    branch,
    clean: lines.length === 0,
    changedFiles: lines.length,
    ahead,
    behind,
  };
};

export const readGitStatus = (projectPath: string): UiGitStatus => {
  try {
    const output = execFileSync('git', ['status', '--porcelain=v1', '--branch', '--untracked-files=all'], {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseGitStatus(output);
  } catch {
    return { isRepository: false, branch: null, clean: false, changedFiles: 0, ahead: 0, behind: 0 };
  }
};
