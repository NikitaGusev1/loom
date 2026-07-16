import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { request, type Server } from 'node:http';
import { createUiServer } from './server.js';
import { registerProject } from './projects.js';

let projectDir: string;
let slotDir: string;
let artifactsDir: string;
let dagPath: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'dag-ui-server-'));
  slotDir = mkdtempSync(join(tmpdir(), 'dag-ui-server-slots-'));
  artifactsDir = mkdtempSync(join(tmpdir(), 'dag-ui-server-artifacts-'));
  dagPath = join(projectDir, 'work.json');
  writeFileSync(dagPath, JSON.stringify(dagJson()));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(slotDir, { recursive: true, force: true });
  rmSync(artifactsDir, { recursive: true, force: true });
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
  const server = createUiServer({
    projectPath: projectDir,
    artifactsRoot: artifactsDir,
    slotDir,
    maxSlots: 2,
    intakeService,
  });
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

const requestStatus = (baseUrl: string, headers: Record<string, string>): Promise<number> =>
  new Promise((resolve, reject) => {
    const url = new URL('/api/session', baseUrl);
    const req = request({ hostname: url.hostname, port: url.port, path: url.pathname, headers }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end();
  });

const fetchJson = async (baseUrl: string, path: string, init?: RequestInit) => {
  const method = init?.method ?? 'GET';
  const headers = new Headers(init?.headers);
  if (method !== 'GET' && method !== 'HEAD') {
    const session = await fetch(`${baseUrl}/api/session`);
    const body = await session.json();
    headers.set('x-loom-csrf', body.csrfToken);
  }
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
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
      assert.deepEqual(json.git, {
        isRepository: false,
        branch: null,
        clean: false,
        changedFiles: 0,
        ahead: 0,
        behind: 0,
      });
      assert.deepEqual(json.slots, { maxSlots: 2, holders: [], waiters: [] });
      assert.deepEqual(json.errors, []);
    });
  });

  it('issues a session token and rejects mutations without it', async () => {
    await withServer(async (baseUrl) => {
      const session = await fetch(`${baseUrl}/api/session`);
      const body = await session.json();
      const rejected = await fetch(`${baseUrl}/api/inbox`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: 'Must be rejected' }),
      });

      assert.equal(typeof body.csrfToken, 'string');
      assert.ok(body.csrfToken.length > 0);
      assert.equal(rejected.status, 403);
    });
  });

  it('rejects cross-origin and invalid Host requests', async () => {
    await withServer(async (baseUrl) => {
      const crossOrigin = await fetch(`${baseUrl}/api/session`, { headers: { origin: 'https://example.com' } });
      const malformedOrigin = await fetch(`${baseUrl}/api/session`, { headers: { origin: 'not-a-url' } });
      const invalidHostStatus = await requestStatus(baseUrl, { host: 'example.com' });

      assert.equal(crossOrigin.status, 403);
      assert.equal(malformedOrigin.status, 403);
      assert.equal(invalidHostStatus, 403);
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

  it('lists projects and serves slug-scoped summaries', async () => {
    await withServer(async (baseUrl) => {
      const listed = await fetchJson(baseUrl, '/api/projects');
      const slug = basename(projectDir);
      const summary = await fetchJson(baseUrl, `/api/projects/${encodeURIComponent(slug)}`);

      assert.equal(listed.json.projects.length, 1);
      assert.equal(listed.json.projects[0].slug, slug);
      assert.equal(summary.json.displayName, slug);
      assert.deepEqual(summary.json.dagCounts, { active: 1, history: 0, archived: 0, attention: 0 });
    });
  });

  it('bounds project intake services and stops the idle LRU service on eviction', async () => {
    const secondProject = mkdtempSync(join(tmpdir(), 'dag-ui-server-second-'));
    const first = registerProject(artifactsDir, projectDir);
    const second = registerProject(artifactsDir, secondProject);
    const stopped: string[] = [];
    const server = createUiServer({
      artifactsRoot: artifactsDir,
      maxIntakeServices: 1,
      isIntakeActive: () => false,
      intakeServiceFactory: (projectPath) => ({
        enqueueTriage: () => {},
        updatePolicy: (policy) => policy,
        clarify: () => {},
        approve: async () => {},
        cancel: async () => {},
        stop: () => stopped.push(projectPath),
      }),
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address === 'object');
    try {
      const baseUrl = `http://127.0.0.1:${address.port}`;
      await fetchJson(baseUrl, `/api/projects/${encodeURIComponent(first.slug)}/intake/reconcile`, { method: 'POST' });
      await fetchJson(baseUrl, `/api/projects/${encodeURIComponent(second.slug)}/intake/reconcile`, { method: 'POST' });
      assert.deepEqual(stopped, [first.repoPath]);
    } finally {
      await closeServer(server);
      rmSync(secondProject, { recursive: true, force: true });
    }
  });

  it('returns 503 instead of evicting a busy intake service', async () => {
    const secondProject = mkdtempSync(join(tmpdir(), 'dag-ui-server-busy-'));
    const first = registerProject(artifactsDir, projectDir);
    const second = registerProject(artifactsDir, secondProject);
    const stopped: string[] = [];
    const server = createUiServer({
      artifactsRoot: artifactsDir,
      maxIntakeServices: 1,
      isIntakeActive: () => true,
      intakeServiceFactory: (projectPath) => ({
        enqueueTriage: () => {},
        updatePolicy: (policy) => policy,
        clarify: () => {},
        approve: async () => {},
        cancel: async () => {},
        stop: () => stopped.push(projectPath),
      }),
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address === 'object');
    try {
      const baseUrl = `http://127.0.0.1:${address.port}`;
      await fetchJson(baseUrl, `/api/projects/${encodeURIComponent(first.slug)}/intake/reconcile`, { method: 'POST' });
      const response = await fetchJson(baseUrl, `/api/projects/${encodeURIComponent(second.slug)}/intake/reconcile`, {
        method: 'POST',
      });
      assert.equal(response.response.status, 503);
      assert.deepEqual(stopped, []);
    } finally {
      await closeServer(server);
      rmSync(secondProject, { recursive: true, force: true });
    }
  });

  it('archives and restores completed DAGs without changing source bytes', async () => {
    writeFileSync(
      join(projectDir, 'work.state.json'),
      JSON.stringify({
        status: 'completed',
        tasks: { 'task-a': { status: 'completed' }, 'task-b': { status: 'completed' } },
      }),
    );
    const before = readFileSync(dagPath, 'utf-8');
    await withServer(async (baseUrl) => {
      const slug = encodeURIComponent(basename(projectDir));
      const archived = await fetchJson(baseUrl, `/api/projects/${slug}/dags/archive`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'work.json' }),
      });
      const archivedList = await fetchJson(baseUrl, `/api/projects/${slug}/dags?view=archived`);
      const restored = await fetchJson(baseUrl, `/api/projects/${slug}/dags/restore`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'work.json' }),
      });

      assert.equal(archived.response.status, 200);
      assert.equal(archivedList.json.dags[0].relativePath, 'work.json');
      assert.equal(restored.response.status, 200);
      assert.equal(readFileSync(dagPath, 'utf-8'), before);
    });
  });

  it('rejects traversal and archiving incomplete DAGs', async () => {
    await withServer(async (baseUrl) => {
      const slug = encodeURIComponent(basename(projectDir));
      const traversal = await fetchJson(
        baseUrl,
        `/api/projects/${slug}/dags/detail?path=${encodeURIComponent('../work.json')}`,
      );
      const incomplete = await fetchJson(baseUrl, `/api/projects/${slug}/dags/archive`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'work.json' }),
      });
      assert.equal(traversal.response.status, 400);
      assert.equal(incomplete.response.status, 409);
    });
  });

  it('GET /api/dags/detail?path=... returns DAG detail', async () => {
    await withServer(async (baseUrl) => {
      const { response, json } = await fetchJson(baseUrl, '/api/dags/detail?path=work.json');

      assert.equal(response.status, 200);
      assert.equal(json.dagPath, dagPath);
      assert.equal(json.dag.meta.id, 'work');
      assert.equal(json.progress.totalTasks, 2);
    });
  });

  it('GET /api/tasks/detail?dagPath=...&taskId=... returns task detail', async () => {
    await withServer(async (baseUrl) => {
      const { response, json } = await fetchJson(baseUrl, '/api/tasks/detail?dagPath=work.json&taskId=task-b');

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

  it('exposes intake policy and triage controls without treating definitions as runs', async () => {
    let retried = '';
    await withServer(
      async (baseUrl) => {
        const status = await fetchJson(baseUrl, '/api/intake/status');
        const runs = await fetchJson(baseUrl, '/api/intake/runs');
        const retriedResponse = await fetchJson(baseUrl, '/api/inbox/todo-1/triage', { method: 'POST' });

        assert.equal(status.json.policy.autoRunEnabled, true);
        assert.equal(runs.json.runs.length, 0);
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
      assert.match(html, /<title>Loom<\/title>/);
      assert.match(html, /All projects/);
      assert.match(html, /gitStatus/);
      assert.match(html, /Todo inbox/);
      assert.match(html, /Agent runs/);
      assert.match(html, /Active/);
      assert.match(html, /History/);
      assert.match(html, /Archived/);
      assert.match(html, /\/api\/projects\//);
      assert.match(html, /projectName/);
      assert.doesNotMatch(html, /Not a valid DAG/);
      assert.match(html, /role="dialog" aria-modal="true"/);
      assert.match(html, /aria-labelledby="chatTitle"/);
      assert.match(html, /Archive this completed DAG/);
      assert.match(html, /legacyQuestion/);
      assert.match(html, /conversationMessages/);
      assert.match(html, /conversationDrafts/);
      assert.match(html, /autoOpenedQuestions/);
      assert.match(html, /event\.key === 'Enter' && !event\.shiftKey/);
      assert.match(html, /event\.key === 'Escape'/);
      assert.match(html, /el\('allProjects'\)\.onclick = \(\) => renderHome\(false\)/);
      assert.match(html, /generation/);
    });
  });

  it('starts from the dag-executor --ui CLI path', async () => {
    const child = spawn(process.execPath, ['build/index.js', '--ui', `--project=${projectDir}`, '--port=0'], {
      env: { ...process.env, LOOM_ARTIFACTS_DIR: artifactsDir },
    });
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
