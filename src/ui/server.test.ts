import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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

const withServer = async <T>(
  fn: (baseUrl: string) => Promise<T>,
  overrides: Partial<{
    enqueueTriage: (id: string) => void;
    clarify: (id: string, revision: number, answer: string) => void;
    approve: (id: string, revision: number) => Promise<void>;
    cancel: (id: string) => Promise<void>;
  }> = {},
): Promise<T> => {
  const intakeService = {
    enqueueTriage: overrides.enqueueTriage ?? (() => {}),
    updatePolicy: (policy: { autoRunEnabled: boolean; confidenceThreshold: number; triageProvider: 'codex' }) => policy,
    clarify: overrides.clarify ?? (() => {}),
    approve: overrides.approve ?? (async () => {}),
    cancel: overrides.cancel ?? (async () => {}),
    stop: () => {},
  };
  const server = createUiServer({ projectPath: projectDir, slotDir, maxSlots: 2, intakeService });
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
    let triagedId = '';
    await withServer(
      async (baseUrl) => {
        const { response, json } = await fetchJson(baseUrl, '/api/inbox', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ body: 'Review task progress' }),
        });

        assert.equal(response.status, 201);
        assert.equal(json.item.body, 'Review task progress');
        assert.equal(json.item.status, 'open');
        assert.equal(triagedId, json.item.id);
      },
      {
        enqueueTriage: (id) => {
          triagedId = id;
        },
      },
    );
  });

  it('exposes intake policy, runs, and triage controls', async () => {
    let retried = '';
    await withServer(
      async (baseUrl) => {
        const status = await fetchJson(baseUrl, '/api/intake/status');
        const runs = await fetchJson(baseUrl, '/api/intake/runs');
        const retriedResponse = await fetchJson(baseUrl, '/api/inbox/todo-1/triage', { method: 'POST' });

        assert.equal(status.json.policy.autoRunEnabled, true);
        assert.equal(runs.json.runs.length, 1);
        assert.equal(runs.json.runs[0].mode, 'dag');
        assert.equal(runs.json.runs[0].status, 'queued');
        assert.equal(runs.json.runs[0].dagPath, dagPath);
        assert.equal(retriedResponse.response.status, 202);
        assert.equal(retried, 'todo-1');
      },
      {
        enqueueTriage: (id) => {
          retried = id;
        },
      },
    );
  });

  it('GET and PATCH /api/inbox list and update inbox items', async () => {
    await withServer(async (baseUrl) => {
      const created = await fetchJson(baseUrl, '/api/inbox', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: 'Turn this into agent work' }),
      });
      const id = encodeURIComponent(created.json.item.id);
      const updated = await fetchJson(baseUrl, `/api/inbox/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'converted', linkedDagPath: dagPath, linkedTaskId: 'task-a' }),
      });
      const listed = await fetchJson(baseUrl, '/api/inbox');

      assert.equal(updated.response.status, 200);
      assert.equal(updated.json.item.status, 'converted');
      assert.equal(updated.json.item.linkedTaskId, 'task-a');
      assert.equal(listed.json.items[0].id, created.json.item.id);
      assert.equal(listed.json.items[0].status, 'converted');
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

  it('serves the one-tab ops console HTML', async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/`);
      const html = await response.text();

      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /^text\/html/);
      assert.match(html, /DAG Executor/);
      assert.match(html, /Local agent intake/);
      assert.match(html, /Todo inbox/);
      assert.match(html, /Agent runs/);
      assert.match(html, /phase-track/);
      assert.match(html, /api\/dags/);
    });
  });

  it('starts from the dag-executor --ui CLI path', async () => {
    const child = spawn(process.execPath, ['build/index.js', '--ui', `--project=${projectDir}`, '--port=0']);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));

    const url = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`timed out waiting for UI URL; stderr=${stderr}`)), 5000);
      child.stdout.on('data', () => {
        const match = stdout.match(/DAG UI listening on (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) {
          clearTimeout(timeout);
          resolve(match[1]);
        }
      });
      child.on('exit', (code) => reject(new Error(`UI process exited ${code}; stderr=${stderr}`)));
    });

    try {
      const response = await fetch(`${url}/api/dags`);
      const body = await response.json();
      assert.equal(body.dags[0].id, 'work');
    } finally {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.on('exit', resolve));
    }
  });
});
