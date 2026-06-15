import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanSlots, renderSlotsStatus } from './slots-status.js';

let slotDir: string;

// PID 0x7FFFFFFF is effectively guaranteed not to exist → process.kill throws ESRCH.
const DEAD_PID = 2147483647;
const LIVE_PID = process.pid;

beforeEach(() => {
  slotDir = mkdtempSync(join(tmpdir(), 'dag-slots-status-'));
});

afterEach(() => {
  rmSync(slotDir, { recursive: true, force: true });
});

const writeSlot = (name: string, meta: unknown): void => writeFileSync(join(slotDir, name), JSON.stringify(meta));

describe('scanSlots', () => {
  it('returns an empty scan for a missing directory', () => {
    const scan = scanSlots(join(slotDir, 'does-not-exist'), 4);
    assert.deepEqual(scan, { maxSlots: 4, holders: [], waiters: [] });
  });

  it('returns an empty scan for an empty directory', () => {
    const scan = scanSlots(slotDir, 4);
    assert.equal(scan.holders.length, 0);
    assert.equal(scan.waiters.length, 0);
    assert.equal(scan.maxSlots, 4);
  });

  it('collects holders and live waiters', () => {
    writeSlot('slot-0', { pid: LIVE_PID, label: 'task-a', startedAt: new Date().toISOString() });
    writeSlot('slot-2', { pid: LIVE_PID, label: 'task-b', startedAt: new Date().toISOString() });
    writeSlot('wait-123-0', { pid: LIVE_PID, label: 'task-c', since: new Date().toISOString() });

    const scan = scanSlots(slotDir, 4);
    assert.equal(scan.holders.length, 2);
    assert.equal(scan.waiters.length, 1);
    // holders sorted by slot name
    assert.deepEqual(
      scan.holders.map((h) => h.slot),
      ['slot-0', 'slot-2'],
    );
    assert.equal(scan.waiters[0].label, 'task-c');
  });

  it('ignores non slot/wait entries', () => {
    writeSlot('other-file', { pid: LIVE_PID, label: 'x', startedAt: new Date().toISOString() });
    const scan = scanSlots(slotDir, 4);
    assert.equal(scan.holders.length, 0);
    assert.equal(scan.waiters.length, 0);
  });

  it('skips corrupt/empty files', () => {
    writeFileSync(join(slotDir, 'slot-0'), 'not-json');
    writeFileSync(join(slotDir, 'wait-1-0'), '');
    const scan = scanSlots(slotDir, 4);
    assert.equal(scan.holders.length, 0);
    assert.equal(scan.waiters.length, 0);
  });

  it('keeps a dead-PID holder but marks it stale', () => {
    writeSlot('slot-0', { pid: DEAD_PID, label: 'ghost', startedAt: new Date().toISOString() });
    writeSlot('slot-1', { pid: LIVE_PID, label: 'task-live', startedAt: new Date().toISOString() });
    const scan = scanSlots(slotDir, 4);
    assert.equal(scan.holders.length, 2);
    assert.equal(scan.holders.find((h) => h.slot === 'slot-0')?.stale, true);
    assert.equal(scan.holders.find((h) => h.slot === 'slot-1')?.stale, false);
  });

  it('filters out a dead-PID waiter', () => {
    writeSlot('wait-1-0', { pid: DEAD_PID, label: 'ghost', since: new Date().toISOString() });
    writeSlot('wait-2-0', { pid: LIVE_PID, label: 'task-live', since: new Date().toISOString() });
    const scan = scanSlots(slotDir, 4);
    assert.equal(scan.waiters.length, 1);
    assert.equal(scan.waiters[0].label, 'task-live');
  });

  it('sorts holders by numeric slot index, not lexicographically', () => {
    writeSlot('slot-0', { pid: LIVE_PID, label: 'a', startedAt: new Date().toISOString() });
    writeSlot('slot-10', { pid: LIVE_PID, label: 'b', startedAt: new Date().toISOString() });
    writeSlot('slot-2', { pid: LIVE_PID, label: 'c', startedAt: new Date().toISOString() });
    const scan = scanSlots(slotDir, 16);
    assert.deepEqual(
      scan.holders.map((h) => h.slot),
      ['slot-0', 'slot-2', 'slot-10'],
    );
  });

  it('sorts waiters with a missing since timestamp last', () => {
    writeSlot('wait-1-0', { pid: LIVE_PID, label: 'has-since', since: new Date().toISOString() });
    writeSlot('wait-2-0', { pid: LIVE_PID, label: 'no-since' }); // since missing → defaults to ''
    const scan = scanSlots(slotDir, 4);
    assert.deepEqual(
      scan.waiters.map((w) => w.label),
      ['has-since', 'no-since'],
    );
  });

  it('marks a holder with a non-positive PID stale instead of probing the process group', () => {
    // pid 0 / negatives target a process group in process.kill — must never be probed.
    writeSlot('slot-0', { pid: 0, label: 'bad', startedAt: new Date().toISOString() });
    const scan = scanSlots(slotDir, 4);
    assert.equal(scan.holders.find((h) => h.slot === 'slot-0')?.stale, true);
  });
});

describe('renderSlotsStatus', () => {
  it('renders the exact summary line', () => {
    const out = renderSlotsStatus({ maxSlots: 4, holders: [], waiters: [] });
    assert.equal(out, 'slots 0/4 held · 0 waiting');
  });

  it('counts holders and waiters in the summary', () => {
    const now = Date.now();
    const out = renderSlotsStatus(
      {
        maxSlots: 4,
        holders: [
          { slot: 'slot-0', pid: 10, label: 'task-a', startedAt: new Date(now - 252_000).toISOString(), stale: false },
        ],
        waiters: [{ pid: 11, label: 'task-b', since: new Date(now - 5_000).toISOString() }],
      },
      now,
    );
    const lines = out.split('\n');
    assert.equal(lines[0], 'slots 1/4 held · 1 waiting');
    // 252s → 4m12s duration formatter
    assert.match(lines[1], /slot-0\s+task-a\s+pid 10\s+4m12s/);
    assert.match(lines[2], /wait\s+task-b\s+pid 11\s+5s/);
  });

  it('marks stale holders', () => {
    const out = renderSlotsStatus({
      maxSlots: 4,
      holders: [{ slot: 'slot-0', pid: 99, label: 'ghost', startedAt: new Date().toISOString(), stale: true }],
      waiters: [],
    });
    assert.match(out, /\(stale\)/);
  });
});
