import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  archiveDag,
  classifyDags,
  DagArchiveConflictError,
  getDagArchivePath,
  readDagArchive,
  restoreDag,
} from './dag-archive.js';
import type { UiDagListItem } from './types.js';

let artifactsDir: string;
beforeEach(() => {
  artifactsDir = mkdtempSync(join(tmpdir(), 'loom-dag-archive-'));
});
afterEach(() => rmSync(artifactsDir, { recursive: true, force: true }));

const dag = (relativePath: string, status: UiDagListItem['status'] = 'completed'): UiDagListItem => ({
  path: `/repo/${relativePath}`,
  relativePath,
  eventLogPath: `/repo/${relativePath}.events`,
  statePath: `/repo/${relativePath}.state`,
  id: relativePath,
  title: relativePath,
  status,
  totalTasks: 1,
  completedTasks: status === 'completed' ? 1 : 0,
  failedTasks: 0,
  runningTasks: 0,
  updatedAt: null,
  errors: [],
});

describe('DAG archive', () => {
  it('starts empty and archives/restores idempotently', async () => {
    assert.deepEqual(readDagArchive(artifactsDir, 'demo').items, []);
    await archiveDag(artifactsDir, 'demo', dag('b.json'), () => 'now');
    await archiveDag(artifactsDir, 'demo', dag('b.json'), () => 'later');
    assert.deepEqual(readDagArchive(artifactsDir, 'demo').items, [{ relativePath: 'b.json', archivedAt: 'now' }]);
    await restoreDag(artifactsDir, 'demo', 'b.json');
    await restoreDag(artifactsDir, 'demo', 'b.json');
    assert.deepEqual(readDagArchive(artifactsDir, 'demo').items, []);
  });

  it('serializes concurrent updates and writes deterministic order', async () => {
    await Promise.all([
      archiveDag(artifactsDir, 'demo', dag('z.json'), () => 'z'),
      archiveDag(artifactsDir, 'demo', dag('a.json'), () => 'a'),
    ]);
    assert.deepEqual(
      readDagArchive(artifactsDir, 'demo').items.map((item) => item.relativePath),
      ['a.json', 'z.json'],
    );
  });

  it('rejects incomplete DAGs without creating metadata', async () => {
    await assert.rejects(() => archiveDag(artifactsDir, 'demo', dag('work.json', 'paused')), DagArchiveConflictError);
    assert.equal(existsSync(getDagArchivePath(artifactsDir, 'demo')), false);
  });

  it('classifies active, history, archived, and stale records', () => {
    const result = classifyDags([dag('active.json', 'running'), dag('history.json'), dag('archived.json')], {
      schemaVersion: 1,
      items: [
        { relativePath: 'archived.json', archivedAt: 'now' },
        { relativePath: 'gone.json', archivedAt: 'before' },
      ],
    });
    assert.deepEqual(
      result.active.map((item) => item.relativePath),
      ['active.json'],
    );
    assert.deepEqual(
      result.history.map((item) => item.relativePath),
      ['history.json'],
    );
    assert.deepEqual(
      result.archived.map((item) => item.relativePath),
      ['archived.json'],
    );
    assert.equal(result.errors.length, 1);
  });

  it('rejects malformed metadata', () => {
    const path = getDagArchivePath(artifactsDir, 'demo');
    mkdirSync(join(artifactsDir, 'projects', 'demo', 'runs'), { recursive: true });
    writeFileSync(path, JSON.stringify({ schemaVersion: 2, items: [] }), { flush: true });
    assert.throws(() => readDagArchive(artifactsDir, 'demo'));
  });

  it('does not modify source DAG bytes', async () => {
    const source = join(artifactsDir, 'source.json');
    writeFileSync(source, 'source bytes');
    const before = readFileSync(source, 'utf-8');
    await archiveDag(artifactsDir, 'demo', dag('source.json'));
    assert.equal(readFileSync(source, 'utf-8'), before);
  });
});
