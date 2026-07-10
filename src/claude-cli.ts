import { spawn } from 'node:child_process';
import type { TaskUsage } from './types.js';
import { USAGE_TOKEN_FIELDS } from './usage.js';

// ---------------------------------------------------------------------------
// Local message types — replace the SDK's SDKMessage / ModelUsage. The Claude
// CLI's `--output-format stream-json` emits the same Anthropic message schema the
// Agent SDK wrapped, so these mirror only the fields we consume. Extra CLI fields
// (costUSD/contextWindow/maxOutputTokens on modelUsage, etc.) are tolerated and
// ignored.
// ---------------------------------------------------------------------------

export interface CliModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  [key: string]: unknown;
}

export interface ContentBlock {
  type: string; // 'text' | 'tool_use' | 'tool_result' | 'thinking' | ...
  name?: string; // tool_use
  input?: unknown; // tool_use
  text?: string; // text
  tool_use_id?: string; // tool_result (read by summarizeMessage)
}

export interface ParsedMessage {
  type: string; // 'assistant' | 'user' | 'result' | 'system' | 'rate_limit_event' | 'stream_event'
  subtype?: string;
  message?: { content?: ContentBlock[] };
  // result-event fields:
  modelUsage?: Record<string, CliModelUsage>;
  total_cost_usd?: number;
  num_turns?: number;
  duration_ms?: number;
  duration_api_ms?: number;
  is_error?: boolean;
  stop_reason?: string;
  result?: string;
}

// ---------------------------------------------------------------------------
// SessionTrace — per-session trace captured while streaming messages. Lets no-op
// detection distinguish its two root-cause classes: zero Write/Edit calls (agent
// emitted content as prose or declared the task already done) vs. writes that
// landed outside the expected tree (wrong-cwd).
// ---------------------------------------------------------------------------

export interface SessionTrace {
  /** tool_use block counts by tool name */
  toolCalls: Record<string, number>;
  /** file_path inputs of Write/Edit/NotebookEdit calls (capped) */
  writePaths: string[];
  /** last non-empty assistant text block (truncated) */
  lastAssistantText: string;
}

export const createTrace = (): SessionTrace => ({ toolCalls: {}, writePaths: [], lastAssistantText: '' });

const TRACE_WRITE_PATHS_CAP = 50;
const TRACE_TEXT_CAP = 4_000;
export const WRITE_TOOL_NAMES = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

export const recordTraceFromMessage = (trace: SessionTrace, m: ParsedMessage): void => {
  if (m.type !== 'assistant') return;
  const content = m.message?.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block.type === 'tool_use' && block.name) {
      trace.toolCalls[block.name] = (trace.toolCalls[block.name] ?? 0) + 1;
      if (WRITE_TOOL_NAMES.has(block.name) && block.input && typeof block.input === 'object') {
        const input = block.input as Record<string, unknown>;
        const fp = input.file_path ?? input.notebook_path;
        if (typeof fp === 'string' && trace.writePaths.length < TRACE_WRITE_PATHS_CAP) {
          trace.writePaths.push(fp);
        }
      }
    } else if (block.type === 'text' && block.text && block.text.trim()) {
      trace.lastAssistantText = block.text.slice(0, TRACE_TEXT_CAP);
    }
  }
};

export const countWriteCalls = (trace: SessionTrace): number =>
  [...WRITE_TOOL_NAMES].reduce((sum, name) => sum + (trace.toolCalls[name] ?? 0), 0);

export const aggregateModelUsage = (
  modelUsage: Record<string, CliModelUsage>,
): Pick<TaskUsage, 'inputTokens' | 'outputTokens' | 'cacheReadInputTokens' | 'cacheCreationInputTokens'> => {
  const totals = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
  for (const mu of Object.values(modelUsage)) {
    for (const field of USAGE_TOKEN_FIELDS) totals[field] += mu[field];
  }
  return totals;
};

export const extractUsageFromResult = (m: ParsedMessage): TaskUsage => ({
  ...aggregateModelUsage(m.modelUsage ?? {}),
  costUSD: m.total_cost_usd ?? 0,
  numTurns: m.num_turns ?? 0,
  durationMs: m.duration_ms ?? 0,
  durationApiMs: m.duration_api_ms ?? 0,
});

// ---------------------------------------------------------------------------
// NDJSON parsing — `claude -p --output-format stream-json` is line-delimited
// JSON. Pure + testable: feed (remainder, chunk) and get back fully-parsed
// messages plus the new trailing partial line to carry forward. Never parses an
// incomplete line; malformed lines are skipped rather than throwing.
// ---------------------------------------------------------------------------

