import { existsSync, readFileSync } from 'node:fs';
import { exec } from './exec.js';
import { getEventLogPath, readEvents } from './events/log.js';
import type { DagEvent } from './events/types.js';
import type { DAGTask, DecompositionDAG } from './types.js';

export interface TaskAnnotation {
  id: string;
  name: string;
  weight?: DAGTask['weight'];
  dependencies: string[];
  description?: string;
  inputs: Array<{ name: string; source: string; type?: string }>;
  outputs: Array<{ name: string; kind: string; description: string }>;
  filesChangedCount: number;
}

export interface TaskDiff {
  annotation: TaskAnnotation;
  rawDiff: string;
  degraded?: string;
  fileList: string[];
}

export interface AggregateDiff {
  rawDiff: string;
  degraded?: string;
  fileList: string[];
}

export interface DiffViewModel {
  dagId: string;
  dagPath: string;
  baseBranch: string;
  degraded?: string;
  aggregate: AggregateDiff;
  tasks: TaskDiff[];
}

export interface DiffViewDeps {
  gitDiff: (range: string) => Promise<string>;
}

const GIT_DIFF_MAX_BUFFER = 64 * 1024 * 1024;

const defaultDeps: DiffViewDeps = {
  gitDiff: async (range: string): Promise<string> => {
    const { stdout } = await exec('git', ['diff', range], {
      cwd: process.cwd(),
      maxBuffer: GIT_DIFF_MAX_BUFFER,
    });
    return stdout;
  },
};

const gitDiffFail = (err: unknown): string =>
  `git diff failed (SHA missing from history?): ${err instanceof Error ? err.message : String(err)}`;

type DagStarted = Extract<DagEvent, { kind: 'dag.started' }>;
type WorktreeMerged = Extract<DagEvent, { kind: 'worktree.merged' }>;

const loadDag = (dagPath: string): DecompositionDAG | null => {
  if (!existsSync(dagPath)) return null;
  try {
    return JSON.parse(readFileSync(dagPath, 'utf-8')) as DecompositionDAG;
  } catch {
    return null;
  }
};

const buildAnnotation = (taskId: string, task: DAGTask | undefined, filesChangedCount: number): TaskAnnotation => ({
  id: taskId,
  name: task?.name ?? taskId,
  weight: task?.weight,
  dependencies: task?.dependencies ?? [],
  description: task?.description,
  inputs: Object.entries(task?.contracts?.inputs ?? {}).map(([name, v]) => ({
    name,
    source: v.source,
    type: v.type,
  })),
  outputs: Object.entries(task?.contracts?.outputs ?? {}).map(([name, o]) => ({
    name,
    kind: o.kind,
    description: o.description,
  })),
  filesChangedCount,
});

export const diffViewFromLog = async (dagPath: string, deps: DiffViewDeps = defaultDeps): Promise<DiffViewModel> => {
  const logPath = getEventLogPath(dagPath);
  if (!existsSync(logPath)) throw new Error(`event log not found: ${logPath}`);

  const events = readEvents(logPath);
  if (events.length === 0) throw new Error(`event log is empty: ${logPath}`);

  const started = events.find((e): e is DagStarted => e.kind === 'dag.started');
  const dagId = started?.dagId ?? events[0]?.dagId ?? '';
  const baseBranch = started?.branch ?? '';
  const baseStartSha = started?.baseStartSha;

  const dag = loadDag(dagPath);
  const taskById = dag ? new Map(dag.tasks.map((t) => [t.id, t])) : null;

  const mergedByTask = new Map<string, WorktreeMerged>();
  let finalAfter: string | undefined;
  for (const e of events) {
    if (e.kind !== 'worktree.merged') continue;
    mergedByTask.set(e.taskId, e);
    if (e.baseShaAfter) finalAfter = e.baseShaAfter;
  }
  const merged = [...mergedByTask.values()];

  const tasks: TaskDiff[] = [];
  for (const m of merged) {
    const fileList = m.filesChanged ?? [];
    const annotation = buildAnnotation(m.taskId, taskById?.get(m.taskId), fileList.length);
    if (!m.baseShaBefore || !m.baseShaAfter) {
      tasks.push({ annotation, rawDiff: '', degraded: 'no base SHAs recorded for this task', fileList });
      continue;
    }

    try {
      const rawDiff = await deps.gitDiff(`${m.baseShaBefore}..${m.baseShaAfter}`);
      tasks.push({ annotation, rawDiff, fileList });
    } catch (err) {
      tasks.push({ annotation, rawDiff: '', degraded: gitDiffFail(err), fileList });
    }
  }

  const aggFileList = [...new Set(merged.flatMap((m) => m.filesChanged ?? []))];
  let aggregate: AggregateDiff;
  let runDegraded = false;
  if (!baseStartSha || !finalAfter) {
    runDegraded = true;
    aggregate = {
      rawDiff: '',
      degraded: 'run predates base-SHA capture - no aggregate diff available',
      fileList: aggFileList,
    };
  } else {
    try {
      aggregate = { rawDiff: await deps.gitDiff(`${baseStartSha}..${finalAfter}`), fileList: aggFileList };
    } catch (err) {
      aggregate = { rawDiff: '', degraded: gitDiffFail(err), fileList: aggFileList };
    }
  }

  return {
    dagId,
    dagPath,
    baseBranch,
    ...(runDegraded && { degraded: 'run predates base-SHA capture - showing changed-file lists only' }),
    aggregate,
    tasks,
  };
};

