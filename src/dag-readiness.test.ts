import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { analyzeDAGReadiness, formatDAGReadinessReport } from './dag-readiness.js';
import type { DAGTask, DecompositionDAG } from './types.js';

const task = (overrides: Partial<DAGTask> & Pick<DAGTask, 'id'>): DAGTask => {
  const base: DAGTask = {
    id: overrides.id,
    name: `Task ${overrides.id}`,
    description: 'Do one focused thing.',
    dependencies: [],
    contracts: {
      inputs: {},
      outputs: {
        [`${overrides.id}-output`]: {
          kind: 'file',
          path: `${overrides.id}.ts`,
          mediaType: 'typescript',
          description: 'Changed file',
        },
      },
    },
    context: { files: [`${overrides.id}.ts`], conventions: ['Follow local patterns.'] },
    completionCriteria: { automated: ['npm test'], manual: [] },
    estimatedScope: 'single-component',
    weight: 'standard',
  };
  return { ...base, ...overrides, id: overrides.id };
};

const dag = (tasks: DAGTask[], acceptanceCriteria: string[] = []): DecompositionDAG => ({
  meta: {
    id: 'test-dag',
    source: {
      type: 'description',
      title: 'test',
      description: '',
      figmaUrls: [],
      acceptanceCriteria,
    },
    createdAt: '2026-07-09T00:00:00.000Z',
    gitCommit: 'abc123',
    branch: 'main',
    qualityReport: { iterations: 1, checksRun: [], allPassed: true },
  },
  tasks,
  executionLayers: [{ layer: 0, description: 'all', taskIds: tasks.map((t) => t.id) }],
});

