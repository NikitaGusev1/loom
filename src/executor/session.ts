// runQuery — the single spawn point for every LLM session in the system.
// Owns the tool allowlists, weight→model/turns mapping, and the DAG_DEBUG
// per-message summaries.

import type { DAGTask, ExecutorConfig, TaskUsage } from '../types.js';
import { WEIGHT_MAX_TURNS } from '../types.js';
import { WEIGHT_BUDGET_USD } from '../consts.js';
import {
  streamClaudeCli,
  recordTraceFromMessage,
  extractUsageFromResult,
  createTrace,
  type ParsedMessage,
  type SessionTrace,
} from '../claude-cli.js';
import { runCodexCli } from '../codex-cli.js';
import { acquireSlot } from '../semaphore.js';

const getMaxTurns = (weight: DAGTask['weight'], config: ExecutorConfig): number =>
  WEIGHT_MAX_TURNS[weight] ?? config.maxTurns;

const getModelForWeight = (weight: DAGTask['weight'], config: ExecutorConfig): string =>
  weight === 'heavy' ? config.heavyModel : config.defaultModel;

const ALLOWED_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash', 'Agent', 'Notebook'];
export const TRIVIAL_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'];

const DAG_DEBUG = process.env.DAG_DEBUG === '1';

const summarizeMessage = (m: ParsedMessage): Record<string, unknown> => {
  const out: Record<string, unknown> = { type: m.type };
  if (m.type === 'assistant' || m.type === 'user') {
    const content = m.message?.content;
    if (Array.isArray(content)) {
      out.blocks = content.map((b) => {
        if (b.type === 'tool_use') {
          return { tool: b.name, input_keys: b.input && typeof b.input === 'object' ? Object.keys(b.input) : [] };
        }
        if (b.type === 'tool_result') return { tool_result_for: b.tool_use_id };
        if (b.type === 'text') return { text: (b.text ?? '').slice(0, 200) };
        return { kind: b.type };
      });
    }
  } else if (m.type === 'result') {
    out.num_turns = m.num_turns;
    out.duration_ms = m.duration_ms;
    out.is_error = m.is_error;
    out.subtype = m.subtype;
  } else if (m.type === 'system') {
    out.subtype = m.subtype;
  }
  return out;
};

export const runQuery = async (
  prompt: string,
  weight: DAGTask['weight'],
  config: ExecutorConfig,
  opts?: { cwd?: string; allowedTools?: string[]; signal?: AbortSignal; label?: string },
): Promise<{ usage?: TaskUsage; trace: SessionTrace }> => {
  let usage: TaskUsage | undefined;
  const trace: SessionTrace = createTrace();

  // Acquire a machine-wide concurrency slot before spawning the LLM session — the
  // single chokepoint that bounds RAM across all dag-executor windows. Waits here
  // if every slot is busy; releases in finally so a crash mid-session frees it.
  const releaseSlot = await acquireSlot(opts?.label ?? weight, { signal: opts?.signal });

  try {
    if (config.provider === 'codex') {
      return await runCodexCli(prompt, {
        model: getModelForWeight(weight, config),
        ...(opts?.cwd && { cwd: opts.cwd }),
        ...(opts?.signal && { signal: opts.signal }),
      });
    }

    const stream = streamClaudeCli(prompt, {
      model: getModelForWeight(weight, config),
      maxTurns: getMaxTurns(weight, config),
      maxBudgetUsd: WEIGHT_BUDGET_USD[weight],
      permissionMode: config.permissionMode,
      allowedTools: opts?.allowedTools ?? ALLOWED_TOOLS,
      ...(opts?.cwd && { cwd: opts.cwd }),
      ...(opts?.signal && { signal: opts.signal }),
    });
    for await (const message of stream) {
      if (DAG_DEBUG) {
        console.log(`[DAG_DEBUG] ${JSON.stringify(summarizeMessage(message))}`);
      }
      recordTraceFromMessage(trace, message);
      if (message.type === 'result') {
        usage = extractUsageFromResult(message);
      }
    }
  } finally {
    releaseSlot();
  }

  return { usage, trace };
};
