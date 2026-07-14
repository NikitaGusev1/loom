import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { buildRiskScanContext, parseExplicitSeedPaths } from './context.js';

const repositories: string[] = [];
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' });

const makeRepo = (): string => {
  const repo = mkdtempSync(join(tmpdir(), 'risk-context-'));
  repositories.push(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'risk@test');
  git(repo, 'config', 'user.name', 'Risk Test');
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'base');
  return repo;
};

afterEach(() => {
  for (const repo of repositories.splice(0)) rmSync(repo, { recursive: true, force: true });
});

describe('buildRiskScanContext', () => {
  it('discovers committed, staged, unstaged, and untracked non-ignored seeds in stable order', async () => {
    const repo = makeRepo();
    git(repo, 'checkout', '-b', 'feature');
    writeFileSync(join(repo, 'committed.txt'), 'committed\n');
    git(repo, 'add', 'committed.txt');
    git(repo, 'commit', '-m', 'feature');
    writeFileSync(join(repo, 'staged.txt'), 'staged\n');
    git(repo, 'add', 'staged.txt');
    writeFileSync(join(repo, 'base.txt'), 'changed\n');
    writeFileSync(join(repo, 'untracked.txt'), 'untracked\n');
    writeFileSync(join(repo, 'line\nbreak.txt'), 'nul-delimited\n');
    writeFileSync(join(repo, '.gitignore'), 'ignored.txt\n');
    writeFileSync(join(repo, 'ignored.txt'), 'ignored\n');

    const context = await buildRiskScanContext({ repo, base: 'main' });

    assert.deepEqual(context.diff.committed, ['committed.txt']);
    assert.deepEqual(context.diff.staged, ['staged.txt']);
    assert.deepEqual(context.diff.unstaged, ['base.txt']);
    assert.deepEqual(context.diff.untracked, ['.gitignore', 'line\nbreak.txt', 'untracked.txt']);
    assert.deepEqual(context.seedPaths, [
      '.gitignore',
      'base.txt',
      'committed.txt',
      'line\nbreak.txt',
      'staged.txt',
      'untracked.txt',
    ]);
    assert.equal(context.noSeeds, false);
    assert.equal(context.baseRef, 'main');
  });

  it('uses main as the safe default fallback and returns a structured no-seeds result', async () => {
    const repo = makeRepo();
    const context = await buildRiskScanContext({ repo });
    assert.equal(context.baseRef, 'main');
    assert.deepEqual(context.seedPaths, []);
    assert.equal(context.noSeeds, true);
  });

  it('deduplicates explicit paths and rejects missing, absolute, traversal, directory, and escaping symlink paths', async () => {
    const repo = makeRepo();
    mkdirSync(join(repo, 'directory'));
    const outside = mkdtempSync(join(tmpdir(), 'risk-outside-'));
    repositories.push(outside);
    writeFileSync(join(outside, 'secret.txt'), 'secret\n');
    symlinkSync(join(outside, 'secret.txt'), join(repo, 'escape.txt'));

    assert.deepEqual(await parseExplicitSeedPaths(repo, 'base.txt,base.txt'), ['base.txt']);
    await assert.rejects(parseExplicitSeedPaths(repo, 'missing.txt'), /does not exist/u);
    await assert.rejects(parseExplicitSeedPaths(repo, join(repo, 'base.txt')), /repository-relative/u);
    await assert.rejects(parseExplicitSeedPaths(repo, '../base.txt'), /must not contain/u);
    await assert.rejects(parseExplicitSeedPaths(repo, 'directory'), /must name a file/u);
    await assert.rejects(parseExplicitSeedPaths(repo, 'escape.txt'), /escapes the repository/u);
  });

  it('keeps missing deletion seeds while filtering tracked and untracked symlinks that escape the worktree', async () => {
    const repo = makeRepo();
    const outside = mkdtempSync(join(tmpdir(), 'risk-outside-'));
    repositories.push(outside);
    writeFileSync(join(outside, 'secret.txt'), 'secret\n');
    git(repo, 'checkout', '-b', 'feature');
    symlinkSync(join(outside, 'secret.txt'), join(repo, 'tracked-escape.txt'));
    git(repo, 'add', 'tracked-escape.txt');
    git(repo, 'commit', '-m', 'tracked escaping symlink');
    symlinkSync(join(outside, 'secret.txt'), join(repo, 'untracked-escape.txt'));
    rmSync(join(repo, 'base.txt'));

    const context = await buildRiskScanContext({ repo, base: 'main' });

    assert.deepEqual(context.diff.committed, []);
    assert.deepEqual(context.diff.untracked, []);
    assert.deepEqual(context.diff.unstaged, ['base.txt']);
    assert.deepEqual(context.seedPaths, ['base.txt']);
    assert.equal(context.noSeeds, false);
  });

  it('prefers origin HEAD over local fallback branches', async () => {
    const repo = makeRepo();
    git(repo, 'branch', 'trunk');
    git(repo, 'update-ref', 'refs/remotes/origin/trunk', 'trunk');
    git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');

    const context = await buildRiskScanContext({ repo });

    assert.equal(context.baseRef, 'refs/remotes/origin/trunk');
  });
});
