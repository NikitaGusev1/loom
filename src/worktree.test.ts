import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { mergeLayerWorktrees } from './worktree.js';

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' });

// Integration tests against a real temp git repo: mergeLayerWorktrees shells
// out via exec(), so module-level mocking would only re-test the mock.
// The two its are deliberately ordered — the second resumes over the state the
// first leaves behind (partial merge aborted by a conflict), mirroring the
// real pause -> resume sequence.
describe('mergeLayerWorktrees', () => {
  let repo: string;
  let prevCwd: string;

  const commitFile = (file: string, content: string, message: string): void => {
    writeFileSync(join(repo, file), content);
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', message);
  };

  const branchWithCommit = (taskId: string, file: string, content: string): void => {
    git(repo, 'checkout', '-b', `dag/${taskId}`);
    commitFile(file, content, `task ${taskId}`);
    git(repo, 'checkout', 'main');
  };

  before(() => {
    prevCwd = process.cwd();
    repo = mkdtempSync(join(tmpdir(), 'wt-merge-test-'));
    git(repo, 'init', '-b', 'main');
    git(repo, 'config', 'user.email', 'test@test');
    git(repo, 'config', 'user.name', 'test');
    commitFile('conflict.txt', 'base\n', 'init');

    branchWithCommit('t1', 'a.txt', 'a\n');
    branchWithCommit('t2', 'conflict.txt', 'branch change\n');
    branchWithCommit('t3', 'c.txt', 'c\n');
    // Advance main on the same line dag/t2 touched -> its merge conflicts.
    commitFile('conflict.txt', 'main change\n', 'conflicting main commit');

    process.chdir(repo);
  });

  after(() => {
    process.chdir(prevCwd);
    rmSync(repo, { recursive: true, force: true });
  });

  it('reports each merged task via onMerged before a later conflict aborts the loop', async () => {
    const merged: string[] = [];
    const result = await mergeLayerWorktrees(['t1', 't2', 't3'], (id) => merged.push(id));

    assert.equal(result.success, false);
    assert.equal(result.failedAt, 't2');
    // t1 merged+cleaned before the conflict and MUST be reported — emitting
    // only after the whole call would leave it merged:false forever.
    assert.deepEqual(merged, ['t1']);
    // t1's branch was cleaned up; t3 (after the conflict) was never reached.
    assert.throws(() => git(repo, 'rev-parse', '--verify', 'dag/t1'));
    git(repo, 'rev-parse', '--verify', 'dag/t3');
  });

  it('treats an already-gone branch as merged so resume is idempotent', async () => {
    // Resume shape after the conflict above: dag/t1 deleted by the first pass,
    // t3 still pending. A gone branch must report merged, not silently skip.
    const merged: string[] = [];
    const result = await mergeLayerWorktrees(['t1', 't3'], (id) => merged.push(id));

    assert.equal(result.success, true);
    assert.deepEqual(merged, ['t1', 't3']);
  });
});
