import type { TaskUsage } from './types.js';

export interface Logger {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  success: (message: string) => void;
  progress: (completed: number, total: number, label: string) => void;
  taskUsage: (taskId: string, usage: TaskUsage) => void;
  layerCostSummary: (layerNum: number, taskUsages: Array<{ taskId: string; usage: TaskUsage }>) => void;
  dagCostSummary: (taskEntries: Array<{ id: string; usage: TaskUsage }>) => void;
  passStart: (taskId: string) => void;
  child: (prefix: string) => Logger;
}

const RESET = '\x1b[0m';
const GRAY = '\x1b[90m';
const BLUE = '\x1b[34m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const BOLD = '\x1b[1m';

const fmtTokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

const fmtCost = (usd: number): string => `$${usd.toFixed(2)}`;

const fmtDuration = (ms: number): string => {
  const s = ms / 1000;
  return s >= 60 ? `${(s / 60).toFixed(1)}m` : `${s.toFixed(1)}s`;
};

const timestamp = (): string => {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
};

export const createLogger = (prefixes: string[] = []): Logger => {
  const fmt = (color: string, level: string, message: string): string => {
    const ts = `${GRAY}[${timestamp()}]${RESET}`;
    const pfx = prefixes.map((p) => ` ${GRAY}[${p}]${RESET}`).join('');
    const lvl = `${color}${level}${RESET}`;
    return `${ts}${pfx} ${lvl} ${message}`;
  };

  return {
    info: (message: string) => {
      console.error(fmt(BLUE, 'INFO', message));
    },
    warn: (message: string) => {
      console.error(fmt(YELLOW, 'WARN', message));
    },
    error: (message: string) => {
      console.error(fmt(RED, 'ERROR', message));
    },
    success: (message: string) => {
      console.error(fmt(GREEN, '  OK', message));
    },
    progress: (completed: number, total: number, label: string) => {
      const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
      const bar = `[${completed}/${total}]`;
      console.error(fmt(BLUE, 'PROG', `${bar} ${pct}% ${label}`));
    },
    taskUsage: (taskId: string, usage: TaskUsage) => {
      console.error(
        fmt(
          CYAN,
          'COST',
          `${taskId}: ${fmtTokens(usage.inputTokens)} in / ${fmtTokens(usage.outputTokens)} out, ` +
            `${usage.numTurns} turns, ${fmtCost(usage.costUSD)} (${fmtDuration(usage.durationMs)})`,
        ),
      );
    },
    layerCostSummary: (layerNum: number, taskUsages: Array<{ taskId: string; usage: TaskUsage }>) => {
      const totalCost = taskUsages.reduce((sum, t) => sum + t.usage.costUSD, 0);
      const totalDuration = Math.max(...taskUsages.map((t) => t.usage.durationMs), 0);
      console.error(
        fmt(
          CYAN,
          'COST',
          `Layer ${layerNum} total: ${taskUsages.length} task(s), ` +
            `${fmtCost(totalCost)} (${fmtDuration(totalDuration)})`,
        ),
      );
    },
    dagCostSummary: (entries: Array<{ id: string; usage: TaskUsage }>) => {
      if (entries.length === 0) return;

      const pad = (s: string, n: number) => s.padEnd(n);
      const rpad = (s: string, n: number) => s.padStart(n);
      const idWidth = Math.max(7, ...entries.map((e) => e.id.length)) + 2;

      const header =
        `${BOLD}${pad('Task', idWidth)}${rpad('Input', 10)}${rpad('Output', 10)}` +
        `${rpad('Turns', 7)}${rpad('Cost', 9)}${RESET}`;
      const sep = '-'.repeat(idWidth + 10 + 10 + 7 + 9);

      console.error('');
      console.error(header);
      console.error(sep);
      for (const { id, usage } of entries) {
        console.error(
          `${pad(id, idWidth)}${rpad(fmtTokens(usage.inputTokens), 10)}` +
            `${rpad(fmtTokens(usage.outputTokens), 10)}` +
            `${rpad(String(usage.numTurns), 7)}${rpad(fmtCost(usage.costUSD), 9)}`,
        );
      }
      console.error(sep);

      const totIn = entries.reduce((s, e) => s + e.usage.inputTokens, 0);
      const totOut = entries.reduce((s, e) => s + e.usage.outputTokens, 0);
      const totTurns = entries.reduce((s, e) => s + e.usage.numTurns, 0);
      const totCost = entries.reduce((s, e) => s + e.usage.costUSD, 0);

      console.error(
        `${BOLD}${pad('Total', idWidth)}${rpad(fmtTokens(totIn), 10)}` +
          `${rpad(fmtTokens(totOut), 10)}` +
          `${rpad(String(totTurns), 7)}${rpad(fmtCost(totCost), 9)}${RESET}`,
      );
      console.error('');
    },
    passStart: (taskId: string) => {
      console.error(fmt(BLUE, 'INFO', `Task ${taskId}: starting Implement pass`));
    },
    child: (childPrefix: string) => createLogger([...prefixes, childPrefix]),
  };
};
