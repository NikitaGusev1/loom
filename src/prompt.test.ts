import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildBatchedTrivialPrompt, buildTaskPrompt } from './prompt.js';
import type { DAGTask } from './types.js';
import type { ProjectMemory } from './memory.js';

const task: DAGTask = {
  id: 'task-1',
  name: 'Add focused behavior',
  description: 'Implement the requested behavior.',
  dependencies: [],
  contracts: {
    inputs: {},
    outputs: {
      behavior: {
        kind: 'file',
        path: 'src/feature.ts',
        mediaType: 'typescript',
        description: 'Feature implementation',
      },
    },
  },
  context: { files: ['src/feature.ts'] },
  completionCriteria: { automated: ['npm test'], manual: [] },
  estimatedScope: 'single-component',
  weight: 'standard',
};

const memory: ProjectMemory = {
  path: '.dag-executor/memory.md',
  content: '- Past runs failed when tasks changed tests instead of implementation.',
  truncated: true,
};

describe('prompt memory', () => {
  it('injects curated project memory into single-task prompts', () => {
    const prompt = buildTaskPrompt(task, { projectMemory: memory });

    assert.match(prompt, /## Curated Project Memory/);
    assert.match(prompt, /Source: `.dag-executor\/memory.md` \(truncated\)/);
    assert.match(prompt, /Past runs failed/);
    assert.match(prompt, /current task instructions\nand source code win on conflicts/);
  });

  it('injects curated project memory into batched trivial prompts', () => {
    const prompt = buildBatchedTrivialPrompt([{ ...task, weight: 'trivial' }], { projectMemory: memory });

    assert.match(prompt, /## Curated Project Memory/);
    assert.match(prompt, /Past runs failed/);
    assert.match(prompt, /## Task 1: Add focused behavior/);
  });

  it('omits the memory section when no memory is loaded', () => {
    const prompt = buildTaskPrompt(task);

    assert.doesNotMatch(prompt, /## Curated Project Memory/);
  });
});
