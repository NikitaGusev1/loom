import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PROJECT_MEMORY_PATH, describeProjectMemory, loadProjectMemory } from './memory.js';

describe('loadProjectMemory', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dag-memory-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null when the default memory file is absent', () => {
    assert.equal(loadProjectMemory({ cwd: dir }), null);
  });

  it('throws when an explicit memory path is absent', () => {
    assert.throws(() => loadProjectMemory({ cwd: dir, path: 'missing.md' }), /Project memory file not found/);
  });

  it('loads the default curated memory file', () => {
    const memoryPath = join(dir, DEFAULT_PROJECT_MEMORY_PATH);
    mkdirSync(join(dir, '.dag-executor'), { recursive: true });
    writeFileSync(memoryPath, '\n- Prefer focused task scopes.\n');

    assert.deepEqual(loadProjectMemory({ cwd: dir }), {
      path: DEFAULT_PROJECT_MEMORY_PATH,
      content: '- Prefer focused task scopes.',
      truncated: false,
    });
  });

  it('caps memory content on a line boundary', () => {
    writeFileSync(join(dir, 'memory.md'), ['first lesson', 'second lesson', 'third lesson'].join('\n'));

    assert.deepEqual(loadProjectMemory({ cwd: dir, path: 'memory.md', maxChars: 15 }), {
      path: 'memory.md',
      content: 'first lesson',
      truncated: true,
    });
  });

  it('can be disabled explicitly', () => {
    writeFileSync(join(dir, 'memory.md'), 'useful lesson');

    assert.equal(loadProjectMemory({ cwd: dir, path: 'memory.md', disabled: true }), null);
  });
});

describe('describeProjectMemory', () => {
  it('formats loaded, truncated, disabled, and absent states', () => {
    assert.equal(
      describeProjectMemory({ path: 'memory.md', content: 'lesson', truncated: false }),
      'Project memory: loaded memory.md.',
    );
    assert.equal(
      describeProjectMemory({ path: 'memory.md', content: 'lesson', truncated: true }),
      'Project memory: loaded memory.md (truncated).',
    );
    assert.equal(describeProjectMemory(null, true), 'Project memory: disabled (--no-memory).');
    assert.equal(describeProjectMemory(null), null);
  });
});
