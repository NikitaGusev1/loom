import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireSlot } from './semaphore.js';

let slotDir: string;

beforeEach(() => {
  slotDir = mkdtempSync(join(tmpdir(), 'dag-slots-'));
});

afterEach(() => {
  rmSync(slotDir, { recursive: true, force: true });
});

const slotCount = (): number => readdirSync(slotDir).filter((n) => n.startsWith('slot-')).length;
const waitCount = (): number => readdirSync(slotDir).filter((n) => n.startsWith('wait-')).length;

// Poll until `predicate` holds or `timeoutMs` elapses (avoids fixed-sleep flakiness).
const waitFor = async (predicate: () => boolean, timeoutMs = 1000): Promise<void> => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((res) => setTimeout(res, 5));
  }
};

describe('acquireSlot', () => {
  it('creates a slot file and removes it on release', async () => {
    const release = await acquireSlot('task-a', { slotDir, maxSlots: 2, pollMs: 10 });
    assert.equal(slotCount(), 1);
    release();
    assert.equal(slotCount(), 0);
  });

  it('release is idempotent', async () => {
    const release = await acquireSlot('task-a', { slotDir, maxSlots: 2, pollMs: 10 });
    release();
    release(); // must not throw or remove an unrelated slot
    assert.equal(slotCount(), 0);
  });

  it('blocks when all slots are busy, resumes when one frees', async () => {
    const r1 = await acquireSlot('task-1', { slotDir, maxSlots: 1, pollMs: 10 });
    assert.equal(slotCount(), 1);

    let secondAcquired = false;
    const pending = acquireSlot('task-2', { slotDir, maxSlots: 1, pollMs: 10 }).then((rel) => {
      secondAcquired = true;
      return rel;
    });

    // Give the waiter a few poll cycles; it must still be blocked.
    await new Promise((res) => setTimeout(res, 50));
    assert.equal(secondAcquired, false, 'second acquire should block while slot is held');

    r1();
    const r2 = await pending;
    assert.equal(secondAcquired, true);
    assert.equal(slotCount(), 1);
    r2();
    assert.equal(slotCount(), 0);
  });

  it('reclaims a slot held by a dead PID', async () => {
    // PID 0x7FFFFFFF is effectively guaranteed not to exist → process.kill throws ESRCH.
    const deadPid = 2147483647;
    writeFileSync(
      join(slotDir, 'slot-0'),
      JSON.stringify({ pid: deadPid, label: 'ghost', startedAt: new Date().toISOString() }),
    );

    const release = await acquireSlot('task-live', { slotDir, maxSlots: 1, pollMs: 10 });
    assert.equal(slotCount(), 1); // ghost reclaimed, live holder occupies the single slot
    release();
    assert.equal(slotCount(), 0);
  });

  it('reclaims a slot held by an invalid PID (0), not treating it as alive', async () => {
    // pid 0 / negatives target a process group in process.kill(pid, 0) — must be
    // treated as dead and reclaimed, never probed.
    writeFileSync(
      join(slotDir, 'slot-0'),
      JSON.stringify({ pid: 0, label: 'ghost', startedAt: new Date().toISOString() }),
    );
    const release = await acquireSlot('task-live', { slotDir, maxSlots: 1, pollMs: 10 });
    assert.equal(slotCount(), 1); // invalid-PID ghost reclaimed; live task takes the single slot
    release();
    assert.equal(slotCount(), 0);
  });

  it('reclaims a corrupt slot file', async () => {
    writeFileSync(join(slotDir, 'slot-0'), 'not-json');
    const release = await acquireSlot('task-live', { slotDir, maxSlots: 1, pollMs: 10 });
    assert.equal(existsSync(join(slotDir, 'slot-0')), true);
    release();
    assert.equal(slotCount(), 0);
  });

  it('rejects when the abort signal fires while waiting', async () => {
    const r1 = await acquireSlot('task-1', { slotDir, maxSlots: 1, pollMs: 10 });
    const ac = new AbortController();
    const pending = acquireSlot('task-2', { slotDir, maxSlots: 1, pollMs: 10, signal: ac.signal });
    setTimeout(() => ac.abort(), 30);
    await assert.rejects(pending, /Aborted while waiting/);
    r1();
  });
});