export type DiffLineType = 'add' | 'del' | 'ctx';

export interface DiffLine {
  type: DiffLineType;
  oldNo?: number;
  newNo?: number;
  text: string;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export type DiffFileStatus = 'added' | 'deleted' | 'modified' | 'renamed';

export interface DiffFile {
  path: string;
  oldPath?: string;
  status: DiffFileStatus;
  binary: boolean;
  hunks: DiffHunk[];
}

export const parseUnifiedDiff = (raw: string): DiffFile[] => {
  if (!raw.trim()) return [];
  const lines = raw.split('\n');
  const files: DiffFile[] = [];
  let cur: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  const flush = (): void => {
    if (cur) files.push(cur);
  };

  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      flush();
      const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      cur = { path: m ? m[2] : '', status: 'modified', binary: false, hunks: [] };
      hunk = null;
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('new file mode')) {
      cur.status = 'added';
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      cur.status = 'deleted';
      continue;
    }
    if (line.startsWith('rename from ')) {
      cur.oldPath = line.slice('rename from '.length);
      cur.status = 'renamed';
      continue;
    }
    if (line.startsWith('rename to ')) {
      cur.path = line.slice('rename to '.length);
      cur.status = 'renamed';
      continue;
    }
    if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) {
      cur.binary = true;
      continue;
    }
    if (!hunk && line.startsWith('--- ')) continue;
    if (!hunk && line.startsWith('+++ ')) {
      const p = line.slice(4);
      if (p !== '/dev/null') cur.path = p.replace(/^b\//, '');
      continue;
    }
    if (line.startsWith('@@')) {
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      oldNo = m ? parseInt(m[1], 10) : 0;
      newNo = m ? parseInt(m[2], 10) : 0;
      hunk = { header: line, lines: [] };
      cur.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (line.startsWith('\\')) continue;
    const marker = line[0];
    if (marker === '+') {
      hunk.lines.push({ type: 'add', newNo, text: line.slice(1) });
      newNo++;
    } else if (marker === '-') {
      hunk.lines.push({ type: 'del', oldNo, text: line.slice(1) });
      oldNo++;
    } else {
      hunk.lines.push({ type: 'ctx', oldNo, newNo, text: line.startsWith(' ') ? line.slice(1) : line });
      oldNo++;
      newNo++;
    }
  }
  flush();
  return files;
};

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const STATUS_LABEL: Record<DiffFileStatus, string> = {
  added: 'A',
  deleted: 'D',
  modified: 'M',
  renamed: 'R',
};

const emptyHalf = `<td class="ln empty"></td><td class="code empty"></td>`;

const renderHunkSplit = (h: DiffHunk): string => {
  const rows: string[] = [];
  let dels: DiffLine[] = [];
  let adds: DiffLine[] = [];
  const flushPairs = (): void => {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) {
      const d = dels[i];
      const a = adds[i];
      const left = d ? `<td class="ln">${d.oldNo ?? ''}</td><td class="code del">${esc(d.text)}</td>` : emptyHalf;
      const right = a ? `<td class="ln">${a.newNo ?? ''}</td><td class="code add">${esc(a.text)}</td>` : emptyHalf;
      rows.push(`<tr>${left}${right}</tr>`);
    }
    dels = [];
    adds = [];
  };

  for (const l of h.lines) {
    if (l.type === 'del') {
      dels.push(l);
      continue;
    }
    if (l.type === 'add') {
      adds.push(l);
      continue;
    }
    flushPairs();
    const code = esc(l.text);
    rows.push(
      `<tr><td class="ln">${l.oldNo ?? ''}</td><td class="code ctx">${code}</td><td class="ln">${l.newNo ?? ''}</td><td class="code ctx">${code}</td></tr>`,
    );
  }

  flushPairs();
  return `<tr class="hunk"><td class="code" colspan="4">${esc(h.header)}</td></tr>${rows.join('')}`;
};

