// Bounded verify → fix → re-verify loop, with all I/O injected so it is
// unit-testable without spawning `claude` or touching the cross-process slot
// semaphore (the executor's real runQuery does both). The executor wires the
// real runQuery / runVerification / changed-file computation in; tests pass
// stubs.

import type { TaskUsage } from '../types.js';
import type { VerificationOutcome } from './run.js';
import { formatFailures } from './run.js';

export interface VerifyFixLoopDeps {
  /** Re-invoke the task session (one fix attempt) with the given prompt; returns its usage. */
  runFix: (prompt: string) => Promise<{ usage?: TaskUsage }>;
  /** Compute the changed-file set in the session's working dir (drives test/lint scoping). */
  getChangedFiles: () => Promise<string[]>;
  /** Run verification against the given changed files. */
  runVerification: (changedFiles: string[]) => Promise<VerificationOutcome>;
}

export interface VerifyFixLoopArgs {
  /** Original task prompt, re-sent (plus the notice + failures) on each fix attempt. */
  basePrompt: string;
  /** Notice prepended to the failure detail on a fix re-invoke. */
  fixNotice: string;
  /** Max fix re-invokes before giving up (VERIFICATION_MAX_FIX_ATTEMPTS). */
  maxAttempts: number;
}

export interface VerifyFixLoopResult {
  /** True when verification passed (possibly after fixes). */
  ok: boolean;
  /** Number of fix re-invokes performed (0 = passed on the first verification). */
  attempts: number;
  /** Final verification outcome (for the failure detail / event). */
  outcome: VerificationOutcome;
  /** Summed usage across fix re-invokes (undefined when no fix ran). */
  fixUsage?: TaskUsage;
}

/** Sum two usage records field-wise; either may be undefined. */
export const sumUsage = (a: TaskUsage | undefined, b: TaskUsage | undefined): TaskUsage | undefined => {
  if (!a) return b;
  if (!b) return a;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
    costUSD: a.costUSD + b.costUSD,
    numTurns: a.numTurns + b.numTurns,
    durationMs: a.durationMs + b.durationMs,
    durationApiMs: a.durationApiMs + b.durationApiMs,
  };
};

export const runVerifyFixLoop = async (
  deps: VerifyFixLoopDeps,
  { basePrompt, fixNotice, maxAttempts }: VerifyFixLoopArgs,
): Promise<VerifyFixLoopResult> => {
  let changed = await deps.getChangedFiles();
  let outcome = await deps.runVerification(changed);
  let attempts = 0;
  let fixUsage: TaskUsage | undefined;

  while (!outcome.ok && attempts < maxAttempts) {
    attempts += 1;
    const prompt = `${basePrompt}\n\n${fixNotice}\n\n${formatFailures(outcome)}`;
    const { usage } = await deps.runFix(prompt);
    fixUsage = sumUsage(fixUsage, usage);
    changed = await deps.getChangedFiles();
    outcome = await deps.runVerification(changed);
  }

  return { ok: outcome.ok, attempts, outcome, fixUsage };
};
