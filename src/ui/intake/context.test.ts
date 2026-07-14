import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectIntakeContext } from './context.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'intake-context-'));
  writeFileSync(join(dir, 'README.md'), 'Project guidance');
  writeFileSync(join(dir, '.env'), 'SECRET=value');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'index.ts'), 'export {}');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('collectIntakeContext', () => {
  it('collects bounded context and excludes secret-looking files', () => {
    const context = collectIntakeContext(dir, ['src/active.ts']);
    assert.equal(context.projectName, dir.split('/').at(-1));
    assert.equal(context.files.includes('src/index.ts'), true);
    assert.equal(context.files.includes('.env'), false);
    assert.deepEqual(context.activeSequentialFiles, ['src/active.ts']);
    assert.equal(context.git.isRepository, false);
  });
});
