// executeTrivialBatch — all of a layer's trivial tasks in ONE session on the
// main branch (no worktree), auto-committed. Failed work is therefore already
// on main: the no-op retry runs in-batch (once, fresh session), and Tier-1
// fixes are follow-up commits rather than discards.

import type { DAGTask, ExecutionState, ExecutorConfig, ProjectContext, TaskUsage } from '../types.js';
import type { DagEvent } from '../events/types.js';
import type { Logger } from '../logger.js';
import type { SessionTrace } from '../claude-cli.js';
import type { ProjectMemory } from '../memory.js';
import { toErrorMessage } from '../exec.js';
import { buildBatchedTrivialPrompt, VERIFICATION_FIX_NOTICE } from '../prompt.js';
import { resolveOutputFiles } from '../contracts.js';
import { WEIGHT_DEADLINE_MS, VERIFICATION_MAX_FIX_ATTEMPTS } from '../consts.js';
import {
  durationSinceStart,
  emitTaskStarted,
  emitTaskRetry,
  emitTaskCompleted,
  emitTaskFailed,
  emitTaskTimeout,
  emitTaskVerificationFailed,
} from '../events/emit.js';
import type { ResolvedCommands } from '../verify/detect.js';
import { runVerification, formatFailures, firstFailedKind } from '../verify/run.js';
import { runVerifyFixLoop } from '../verify/fix-loop.js';
import { createTaskDeadline } from '../policy/deadline.js';
import { runQuery, TRIVIAL_TOOLS } from './session.js';
import { autoCommit, getFilesModified } from './git-ops.js';
import { buildBatchCommitMessage } from './commit-message.js';
import { settleNoOpGate } from './noop-gate.js';
import { divideUsage } from '../usage.js';

// Prepended to the batched prompt when re-running tasks that silently no-op'd.
const TRIVIAL_RETRY_NOTICE =
  'PREVIOUS ATTEMPT FAILED: a prior session reported the tasks below complete but wrote NO files — ' +
  'the declared outputs DO NOT exist yet. You MUST create or modify them via the Write and Edit tools. ' +
  'File content pasted into your reply text writes nothing.\n\n';

interface ExecuteTrivialBatchArgs {
  tasks: DAGTask[];
  config: ExecutorConfig;
  state: ExecutionState;
  log: Logger;
  /** Base-branch HEAD the batch's changes are diffed against (re-recorded by the caller after the batch commits). */
  baseCommitSha: string;
  emit: (event: DagEvent) => void;
  dagId: string;
  layerNum: number;
  signal?: AbortSignal;
  verifyCommands?: ResolvedCommands;
  projectMemory?: ProjectMemory | null;
  projectContext?: ProjectContext;
}

