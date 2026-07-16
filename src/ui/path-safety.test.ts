import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { assertContainedArtifactPath } from './path-safety.js';

let root: string;
let external: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'loom-safe-root-'));
  external = mkdtempSync(join(tmpdir(), 'loom-safe-external-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(external, { recursive: true, force: true });
});

describe('artifact path safety', () => {
  it('accepts lexical descendants and rejects traversal', () => {
    assert.doesNotThrow(() => assertContainedArtifactPath(root, join(root, '.dag-executor', 'run.json')));
    assert.throws(() => assertContainedArtifactPath(root, join(root, '..', 'outside.json')), /escapes project/);
  });

  it('rejects existing symlink ancestors', () => {
    symlinkSync(external, join(root, '.dag-executor'));
    assert.throws(
      () => assertContainedArtifactPath(root, join(root, '.dag-executor', 'ui-inbox.json')),
      /symbolic link/,
    );
  });
});
