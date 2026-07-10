import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  diffViewFromLog,
  parseUnifiedDiff,
  renderDiffHtml,
  type DiffViewDeps,
  type DiffViewModel,
} from './diff-view.js';
import { appendEvent, getEventLogPath } from './events/log.js';
import type { DagEvent } from './events/types.js';
import type { DecompositionDAG } from './types.js';

let dir: string;
let dagPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dag-diffview-'));
  dagPath = join(dir, 'dag.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const base = { schemaVersion: 1 as const, dagId: 'test-dag', ts: '2026-07-01T00:00:00Z' };

const append = (e: Record<string, unknown>): void => appendEvent(getEventLogPath(dagPath), e as unknown as DagEvent);

const stubDeps = (byRange: Record<string, string> = {}): DiffViewDeps & { ranges: string[] } => {
  const ranges: string[] = [];
  return {
    ranges,
    gitDiff: async (range: string) => {
      ranges.push(range);
      if (range in byRange) return byRange[range];
      return `diff for ${range}`;
    },
  };
};

const writeDag = (): void => {
  const dag = {
    meta: {
      id: 'test-dag',
      source: {
        type: 'description',
        title: 'Test DAG',
        description: 'Test',
        figmaUrls: [],
        acceptanceCriteria: [],
      },
      createdAt: '2026-07-01T00:00:00Z',
      gitCommit: 'sha0',
      branch: 'main',
      qualityReport: { iterations: 1, checksRun: [], allPassed: true },
    },
    tasks: [
      {
        id: 'A',
        name: 'Task A',
        description: 'does A',
        dependencies: [],
        weight: 'standard',
        contracts: { inputs: {}, outputs: { Foo: { kind: 'file', path: 'x.ts', description: 'the foo' } } },
        context: { files: [] },
        completionCriteria: { automated: [], manual: [] },
        estimatedScope: 'single-component',
      },
      {
        id: 'B',
        name: 'Task B',
        description: 'does B',
        dependencies: ['A'],
        weight: 'heavy',
        contracts: { inputs: { Foo: { source: 'A', type: 'file' } }, outputs: {} },
        context: { files: [] },
        completionCriteria: { automated: [], manual: [] },
        estimatedScope: 'single-component',
      },
    ],
    executionLayers: [
      { layer: 0, description: '', taskIds: ['A'] },
      { layer: 1, description: '', taskIds: ['B'] },
    ],
  } satisfies DecompositionDAG;

  writeFileSync(dagPath, JSON.stringify(dag));
};

describe('diffViewFromLog', () => {
  it('throws on a missing event log', async () => {
    await assert.rejects(() => diffViewFromLog(dagPath, stubDeps()), /event log not found/);
  });

  it('throws on an empty event log', async () => {
    writeFileSync(getEventLogPath(dagPath), '');

    await assert.rejects(() => diffViewFromLog(dagPath, stubDeps()), /event log is empty/);
  });

  it('computes per-task and aggregate ranges from the recorded SHAs', async () => {
    writeDag();
    append({ ...base, kind: 'dag.started', dagPath, branch: 'main', resume: false, baseStartSha: 'sha0' });
    append({
      ...base,
      kind: 'worktree.merged',
      taskId: 'A',
      worktreePath: '/wt/A',
      branch: 'dag/A',
      targetBranch: 'main',
      filesChanged: ['x.ts'],
      baseShaBefore: 'sha0',
      baseShaAfter: 'sha1',
    });
    append({
      ...base,
      kind: 'worktree.merged',
      taskId: 'B',
      worktreePath: '/wt/B',
      branch: 'dag/B',
      targetBranch: 'main',
      filesChanged: ['y.ts'],
      baseShaBefore: 'sha1',
      baseShaAfter: 'sha2',
    });

    const deps = stubDeps({ 'sha0..sha1': 'A-diff', 'sha1..sha2': 'B-diff', 'sha0..sha2': 'AGG-diff' });
    const model = await diffViewFromLog(dagPath, deps);

    assert.equal(model.degraded, undefined);
    assert.equal(model.baseBranch, 'main');
    assert.equal(model.aggregate.rawDiff, 'AGG-diff');
    assert.deepEqual(deps.ranges, ['sha0..sha1', 'sha1..sha2', 'sha0..sha2']);

    const a = model.tasks.find((t) => t.annotation.id === 'A');
    const b = model.tasks.find((t) => t.annotation.id === 'B');
    assert.ok(a);
    assert.ok(b);
    assert.equal(a.rawDiff, 'A-diff');
    assert.equal(b.rawDiff, 'B-diff');
    assert.equal(a.annotation.name, 'Task A');
    assert.equal(b.annotation.weight, 'heavy');
    assert.deepEqual(b.annotation.dependencies, ['A']);
    assert.equal(a.annotation.outputs[0]?.name, 'Foo');
    assert.equal(b.annotation.inputs[0]?.source, 'A');
  });

  it('uses the latest land for a re-merged task and final aggregate endpoint', async () => {
    writeDag();
    append({ ...base, kind: 'dag.started', dagPath, branch: 'main', resume: true, baseStartSha: 'sha0' });
    append({
      ...base,
      kind: 'worktree.merged',
      taskId: 'A',
      worktreePath: '/wt/A',
      branch: 'dag/A',
      targetBranch: 'main',
      filesChanged: ['old.ts'],
      baseShaBefore: 'sha0',
      baseShaAfter: 'sha1',
    });
    append({
      ...base,
      kind: 'worktree.merged',
      taskId: 'A',
      worktreePath: '/wt/A',
      branch: 'dag/A',
      targetBranch: 'main',
      filesChanged: ['new.ts'],
      baseShaBefore: 'sha1',
      baseShaAfter: 'sha2',
    });

    const deps = stubDeps({ 'sha1..sha2': 'A-rediff', 'sha0..sha2': 'AGG-diff' });
    const model = await diffViewFromLog(dagPath, deps);

    assert.equal(model.tasks.length, 1);
    assert.equal(model.tasks[0].rawDiff, 'A-rediff');
    assert.deepEqual(model.tasks[0].fileList, ['new.ts']);
    assert.equal(model.aggregate.rawDiff, 'AGG-diff');
  });

  it('degrades to file lists when the log predates SHA capture', async () => {
    writeDag();
    append({ ...base, kind: 'dag.started', dagPath, branch: 'main', resume: false });
    append({
      ...base,
      kind: 'worktree.merged',
      taskId: 'A',
      worktreePath: '/wt/A',
      branch: 'dag/A',
      targetBranch: 'main',
      filesChanged: ['x.ts', 'z.ts'],
    });

    const deps = stubDeps();
    const model = await diffViewFromLog(dagPath, deps);

    assert.ok(model.degraded);
    assert.equal(deps.ranges.length, 0);
    assert.ok(model.aggregate.degraded);
    assert.deepEqual(model.aggregate.fileList, ['x.ts', 'z.ts']);
    assert.ok(model.tasks[0].degraded);
    assert.deepEqual(model.tasks[0].fileList, ['x.ts', 'z.ts']);
    assert.equal(model.tasks[0].annotation.filesChangedCount, 2);
  });

  it('falls back per item when git diff throws', async () => {
    writeDag();
    append({ ...base, kind: 'dag.started', dagPath, branch: 'main', resume: false, baseStartSha: 'gone0' });
    append({
      ...base,
      kind: 'worktree.merged',
      taskId: 'A',
      worktreePath: '/wt/A',
      branch: 'dag/A',
      targetBranch: 'main',
      filesChanged: ['x.ts'],
      baseShaBefore: 'gone0',
      baseShaAfter: 'gone1',
    });

    const deps: DiffViewDeps = {
      gitDiff: async () => {
        throw new Error("fatal: bad revision 'gone0..gone1'");
      },
    };
    const model = await diffViewFromLog(dagPath, deps);

    assert.match(model.tasks[0].degraded ?? '', /git diff failed/);
    assert.deepEqual(model.tasks[0].fileList, ['x.ts']);
    assert.match(model.aggregate.degraded ?? '', /git diff failed/);
  });
});

describe('parseUnifiedDiff', () => {
  it('parses hunks with correct line numbers and line types', () => {
    const raw = [
      'diff --git a/src/x.ts b/src/x.ts',
      'index 111..222 100644',
      '--- a/src/x.ts',
      '+++ b/src/x.ts',
      '@@ -1,3 +1,3 @@',
      ' const a = 1;',
      '-const b = 2;',
      '+const b = 3;',
      ' const c = 4;',
    ].join('\n');

    const files = parseUnifiedDiff(raw);
    assert.equal(files.length, 1);
    assert.equal(files[0].path, 'src/x.ts');
    assert.equal(files[0].status, 'modified');
    assert.equal(files[0].binary, false);
    assert.equal(files[0].hunks.length, 1);
    const lines = files[0].hunks[0].lines;
    assert.deepEqual(
      lines.map((l) => l.type),
      ['ctx', 'del', 'add', 'ctx'],
    );
    assert.deepEqual({ o: lines[0].oldNo, n: lines[0].newNo }, { o: 1, n: 1 });
    assert.equal(lines[1].oldNo, 2);
    assert.equal(lines[2].newNo, 2);
    assert.deepEqual({ o: lines[3].oldNo, n: lines[3].newNo }, { o: 3, n: 3 });
  });

  it('flags new, deleted, renamed, and binary files', () => {
    const added = parseUnifiedDiff(
      ['diff --git a/n.ts b/n.ts', 'new file mode 100644', '--- /dev/null', '+++ b/n.ts', '@@ -0,0 +1 @@', '+hi'].join(
        '\n',
      ),
    );
    assert.equal(added[0].status, 'added');

    const deleted = parseUnifiedDiff(
      [
        'diff --git a/d.ts b/d.ts',
        'deleted file mode 100644',
        '--- a/d.ts',
        '+++ /dev/null',
        '@@ -1 +0,0 @@',
        '-bye',
      ].join('\n'),
    );
    assert.equal(deleted[0].status, 'deleted');

    const renamed = parseUnifiedDiff(
      ['diff --git a/old.ts b/new.ts', 'similarity index 90%', 'rename from old.ts', 'rename to new.ts'].join('\n'),
    );
    assert.equal(renamed[0].status, 'renamed');
    assert.equal(renamed[0].oldPath, 'old.ts');
    assert.equal(renamed[0].path, 'new.ts');

    const binary = parseUnifiedDiff(
      ['diff --git a/i.png b/i.png', 'new file mode 100644', 'Binary files /dev/null and b/i.png differ'].join('\n'),
    );
    assert.equal(binary[0].binary, true);
  });

  it('returns an empty array for an empty diff', () => {
    assert.deepEqual(parseUnifiedDiff(''), []);
    assert.deepEqual(parseUnifiedDiff('   \n'), []);
  });

  it('does not mistake in-hunk content beginning with +++ or --- for a file header', () => {
    const raw = [
      'diff --git a/patch.txt b/patch.txt',
      '--- a/patch.txt',
      '+++ b/patch.txt',
      '@@ -1,2 +1,2 @@',
      '-- removed marker line',
      '++ added marker line',
    ].join('\n');

    const files = parseUnifiedDiff(raw);
    assert.equal(files.length, 1);
    assert.equal(files[0].path, 'patch.txt');
    const lines = files[0].hunks[0].lines;
    assert.deepEqual(
      lines.map((l) => l.type),
      ['del', 'add'],
    );
    assert.equal(lines[0].text, '- removed marker line');
    assert.equal(lines[1].text, '+ added marker line');
  });
});

describe('renderDiffHtml', () => {
  const model = (over: Partial<DiffViewModel> = {}): DiffViewModel => ({
    dagId: 'test-dag',
    dagPath: '/t/dag.json',
    baseBranch: 'main',
    aggregate: { rawDiff: '', fileList: [] },
    tasks: [],
    ...over,
  });

  it('HTML-escapes code content', () => {
    const raw = [
      'diff --git a/x.ts b/x.ts',
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -1 +1 @@',
      '+const html = "<script>alert(1)</script>";',
    ].join('\n');
    const html = renderDiffHtml(model({ aggregate: { rawDiff: raw, fileList: [] } }));

    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(!html.includes('<script>alert(1)'));
  });

  it('renders both views and a working toggle target', () => {
    const html = renderDiffHtml(model());

    assert.ok(html.includes('id="view-aggregate"'));
    assert.ok(html.includes('id="view-tasks"'));
    assert.ok(html.includes('data-view="tasks"'));
  });

  it('shows the degrade banner when the model is degraded', () => {
    const html = renderDiffHtml(model({ degraded: 'run predates base-SHA capture' }));

    assert.ok(html.includes('class="banner"'));
    assert.ok(html.includes('run predates base-SHA capture'));
  });

  it('shows "No file changes" for an empty aggregate diff', () => {
    const html = renderDiffHtml(model());

    assert.ok(html.includes('No file changes'));
  });

  it('renders the per-task annotation panel', () => {
    const html = renderDiffHtml(
      model({
        tasks: [
          {
            annotation: {
              id: 'A',
              name: 'Task A',
              weight: 'heavy',
              dependencies: ['B'],
              description: 'does A',
              inputs: [{ name: 'Foo', source: 'B', type: 'file' }],
              outputs: [{ name: 'Bar', kind: 'file', description: 'the bar' }],
              filesChangedCount: 2,
            },
            rawDiff: '',
            fileList: [],
          },
        ],
      }),
    );

    assert.ok(html.includes('Task A'));
    assert.ok(html.includes('heavy'));
    assert.ok(html.includes('Foo'));
    assert.ok(html.includes('files changed'));
  });
});