export const executeTrivialBatch = async ({
  tasks,
  config,
  state,
  log,
  baseCommitSha,
  emit,
  dagId,
  layerNum,
  signal,
  verifyCommands = {},
  projectMemory,
  projectContext,
}: ExecuteTrivialBatchArgs): Promise<{ success: boolean; filesModified: string[] }> => {
  if (tasks.length === 0) return { success: true, filesModified: [] };

  log.info(`Running ${tasks.length} trivial task(s) as batched session on main branch...`);

  // Track startedAt locally — local `state` param won't reflect emit updates.
  const taskStartedAt: Record<string, string> = {};
  for (const task of tasks) {
    const ts = new Date().toISOString();
    taskStartedAt[task.id] = ts;
    emitTaskStarted({ task, ts, dagId, layer: layerNum, emit });
  }

  // Two-attempt loop: tasks that silently no-op on the first session are re-run
  // once in a fresh batched session (with an explicit retry notice) before the
  // layer pauses. Mirrors the no-op retry-once policy of the worktree path.
  let toRun = tasks;
  let attempt = 0;
  const modifiedAll = new Set<string>();
  let anyPermanentNoOp = false;

  while (toRun.length > 0) {
    const prompt =
      (attempt > 0 ? TRIVIAL_RETRY_NOTICE : '') + buildBatchedTrivialPrompt(toRun, { projectMemory, projectContext });

    // The batch is a single SDK session so the deadline covers all tasks collectively.
    const deadline = createTaskDeadline({
      deadlineMs: WEIGHT_DEADLINE_MS.trivial,
      enabled: true,
      externalSignal: signal,
    });

    let usage: TaskUsage | undefined;
    let trace: SessionTrace | undefined;
    try {
      const result = await runQuery(prompt, 'trivial', config, {
        allowedTools: TRIVIAL_TOOLS,
        label: attempt === 0 ? 'trivial-batch' : 'trivial-batch-retry',
        ...(deadline.signal && { signal: deadline.signal }),
      });
      usage = result.usage;
      trace = result.trace;
    } catch (err) {
      const isDeadline = deadline.wasDeadlineAbort();
      const errMsg = toErrorMessage(err);
      for (const task of toRun) {
        const ts = new Date().toISOString();
        const durationMs = durationSinceStart(taskStartedAt[task.id], ts);
        const baseFields = { task, state, ts, durationMs, dagId, layer: layerNum, emit };
        if (isDeadline) {
          emitTaskTimeout({ ...baseFields, timeoutMs: deadline.deadlineMs });
        } else {
          emitTaskFailed({ ...baseFields, error: errMsg });
        }
      }
      return { success: false, filesModified: [...modifiedAll] };
    } finally {
      deadline.cleanup();
    }

    const trivialScope = [...new Set(toRun.flatMap((t) => t.context.files))];
    const outputsByTask = new Map(toRun.map((t) => [t.id, resolveOutputFiles(t)] as const));
    const trivialForceAdd = [...outputsByTask.values()].flat();
    await autoCommit(process.cwd(), buildBatchCommitMessage(toRun), log, trivialForceAdd, trivialScope);

    const filesModified = await getFilesModified(process.cwd(), baseCommitSha);
    for (const f of filesModified) modifiedAll.add(f);

    const perTaskUsage = usage ? divideUsage(usage, toRun.length) : undefined;

    const retryTasks: DAGTask[] = [];
    for (const task of toRun) {
      const ts = new Date().toISOString();
      const durationMs = durationSinceStart(taskStartedAt[task.id], ts);

      const declaredOutputs = outputsByTask.get(task.id) ?? [];
      const settle = await settleNoOpGate({
        task,
        cwd: process.cwd(),
        declaredOutputs,
        trace,
        usage: perTaskUsage,
        state,
        ts,
        durationMs,
        dagId,
        layer: layerNum,
        emit,
        log,
      });
      if (!settle.ok) {
        if (attempt === 0) {
          retryTasks.push(task);
          const retryTs = new Date().toISOString();
          emitTaskRetry({
            task,
            ts: retryTs,
            dagId,
            layer: layerNum,
            emit,
            attempt: 1,
            delayMs: 0,
            reason: 'silent no-op',
            previousError: settle.errMsg,
          });
          emitTaskStarted({ task, ts: retryTs, dagId, layer: layerNum, emit });
          taskStartedAt[task.id] = retryTs;
          log.warn(`Task ${task.id} will retry once in a fresh batched session`);
        } else {
          anyPermanentNoOp = true;
          log.error(`Task ${task.id} permanently failed (no-op-exhausted)`);
        }
        continue;
      }

      emitTaskCompleted({
        task,
        state,
        ts,
        durationMs,
        dagId,
        layer: layerNum,
        usage: perTaskUsage,
        filesModified,
        emit,
      });
    }
    if (perTaskUsage) {
      // Log the per-task share (session usage / batch size) so this line
      // reconciles with the event-sourced summaries, which sum divided
      // per-task usage — the raw session figure would double-count retried
      // tasks across passes.
      log.taskUsage(
        `${attempt === 0 ? 'trivial-batch' : 'trivial-batch-retry'} per-task (÷${toRun.length})`,
        perTaskUsage,
      );
    }

    toRun = retryTasks;
    attempt += 1;
  }

  // --- Tier-1 verification gate (trivial batch, on main, AFTER the no-op loop) ---
  // The batch's work is already committed to main, so a fix is a follow-up commit
  // (not a discard). Skip when a task already permanently no-op'd (the batch
  // returns success:false → the layer pauses anyway). On terminal verification
  // failure, emit task.verification-failed for each batch task and return
  // success:false so the layer loop pauses (the committed work stays on main;
  // resume re-runs after a human fix). There is no worktree to leave unmerged.
  // verifyCommands is empty when verification is disabled (resolveVerifyCommands
  // returns {}), so its non-emptiness already implies enabled.
  if (!anyPermanentNoOp && Object.keys(verifyCommands).length > 0) {
    const cwd = process.cwd();
    const allScope = [...new Set(tasks.flatMap((t) => t.context.files))];
    const allForceAdd = [...new Set(tasks.flatMap((t) => resolveOutputFiles(t)))];

    const loop = await runVerifyFixLoop(
      {
        runFix: async (p) => {
          // Bound the fix session with a trivial deadline, like the main trivial
          // session above — otherwise a stalled fix re-invoke is unbounded by wall clock.
          const fixDeadline = createTaskDeadline({
            deadlineMs: WEIGHT_DEADLINE_MS.trivial,
            enabled: true,
            externalSignal: signal,
          });
          try {
            const r = await runQuery(p, 'trivial', config, {
              allowedTools: TRIVIAL_TOOLS,
              label: 'trivial-verify-fix',
              ...(fixDeadline.signal && { signal: fixDeadline.signal }),
            });
            await autoCommit(cwd, buildBatchCommitMessage(tasks, { verifyFix: true }), log, allForceAdd, allScope);
            return { usage: r.usage };
          } finally {
            fixDeadline.cleanup();
          }
        },
        getChangedFiles: () => getFilesModified(cwd, baseCommitSha),
        runVerification: (files) =>
          runVerification({ commands: verifyCommands, changedFiles: files, cwd, weight: 'trivial', signal, log }),
      },
      {
        basePrompt: buildBatchedTrivialPrompt(tasks, { projectMemory, projectContext }),
        fixNotice: VERIFICATION_FIX_NOTICE,
        maxAttempts: VERIFICATION_MAX_FIX_ATTEMPTS,
      },
    );

    if (!loop.ok) {
      const perTaskFixUsage = loop.fixUsage ? divideUsage(loop.fixUsage, tasks.length) : undefined;
      const verificationKind = firstFailedKind(loop.outcome.results);
      const error = `Trivial-batch verification failed after ${loop.attempts} fix attempt(s).\n${formatFailures(loop.outcome)}`;
      for (const task of tasks) {
        const ts = new Date().toISOString();
        const durationMs = durationSinceStart(taskStartedAt[task.id], ts);
        emitTaskVerificationFailed({
          task,
          state,
          ts,
          durationMs,
          dagId,
          layer: layerNum,
          verificationKind,
          error,
          usage: perTaskFixUsage,
          emit,
        });
      }
      log.error(
        `Trivial batch failed verification (${verificationKind}). Pausing — work is committed on main; resume after fixing.`,
      );
      return { success: false, filesModified: [...modifiedAll] };
    }
  }

  return { success: !anyPermanentNoOp, filesModified: [...modifiedAll] };
};
