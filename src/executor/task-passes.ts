// executeTaskPasses — one worktree task's full lifecycle: session → Tier-1
// verification fix loop → autoCommit. The caller creates the worktree and emits
// task.started beforehand, and runs the no-op gate / task.completed afterwards.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DAGTask, ExecutionState, ExecutorConfig, TaskUsage } from '../types.js';
import type { DagEvent } from '../events/types.js';
import type { Logger } from '../logger.js';
import type { SessionTrace } from '../claude-cli.js';
import { toErrorMessage } from '../exec.js';
import { buildTaskPrompt, VERIFICATION_FIX_NOTICE } from '../prompt.js';
import { resolveOutputFiles } from '../contracts.js';
import { WEIGHT_DEADLINE_MS, VERIFICATION_MAX_FIX_ATTEMPTS } from '../consts.js';
import { durationSinceStart, emitTaskFailed, emitTaskTimeout, emitTaskVerificationFailed } from '../events/emit.js';
import type { ResolvedCommands } from '../verify/detect.js';
import { runVerification, formatFailures, firstFailedKind } from '../verify/run.js';
import { runVerifyFixLoop, sumUsage } from '../verify/fix-loop.js';
import { createTaskDeadline } from '../policy/deadline.js';
import { runQuery } from './session.js';
import { autoCommit, getUncommittedChanges } from './git-ops.js';
import { buildTaskCommitMessage } from './commit-message.js';

interface ExecuteTaskPassesArgs {
  task: DAGTask;
  config: ExecutorConfig;
  state: ExecutionState;
  log: Logger;
  /** Session working directory (the task's worktree). */
  cwd: string;
  emit: (event: DagEvent) => void;
  dagId: string;
  layerNum: number;
  verifyCommands?: ResolvedCommands;
  /** Top-level abort signal (from SIGINT handler). Passed through to runQuery for cooperative cancellation. */
  signal?: AbortSignal;
}

export const executeTaskPasses = async ({
  task,
  config,
  state,
  log,
  cwd,
  emit,
  dagId,
  layerNum,
  verifyCommands = {},
  signal,
}: ExecuteTaskPassesArgs): Promise<{ usage?: TaskUsage; trace?: SessionTrace; failed: boolean }> => {
  // Ensure .claude/ai/ exists in worktrees (gitignored)
  mkdirSync(join(cwd, '.claude/ai'), { recursive: true });

  log.passStart(task.id);

  const deadline = createTaskDeadline({
    deadlineMs: WEIGHT_DEADLINE_MS[task.weight],
    enabled: true,
    externalSignal: signal,
  });

  try {
    const prompt = buildTaskPrompt(task);
    const { usage, trace } = await runQuery(prompt, task.weight, config, {
      cwd,
      signal: deadline.signal,
      label: task.id,
    });

    // --- Tier-1 verification gate (in-worktree, BEFORE autoCommit) ---
    // Orthogonal to the caller's no-op gate (verifyOutputsCommitted): that gate
    // checks the task PRODUCED its declared outputs; this gate checks the changes
    // are CORRECT (tests/lint/types). A change can pass one and fail the other.
    // Run the target repo's detected checks against the session's (uncommitted)
    // changes; on failure, re-invoke the session up to N times with the errors.
    // Exhaust → emit task.verification-failed and return failed WITHOUT
    // committing. The caller throws on `failed`, decide() classifies this
    // permanent (retry.ts), so the worktree is left unmerged. In a fresh worktree
    // without node_modules, JS checks skip (never false-fail) — Tier-2 on merged
    // main is the backstop.
    // resolveVerifyCommands returns {} when verification is disabled, so a
    // non-empty command set already implies it's enabled — no separate
    // disableVerification check needed here.
    let fixUsage: TaskUsage | undefined;
    if (Object.keys(verifyCommands).length > 0) {
      const loop = await runVerifyFixLoop(
        {
          runFix: (p) => runQuery(p, task.weight, config, { cwd, signal: deadline.signal, label: `${task.id}-fix` }),
          getChangedFiles: () => getUncommittedChanges(cwd),
          runVerification: (files) =>
            runVerification({ commands: verifyCommands, changedFiles: files, cwd, weight: task.weight, signal, log }),
        },
        { basePrompt: prompt, fixNotice: VERIFICATION_FIX_NOTICE, maxAttempts: VERIFICATION_MAX_FIX_ATTEMPTS },
      );
      fixUsage = loop.fixUsage; // carry fix-attempt cost onto the merged task, pass or fail

      if (!loop.ok) {
        const ts = new Date().toISOString();
        const durationMs = durationSinceStart(state.tasks[task.id]?.startedAt, ts);
        emitTaskVerificationFailed({
          task,
          state,
          ts,
          durationMs,
          dagId,
          layer: layerNum,
          verificationKind: firstFailedKind(loop.outcome.results),
          error: `Verification failed after ${loop.attempts} fix attempt(s).\n${formatFailures(loop.outcome)}`,
          usage: sumUsage(usage, fixUsage),
          emit,
        });
        return { failed: true };
      }
    }

    await autoCommit(cwd, buildTaskCommitMessage(task), log, resolveOutputFiles(task), task.context.files);

    return { usage: sumUsage(usage, fixUsage), trace, failed: false };
  } catch (err) {
    const ts = new Date().toISOString();
    const durationMs = durationSinceStart(state.tasks[task.id]?.startedAt, ts);
    const baseFields = { task, state, ts, durationMs, dagId, layer: layerNum, emit };

    if (deadline.wasDeadlineAbort()) {
      emitTaskTimeout({ ...baseFields, timeoutMs: deadline.deadlineMs });
    } else {
      emitTaskFailed({ ...baseFields, error: toErrorMessage(err) });
    }
    return { failed: true };
  } finally {
    deadline.cleanup();
  }
};