describe('acquireSlot waiter markers', () => {
  it('writes no marker when a slot is acquired immediately', async () => {
    const release = await acquireSlot('task-a', { slotDir, maxSlots: 2, pollMs: 10 });
    assert.equal(waitCount(), 0);
    release();
  });

  it('creates a marker while parked and removes it on acquisition', async () => {
    const r1 = await acquireSlot('task-1', { slotDir, maxSlots: 1, pollMs: 10 });

    let acquired = false;
    const pending = acquireSlot('task-2', { slotDir, maxSlots: 1, pollMs: 10 }).then((rel) => {
      acquired = true;
      return rel;
    });

    await waitFor(() => waitCount() === 1);
    assert.equal(acquired, false, 'second acquire should still be parked');

    r1();
    const r2 = await pending;
    assert.equal(acquired, true);
    assert.equal(waitCount(), 0, 'marker removed once the slot is acquired');
    r2();
  });

  it('removes the marker when the abort signal fires while waiting', async () => {
    const r1 = await acquireSlot('task-1', { slotDir, maxSlots: 1, pollMs: 10 });
    const ac = new AbortController();
    const pending = acquireSlot('task-2', { slotDir, maxSlots: 1, pollMs: 10, signal: ac.signal });

    await waitFor(() => waitCount() === 1);
    ac.abort();
    await assert.rejects(pending, /Aborted while waiting/);
    await waitFor(() => waitCount() === 0);
    r1();
  });

  it('two concurrent waiters create two marker files', async () => {
    const r1 = await acquireSlot('holder', { slotDir, maxSlots: 1, pollMs: 10 });
    const ac = new AbortController();
    const w1 = acquireSlot('waiter-1', { slotDir, maxSlots: 1, pollMs: 10, signal: ac.signal });
    const w2 = acquireSlot('waiter-2', { slotDir, maxSlots: 1, pollMs: 10, signal: ac.signal });

    await waitFor(() => waitCount() === 2);

    ac.abort();
    await Promise.allSettled([w1, w2]);
    r1();
  });

  it('reclaims a wait marker left by a dead PID', async () => {
    // Ghost waiter from a crashed process.
    const deadPid = 2147483647;
    writeFileSync(
      join(slotDir, `wait-${deadPid}-0`),
      JSON.stringify({ pid: deadPid, label: 'ghost', since: new Date().toISOString() }),
    );

    // Hold the only slot so a live waiter parks and drives reclaimStale each poll.
    const r1 = await acquireSlot('holder', { slotDir, maxSlots: 1, pollMs: 10 });
    const ac = new AbortController();
    const live = acquireSlot('live-waiter', { slotDir, maxSlots: 1, pollMs: 10, signal: ac.signal });

    // After polls run, only the live waiter's marker should remain.
    await waitFor(() => waitCount() === 1);
    assert.equal(existsSync(join(slotDir, `wait-${deadPid}-0`)), false, 'dead waiter reclaimed');

    ac.abort();
    await assert.rejects(live, /Aborted while waiting/);
    r1();
  });

  it('cleans up slot and waiter markers on process exit', () => {
    const semaphorePath = fileURLToPath(new URL('./semaphore.js', import.meta.url));
    // Child: claim the only slot, park a second acquire as a waiter, then exit.
    // The on-exit handler must remove BOTH the slot and the waiter marker.
    const script = `
      import { acquireSlot } from ${JSON.stringify(semaphorePath)};
      const slotDir = process.argv[1];
      await acquireSlot('holder', { slotDir, maxSlots: 1, pollMs: 20 });
      acquireSlot('waiter', { slotDir, maxSlots: 1, pollMs: 20 }).catch(() => {});
      setTimeout(() => process.exit(0), 150);
    `;
    execFileSync(process.execPath, ['--input-type=module', '-e', script, slotDir], { stdio: 'ignore' });

    assert.equal(slotCount(), 0, 'slot freed on exit');
    assert.equal(waitCount(), 0, 'waiter marker freed on exit');
  });

  it('cleans up its slot on SIGTERM', async () => {
    const semaphorePath = fileURLToPath(new URL('./semaphore.js', import.meta.url));
    // Child claims the only slot, signals readiness, then stays alive until SIGTERM.
    // Node's default SIGTERM terminates WITHOUT firing 'exit', so without a SIGTERM
    // handler the slot file leaks. The handler must releaseAll + exit.
    const script = `
      import { acquireSlot } from ${JSON.stringify(semaphorePath)};
      const slotDir = process.argv[1];
      await acquireSlot('holder', { slotDir, maxSlots: 1, pollMs: 20 });
      console.log('ready');
      setTimeout(() => {}, 10_000);
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, slotDir], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    await waitFor(() => slotCount() === 1, 3000);
    const exited = new Promise<void>((res) => child.on('close', () => res()));
    child.kill('SIGTERM');
    await exited;
    assert.equal(slotCount(), 0, 'slot file must be removed when the process receives SIGTERM');
  });
});
