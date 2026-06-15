// Retry decision policy — pure, no I/O, no Date.now(), no fs, no console.
// Slice 3 AC rules:
//   AC-1: 1st task.timeout → retry after 30 s
//   AC-2: 2nd task.timeout → retry after 90 s
//   AC-3: 3rd consecutive task.timeout → permanent 'timeout-exhausted'
//   AC-4: 1st transient task.failed → retry after 30 s
//   AC-5: non-transient task.failed → permanent 'non-transient'

import type { DagEvent } from '../events/types.js';
import { isQuotaLimitError } from './quota.js';

// ---------------------------------------------------------------------------
// Decision type
// ---------------------------------------------------------------------------

export type Decision =
  | { kind: 'retry'; delayMs: number }
  | { kind: 'permanent'; reason: 'timeout-exhausted' | 'non-transient' | 'no-op-exhausted' | 'verification-failed' }
  | { kind: 'quota'; reason: string }
  | { kind: 'succeeded' };

// ---------------------------------------------------------------------------
// Transient error patterns (additive — keep small)
// ---------------------------------------------------------------------------

export const TRANSIENT_ERROR_PATTERNS: ReadonlyArray<RegExp> = [
  /rate.?limit/i,
  /5\d\d/,
  /ECONNRESET|ETIMEDOUT|ENOTFOUND/,
  /overloaded/i,
];

const isTransient = (errorMessage: string): boolean =>
  TRANSIENT_ERROR_PATTERNS.some((pattern) => pattern.test(errorMessage));

// ---------------------------------------------------------------------------
// Silent no-op pattern — matches the error emitted by the executor when a
// session reports completion with declared file outputs but zero modifications.
// The executor's noOpFileOutputError message must keep matching this pattern
// (cross-checked by a test in retry.test.ts).
// ---------------------------------------------------------------------------

export const NO_OP_ERROR_PATTERN = /silent no-op/i;

// ---------------------------------------------------------------------------
// Streak helpers
// ---------------------------------------------------------------------------

// Event kinds that terminate a task's attempt. Any of these (for the target
// task) ends a streak walk. Each streak helper counts ONE specific kind via an
// earlier `continue` branch and treats every terminal kind as a boundary —
// listing the counted kind here is harmless because that branch consumes it
// first. Single source of truth so a new terminal event kind can't be silently
// miscounted by forgetting to add it to one helper's boundary chain.
const TERMINAL_TASK_EVENT_KINDS: ReadonlySet<DagEvent['kind']> = new Set([
  'task.completed',
  'task.failed',
  'task.timeout',
  'task.verification-failed',
  'task.reset',
]);

const isTaskBoundary = (e: DagEvent, taskId: string): boolean =>
  TERMINAL_TASK_EVENT_KINDS.has(e.kind) && 'taskId' in e && e.taskId === taskId;

/**
 * Count consecutive counted events for taskId walking newest-to-oldest, stopping
 * at the first non-counted boundary (any other terminal task event).
 *
 * A task.retry event between counted events is NOT a boundary — it is
 * administrative. task.started / unrelated events are skipped without breaking
 * the streak. The `counts` predicate is checked first, so a counted event that
 * is also a terminal kind extends the streak instead of ending it.
 */
const countStreak = (events: ReadonlyArray<DagEvent>, taskId: string, counts: (e: DagEvent) => boolean): number => {
  let streak = 0;

  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (counts(e)) {
      streak += 1;
      continue;
    }
    if (isTaskBoundary(e, taskId)) {
      break;
    }
  }

  return streak;
};

const countTimeoutStreak = (events: ReadonlyArray<DagEvent>, taskId: string): number =>
  countStreak(events, taskId, (e) => e.kind === 'task.timeout' && e.taskId === taskId);

// Consecutive no-op task.failed events; a non-no-op task.failed breaks the streak
// via the boundary check.
const countNoOpStreak = (events: ReadonlyArray<DagEvent>, taskId: string): number =>
  countStreak(
    events,
    taskId,
    (e) => e.kind === 'task.failed' && e.taskId === taskId && NO_OP_ERROR_PATTERN.test(e.error ?? ''),
  );

// ---------------------------------------------------------------------------
// decide
// ---------------------------------------------------------------------------

/**
 * Given all DAG events for a run and the target taskId, return the retry
 * Decision based on the most recent terminal event for that task.
 *
 * @param eventsForTask - Full event log (decide filters by taskId internally)
 * @param taskId        - The task to evaluate
 */
export const decide = (eventsForTask: ReadonlyArray<DagEvent>, taskId: string): Decision => {
  // Find the most recent terminal event for this task (newest-to-oldest)
  for (let i = eventsForTask.length - 1; i >= 0; i--) {
    const e = eventsForTask[i];

    if (e.kind === 'task.completed' && e.taskId === taskId) {
      // AC: task succeeded — no retry needed
      return { kind: 'succeeded' };
    }

    if (e.kind === 'task.verification-failed' && e.taskId === taskId) {
      // A verification failure surfaces only after the in-task fix budget is
      // already spent — retrying the policy loop won't help. Permanent, and
      // (critically) classified BEFORE the default succeeded fall-through so the
      // executor routes it to permanentFailedIds and never merges the worktree.
      // This branch lives INSIDE the loop so it wins as the most-recent terminal
      // event for the task.
      return { kind: 'permanent', reason: 'verification-failed' };
    }

    if (e.kind === 'task.timeout' && e.taskId === taskId) {
      // AC-1/2/3: count consecutive timeout streak
      const streak = countTimeoutStreak(eventsForTask, taskId);

      if (streak >= 3) {
        // AC-3: 3rd consecutive timeout → permanent
        return { kind: 'permanent', reason: 'timeout-exhausted' };
      }
      if (streak === 2) {
        // AC-2: 2nd timeout → retry 90 s
        return { kind: 'retry', delayMs: 90_000 };
      }
      // AC-1: 1st timeout → retry 30 s
      return { kind: 'retry', delayMs: 30_000 };
    }

    if (e.kind === 'task.failed' && e.taskId === taskId) {
      if (isQuotaLimitError(e.error ?? '')) {
        return { kind: 'quota', reason: e.error ?? 'quota limit reached' };
      }
      if (NO_OP_ERROR_PATTERN.test(e.error ?? '')) {
        // Silent no-op: session reported completion without writing files.
        // Retry immediately once — nothing transient to wait out. A second
        // consecutive no-op means retrying won't help; park for a human.
        const noOpStreak = countNoOpStreak(eventsForTask, taskId);
        if (noOpStreak >= 2) {
          return { kind: 'permanent', reason: 'no-op-exhausted' };
        }
        return { kind: 'retry', delayMs: 0 };
      }
      if (isTransient(e.error ?? '')) {
        // AC-4: transient error → retry 30 s
        return { kind: 'retry', delayMs: 30_000 };
      }
      // AC-5: non-transient → permanent
      return { kind: 'permanent', reason: 'non-transient' };
    }
  }

  // No terminal event found for this task — treat as succeeded (nothing to retry)
  return { kind: 'succeeded' };
};
