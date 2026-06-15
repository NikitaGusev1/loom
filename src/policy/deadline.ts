// Per-task / per-batch deadline timer.
// Owns the AbortController, the setTimeout, and the SIGINT-merged signal so callers
// only see start() and cleanup(); compared against signal.reason to distinguish
// deadline-driven aborts from external (SIGINT) aborts.

export const DEADLINE_REASON = 'task-deadline';

export interface TaskDeadline {
  /** Signal merged from the deadline controller plus any external (SIGINT) signal. */
  signal: AbortSignal | undefined;
  /** Deadline duration in milliseconds. */
  deadlineMs: number;
  /** True if the controller was aborted by the deadline (not external SIGINT). */
  wasDeadlineAbort: () => boolean;
  /** Stop the timer. Idempotent. */
  cleanup: () => void;
}

interface CreateOptions {
  deadlineMs: number;
  enabled: boolean;
  externalSignal?: AbortSignal;
}

export const createTaskDeadline = ({ deadlineMs, enabled, externalSignal }: CreateOptions): TaskDeadline => {
  if (!enabled) {
    return {
      signal: externalSignal,
      deadlineMs,
      wasDeadlineAbort: () => false,
      cleanup: () => {},
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(DEADLINE_REASON), deadlineMs);

  const signals: AbortSignal[] = [controller.signal];
  if (externalSignal) signals.push(externalSignal);
  const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);

  return {
    signal,
    deadlineMs,
    wasDeadlineAbort: () => controller.signal.aborted && controller.signal.reason === DEADLINE_REASON,
    cleanup: () => clearTimeout(timer),
  };
};
