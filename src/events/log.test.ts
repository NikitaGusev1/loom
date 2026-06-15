import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, appendFileSync as fsAppendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { appendEvent, readEvents, EventLogParseError } from './log.js';
import type { DagEvent } from './types.js';

const makeStartedEvent = (taskId: string): DagEvent => ({
  kind: 'task.started',
  schemaVersion: 1,
  ts: new Date().toISOString(),
  dagId: 'test-dag',
  taskId,
  taskName: taskId,
  layer: 0,
});

let tmpDir: string;
let logPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'evlog-test-'));
  logPath = join(tmpDir, 'test.events.jsonl');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Spawn a child process that appends `count` task.started events with taskId prefix `writerId`. */
const runWriter = (path: string, writerId: string, count: number): Promise<void> =>
  new Promise((resolve, reject) => {
    const code = `
import { appendFileSync } from 'node:fs';
const lp = ${JSON.stringify(path)};
const wid = ${JSON.stringify(writerId)};
for (let i = 0; i < ${count}; i++) {
  const line = JSON.stringify({
    kind: 'task.started',
    schemaVersion: 1,
    ts: new Date().toISOString(),
    dagId: 'atomicity-test',
    taskId: wid + '-' + i,
    taskName: wid,
    layer: 0,
  }) + '\\n';
  appendFileSync(lp, line, { encoding: 'utf-8', flag: 'a' });
}
`;
    const child = spawn(process.execPath, ['--input-type=module'], {
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    child.stdin.write(code);
    child.stdin.end();
    child.on('close', (exitCode) =>
      exitCode === 0 ? resolve() : reject(new Error(`Writer ${writerId} exited with code ${exitCode}`)),
    );
    child.on('error', reject);
  });

describe('appendEvent', () => {
  it('writes one line per call', () => {
    appendEvent(logPath, makeStartedEvent('task-a'));
    appendEvent(logPath, makeStartedEvent('task-b'));
    appendEvent(logPath, makeStartedEvent('task-c'));
    const raw = readFileSync(logPath, 'utf-8');
    const nonEmpty = raw.split('\n').filter((l) => l !== '');
    assert.equal(nonEmpty.length, 3);
    for (const line of nonEmpty) {
      assert.doesNotThrow(() => JSON.parse(line), `should be valid JSON: ${line}`);
    }
  });

  it('each appended line ends with a newline', () => {
    appendEvent(logPath, makeStartedEvent('task-a'));
    const raw = readFileSync(logPath, 'utf-8');
    assert.ok(raw.endsWith('\n'), 'appended content must end with \\n');
  });
});

describe('readEvents', () => {
  it('returns empty array for non-existent file', () => {
    const events = readEvents(join(tmpDir, 'nonexistent.jsonl'));
    assert.deepEqual(events, []);
  });

  it('returns events in append order', () => {
    const ids = ['first', 'second', 'third'];
    for (const id of ids) {
      appendEvent(logPath, makeStartedEvent(id));
    }
    const events = readEvents(logPath);
    assert.equal(events.length, 3);
    for (let i = 0; i < ids.length; i++) {
      assert.equal((events[i] as { taskId: string }).taskId, ids[i]);
    }
  });

  it('skips blank lines', () => {
    appendEvent(logPath, makeStartedEvent('task-a'));
    appendEvent(logPath, makeStartedEvent('task-b'));
    const raw = readFileSync(logPath, 'utf-8');
    // inject blank lines before, between, and after valid lines
    writeFileSync(logPath, `\n${raw}\n`);
    const events = readEvents(logPath);
    assert.equal(events.length, 2);
  });

  it('throws EventLogParseError with correct lineNumber on partial trailing line', () => {
    appendEvent(logPath, makeStartedEvent('task-a'));
    // append a corrupt line — truncated JSON, missing closing brace
    fsAppendFileSync(logPath, '{"kind":"task.started","partial":true\n');
    let thrown: unknown;
    try {
      readEvents(logPath);
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown instanceof EventLogParseError, `expected EventLogParseError, got ${thrown}`);
    assert.equal((thrown as EventLogParseError).lineNumber, 2);
  });
});

describe('atomicity', () => {
  it('concurrent writers from two child processes produce no interleaved lines', async () => {
    const COUNT = 50;
    await Promise.all([runWriter(logPath, 'writer-A', COUNT), runWriter(logPath, 'writer-B', COUNT)]);
    // readEvents throws EventLogParseError if any line was corrupted/interleaved
    const events = readEvents(logPath);
    assert.equal(events.length, COUNT * 2, `expected ${COUNT * 2} events, got ${events.length}`);
    const aEvents = events.filter((e) => (e as { taskId?: string }).taskId?.startsWith('writer-A'));
    const bEvents = events.filter((e) => (e as { taskId?: string }).taskId?.startsWith('writer-B'));
    assert.equal(aEvents.length, COUNT, `writer-A should have ${COUNT} events`);
    assert.equal(bEvents.length, COUNT, `writer-B should have ${COUNT} events`);
  });
});
