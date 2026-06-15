// The silent-no-op commit gate: a task that reports completion must have its
// declared outputs committed. Guards the worst observed failure mode — an agent
// "completing" while writing nothing (content emitted as prose, or a wrong-cwd
// write).

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DAGTask, ExecutionState, TaskUsage } from '../types.js';
import type { DagEvent } from '../events/types.js';
import type { Logger } from '../logger.js';
import { countWriteCalls, type SessionTrace } from '../claude-cli.js';
import { verifyOutputsCommitted } from '../commit-gate.js';
import { emitTaskFailed } from '../events/emit.js';

// Persist a no-op debug artifact to the main repo (worktrees get destroyed) so the
// next occurrence is root-causable. Best-effort — never throws.
const writeNoOpDebugArtifact = (
  taskId: string,
  declaredOutputs: string[],
  trace: SessionTrace | undefined,
  usage: TaskUsage | undefined,
  sessionCwd: string,
): string | undefined => {
  try {
    const dir = join(process.cwd(), '.claude/ai/dag-debug');
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = join(dir, `noop-${taskId}-${stamp}.json`);
    writeFileSync(
      file,
      JSON.stringify(
        {
          taskId,
          ts: new Date().toISOString(),
          sessionCwd,
          declaredOutputs,
          toolCalls: trace?.toolCalls ?? {},
          writePaths: trace?.writePaths ?? [],
          lastAssistantText: trace?.lastAssistantText ?? '',
          usage: usage ?? null,
        },
        null,
        2,
      ),
    );
    return file;
  } catch {
    return undefined;
  }
};

// Build the error message emitted when a task reports completion but modified zero files
// despite having declared file outputs. Must keep matching NO_OP_ERROR_PATTERN in
// policy/retry.ts ("silent no-op") so the retry policy recognizes it.
const noOpFileOutputError = (
  taskId: string,
  fileOutputPaths: string[],
  trace?: SessionTrace,
  artifactPath?: string,
  offendingPaths?: string[],
): string => {
  const outputList = fileOutputPaths.map((p) => `"${p}"`).join(', ');
  let msg =
    `Task reported completion but produced 0 file modifications, despite having ${outputList} file output(s).` +
    ` Likely a silent no-op — re-run with --rerun=${taskId} or write the output manually and patch the state file.`;
  if (offendingPaths && offendingPaths.length > 0) {
    msg += ` Uncommitted outputs (dirty/untracked/absent): [${offendingPaths.map((p) => `"${p}"`).join(', ')}].`;
  }
  if (trace) {
    const writeCalls = countWriteCalls(trace);
    msg +=
      writeCalls === 0
        ? ` Session made 0 Write/Edit tool calls (tool calls: ${JSON.stringify(trace.toolCalls)}) —` +
          ' agent likely emitted content as prose or declared the task already done.'
        : ` Session made ${writeCalls} Write/Edit call(s) targeting [${trace.writePaths.join(', ')}]` +
          ' but the tree is clean — possible wrong-cwd write.';
  }
  if (artifactPath) {
    msg += ` Debug artifact: ${artifactPath}`;
  }
  return msg;
};

// Settle a task against the no-op commit gate: behavioral-only tasks (no declared
// outputs) pass trivially; tasks with declared outputs must have them committed in
// `cwd`. On gate failure, persist the debug artifact, emit task.failed, and log —
// returning the error message so each caller applies its own retry semantics
// (in-batch retry-once for the trivial batch, the decide() policy loop for
// worktree tasks).
export const settleNoOpGate = async ({
  task,
  cwd,
  declaredOutputs,
  trace,
  usage,
  state,
  ts,
  durationMs,
  dagId,
  layer,
  emit,
  log,
}: {
  task: DAGTask;
  cwd: string;
  declaredOutputs: string[];
  trace: SessionTrace | undefined;
  usage: TaskUsage | undefined;
  state: ExecutionState;
  ts: string;
  durationMs: number;
  dagId: string;
  layer: number;
  emit: (event: DagEvent) => void;
  log: Logger;
}): Promise<{ ok: true } | { ok: false; errMsg: string }> => {
  const gateResult = await verifyOutputsCommitted(cwd, declaredOutputs);
  if (gateResult.ok) return { ok: true };
  const artifactPath = writeNoOpDebugArtifact(task.id, declaredOutputs, trace, usage, cwd);
  const errMsg = noOpFileOutputError(task.id, declaredOutputs, trace, artifactPath, gateResult.offending);
  emitTaskFailed({ task, state, ts, durationMs, dagId, layer, error: errMsg, emit });
  log.error(`Task ${task.id} silently no-op'd: ${errMsg}`);
  return { ok: false, errMsg };
};
