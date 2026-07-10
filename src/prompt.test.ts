import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildBatchedTrivialPrompt, buildTaskPrompt } from './prompt.js';
import type { DAGTask, ProjectContext } from './types.js';
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

const projectContext: ProjectContext = {
  conventions: ['Prefer existing utilities over new helpers.'],
  sharedComponents: '- Button: src/components/Button.tsx',
  figmaToolset: ['figma_dev_tool', 'figma_context_tool'],
  themeTokensDoc: 'docs/theme-tokens.md',
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

describe('prompt project context', () => {
  it('renders project context without requiring project memory', () => {
    const prompt = buildTaskPrompt(task, { projectContext });

    assert.match(prompt, /## Project Context/);
    assert.match(prompt, /Prefer existing utilities/);
    assert.doesNotMatch(prompt, /## Curated Project Memory/);
  });

  it('keeps project context and curated memory as separate sections', () => {
    const prompt = buildTaskPrompt(task, { projectContext, projectMemory: memory });

    assert.match(prompt, /## Project Context/);
    assert.match(prompt, /## Curated Project Memory/);
    assert.ok(prompt.indexOf('## Project Context') < prompt.indexOf('## Curated Project Memory'));
  });

  it('omits UI-only shared components and token docs for non-UI tasks', () => {
    const prompt = buildTaskPrompt(task, { projectContext });

    assert.match(prompt, /Prefer existing utilities/);
    assert.doesNotMatch(prompt, /Shared components/);
    assert.doesNotMatch(prompt, /docs\/theme-tokens\.md/);
  });

  it('renders UI project context and custom Figma tools for UI tasks', () => {
    const uiTask: DAGTask = {
      ...task,
      context: {
        ...task.context,
        files: ['src/CardStyle.ts'],
        figmaRef: { nodeId: '1:2' },
        figmaTokens: { cardBackground: '#fff' },
      },
    };

    const prompt = buildTaskPrompt(uiTask, { projectContext });

    assert.match(prompt, /Shared components/);
    assert.match(prompt, /src\/components\/Button\.tsx/);
    assert.match(prompt, /docs\/theme-tokens\.md/);
    assert.match(prompt, /figma_dev_tool/);
    assert.doesNotMatch(prompt, /mcp__figma-console__figma_get_component_for_development/);
  });

  it('renders project context in batched trivial prompts', () => {
    const prompt = buildBatchedTrivialPrompt([{ ...task, weight: 'trivial' }], { projectContext });

    assert.match(prompt, /## Project Context/);
    assert.match(prompt, /Prefer existing utilities/);
  });
});