export const parseNdjsonChunk = (
  remainder: string,
  chunk: string,
): { messages: ParsedMessage[]; remainder: string } => {
  const buf = remainder + chunk;
  const parts = buf.split('\n');
  const newRemainder = parts.pop() ?? '';
  const messages: ParsedMessage[] = [];
  for (const line of parts) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      messages.push(JSON.parse(trimmed) as ParsedMessage);
    } catch {
      // skip malformed line (defensive — should not happen on well-formed stream)
    }
  }
  return { messages, remainder: newRemainder };
};

// Pure fold over a full message array — the testable heart of the stream consumer.
export const foldStreamMessages = (msgs: ParsedMessage[]): { usage?: TaskUsage; trace: SessionTrace } => {
  const trace = createTrace();
  let usage: TaskUsage | undefined;
  for (const m of msgs) {
    recordTraceFromMessage(trace, m);
    if (m.type === 'result') usage = extractUsageFromResult(m);
  }
  return { usage, trace };
};

// ---------------------------------------------------------------------------
// streamClaudeCli — spawn `claude -p` and stream parsed NDJSON messages. Owns
// the child lifecycle: prompt via stdin (avoids ARG_MAX + the 3s no-stdin
// stall), process-group kill on deadline/abort, stderr capture, and exit-code /
// is_error / no-result error mapping. The thrown error's *text* carries stderr so
// the retry policy (policy/retry.ts) can pattern-match transient failures.
// ---------------------------------------------------------------------------

export interface StreamOptions {
  model: string;
  maxTurns: number;
  maxBudgetUsd: number;
  permissionMode: string;
  allowedTools: string[];
  cwd?: string;
  signal?: AbortSignal;
}

const KILL_GRACE_MS = 5_000;

export async function* streamClaudeCli(prompt: string, options: StreamOptions): AsyncGenerator<ParsedMessage> {
  const bin = process.env.CLAUDE_BIN ?? 'claude';
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose', // REQUIRED with -p + stream-json
    '--model',
    options.model,
    '--max-budget-usd',
    String(options.maxBudgetUsd),
    '--max-turns',
    String(options.maxTurns),
    '--permission-mode',
    options.permissionMode,
    '--dangerously-skip-permissions',
    '--setting-sources',
    'user,project,local',
    '--no-session-persistence',
    // variadic; keep LAST-but-one so the trailing flag terminates the list
    '--allowedTools',
    ...options.allowedTools,
  ];

  const child = spawn(bin, args, {
    ...(options.cwd && { cwd: options.cwd }),
    detached: true, // own process group so -pid kills claude's descendants too
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Feed the prompt over stdin then close it. Swallow EPIPE if the child exits early.
  child.stdin.on('error', () => {});
  child.stdin.write(prompt);
  child.stdin.end();

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => {
    stderr += d;
  });

  // Process-group kill on abort (deadline or SIGINT). Guard child.pid (undefined
  // on synchronous spawn failure). SIGTERM, then SIGKILL after a grace window.
  let killTimer: NodeJS.Timeout | undefined;
  const onAbort = (): void => {
    if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        // already gone
      }
      killTimer = setTimeout(() => {
        if (child.pid) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            // already gone
          }
        }
      }, KILL_GRACE_MS);
    }
  };
  const signal = options.signal;
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  const exited = new Promise<{ code: number | null; sig: NodeJS.Signals | null }>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, sig) => resolve({ code, sig }));
  });

  let remainder = '';
  let sawResult = false;
  let resultErrored = false;
  let resultDetail = '';

  const noteResult = (m: ParsedMessage): void => {
    sawResult = true;
    resultErrored = m.is_error === true;
    resultDetail = `${m.subtype ?? ''}: ${m.result ?? ''}`.trim();
  };

  try {
    child.stdout.setEncoding('utf8');
    for await (const chunk of child.stdout) {
      const parsed = parseNdjsonChunk(remainder, chunk as string);
      remainder = parsed.remainder;
      for (const m of parsed.messages) {
        if (m.type === 'result') noteResult(m);
        yield m;
      }
    }
    // Flush any trailing partial line.
    if (remainder.trim()) {
      const parsed = parseNdjsonChunk('', remainder + '\n');
      for (const m of parsed.messages) {
        if (m.type === 'result') noteResult(m);
        yield m;
      }
    }
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
  }

  const { code, sig } = await exited;
  if (killTimer) clearTimeout(killTimer);

  const stderrSuffix = stderr.trim() ? `: ${stderr.trim()}` : '';
  if (signal?.aborted) {
    // Deadline/SIGINT abort — caller routes to task.timeout via wasDeadlineAbort(),
    // which inspects the abort reason, not this error.
    throw new Error(`claude -p aborted${stderrSuffix}`);
  }
  if (resultErrored) {
    throw new Error(`claude -p result error (${resultDetail})${stderrSuffix}`);
  }
  if (!sawResult) {
    throw new Error(`claude -p produced no result event (exit=${code}, signal=${sig})${stderrSuffix}`);
  }
  if (code !== 0) {
    throw new Error(`claude -p exited ${code}${stderrSuffix}`);
  }
}
