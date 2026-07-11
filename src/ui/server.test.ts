import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createUiServer } from './server.js';

let projectDir: string;
let slotDir: string;
let dagPath: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'dag-ui-server-'));
  slotDir = mkdtempSync(join(tmpdir(), 'dag-ui-server-slots-'));
  dagPath = join(projectDir, 'work.json');
  writeFileSync(dagPath, JSON.stringify(dagJson()));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(slotDir, { recursive: true, force: true });
});

const dagJson = () => ({
  meta: {
    id: 'work',
    source: {
      type: 'description',
      title: 'Work DAG',
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
      description: 'First task',
      dependencies: [],
      contracts: { inputs: {}, outputs: {} },
      context: { files: ['src/a.ts'] },
      completionCriteria: { automated: [], manual: [] },
      estimatedScope: 'single-component',
      weight: 'standard',
    },
    {
      id: 'task-b',
      name: 'Task B',
      description: 'Second task',
      dependencies: ['task-a'],
      contracts: { inputs: {}, outputs: {} },
      context: { files: ['src/b.ts'] },
      completionCriteria: { automated: [], manual: [] },
      estimatedScope: 'single-component',
      weight: 'standard',
    },
  ],
  executionLayers: [
    { layer: 0, description: 'Layer 0', taskIds: ['task-a'] },
    { layer: 1, description: 'Layer 1', taskIds: ['task-b'] },
  ],
});

const withServer = async <T>(fn: (baseUrl: string) => Promise<T>): Promise<T> => {
  const server = createUiServer({ projectPath: projectDir, slotDir, maxSlots: 2 });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  try {
    return await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await closeServer(server);
  }
};

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });

const fetchJson = async (baseUrl: string, path: string, init?: RequestInit) => {
  const response = await fetch(`${baseUrl}${path}`, init);
  assert.match(response.headers.get('content-type') ?? '', /^application\/json; charset=utf-8$/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return { response, json: await response.json() };
};

describe('createUiServer', () => {
  it('GET /api/project returns project summary with DAG count, slots, and errors', async () => {
    await withServer(async (baseUrl) => {
      const { response, json } = await fetchJson(baseUrl, '/api/project');

      assert.equal(response.status, 200);
      assert.equal(json.projectPath, projectDir);
      assert.equal(json.dagCount, 1);
      assert.deepEqual(json.slots, { maxSlots: 2, holders: [], waiters: [] });
      assert.deepEqual(json.errors, []);
    });
  });

  it('GET /api/dags returns discovered DAG list', async () => {
    await withServer(async (baseUrl) => {
      const { response, json } = await fetchJson(baseUrl, '/api/dags');

      assert.equal(response.status, 200);
      assert.equal(json.projectPath, projectDir);
      assert.deepEqual(
        json.dags.map((dag: { id: string }) => dag.id),
        ['work'],
      );
    });
  });

  it('GET /api/dags/detail?path=... returns DAG detail', async () => {
    await withServer(async (baseUrl) => {
      const { response, json } = await fetchJson(baseUrl, `/api/dags/detail?path=${encodeURIComponent(dagPath)}`);

      assert.equal(response.status, 200);
      assert.equal(json.dagPath, dagPath);
      assert.equal(json.dag.meta.id, 'work');
      assert.equal(json.progress.totalTasks, 2);
    });
  });

  it('GET /api/tasks/detail?dagPath=...&taskId=... returns task detail', async () => {
    await withServer(async (baseUrl) => {
      const { response, json } = await fetchJson(
        baseUrl,
        `/api/tasks/detail?dagPath=${encodeURIComponent(dagPath)}&taskId=task-b`,
      );

      assert.equal(response.status, 200);
      assert.equal(json.task.id, 'task-b');
      assert.equal(json.description, 'Second task');
      assert.deepEqual(json.files, ['src/b.ts']);
    });
  });

  it('POST /api/inbox creates an inbox item', async () => {
    await withServer(async (baseUrl) => {
      const { response, json } = await fetchJson(baseUrl, '/api/inbox', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: 'Review task progress' }),
      });

      assert.equal(response.status, 201);
      assert.equal(json.item.body, 'Review task progress');
      assert.equal(json.item.status, 'open');
    });
  });

  it('POST /api/inbox/:id/archive archives an inbox item', async () => {
    await withServer(async (baseUrl) => {
      const created = await fetchJson(baseUrl, '/api/inbox', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: 'Archive after triage' }),
      });

      const id = encodeURIComponent(created.json.item.id);
      const { response, json } = await fetchJson(baseUrl, `/api/inbox/${id}/archive`, { method: 'POST' });

      assert.equal(response.status, 200);
      assert.equal(json.item.id, created.json.item.id);
      assert.equal(json.item.status, 'archived');
    });
  });

  it('returns 404 text for unknown API routes', async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/unknown`);

      assert.equal(response.status, 404);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(await response.text(), 'Not found');
    });
  });
});
