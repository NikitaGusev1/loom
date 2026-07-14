import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverDags } from './discovery.js';

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'dag-ui-discovery-'));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

const dagJson = (id: string) => ({
  meta: {
    id,
    source: {
      type: 'description',
      title: `Title ${id}`,
      description: '',
      figmaUrls: [],
      acceptanceCriteria: [],
    },
    createdAt: '2026-07-10T00:00:00.000Z',
    gitCommit: 'abc123',
    branch: 'main',
    qualityReport: { iterations: 1, checksRun: [], allPassed: true },
  },
  tasks: [
    {
      id: 'task-a',
      name: 'Task A',
      description: '',
      dependencies: [],
      contracts: { inputs: {}, outputs: {} },
      context: { files: [] },
      completionCriteria: { automated: [], manual: [] },
      estimatedScope: 'single-component',
      weight: 'standard',
    },
  ],
  executionLayers: [{ layer: 0, description: 'Layer 0', taskIds: ['task-a'] }],
});

describe('discoverDags', () => {
  it('finds valid DAG JSON files recursively and reports artifact paths', () => {
    mkdirSync(join(projectDir, '.claude', 'ai'), { recursive: true });
    const dagPath = join(projectDir, '.claude', 'ai', 'work.json');
    writeFileSync(dagPath, JSON.stringify(dagJson('work')));

    const result = discoverDags(projectDir);

    assert.equal(result.errors.length, 0);
    assert.equal(result.dags.length, 1);
    assert.equal(result.dags[0].id, 'work');
    assert.equal(result.dags[0].title, 'Title work');
    assert.equal(result.dags[0].relativePath, '.claude/ai/work.json');
    assert.equal(result.dags[0].eventLogPath.endsWith('work.events.jsonl'), true);
    assert.equal(result.dags[0].statePath.endsWith('work.state.json'), true);
  });

  it('discovers DAGs whose names only end with ignored config filename text', () => {
    writeFileSync(join(projectDir, 'feature-package.json'), JSON.stringify(dagJson('feature-package')));

    const result = discoverDags(projectDir);

    assert.deepEqual(
      result.dags.map((dag) => dag.id),
      ['feature-package'],
    );
  });

  it('ignores exact config filenames', () => {
    writeFileSync(join(projectDir, 'package.json'), JSON.stringify(dagJson('package')));
    writeFileSync(join(projectDir, 'package-lock.json'), JSON.stringify(dagJson('package-lock')));
    writeFileSync(join(projectDir, 'tsconfig.json'), JSON.stringify(dagJson('tsconfig')));
    writeFileSync(join(projectDir, 'real.json'), JSON.stringify(dagJson('real')));

    const result = discoverDags(projectDir);

    assert.deepEqual(
      result.dags.map((dag) => dag.id),
      ['real'],
    );
  });

  it('ignores generated, repository, tool, and dependency directories', () => {
    const ignoredDirs = [
      '.git',
      '.worktrees',
      'node_modules',
      'build',
      '.dag-executor',
      '.loom-supervisor',
      '.superpowers',
    ];
    for (const dir of ignoredDirs) {
      mkdirSync(join(projectDir, dir, 'nested'), { recursive: true });
      writeFileSync(join(projectDir, dir, 'nested', 'ignored.json'), JSON.stringify(dagJson(`ignored-${dir}`)));
    }
    writeFileSync(join(projectDir, 'real.json'), JSON.stringify(dagJson('real')));

    const result = discoverDags(projectDir);

    assert.deepEqual(
      result.dags.map((dag) => dag.id),
      ['real'],
    );
  });

  it('reports invalid JSON and invalid DAGs without throwing', () => {
    writeFileSync(join(projectDir, 'bad-json.json'), '{bad');
    writeFileSync(join(projectDir, 'bad-dag.json'), JSON.stringify({ nope: true }));

    const result = discoverDags(projectDir);

    assert.equal(result.dags.length, 2);
    assert.deepEqual(
      result.dags.map((dag) => dag.status),
      ['invalid', 'invalid'],
    );
    assert.equal(
      result.dags.every((dag) => dag.errors.length === 1),
      true,
    );
  });

  it('uses state and event artifacts to derive status and counts', () => {
    const dagPath = join(projectDir, 'work.json');
    const statePath = join(projectDir, 'work.state.json');
    const eventLogPath = join(projectDir, 'work.events.jsonl');
    const dagMtime = new Date('2026-07-10T00:00:00.000Z');
    const stateMtime = new Date('2026-07-10T00:01:00.000Z');
    const eventLogMtime = new Date('2026-07-10T00:02:00.000Z');

    writeFileSync(dagPath, JSON.stringify(dagJson('work')));
    writeFileSync(
      statePath,
      JSON.stringify({
        derived: true,
        status: 'running',
        tasks: { 'task-a': { status: 'in-progress' } },
      }),
    );
    writeFileSync(eventLogPath, '{"kind":"dag.started","schemaVersion":1}\n');
    utimesSync(dagPath, dagMtime, dagMtime);
    utimesSync(statePath, stateMtime, stateMtime);
    utimesSync(eventLogPath, eventLogMtime, eventLogMtime);

    const result = discoverDags(projectDir);

    assert.equal(result.dags.length, 1);
    assert.equal(result.dags[0].status, 'running');
    assert.equal(result.dags[0].totalTasks, 1);
    assert.equal(result.dags[0].runningTasks, 1);
    assert.equal(result.dags[0].updatedAt, eventLogMtime.toISOString());
  });
});
