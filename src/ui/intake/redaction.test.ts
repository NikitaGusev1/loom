import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { redactIntakeOutput } from './redaction.js';

describe('redactIntakeOutput', () => {
  it('redacts bearer, provider key, and environment-style secrets', () => {
    const output = redactIntakeOutput('Bearer abc.def API_KEY=secret sk-abcdefghijklmnop');
    assert.doesNotMatch(output, /abc\.def|secret|abcdefghijklmnop/);
    assert.match(output, /\[REDACTED\]/);
  });
});
