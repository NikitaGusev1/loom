import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { defaultSupervisorQueuePath, readSupervisorQueue, SupervisorQueueClient } from './supervisor-queue.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'supervisor-queue-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('typed supervisor queue reader', () => {
  it('returns an empty queue when absent and validates persisted items', () => {
    const path = defaultSupervisorQueuePath(dir);
    assert.deepEqual(readSupervisorQueue(path).items, []);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: 1,
        updatedAt: 'now',
        items: [{ id: 'q1', dagPath: '/d.json', status: 'queued', priority: 3 }],
      }),
    );
    assert.equal(readSupervisorQueue(path).items[0].priority, 3);
  });
  it('rejects malformed queue records', () => {
    const path = defaultSupervisorQueuePath(dir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, updatedAt: 'now', items: [{}] }));
    assert.throws(() => readSupervisorQueue(path), /Invalid supervisor queue item/);
  });

  it('starts the detached worker after enqueue and tolerates an existing worker', async () => {
    const scriptPath = join(dir, 'fake-supervisor.cjs');
    const callsPath = join(dir, 'calls.jsonl');
    const dagPath = join(dir, 'work.json');
    writeFileSync(dagPath, '{}');
    writeFileSync(
      scriptPath,
      `const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(process.argv.slice(2)) + '\\n');
process.exit(process.argv.includes('--queue-run') ? 4 : 0);
`,
    );

    const client = new SupervisorQueueClient(dir, defaultSupervisorQueuePath(dir), scriptPath);
    await client.add(dagPath, 7);

    const calls = readFileSync(callsPath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(calls[0].slice(0, 3), ['--queue-add', dagPath, '--priority=7']);
    assert.deepEqual(calls[1].slice(0, 2), ['--queue-run', '--detach']);
  });
});
