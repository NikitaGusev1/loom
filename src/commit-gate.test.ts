import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { verifyOutputsCommitted } from './commit-gate.js';

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' });

describe('verifyOutputsCommitted', () => {
  let repo: string;

  before(() => {
    repo = mkdtempSync(join(tmpdir(), 'commit-gate-test-'));
    git(repo, 'init', '-b', 'main');
    git(repo, 'config', 'user.email', 'test@test');
    git(repo, 'config', 'user.name', 'test');
    writeFileSync(join(repo, 'committed.txt'), 'hello\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'init');
  });

  after(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('empty paths => {ok:true, offending:[]}', async () => {
    const r = await verifyOutputsCommitted(repo, []);
    assert.deepEqual(r, { ok: true, offending: [] });
  });

  it('committed clean file => ok:true, offending:[]', async () => {
    const r = await verifyOutputsCommitted(repo, ['committed.txt']);
    assert.deepEqual(r, { ok: true, offending: [] });
  });

  it('untracked file => ok:false, offending includes path', async () => {
    writeFileSync(join(repo, 'untracked.txt'), 'x\n');
    try {
      const r = await verifyOutputsCommitted(repo, ['untracked.txt']);
      assert.equal(r.ok, false);
      assert.deepEqual(r.offending, ['untracked.txt']);
    } finally {
      rmSync(join(repo, 'untracked.txt'));
    }
  });

  it('staged-not-committed => ok:false, offending includes path', async () => {
    writeFileSync(join(repo, 'staged.txt'), 'x\n');
    git(repo, 'add', 'staged.txt');
    try {
      const r = await verifyOutputsCommitted(repo, ['staged.txt']);
      assert.equal(r.ok, false);
      assert.deepEqual(r.offending, ['staged.txt']);
    } finally {
      git(repo, 'rm', '--cached', 'staged.txt');
      rmSync(join(repo, 'staged.txt'));
    }
  });

  it('absent from HEAD => ok:false, offending includes path', async () => {
    const r = await verifyOutputsCommitted(repo, ['nonexistent.txt']);
    assert.equal(r.ok, false);
    assert.deepEqual(r.offending, ['nonexistent.txt']);
  });

  it('multi-path: one committed clean, one untracked => ok:false, offending = [bad]', async () => {
    writeFileSync(join(repo, 'bad.txt'), 'x\n');
    try {
      const r = await verifyOutputsCommitted(repo, ['committed.txt', 'bad.txt']);
      assert.equal(r.ok, false);
      assert.deepEqual(r.offending, ['bad.txt']);
    } finally {
      rmSync(join(repo, 'bad.txt'));
    }
  });
});
