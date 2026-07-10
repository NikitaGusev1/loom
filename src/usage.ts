// Single home for TaskUsage field-wise arithmetic. The exhaustive
// Record<keyof TaskUsage, ...> forces new TaskUsage fields to be classified here.

import type { TaskUsage } from './types.js';

// false -> integer count, divides with Math.ceil.
// true -> continuous ratio, divides as a true fraction.
const DIVIDE_AS_RATIO: Record<keyof TaskUsage, boolean> = {
  inputTokens: false,
  outputTokens: false,
  cacheReadInputTokens: false,
  cacheCreationInputTokens: false,
  costUSD: true,
  numTurns: false,
  durationMs: false,
  durationApiMs: false,
};

const USAGE_FIELDS = Object.keys(DIVIDE_AS_RATIO) as (keyof TaskUsage)[];

export const USAGE_TOKEN_FIELDS = [
  'inputTokens',
  'outputTokens',
  'cacheReadInputTokens',
  'cacheCreationInputTokens',
] as const satisfies readonly (keyof TaskUsage)[];

export const ZERO_USAGE: TaskUsage = Object.fromEntries(USAGE_FIELDS.map((field) => [field, 0])) as unknown as TaskUsage;

export const addUsage = (a: TaskUsage | undefined, b: TaskUsage | undefined): TaskUsage | undefined => {
  if (!a) return b;
  if (!b) return a;
  return Object.fromEntries(USAGE_FIELDS.map((field) => [field, a[field] + b[field]])) as unknown as TaskUsage;
};

export const divideUsage = (usage: TaskUsage, divisor: number): TaskUsage =>
  Object.fromEntries(
    USAGE_FIELDS.map((field) => [
      field,
      DIVIDE_AS_RATIO[field] ? usage[field] / divisor : Math.ceil(usage[field] / divisor),
    ]),
  ) as unknown as TaskUsage;
