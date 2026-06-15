import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decide, NO_OP_ERROR_PATTERN } from './retry.js';
import type { DagEvent } from '../events/types.js';
import type { TaskState } from '../types.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const TS = '2024-01-01T00:00:00.000Z';
const SCHEMA = 1 as const;

const finalState: TaskState = { status: 'in-progress' };

const timeout = (taskId: string): DagEvent => ({
  kind: 'task.timeout',
  schemaVersion: SCHEMA,
  ts: TS,
  dagId: 'dag-1',
  taskId,
  taskName: taskId,
  layer: 0,
  timeoutMs: 300_000,
  durationMs: 300_000,
  finalState,
});

const failed = (taskId: string, error: string): DagEvent => ({
  kind: 'task.failed',
  schemaVersion: SCHEMA,
  ts: TS,
  dagId: 'dag-1',
  taskId,
  taskName: taskId,
  layer: 0,
  error,
  durationMs: 5_000,
  finalState: { status: 'failed' },
});

const completed = (taskId: string): DagEvent => ({
  kind: 'task.completed',
  schemaVersion: SCHEMA,
  ts: TS,
  dagId: 'dag-1',
  taskId,
  taskName: taskId,
  layer: 0,
  durationMs: 10_000,
  usage: {
    inputTokens: 100,
    outputTokens: 50,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    costUSD: 0.01,
    numTurns: 1,
    durationMs: 10_000,
    durationApiMs: 8_000,
  },
  filesModified: [],
  finalState: { status: 'completed' },
});

const retry = (taskId: string): DagEvent => ({
  kind: 'task.retry',
  schemaVersion: SCHEMA,
  ts: TS,
  dagId: 'dag-1',
  taskId,
  taskName: taskId,
  layer: 0,
  attempt: 1,
  reason: 'timeout',
});

const verificationFailed = (taskId: string, kind: 'test' | 'lint' | 'typecheck' = 'test'): DagEvent => ({
  kind: 'task.verification-failed',
  schemaVersion: SCHEMA,
  ts: TS,
  dagId: 'dag-1',
  taskId,
  taskName: taskId,
  layer: 0,
  verificationKind: kind,
  error: `${kind} failed`,
  durationMs: 5_000,
  finalState: { status: 'failed' },
});

// ---------------------------------------------------------------------------
// AC-1: single timeout → retry 30 s
// ---------------------------------------------------------------------------

describe('AC-1: single timeout', () => {
  it('returns retry with 30 s delay', () => {
    const events: DagEvent[] = [timeout('t1')];
    const d = decide(events, 't1');
    assert.deepEqual(d, { kind: 'retry', delayMs: 30_000 });
  });
});

// ---------------------------------------------------------------------------
// AC-2: double timeout → retry 90 s
// ---------------------------------------------------------------------------

describe('AC-2: double timeout', () => {
  it('returns retry with 90 s delay', () => {
    const events: DagEvent[] = [timeout('t1'), retry('t1'), timeout('t1')];
    const d = decide(events, 't1');
    assert.deepEqual(d, { kind: 'retry', delayMs: 90_000 });
  });
});

// ---------------------------------------------------------------------------
// AC-3: triple consecutive timeout → permanent timeout-exhausted
// ---------------------------------------------------------------------------

describe('AC-3: triple consecutive timeout', () => {
  it('returns permanent timeout-exhausted', () => {
    const events: DagEvent[] = [timeout('t1'), retry('t1'), timeout('t1'), retry('t1'), timeout('t1')];
    const d = decide(events, 't1');
    assert.deepEqual(d, { kind: 'permanent', reason: 'timeout-exhausted' });
  });
});

// ---------------------------------------------------------------------------
// AC-4: transient task.failed → retry 30 s
// ---------------------------------------------------------------------------

describe('AC-4: transient failure', () => {
  it('rate-limit error → retry 30 s', () => {
    const events: DagEvent[] = [failed('t1', 'rate limit exceeded')];
    const d = decide(events, 't1');
    assert.deepEqual(d, { kind: 'retry', delayMs: 30_000 });
  });

  it('5xx error → retry 30 s', () => {
    const events: DagEvent[] = [failed('t1', 'HTTP 503 Service Unavailable')];
    const d = decide(events, 't1');
    assert.deepEqual(d, { kind: 'retry', delayMs: 30_000 });
  });

  it('ECONNRESET → retry 30 s', () => {
    const events: DagEvent[] = [failed('t1', 'ECONNRESET connection lost')];
    const d = decide(events, 't1');
    assert.deepEqual(d, { kind: 'retry', delayMs: 30_000 });
  });

  it('overloaded → retry 30 s', () => {
    const events: DagEvent[] = [failed('t1', 'Model overloaded, try again')];
    const d = decide(events, 't1');
    assert.deepEqual(d, { kind: 'retry', delayMs: 30_000 });
  });
});

// ---------------------------------------------------------------------------
// AC-5: non-transient task.failed → permanent non-transient
// ---------------------------------------------------------------------------

describe('AC-5: non-transient failure', () => {
  it('returns permanent non-transient', () => {
    const events: DagEvent[] = [failed('t1', 'TypeError: cannot read property of undefined')];
    const d = decide(events, 't1');
    assert.deepEqual(d, { kind: 'permanent', reason: 'non-transient' });
  });

  it('empty error string → permanent non-transient', () => {
    const events: DagEvent[] = [failed('t1', '')];
    const d = decide(events, 't1');
    assert.deepEqual(d, { kind: 'permanent', reason: 'non-transient' });
  });
});

// ---------------------------------------------------------------------------
// success-after-retry: task completed → succeeded
// ---------------------------------------------------------------------------

