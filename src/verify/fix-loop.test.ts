import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runVerifyFixLoop, sumUsage } from './fix-loop.js';
import type { VerificationOutcome } from './run.js';
import type { TaskUsage } from '../types.js';

const usage = (n: number): TaskUsage => ({
  inputTokens: n,
  outputTokens: n,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  costUSD: n,
  numTurns: 1,
  durationMs: n,
  durationApiMs: n,
});

const pass: VerificationOutcome = { ok: true, results: [{ kind: 'test', status: 'pass', output: '' }] };
const fail: VerificationOutcome = { ok: false, results: [{ kind: 'test', status: 'fail', output: 'boom' }] };

const ARGS = { basePrompt: 'do the task', fixNotice: 'FIX IT', maxAttempts: 2 };

describe('runVerifyFixLoop', () => {
  it('passes on first verification → no fix re-invokes', async () => {
    let fixCalls = 0;
    const res = await runVerifyFixLoop(
      {
        runFix: async () => {
          fixCalls += 1;
          return {};
        },
        getChangedFiles: async () => ['a.ts'],
        runVerification: async () => pass,
      },
      ARGS,
    );
    assert.equal(res.ok, true);
    assert.equal(res.attempts, 0);
    assert.equal(fixCalls, 0);
    assert.equal(res.fixUsage, undefined);
  });

  it('passes after one fix', async () => {
    let verifyCalls = 0;
    let fixCalls = 0;
    const res = await runVerifyFixLoop(
      {
        runFix: async () => {
          fixCalls += 1;
          return { usage: usage(5) };
        },
        getChangedFiles: async () => ['a.ts'],
        runVerification: async () => {
          verifyCalls += 1;
          return verifyCalls === 1 ? fail : pass;
        },
      },
      ARGS,
    );
    assert.equal(res.ok, true);
    assert.equal(res.attempts, 1);
    assert.equal(fixCalls, 1);
    assert.deepEqual(res.fixUsage, usage(5));
  });

  it('exhausts maxAttempts and reports failure', async () => {
    let fixCalls = 0;
    const res = await runVerifyFixLoop(
      {
        runFix: async () => {
          fixCalls += 1;
          return { usage: usage(2) };
        },
        getChangedFiles: async () => [],
        runVerification: async () => fail,
      },
      ARGS,
    );
    assert.equal(res.ok, false);
    assert.equal(res.attempts, 2);
    assert.equal(fixCalls, 2);
    // usage summed across both fix attempts
    assert.equal(res.fixUsage?.inputTokens, 4);
    assert.deepEqual(res.outcome, fail);
  });

  it('the fix prompt includes the base prompt, the notice, and the failure detail', async () => {
    let seenPrompt = '';
    await runVerifyFixLoop(
      {
        runFix: async (p) => {
          seenPrompt = p;
          return {};
        },
        getChangedFiles: async () => [],
        runVerification: async () => fail, // always fail to force a fix
      },
      { ...ARGS, maxAttempts: 1 },
    );
    assert.match(seenPrompt, /do the task/);
    assert.match(seenPrompt, /FIX IT/);
    assert.match(seenPrompt, /boom/);
  });
});

describe('sumUsage', () => {
  it('returns the other operand when one is undefined', () => {
    assert.deepEqual(sumUsage(undefined, usage(3)), usage(3));
    assert.deepEqual(sumUsage(usage(3), undefined), usage(3));
    assert.equal(sumUsage(undefined, undefined), undefined);
  });

  it('adds field-wise', () => {
    const s = sumUsage(usage(2), usage(3))!;
    assert.equal(s.inputTokens, 5);
    assert.equal(s.outputTokens, 5);
    assert.equal(s.costUSD, 5);
    assert.equal(s.numTurns, 2);
  });
});