const renderFile = (f: DiffFile): string => {
  const title = f.oldPath && f.oldPath !== f.path ? `${esc(f.oldPath)} -> ${esc(f.path)}` : esc(f.path);
  const body = f.binary
    ? `<div class="note">Binary file - no textual diff</div>`
    : f.hunks.length === 0
      ? `<div class="note">No textual changes</div>`
      : `<table class="diff"><colgroup><col class="cln"><col class="cco"><col class="cln"><col class="cco"></colgroup>${f.hunks.map(renderHunkSplit).join('')}</table>`;
  return `<details class="file" open><summary><span class="st st-${f.status}">${STATUS_LABEL[f.status]}</span> ${title}</summary>${body}</details>`;
};

const renderFileList = (list: string[]): string =>
  list.length ? `<ul class="filelist">${list.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : '';

const renderDiffBody = (rawDiff: string, degraded: string | undefined, fileList: string[]): string => {
  if (degraded) {
    return `<div class="degrade">${esc(degraded)}</div>${renderFileList(fileList)}`;
  }
  const files = parseUnifiedDiff(rawDiff);
  if (files.length === 0) return `<div class="note">No file changes</div>`;
  return files.map(renderFile).join('');
};

const renderAnnotation = (a: TaskAnnotation): string => {
  const rows: string[] = [];
  if (a.weight) rows.push(`<div><b>weight</b> ${esc(a.weight)}</div>`);
  if (a.dependencies.length) rows.push(`<div><b>deps</b> ${esc(a.dependencies.join(', '))}</div>`);
  if (a.inputs.length) {
    rows.push(
      `<div><b>inputs</b> ${a.inputs.map((i) => esc(`${i.name} <- ${i.source}${i.type ? ` (${i.type})` : ''}`)).join('; ')}</div>`,
    );
  }
  if (a.outputs.length) {
    rows.push(
      `<div><b>outputs</b> ${a.outputs.map((o) => esc(`${o.name}: ${o.kind}${o.description ? ` - ${o.description}` : ''}`)).join('; ')}</div>`,
    );
  }
  rows.push(`<div><b>files changed</b> ${a.filesChangedCount}</div>`);
  if (a.description) rows.push(`<div class="desc">${esc(a.description)}</div>`);
  return `<div class="anno">${rows.join('')}</div>`;
};

const renderTask = (t: TaskDiff): string =>
  `<section class="task"><h3>${esc(t.annotation.name)} <span class="tid">${esc(t.annotation.id)}</span></h3>` +
  `${renderAnnotation(t.annotation)}${renderDiffBody(t.rawDiff, t.degraded, t.fileList)}</section>`;

const LIGHT_VARS = [
  '--bg:#fff;--fg:#1f2328;--mut:#57606a;--bd:#d0d7de',
  '--add:#e6ffed;--del:#ffeef0;--ln:#f6f8fa;--empty:#fafbfc;--panel:#f6f8fa',
  '--hunk-bg:#f6f8fa;--hunk-fg:#0550ae;--accent:#0969da;--accent-fg:#fff',
  '--banner-bg:#fff8c5;--banner-b:#d4a72c',
  '--st-add:#acf2bd;--st-del:#fdb8c0;--st-mod:#ddf4ff;--st-ren:#ffd8b5',
].join(';');

const DARK_VARS = [
  '--bg:#0d1117;--fg:#e6edf3;--mut:#8b949e;--bd:#30363d',
  '--add:#12261c;--del:#2d1417;--ln:#161b22;--empty:#0b0e13;--panel:#161b22',
  '--hunk-bg:#161b22;--hunk-fg:#58a6ff;--accent:#1f6feb;--accent-fg:#fff',
  '--banner-bg:#341a00;--banner-b:#9e6a03',
  '--st-add:#196c2e;--st-del:#8b1a1a;--st-mod:#1f6feb;--st-ren:#9e6a03',
].join(';');

const STYLE = `
:root{${LIGHT_VARS}}
:root[data-theme="dark"]{${DARK_VARS}}
@media (prefers-color-scheme:dark){:root:not([data-theme]){${DARK_VARS}}}
*{box-sizing:border-box}
body{font:16px/1.6 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;margin:0;color:var(--fg);background:var(--bg)}
header{padding:16px 20px;border-bottom:1px solid var(--bd)}
header h1{font-size:20px;margin:0 0 4px}
header .meta{color:var(--mut);font-size:14px}
.tabs{display:flex;gap:8px;padding:12px 20px;border-bottom:1px solid var(--bd);position:sticky;top:0;background:var(--bg);z-index:1}
.tabs button{font:inherit;font-size:14px;padding:6px 14px;border:1px solid var(--bd);border-radius:6px;background:var(--panel);color:var(--fg);cursor:pointer}
.tabs button.active{background:var(--accent);color:var(--accent-fg);border-color:var(--accent)}
.tabs .theme-toggle{margin-left:auto}
main{padding:16px 20px}
.banner{background:var(--banner-bg);border:1px solid var(--banner-b);border-radius:6px;padding:8px 12px;margin-bottom:16px}
.degrade{color:var(--mut);font-style:italic;padding:6px 0}
.note{color:var(--mut);padding:8px 10px}
.filelist{margin:4px 0 0;padding-left:20px;color:var(--mut)}
details.file{border:1px solid var(--bd);border-radius:6px;margin:0 0 12px;overflow:hidden}
details.file>summary{cursor:pointer;padding:8px 12px;background:var(--panel);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:14px}
.st{display:inline-block;width:16px;text-align:center;border-radius:3px;font-weight:700;margin-right:6px}
.st-added{background:var(--st-add)}.st-deleted{background:var(--st-del)}.st-modified{background:var(--st-mod)}.st-renamed{background:var(--st-ren)}
table.diff{table-layout:fixed;width:100%;border-collapse:collapse;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:16px}
table.diff col.cln{width:52px}table.diff col.cco{width:calc(50% - 52px)}
table.diff td{padding:0 8px;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;vertical-align:top}
td.ln{font-size:13px;text-align:right;color:var(--mut);background:var(--ln);border-right:1px solid var(--bd);user-select:none}
td.code.add{background:var(--add)}
td.code.del{background:var(--del)}
td.code.empty,td.ln.empty{background:var(--empty)}
tr.hunk td{background:var(--hunk-bg);color:var(--hunk-fg)}
section.task{border:1px solid var(--bd);border-radius:8px;padding:14px 16px;margin:0 0 18px}
section.task h3{margin:0 0 8px;font-size:16px}
.tid{color:var(--mut);font-weight:400;font-family:ui-monospace,monospace;font-size:13px}
.anno{background:var(--panel);border-radius:6px;padding:8px 12px;margin:0 0 12px;font-size:14px}
.anno>div{margin:2px 0}.anno b{color:var(--mut);font-weight:600;margin-right:4px}
.anno .desc{color:var(--fg);font-style:italic;margin-top:4px}
`.trim();

const SCRIPT = `
(function(){
  var root=document.documentElement;
  var tbtn=document.getElementById('theme-toggle');
  function setTheme(t){root.setAttribute('data-theme',t);tbtn.textContent=t==='dark'?'Light':'Dark';}
  var sysDark=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches;
  setTheme(sysDark?'dark':'light');
  tbtn.addEventListener('click',function(){setTheme(root.getAttribute('data-theme')==='dark'?'light':'dark');});
  document.querySelectorAll('.tabs button[data-view]').forEach(function(b){
    b.addEventListener('click',function(){
      document.querySelectorAll('.tabs button[data-view]').forEach(function(x){x.classList.toggle('active',x===b)});
      var v=b.getAttribute('data-view');
      document.getElementById('view-aggregate').hidden=v!=='aggregate';
      document.getElementById('view-tasks').hidden=v!=='tasks';
    });
  });
})();
`.trim();

export const renderDiffHtml = (model: DiffViewModel): string => {
  const banner = model.degraded ? `<div class="banner">${esc(model.degraded)}</div>` : '';
  const aggregate = renderDiffBody(model.aggregate.rawDiff, model.aggregate.degraded, model.aggregate.fileList);
  const tasks = model.tasks.length
    ? model.tasks.map(renderTask).join('')
    : `<div class="note">No merged tasks in this run.</div>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>diff - ${esc(model.dagId)}</title>
<style>${STYLE}</style>
</head>
<body>
<header>
<h1>Executor diff - ${esc(model.dagId)}</h1>
<div class="meta">base branch: ${esc(model.baseBranch)} - ${model.tasks.length} merged task(s)</div>
</header>
<div class="tabs">
<button data-view="aggregate" class="active">Aggregate</button>
<button data-view="tasks">Per-task</button>
<button id="theme-toggle" class="theme-toggle" type="button">Dark</button>
</div>
<main>
${banner}
<div id="view-aggregate">${aggregate}</div>
<div id="view-tasks" hidden>${tasks}</div>
</main>
<script>${SCRIPT}</script>
</body>
</html>`;
};
