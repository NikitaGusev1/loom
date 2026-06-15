import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseNdjsonChunk,
  foldStreamMessages,
  recordTraceFromMessage,
  createTrace,
  type ParsedMessage,
} from './claude-cli.js';

// The fixture is a real `claude -p --output-format stream-json --verbose` capture
// (2026-06-08 spike). It is not compiled into build/, so resolve back to src/.
const fixtureUrl = new URL('../src/__fixtures__/stream-json-read.jsonl', import.meta.url);
const fixtureLines = readFileSync(fixtureUrl, 'utf8').split('\n').filter(Boolean);
const fixtureMessages: ParsedMessage[] = fixtureLines.map((l) => JSON.parse(l) as ParsedMessage);

test('foldStreamMessages reconstructs trace + usage from the captured fixture', () => {
  const { usage, trace } = foldStreamMessages(fixtureMessages);

  // Trace: one Read tool call, no writes, last assistant text is the version.
  assert.equal(trace.toolCalls.Read, 1);
  assert.equal(trace.writePaths.length, 0);
  assert.equal(trace.lastAssistantText, '0.2.1');

  // Usage: pulled from the result event's camelCase modelUsage + top-level fields.
  assert.ok(usage, 'usage should be set from the result event');
  assert.equal(usage.numTurns, 2);
  assert.equal(usage.inputTokens, 4626);
  assert.equal(usage.outputTokens, 116);
  assert.equal(usage.cacheReadInputTokens, 23208);
  assert.equal(usage.cacheCreationInputTokens, 27994);
  assert.equal(usage.costUSD, 0.2125965);
});

test('foldStreamMessages tolerates system / rate_limit_event lines', () => {
  // The fixture contains system (hook/init) and rate_limit_event lines; folding
  // must ignore them rather than throw or miscount.
  const types = new Set(fixtureMessages.map((m) => m.type));
  assert.ok(types.has('system'));
  assert.ok(types.has('rate_limit_event'));
  const { trace } = foldStreamMessages(fixtureMessages);
  // Only the single Read tool_use is counted across all assistant messages.
  assert.deepEqual(trace.toolCalls, { Read: 1 });
});

test('parseNdjsonChunk reassembles a line split across two chunks', () => {
  const raw = JSON.stringify({ type: 'result', num_turns: 7, total_cost_usd: 1.5 });
  const splitAt = Math.floor(raw.length / 2);
  const first = raw.slice(0, splitAt);
  const second = raw.slice(splitAt) + '\n';

  const a = parseNdjsonChunk('', first);
  assert.equal(a.messages.length, 0, 'incomplete line yields no message');
  assert.equal(a.remainder, first);

  const b = parseNdjsonChunk(a.remainder, second);
  assert.equal(b.messages.length, 1);
  assert.equal(b.messages[0].num_turns, 7);
  assert.equal(b.remainder, '');
});

test('parseNdjsonChunk parses multiple complete lines in one chunk and holds the partial', () => {
  const l1 = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } });
  const l2 = JSON.stringify({ type: 'result', num_turns: 1 });
  const partial = '{"type":"resu';
  const { messages, remainder } = parseNdjsonChunk('', `${l1}\n${l2}\n${partial}`);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].type, 'assistant');
  assert.equal(messages[1].type, 'result');
  assert.equal(remainder, partial);
});

test('recordTraceFromMessage collects write paths and last text, ignores non-assistant', () => {
  const trace = createTrace();
  recordTraceFromMessage(trace, { type: 'system', subtype: 'init' });
  recordTraceFromMessage(trace, {
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', name: 'Write', input: { file_path: '/tmp/a.ts' } },
        { type: 'tool_use', name: 'Edit', input: { file_path: '/tmp/b.ts' } },
        { type: 'text', text: 'done' },
      ],
    },
  });
  assert.equal(trace.toolCalls.Write, 1);
  assert.equal(trace.toolCalls.Edit, 1);
  assert.deepEqual(trace.writePaths, ['/tmp/a.ts', '/tmp/b.ts']);
  assert.equal(trace.lastAssistantText, 'done');
});
