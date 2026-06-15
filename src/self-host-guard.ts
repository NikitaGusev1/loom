import { realpathSync, statSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { exec } from './exec.js';

/**
 * Self-host staleness guard. When dag-executor runs a DAG that modifies its OWN
 * source, the running npm-linked binary is the stale pre-change `build/` — so
 * the very code under repair executes in its broken form and can silently drop
 * work (observed: an export-only output dropped, task wrongly marked complete;
 * see BACKLOG "Supervised /auto-run hardening" #4). This refuses to run a stale
 * self-host build unless explicitly overridden.
 *
 * Self-host = the build dir and the target repo (`cwd`) share one git toplevel.
 * Stale = uncommitted changes under `src/`, OR a `src/*.ts` newer than the
 * newest compiled `build/*.js`.
 */
export interface StalenessVerdict {
  stale: boolean;
  reason?: string;
}

/** Pure decision: combine self-host detection with the two staleness signals. */
export const decideStale = (
  buildToplevel: string | null,
  cwdToplevel: string | null,
  srcDirty: boolean,
  srcNewerThanBuild: boolean,
): StalenessVerdict => {
  // Not self-host (different repo, or build dir not in any git repo) → never block.
  if (!buildToplevel || !cwdToplevel || buildToplevel !== cwdToplevel) return { stale: false };
  if (!srcDirty && !srcNewerThanBuild) return { stale: false };
  const reasons = [
    srcDirty && 'uncommitted changes under src/',
    srcNewerThanBuild && 'src/*.ts newer than build/*.js',
  ].filter(Boolean);
  return { stale: true, reason: `self-host run with ${reasons.join(' and ')}` };
};

const realpathOrSelf = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

// `git -C dir rev-parse --show-toplevel`, realpath-normalized. null if not a git repo.
const gitToplevel = async (dir: string): Promise<string | null> => {
  try {
    const { stdout } = await exec('git', ['-C', dir, 'rev-parse', '--show-toplevel']);
    return realpathOrSelf(stdout.trim());
  } catch {
    return null;
  }
};

const newestMtimeMs = (dir: string, ext: string): number => {
  if (!existsSync(dir)) return 0;
  let newest = 0;
  for (const entry of readdirSync(dir, { recursive: true, encoding: 'utf-8' })) {
    if (!entry.endsWith(ext)) continue;
    try {
      const m = statSync(join(dir, entry)).mtimeMs;
      if (m > newest) newest = m;
    } catch {
      /* unreadable entry — ignore */
    }
  }
  return newest;
};

/**
 * Gather the inputs and decide. `buildModuleUrl` is the running module's
 * `import.meta.url` — node resolves ESM symlinks, so for the npm-linked binary
 * this already points into the real source repo (realpath below is a defensive
 * no-op that also covers `--preserve-symlinks`).
 */
export const checkSelfHostStaleness = async (cwd: string, buildModuleUrl: string): Promise<StalenessVerdict> => {
  const buildDir = realpathOrSelf(dirname(fileURLToPath(buildModuleUrl))); // .../build
  const [buildTop, cwdTop] = await Promise.all([gitToplevel(buildDir), gitToplevel(realpathOrSelf(cwd))]);
  if (!buildTop || !cwdTop || buildTop !== cwdTop) return { stale: false };

  let srcDirty = false;
  try {
    const { stdout } = await exec('git', ['-C', buildTop, 'status', '--porcelain', '--', 'src']);
    srcDirty = stdout.trim().length > 0;
  } catch {
    /* git failure → leave srcDirty false; the mtime signal still applies */
  }

  const srcNewerThanBuild = newestMtimeMs(join(buildTop, 'src'), '.ts') > newestMtimeMs(join(buildTop, 'build'), '.js');

  return decideStale(buildTop, cwdTop, srcDirty, srcNewerThanBuild);
};
