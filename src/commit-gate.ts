import { exec } from './exec.js';

export type CommitGateResult = { ok: boolean; offending: string[] };

export const verifyOutputsCommitted = async (cwd: string, declaredPaths: string[]): Promise<CommitGateResult> => {
  if (declaredPaths.length === 0) return { ok: true, offending: [] };

  const offendingSet = new Set<string>();

  for (const p of declaredPaths) {
    // Dirty or untracked?
    const { stdout } = await exec('git', ['status', '--porcelain', '--', p], { cwd });
    if (stdout.trim().length > 0) offendingSet.add(p);

    // Absent from HEAD?
    try {
      await exec('git', ['cat-file', '-e', `HEAD:${p}`], { cwd });
    } catch {
      offendingSet.add(p);
    }
  }

  const offending = [...offendingSet];
  return { ok: offending.length === 0, offending };
};
