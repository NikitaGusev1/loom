import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { TaskUsage } from './types.js';
import { ZERO_USAGE, addUsage, divideUsage, USAGE_TOKEN_FIELDS } from './usage.js';

const usage = (n: number): TaskUsage => ({
  inputTokens: n,
  outputTokens: n,
  cacheReadInputTokens: n,
  cacheCreationInputTokens: n,
  costUSD: n,
  numTurns: n,
  durationMs: n,
  durationApiMs: n,
});

describe('ZERO_USAGE', () => {
  it('has every TaskUsage field set to 0', () => {
    assert.deepEqual(ZERO_USAGE, usage(0));
  });
});

describe('addUsage', () => {
  it('returns the other operand when one is undefined', () => {
    assert.deepEqual(addUsage(undefined, usage(3)), usage(3));
    assert.deepEqual(addUsage(usage(3), undefined), usage(3));
    assert.equal(addUsage(undefined, undefined), undefined);
  });

  it('adds every field field-wise', () => {
    assert.deepEqual(addUsage(usage(2), usage(3)), usage(5));
  });
});

describe('divideUsage', () => {
  it('ceils integer-count fields but divides costUSD as a true ratio', () => {
    const d = divideUsage(
      {
        inputTokens: 10,
        outputTokens: 7,
        cacheReadInputTokens: 3,
        cacheCreationInputTokens: 1,
        costUSD: 9,
        numTurns: 5,
        durationMs: 8,
        durationApiMs: 4,
      },
      3,
    );

    assert.equal(d.inputTokens, 4);
    assert.equal(d.outputTokens, 3);
    assert.equal(d.cacheReadInputTokens, 1);
    assert.equal(d.cacheCreationInputTokens, 1);
    assert.equal(d.numTurns, 2);
    assert.equal(d.durationMs, 3);
    assert.equal(d.durationApiMs, 2);
    assert.equal(d.costUSD, 3);
  });

  it('keeps costUSD fractional', () => {
    const d = divideUsage({ ...usage(0), costUSD: 1 }, 4);
    assert.equal(d.costUSD, 0.25);
  });
});

describe('USAGE_TOKEN_FIELDS', () => {
  it('is the token subset used for per-model usage folds', () => {
    assert.deepEqual(
      [...USAGE_TOKEN_FIELDS],
      ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens'],
    );
  });
});