describe('success-after-retry', () => {
  it('completed after previous timeout → succeeded', () => {
    const events: DagEvent[] = [timeout('t1'), retry('t1'), completed('t1')];
    const d = decide(events, 't1');
    assert.deepEqual(d, { kind: 'succeeded' });
  });

  it('no terminal events → succeeded (nothing to retry)', () => {
    const d = decide([], 't1');
    assert.deepEqual(d, { kind: 'succeeded' });
  });
});

// ---------------------------------------------------------------------------
// Silent no-op: 1st no-op → immediate retry; 2nd consecutive → permanent
// ---------------------------------------------------------------------------

const NO_OP_ERROR =
  'Task reported completion but produced 0 file modifications, despite having "out/a.ts" file output(s).' +
  ' Likely a silent no-op — re-run with --rerun=t1 or write the output manually and patch the state file.';

describe('silent no-op', () => {
  it('first no-op → immediate retry', () => {
    const events: DagEvent[] = [failed('t1', NO_OP_ERROR)];
    const d = decide(events, 't1');
    assert.deepEqual(d, { kind: 'retry', delayMs: 0 });
  });

  it('second consecutive no-op → permanent no-op-exhausted', () => {
    const events: DagEvent[] = [failed('t1', NO_OP_ERROR), retry('t1'), failed('t1', NO_OP_ERROR)];
    const d = decide(events, 't1');
    assert.deepEqual(d, { kind: 'permanent', reason: 'no-op-exhausted' });
  });

  it('no-op streak resets after a completed boundary', () => {
    const events: DagEvent[] = [failed('t1', NO_OP_ERROR), retry('t1'), completed('t1'), failed('t1', NO_OP_ERROR)];
    const d = decide(events, 't1');
    assert.deepEqual(d, { kind: 'retry', delayMs: 0 });
  });

  it('no-op streak is not broken by intervening retry events', () => {
    const events: DagEvent[] = [
      failed('t1', NO_OP_ERROR),
      retry('t1'),
      failed('t1', NO_OP_ERROR),
      retry('t1'),
      failed('t1', NO_OP_ERROR),
    ];
    const d = decide(events, 't1');
    assert.deepEqual(d, { kind: 'permanent', reason: 'no-op-exhausted' });
  });

  it('no-op failures for other tasks do not count toward streak', () => {
    const events: DagEvent[] = [
      failed('other', NO_OP_ERROR),
      retry('other'),
      failed('other', NO_OP_ERROR),
      failed('t1', NO_OP_ERROR),
    ];
    const d = decide(events, 't1');
    assert.deepEqual(d, { kind: 'retry', delayMs: 0 });
  });

  it('non-no-op failure breaks the no-op streak (most recent failure decides)', () => {
    const events: DagEvent[] = [failed('t1', NO_OP_ERROR), retry('t1'), failed('t1', 'TypeError: boom')];
    const d = decide(events, 't1');
    assert.deepEqual(d, { kind: 'permanent', reason: 'non-transient' });
  });

  it('NO_OP_ERROR_PATTERN matches the executor noOpFileOutputError message shape', () => {
    assert.ok(NO_OP_ERROR_PATTERN.test(NO_OP_ERROR));
  });
});

// ---------------------------------------------------------------------------
// Streak isolation: unrelated task events do not affect streak count
// ---------------------------------------------------------------------------

describe('streak isolation', () => {
  it('timeouts for other tasks do not count toward streak', () => {
    const events: DagEvent[] = [timeout('other'), timeout('other'), timeout('other'), timeout('t1')];
    const d = decide(events, 't1');
    // Only 1 timeout for t1 — should be AC-1 retry 30 s
    assert.deepEqual(d, { kind: 'retry', delayMs: 30_000 });
  });

  it('streak resets after task.failed boundary', () => {
    // Two timeouts for t1, then a failed event, then another timeout
    // The failed breaks the streak — only 1 timeout after the failed
    const events: DagEvent[] = [timeout('t1'), timeout('t1'), failed('t1', 'some error'), timeout('t1')];
    const d = decide(events, 't1');
    // Most recent terminal event is the last timeout; streak = 1 (failed breaks it)
    assert.deepEqual(d, { kind: 'retry', delayMs: 30_000 });
  });
});

// ---------------------------------------------------------------------------
// Verification failure → permanent verification-failed (never transient-retried,
// and CRITICALLY never falls through to succeeded → would merge broken code).
// ---------------------------------------------------------------------------

describe('verification failure', () => {
  it('verification-failed → permanent verification-failed', () => {
    const d = decide([verificationFailed('t1')], 't1');
    assert.deepEqual(d, { kind: 'permanent', reason: 'verification-failed' });
  });

  it('does NOT fall through to succeeded (the merge-the-broken-code guard)', () => {
    const d = decide([verificationFailed('t1', 'typecheck')], 't1');
    assert.notDeepEqual(d, { kind: 'succeeded' });
    assert.equal(d.kind, 'permanent');
  });

  it('wins as most-recent terminal event over an earlier transient failure', () => {
    // An earlier transient task.failed would, alone, retry. The verification
    // failure is newer → must short-circuit to permanent.
    const events: DagEvent[] = [failed('t1', 'rate limit exceeded'), retry('t1'), verificationFailed('t1')];
    const d = decide(events, 't1');
    assert.deepEqual(d, { kind: 'permanent', reason: 'verification-failed' });
  });

  it('not classified as transient even if message looks transient', () => {
    // verificationKind branch keys on event.kind, not message text.
    const ev = verificationFailed('t1');
    const d = decide([ev], 't1');
    assert.equal(d.kind, 'permanent');
  });

  it('verification failure for another task does not affect t1', () => {
    const d = decide([verificationFailed('other')], 't1');
    assert.deepEqual(d, { kind: 'succeeded' });
  });
});