describe('analyzeDAGReadiness', () => {
  it('accepts a focused two-task DAG with contracts, scoped context, and AC coverage', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dag-ready-'));
    try {
      writeFileSync(join(dir, 'types.ts'), 'export interface CalendarToggle {}\n');
      writeFileSync(join(dir, 'ui.ts'), 'export const renderCalendar = () => null;\n');

      const result = analyzeDAGReadiness(
        dag(
          [
            task({
              id: 'types',
              name: 'Add calendar toggle type',
              contracts: {
                inputs: {},
                outputs: {
                  toggleType: {
                    kind: 'export',
                    file: 'types.ts',
                    exportName: 'CalendarToggle',
                    exportKind: 'interface',
                    description: 'Toggle type',
                  },
                },
              },
              context: { files: ['types.ts'], conventions: ['Export interfaces from types.ts.'] },
              completionCriteria: { automated: ['npm test covers calendar toggle'], manual: [] },
            }),
            task({
              id: 'ui',
              name: 'Render calendar toggle',
              dependencies: ['types'],
              contracts: {
                inputs: { toggleType: { type: 'interface', source: 'types' } },
                outputs: {
                  renderedToggle: {
                    kind: 'file',
                    path: 'ui.ts',
                    mediaType: 'typescript',
                    description: 'Calendar toggle UI',
                  },
                },
              },
              context: { files: ['ui.ts'], conventions: ['Reuse existing controls.'] },
              completionCriteria: {
                automated: ['npm test covers calendar toggle'],
                manual: ['Calendar toggle appears in the calendar view.'],
              },
            }),
          ],
          ['calendar toggle'],
        ),
        { cwd: dir },
      );

      assert.equal(result.ok, true);
      assert.deepEqual(result.issues, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects tasks that are too broad to be agent-sized', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dag-ready-'));
    try {
      for (const file of ['a.ts', 'b.ts', 'c.ts', 'd.ts']) {
        writeFileSync(join(dir, file), 'export {};\n');
      }

      const result = analyzeDAGReadiness(
        dag([
          task({
            id: 'broad',
            name: 'Update API and UI',
            description: 'Update the API. Update the UI. Update tests. Update docs.',
            context: { files: ['a.ts', 'b.ts', 'c.ts', 'd.ts'], conventions: ['Follow local patterns.'] },
            estimatedScope: 'cross-module',
          }),
        ]),
        { cwd: dir },
      );

      assert.equal(result.ok, false);
      assert.deepEqual(
        result.issues.map((issue) => issue.code),
        [
          'too-few-tasks',
          'task-name-multiple-concerns',
          'task-description-too-long',
          'task-too-many-files',
          'task-cross-module',
        ],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects missing and mismatched contracts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dag-ready-'));
    try {
      writeFileSync(join(dir, 'producer.ts'), 'export {};\n');
      writeFileSync(join(dir, 'consumer.ts'), 'export {};\n');

      const result = analyzeDAGReadiness(
        dag([
          task({ id: 'producer', contracts: { inputs: {}, outputs: {} } }),
          task({
            id: 'consumer',
            dependencies: ['producer'],
            contracts: {
              inputs: { missingOutput: { source: 'producer' } },
              outputs: {
                consumerOutput: {
                  kind: 'behavioral',
                  description: 'Behavior changed',
                },
              },
            },
            completionCriteria: { automated: [], manual: ['Check behavior manually.'] },
          }),
        ]),
        { cwd: dir },
      );

      assert.equal(result.ok, false);
      assert.deepEqual(
        result.issues.map((issue) => issue.code),
        ['task-missing-outputs', 'contract-input-missing-output', 'behavioral-output-without-automated-check'],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects inputs whose declared source does not produce the input output', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dag-ready-'));
    try {
      writeFileSync(join(dir, 'producer-a.ts'), 'export {};\n');
      writeFileSync(join(dir, 'producer-b.ts'), 'export {};\n');
      writeFileSync(join(dir, 'consumer.ts'), 'export {};\n');

      const result = analyzeDAGReadiness(
        dag([
          task({
            id: 'producer-a',
            contracts: {
              inputs: {},
              outputs: {
                otherOutput: {
                  kind: 'file',
                  path: 'producer-a.ts',
                  mediaType: 'typescript',
                  description: 'Different output',
                },
              },
            },
            context: { files: ['producer-a.ts'], conventions: ['Follow local patterns.'] },
          }),
          task({
            id: 'producer-b',
            contracts: {
              inputs: {},
              outputs: {
                sharedOutput: {
                  kind: 'file',
                  path: 'producer-b.ts',
                  mediaType: 'typescript',
                  description: 'Shared output from another dependency',
                },
              },
            },
            context: { files: ['producer-b.ts'], conventions: ['Follow local patterns.'] },
          }),
          task({
            id: 'consumer',
            dependencies: ['producer-a', 'producer-b'],
            contracts: {
              inputs: { sharedOutput: { source: 'producer-a' } },
              outputs: {
                consumerOutput: {
                  kind: 'file',
                  path: 'consumer.ts',
                  mediaType: 'typescript',
                  description: 'Consumer output',
                },
              },
            },
            context: { files: ['consumer.ts'], conventions: ['Follow local patterns.'] },
          }),
        ]),
        { cwd: dir },
      );

      assert.equal(result.ok, false);
      assert.deepEqual(
        result.issues.map((issue) => issue.code),
        ['contract-input-missing-output'],
      );
      assert.equal(result.issues[0].taskId, 'consumer');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects missing context files unless the task creates the file output', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dag-ready-'));
    try {
      writeFileSync(join(dir, 'existing.ts'), 'export const existing = true;\n');

      const result = analyzeDAGReadiness(
        dag([
          task({
            id: 'ok-new-file',
            contracts: {
              inputs: {},
              outputs: {
                newFile: {
                  kind: 'file',
                  path: 'new-file.ts',
                  mediaType: 'typescript',
                  description: 'New file created by this task',
                },
              },
            },
            context: { files: ['new-file.ts'], conventions: ['Follow local patterns.'] },
          }),
          task({
            id: 'missing-reference',
            contracts: {
              inputs: {},
              outputs: {
                existing: {
                  kind: 'file',
                  path: 'existing.ts',
                  mediaType: 'typescript',
                  description: 'Existing file updated',
                },
              },
            },
            context: { files: ['missing-reference.ts'], conventions: ['Follow local patterns.'] },
          }),
        ]),
        { cwd: dir },
      );

      assert.equal(result.ok, false);
      assert.deepEqual(
        result.issues.map((issue) => issue.code),
        ['context-file-missing'],
      );
      assert.equal(result.issues[0].taskId, 'missing-reference');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects uncovered acceptance criteria', () => {
    const result = analyzeDAGReadiness(
      dag([task({ id: 'toggle' }), task({ id: 'tests' })], ['calendar toggle is visible', 'keyboard navigation works']),
      { cwd: tmpdir() },
    );

    assert.equal(result.ok, false);
    assert.deepEqual(
      result.issues.map((issue) => issue.code),
      ['acceptance-criterion-uncovered', 'acceptance-criterion-uncovered'],
    );
  });

  it('does not count empty completion criteria as AC coverage', () => {
    const result = analyzeDAGReadiness(
      dag(
        [
          task({ id: 'toggle', completionCriteria: { automated: [''], manual: [] } }),
          task({ id: 'tests', completionCriteria: { automated: ['npm test'], manual: [] } }),
        ],
        ['calendar toggle is visible'],
      ),
      { cwd: tmpdir() },
    );

    assert.equal(result.ok, false);
    assert.deepEqual(
      result.issues.map((issue) => issue.code),
      ['acceptance-criterion-uncovered'],
    );
  });
});

describe('formatDAGReadinessReport', () => {
  it('renders a compact report grouped by issue', () => {
    const report = formatDAGReadinessReport({
      ok: false,
      issues: [
        {
          code: 'task-too-many-files',
          message: 'Task "wide" has 4 context files; maximum is 3.',
          taskId: 'wide',
        },
      ],
    });

    assert.equal(
      report,
      'DAG readiness failed:\n- [task-too-many-files] wide: Task "wide" has 4 context files; maximum is 3.',
    );
  });
});

describe('dag-executor --dag-readiness', () => {
  it('exits nonzero and prints readiness failures without executing the DAG', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dag-ready-cli-'));
    try {
      const path = join(dir, 'dag.json');
      writeFileSync(path, JSON.stringify(dag([task({ id: 'single' })])));

      const result = spawnSync(process.execPath, [resolve('build/index.js'), '--dag-readiness', path], {
        cwd: resolve('.'),
        encoding: 'utf-8',
      });

      assert.equal(result.status, 1);
      assert.match(result.stderr, /DAG readiness failed:/);
      assert.match(result.stderr, /\[too-few-tasks\]/);
      assert.doesNotMatch(result.stderr, /DAG execution/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
