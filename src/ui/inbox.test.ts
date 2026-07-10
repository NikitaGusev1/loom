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
    assert.deepEqual(readInbox(projectDir), { schemaVersion: 1, items: [] });
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
