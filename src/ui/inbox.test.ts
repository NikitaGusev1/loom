import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  InboxParseError,
  archiveInboxItem,
  createInboxItem,
  getInboxPath,
  readInbox,
  updateInboxItemStatus,
} from './inbox.js';

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'dag-ui-inbox-'));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe('ui inbox persistence', () => {
  it('returns an empty inbox when the file does not exist', () => {
    assert.deepEqual(readInbox(projectDir), {
      schemaVersion: 2,
      items: [],
      jobs: [],
      policy: { autoRunEnabled: true, confidenceThreshold: 0.85, triageProvider: 'codex' },
    });
  });

  it('migrates a v1 inbox on the next write without losing items', () => {
    const path = getInboxPath(projectDir);
    mkdirSync(dirname(path), { recursive: true });
    const original = {
      id: 'ui-todo-news-app',
      createdAt: '2026-07-11T13:32:56.439Z',
      updatedAt: '2026-07-11T13:32:56.439Z',
      body: 'test todo - move it to done after seeing it',
      status: 'open',
      source: 'ui',
      linkedDagPath: null,
      linkedTaskId: null,
    };
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, items: [original] }), 'utf-8');

    createInboxItem(projectDir, 'Second item', { id: () => 'second', now: () => '2026-07-11T14:00:00.000Z' });

    const persisted = JSON.parse(readFileSync(path, 'utf-8'));
    assert.equal(persisted.schemaVersion, 2);
    assert.deepEqual(persisted.items[0], original);
    assert.equal(persisted.items[1].id, 'second');
  });

  it('creates the inbox file and appends generated items', () => {
    const item = createInboxItem(projectDir, 'Show active DAG progress', {
      now: () => '2026-07-10T10:00:00.000Z',
      id: () => 'ui-todo-20260710-000001',
    });

    assert.equal(item.id, 'ui-todo-20260710-000001');
    assert.equal(item.body, 'Show active DAG progress');
    assert.equal(item.status, 'open');
    assert.equal(existsSync(getInboxPath(projectDir)), true);
    assert.deepEqual(readInbox(projectDir).items, [item]);
  });

  it('loads additive clarification transcripts from schema v2', () => {
    const path = getInboxPath(projectDir);
    mkdirSync(dirname(path), { recursive: true });
    const item = {
      id: 'todo-1',
      createdAt: 'now',
      updatedAt: 'now',
      body: 'Improve intake',
      status: 'open',
      source: 'ui',
      linkedDagPath: null,
      linkedTaskId: null,
      clarificationRounds: 1,
      clarificationMessages: [
        { id: 'm1', role: 'loom', content: 'Which surface?', createdAt: 'now', proposalRevision: 1 },
      ],
    };
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: 2,
        items: [item],
        jobs: [],
        policy: { autoRunEnabled: true, confidenceThreshold: 0.85, triageProvider: 'codex' },
      }),
    );
    assert.deepEqual(readInbox(projectDir).items[0], item);
  });

  it('loads and validates optional queue links and revision proposals from schema v2', () => {
    const path = getInboxPath(projectDir);
    mkdirSync(dirname(path), { recursive: true });
    const item = {
      id: 'todo-1',
      createdAt: 'now',
      updatedAt: 'now',
      body: 'Improve intake',
      status: 'open',
      source: 'ui',
      linkedDagPath: null,
      linkedTaskId: null,
      linkedQueueId: 'queue-1',
      proposal: { revision: 1, affectedFiles: ['src/ui/inbox.ts'] },
    };
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: 2,
        items: [item],
        jobs: [],
        policy: { autoRunEnabled: true, confidenceThreshold: 0.85, triageProvider: 'codex' },
      }),
    );

    assert.deepEqual(readInbox(projectDir).items[0], item);
  });

  it('rejects revision proposals with more than twenty affected files', () => {
    const path = getInboxPath(projectDir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: 2,
        items: [
          {
            id: 'todo-1',
            createdAt: 'now',
            updatedAt: 'now',
            body: 'Improve intake',
            status: 'open',
            source: 'ui',
            linkedDagPath: null,
            linkedTaskId: null,
            proposal: { revision: 1, affectedFiles: Array.from({ length: 21 }, (_, index) => `file-${index}`) },
          },
        ],
        jobs: [],
        policy: { autoRunEnabled: true, confidenceThreshold: 0.85, triageProvider: 'codex' },
      }),
    );

    assert.throws(() => readInbox(projectDir), InboxParseError);
  });

  it('rejects malformed clarification transcript fields', () => {
    const path = getInboxPath(projectDir);
    mkdirSync(dirname(path), { recursive: true });
    const file = {
      schemaVersion: 2,
      items: [
        {
          id: 'todo-1',
          createdAt: 'now',
          updatedAt: 'now',
          body: 'Improve intake',
          status: 'open',
          source: 'ui',
          linkedDagPath: null,
          linkedTaskId: null,
          clarificationRounds: -1,
        },
      ],
      jobs: [],
      policy: { autoRunEnabled: true, confidenceThreshold: 0.85, triageProvider: 'codex' },
    };
    writeFileSync(path, JSON.stringify(file));
    assert.throws(() => readInbox(projectDir), InboxParseError);
  });

  it('rejects empty todo body text', () => {
    assert.throws(() => createInboxItem(projectDir, '   '), /Inbox item body is required/);
  });

  it('updates item status while preserving linked metadata', () => {
    const item = createInboxItem(projectDir, 'Convert me', {
      now: () => '2026-07-10T10:00:00.000Z',
      id: () => 'ui-todo-20260710-000001',
    });

    const updated = updateInboxItemStatus(projectDir, item.id, 'converted', {
      now: () => '2026-07-10T10:05:00.000Z',
      linkedDagPath: '/repo/work.json',
      linkedTaskId: 'task-a',
    });

    assert.equal(updated.status, 'converted');
    assert.equal(updated.updatedAt, '2026-07-10T10:05:00.000Z');
    assert.equal(updated.linkedDagPath, '/repo/work.json');
    assert.equal(updated.linkedTaskId, 'task-a');
  });

  it('clears linked metadata with explicit null updates', () => {
    const item = createInboxItem(projectDir, 'Clear links', {
      now: () => '2026-07-10T10:00:00.000Z',
      id: () => 'ui-todo-20260710-000001',
    });

    updateInboxItemStatus(projectDir, item.id, 'converted', {
      now: () => '2026-07-10T10:05:00.000Z',
      linkedDagPath: '/repo/work.json',
      linkedTaskId: 'task-a',
    });

    const updated = updateInboxItemStatus(projectDir, item.id, 'converted', {
      now: () => '2026-07-10T10:06:00.000Z',
      linkedDagPath: null,
      linkedTaskId: null,
    });

    assert.equal(updated.linkedDagPath, null);
    assert.equal(updated.linkedTaskId, null);
  });

  it('archives an item through the archive helper', () => {
    const item = createInboxItem(projectDir, 'Archive me', {
      now: () => '2026-07-10T10:00:00.000Z',
      id: () => 'ui-todo-20260710-000001',
    });

    const archived = archiveInboxItem(projectDir, item.id, { now: () => '2026-07-10T10:06:00.000Z' });

    assert.equal(archived.status, 'archived');
  });

  it('throws when updating an unknown item', () => {
    assert.throws(() => updateInboxItemStatus(projectDir, 'missing', 'archived'), /Inbox item "missing" not found/);
  });

  it('refuses to overwrite malformed inbox JSON', () => {
    const inboxPath = getInboxPath(projectDir);
    mkdirSync(dirname(inboxPath), { recursive: true });
    writeFileSync(inboxPath, '{bad json', 'utf-8');

    assert.throws(() => readInbox(projectDir), InboxParseError);
    assert.throws(() => createInboxItem(projectDir, 'New work'), InboxParseError);
    assert.equal(readFileSync(inboxPath, 'utf-8'), '{bad json');
  });

  it('rejects parseable inbox JSON with missing item fields', () => {
    const inboxPath = getInboxPath(projectDir);
    mkdirSync(dirname(inboxPath), { recursive: true });
    writeFileSync(
      inboxPath,
      JSON.stringify({
        schemaVersion: 1,
        items: [
          {
            id: 'ui-todo-20260710-000001',
            updatedAt: '2026-07-10T10:00:00.000Z',
            body: 'Missing createdAt',
            status: 'open',
            source: 'ui',
            linkedDagPath: null,
            linkedTaskId: null,
          },
        ],
      }),
      'utf-8',
    );

    assert.throws(() => readInbox(projectDir), InboxParseError);
  });
});
