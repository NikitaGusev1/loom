import { lstat, realpath } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { exec } from '../exec.js';
import type { RiskScanContext, RiskScanDiffMetadata } from './types.js';

export type GitRunner = (cwd: string, args: string[]) => Promise<string>;

const defaultGitRunner: GitRunner = async (cwd, args) => {
  const { stdout } = await exec('git', args, { cwd, encoding: 'utf8' });
  return stdout;
};

const lines = (value: string): string[] => value.split(/\r?\n/u).filter(Boolean);
const nulPaths = (value: string): string[] => value.split('\0').filter(Boolean);
const sortedUnique = (values: Iterable<string>): string[] =>
  [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

const gitOptional = async (git: GitRunner, cwd: string, args: string[]): Promise<string | undefined> => {
  try {
    return (await git(cwd, args)).trim();
  } catch {
    return undefined;
  }
};

const resolveCommit = async (git: GitRunner, root: string, ref: string): Promise<string | undefined> =>
  gitOptional(git, root, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);

const defaultBaseRef = async (git: GitRunner, root: string): Promise<string> => {
  const remoteHead = await gitOptional(git, root, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  const candidates = [remoteHead, 'main', 'master'];
  const upstream = await gitOptional(git, root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  if (upstream) candidates.push(upstream);

  for (const candidate of candidates) {
    if (candidate && (await resolveCommit(git, root, candidate))) return candidate;
  }
  throw new Error(
    'Unable to resolve a Git base: origin/HEAD, main, master, and the current upstream are unavailable. Pass --base <ref>.',
  );
};

const containedFile = async (root: string, candidate: string, allowMissing: boolean): Promise<string> => {
  if (!candidate || isAbsolute(candidate))
    throw new Error(`Seed path must be repository-relative: ${candidate || '<empty>'}`);
  const segments = candidate.replaceAll('\\', '/').split('/');
  if (segments.includes('..')) throw new Error(`Seed path must not contain '..': ${candidate}`);

  const absolute = resolve(root, candidate);
  const normalized = relative(root, absolute).split(sep).join('/');
  let info;
  try {
    info = await lstat(absolute);
  } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return normalized;
    throw new Error(`Seed path does not exist: ${candidate}`);
  }
  if (info.isDirectory()) throw new Error(`Seed path must name a file: ${candidate}`);

  const resolved = await realpath(absolute);
  const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (resolved !== root && !resolved.startsWith(rootPrefix))
    throw new Error(`Seed path escapes the repository: ${candidate}`);
  return normalized;
};

export const parseExplicitSeedPaths = async (root: string, value: string): Promise<string[]> => {
  const repositoryRoot = await realpath(root);
  const candidates = value.split(',').map((path) => path.trim());
  if (candidates.length === 0 || candidates.some((path) => path.length === 0)) {
    throw new Error('--paths requires a comma-separated list of repository-relative files');
  }
  return sortedUnique(await Promise.all(candidates.map((path) => containedFile(repositoryRoot, path, false))));
};

const safeDerivedPaths = async (root: string, paths: string[]): Promise<string[]> => {
  const validated = await Promise.all(
    paths.map(async (path) => {
      try {
        return await containedFile(root, path, true);
      } catch {
        return undefined;
      }
    }),
  );
  return sortedUnique(validated.filter((path): path is string => path !== undefined));
};

const changedPaths = async (git: GitRunner, root: string, mergeBase: string): Promise<RiskScanDiffMetadata> => ({
  committed: await safeDerivedPaths(root, nulPaths(await git(root, ['diff', '--name-only', '-z', mergeBase, 'HEAD']))),
  staged: await safeDerivedPaths(root, nulPaths(await git(root, ['diff', '--cached', '--name-only', '-z']))),
  unstaged: await safeDerivedPaths(root, nulPaths(await git(root, ['diff', '--name-only', '-z']))),
  untracked: await safeDerivedPaths(
    root,
    nulPaths(await git(root, ['ls-files', '--others', '--exclude-standard', '-z'])),
  ),
});

export interface BuildRiskScanContextOptions {
  repo: string;
  base?: string;
  paths?: string;
  git?: GitRunner;
}

export const buildRiskScanContext = async ({
  repo,
  base,
  paths,
  git = defaultGitRunner,
}: BuildRiskScanContextOptions): Promise<RiskScanContext> => {
  const requestedRepo = await realpath(resolve(repo));
  const rootText = await git(requestedRepo, ['rev-parse', '--show-toplevel']).catch(() => {
    throw new Error(`Not a Git repository: ${repo}`);
  });
  const repositoryRoot = await realpath(rootText.trim());
  const head = (await git(repositoryRoot, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
  const baseRef = base ?? (await defaultBaseRef(git, repositoryRoot));
  const baseCommit = await resolveCommit(git, repositoryRoot, baseRef);
  if (!baseCommit) throw new Error(`Unable to resolve Git base ref: ${baseRef}`);
  const mergeBase = await gitOptional(git, repositoryRoot, ['merge-base', baseCommit, head]);
  if (!mergeBase) throw new Error(`No merge-base exists between ${baseRef} and HEAD`);

  const diff = await changedPaths(git, repositoryRoot, mergeBase);
  const seedPaths = paths
    ? await parseExplicitSeedPaths(repositoryRoot, paths)
    : sortedUnique([...diff.committed, ...diff.staged, ...diff.unstaged, ...diff.untracked]);
  const branch = (await gitOptional(git, repositoryRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'])) ?? null;
  const workingTreeStatus = lines(await git(repositoryRoot, ['status', '--short']));

  return {
    repositoryRoot,
    projectSlug: basename(repositoryRoot),
    branch,
    head,
    baseRef,
    baseCommit,
    mergeBase,
    workingTreeStatus,
    seedSource: paths ? 'explicit' : 'diff',
    seedPaths,
    noSeeds: seedPaths.length === 0,
    diff,
  };
};
