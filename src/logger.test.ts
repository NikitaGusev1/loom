import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from './logger.js';
import type { TaskUsage } from './types.js';

const makeUsage = (overrides: Partial<TaskUsage> = {}): TaskUsage => ({
  inputTokens: 125_400,
  outputTokens: 18_300,
  cacheReadInputTokens: 42_000,
  cacheCreationInputTokens: 8_000,
  costUSD: 1.23,
  numTurns: 7,
  durationMs: 94_500,
  durationApiMs: 72_000,
  ...overrides,
});

// Capture console.error output
let captured: string[];
let origError: typeof console.error;

beforeEach(() => {
  captured = [];
  origError = console.error;
  console.error = (...args: unknown[]) => {
    captured.push(args.map(String).join(' '));
  };
});

afterEach(() => {
  console.error = origError;
});

// Strip ANSI escape codes for assertion readability
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('taskUsage', () => {
  it('formats tokens with k suffix, cost, turns, and duration', () => {
    const log = createLogger();
    log.taskUsage('my-task', makeUsage());
    assert.equal(captured.length, 1);
    const line = strip(captured[0]);
    assert.match(line, /COST/);
    assert.match(line, /my-task: 125\.4k in \/ 18\.3k out/);
    assert.match(line, /7 turns/);
    assert.match(line, /\$1\.23/);
    assert.match(line, /1\.6m/); // 94500ms = 1.575m
  });

  it('formats sub-1000 tokens without k suffix', () => {
    const log = createLogger();
    log.taskUsage('small', makeUsage({ inputTokens: 500, outputTokens: 80 }));
    const line = strip(captured[0]);
    assert.match(line, /500 in \/ 80 out/);
  });

  it('formats sub-60s duration as seconds', () => {
    const log = createLogger();
    log.taskUsage('fast', makeUsage({ durationMs: 12_300 }));
    const line = strip(captured[0]);
    assert.match(line, /12\.3s/);
  });
});

describe('layerCostSummary', () => {
  it('prints layer total with task count, cost, and wall-clock duration', () => {
    const log = createLogger();
    log.layerCostSummary(2, [
      { taskId: 'a', usage: makeUsage({ costUSD: 1.0, durationMs: 60_000 }) },
      { taskId: 'b', usage: makeUsage({ costUSD: 2.5, durationMs: 120_000 }) },
    ]);
    assert.equal(captured.length, 1);
    const line = strip(captured[0]);
    assert.match(line, /Layer 2 total: 2 task\(s\)/);
    assert.match(line, /\$3\.50/);
    assert.match(line, /2\.0m/); // max(60s, 120s) = 120s = 2.0m
  });
});

describe('dagCostSummary', () => {
  it('prints nothing for empty entries', () => {
    const log = createLogger();
    log.dagCostSummary([]);
    assert.equal(captured.length, 0);
  });

  it('prints a table with header, rows, and totals', () => {
    const log = createLogger();
    log.dagCostSummary([
      { id: 'task-a', usage: makeUsage({ inputTokens: 10_000, outputTokens: 2_000, numTurns: 3, costUSD: 0.5 }) },
      { id: 'task-b', usage: makeUsage({ inputTokens: 20_000, outputTokens: 5_000, numTurns: 8, costUSD: 1.75 }) },
    ]);

    const lines = captured.map(strip);

    // Header row
    const headerLine = lines.find((l) => l.includes('Task') && l.includes('Input'));
    assert.ok(headerLine, 'should have a header line');
    assert.match(headerLine, /Task/);
    assert.match(headerLine, /Input/);
    assert.match(headerLine, /Output/);
    assert.match(headerLine, /Turns/);
    assert.match(headerLine, /Cost/);

    // Separator
    const sepLine = lines.find((l) => /^-+$/.test(l));
    assert.ok(sepLine, 'should have a separator line');

    // Data rows
    const taskALine = lines.find((l) => l.includes('task-a'));
    assert.ok(taskALine);
    assert.match(taskALine, /10\.0k/);
    assert.match(taskALine, /2\.0k/);
    assert.match(taskALine, /3/);
    assert.match(taskALine, /\$0\.50/);

    const taskBLine = lines.find((l) => l.includes('task-b'));
    assert.ok(taskBLine);
    assert.match(taskBLine, /20\.0k/);
    assert.match(taskBLine, /5\.0k/);
    assert.match(taskBLine, /8/);
    assert.match(taskBLine, /\$1\.75/);

    // Totals row
    const totalLine = lines.find((l) => l.includes('Total'));
    assert.ok(totalLine, 'should have a totals row');
    assert.match(totalLine, /30\.0k/); // 10k + 20k input
    assert.match(totalLine, /7\.0k/); // 2k + 5k output
    assert.match(totalLine, /11/); // 3 + 8 turns
    assert.match(totalLine, /\$2\.25/); // 0.50 + 1.75
  });

  it('adapts column width to long task IDs', () => {
    const log = createLogger();
    const longId = 'a-very-long-task-identifier-name';
    log.dagCostSummary([{ id: longId, usage: makeUsage() }]);
    const lines = captured.map(strip);
    const dataLine = lines.find((l) => l.includes(longId));
    assert.ok(dataLine);
    // The ID should not be truncated
    assert.ok(dataLine.startsWith(longId));
  });
});

describe('passStart', () => {
  it('formats task id with Implement pass', () => {
    const log = createLogger();
    log.passStart('build-header');
    assert.equal(captured.length, 1);
    const line = strip(captured[0]);
    assert.match(line, /INFO/);
    assert.match(line, /Task build-header: starting Implement pass/);
  });

  it('works on child loggers', () => {
    const log = createLogger(['Layer 1']).child('task-a');
    log.passStart('task-a');
    const line = strip(captured[0]);
    assert.match(line, /\[Layer 1\]/);
    assert.match(line, /\[task-a\]/);
    assert.match(line, /starting Implement pass/);
  });
});

describe('child logger', () => {
  it('preserves cost methods on child loggers', () => {
    const log = createLogger(['parent']).child('child');
    log.taskUsage('x', makeUsage({ costUSD: 0.01 }));
    assert.equal(captured.length, 1);
    const line = strip(captured[0]);
    assert.match(line, /\[parent\]/);
    assert.match(line, /\[child\]/);
    assert.match(line, /\$0\.01/);
  });
});
