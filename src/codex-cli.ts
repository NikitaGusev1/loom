import { spawn } from 'node:child_process';
import type { TaskUsage } from './types.js';
import { createTrace, type SessionTrace } from './claude-cli.js';

export interface CodexStreamOptions {
  model: string;
  cwd?: string;
  signal?: AbortSignal;
  onOutput?: (line: string) => void;
}

interface ParsedCodexEvent {
  type?: string;
  event?: string;
  message?: unknown;
  item?: unknown;
  usage?: unknown;
  error?: unknown;
  [key: string]: unknown;
}

const KILL_GRACE_MS = 5_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const numberFrom = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined);

const usageNumber = (record: Record<string, unknown>, camel: string, snake: string): number | undefined =>
  numberFrom(record[camel]) ?? numberFrom(record[snake]);

const readUsage = (value: unknown): Partial<TaskUsage> | undefined => {
  if (!isRecord(value)) return undefined;
  const inputTokens = usageNumber(value, 'inputTokens', 'input_tokens');
  const outputTokens = usageNumber(value, 'outputTokens', 'output_tokens');
  const totalTokens = usageNumber(value, 'totalTokens', 'total_tokens');
  const cachedInputTokens =
    usageNumber(value, 'cacheReadInputTokens', 'cached_input_tokens') ??
    usageNumber(value, 'cacheReadInputTokens', 'cache_read_input_tokens');

  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) return undefined;

  const resolvedInput = inputTokens ?? Math.max(0, (totalTokens ?? 0) - (outputTokens ?? 0));
  const resolvedOutput = outputTokens ?? Math.max(0, (totalTokens ?? 0) - resolvedInput);
  return {
    inputTokens: resolvedInput,
    outputTokens: resolvedOutput,
    cacheReadInputTokens: cachedInputTokens ?? 0,
    cacheCreationInputTokens: usageNumber(value, 'cacheCreationInputTokens', 'cache_creation_input_tokens') ?? 0,
    costUSD: usageNumber(value, 'costUSD', 'cost_usd') ?? 0,
  };
};

const findUsage = (value: unknown): Partial<TaskUsage> | undefined => {
  const direct = readUsage(value);
  if (direct) return direct;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findUsage(item);
      if (found) return found;
    }
  } else if (isRecord(value)) {
    for (const item of Object.values(value)) {
      const found = findUsage(item);
      if (found) return found;
    }
  }
  return undefined;
};

const extractText = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value.trim() ? value : undefined;
  if (Array.isArray(value)) {
    return value.map(extractText).filter(Boolean).join('\n') || undefined;
  }
  if (!isRecord(value)) return undefined;
  for (const key of ['text', 'content', 'message', 'output']) {
    const text = extractText(value[key]);
    if (text) return text;
  }
  return undefined;
};

const noteTrace = (trace: SessionTrace, event: ParsedCodexEvent): void => {
  const eventName = event.type ?? event.event;
  if (eventName) trace.toolCalls[eventName] = (trace.toolCalls[eventName] ?? 0) + 1;
  const text = extractText(event.message) ?? extractText(event.item);
  if (text) trace.lastAssistantText = text.slice(0, 4_000);
};

const parseJsonLine = (line: string): ParsedCodexEvent | undefined => {
  try {
    return JSON.parse(line) as ParsedCodexEvent;
  } catch {
    return undefined;
  }
};

export const runCodexCli = async (
  prompt: string,
  options: CodexStreamOptions,
): Promise<{ usage?: TaskUsage; trace: SessionTrace }> => {
  const bin = process.env.CODEX_BIN ?? 'codex';
  const modelArgs = options.model && options.model !== 'account-default' ? ['--model', options.model] : [];
  const args = [
    'exec',
    '--json',
    ...modelArgs,
    '--sandbox',
    'workspace-write',
    '--skip-git-repo-check',
    ...(options.cwd ? ['--cd', options.cwd] : []),
    '-',
  ];

  const started = Date.now();
  const trace = createTrace();
  let usagePartial: Partial<TaskUsage> | undefined;
  let stderr = '';
  let stdoutRemainder = '';
  let sawJson = false;
  let errorDetail = '';

  const child = spawn(bin, args, {
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  child.stdin.on('error', () => {});
  child.stdin.write(prompt);
  child.stdin.end();

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => {
    stderr += d;
  });

  let killTimer: NodeJS.Timeout | undefined;
  const onAbort = (): void => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      // already gone
    }
    killTimer = setTimeout(() => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }, KILL_GRACE_MS);
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

  try {
    child.stdout.setEncoding('utf8');
    for await (const chunk of child.stdout) {
      stdoutRemainder += chunk as string;
      const lines = stdoutRemainder.split('\n');
      stdoutRemainder = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        options.onOutput?.(trimmed);
        const event = parseJsonLine(trimmed);
        if (!event) continue;
        sawJson = true;
        noteTrace(trace, event);
        usagePartial = findUsage(event) ?? usagePartial;
        if (event.error) errorDetail = JSON.stringify(event.error).slice(0, 2_000);
      }
    }

    if (stdoutRemainder.trim()) {
      options.onOutput?.(stdoutRemainder.trim());
      const event = parseJsonLine(stdoutRemainder.trim());
      if (event) {
        sawJson = true;
        noteTrace(trace, event);
        usagePartial = findUsage(event) ?? usagePartial;
        if (event.error) errorDetail = JSON.stringify(event.error).slice(0, 2_000);
      }
    }
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
  }

  const { code, sig } = await exited;
  if (killTimer) clearTimeout(killTimer);

  const stderrSuffix = stderr.trim() ? `: ${stderr.trim()}` : '';
  if (signal?.aborted) throw new Error(`codex exec aborted${stderrSuffix}`);
  if (code !== 0) throw new Error(`codex exec exited ${code}${errorDetail ? ` (${errorDetail})` : ''}${stderrSuffix}`);
  if (!sawJson && stderr.trim()) throw new Error(`codex exec produced no JSON events${stderrSuffix}`);

  const durationMs = Math.max(0, Date.now() - started);
  return {
    usage: {
      inputTokens: usagePartial?.inputTokens ?? 0,
      outputTokens: usagePartial?.outputTokens ?? 0,
      cacheReadInputTokens: usagePartial?.cacheReadInputTokens ?? 0,
      cacheCreationInputTokens: usagePartial?.cacheCreationInputTokens ?? 0,
      costUSD: usagePartial?.costUSD ?? 0,
      numTurns: 0,
      durationMs,
      durationApiMs: 0,
    },
    trace,
  };
};
