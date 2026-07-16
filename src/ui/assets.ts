export const UI_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Loom</title>
  <style>
    :root{color-scheme:dark;--bg:#0b0d10;--surface:#111419;--raised:#171b21;--line:#272c34;--soft:#89919e;--ink:#f2f4f7;--green:#59d499;--yellow:#f2c94c;--red:#ff6b6b;--blue:#75a7ff}
    *{box-sizing:border-box}html,body{height:100%}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 Inter,ui-sans-serif,system-ui,sans-serif}button,textarea{font:inherit}button{color:inherit}.hidden{display:none!important}
    .home{min-height:100%;padding:34px;max-width:1200px;margin:auto}.home-head{display:flex;align-items:end;justify-content:space-between;margin-bottom:26px}.brand{font-size:18px;font-weight:750}.mark{display:inline-block;width:17px;height:17px;margin-right:9px;border:2px solid var(--green);transform:rotate(45deg)}h1{font-size:29px;margin:8px 0 0}.eyebrow{color:var(--soft);font-size:11px;font-weight:750;text-transform:uppercase;letter-spacing:.06em}.projects{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}.project-card{border:1px solid var(--line);border-radius:9px;background:var(--surface);padding:17px;text-align:left;cursor:pointer}.project-card:hover{border-color:#4a535f;background:var(--raised)}.project-card:disabled{cursor:default;opacity:.55}.card-head,.row{display:flex;align-items:center;justify-content:space-between;gap:12px}.project-card strong{font-size:18px}.path{margin:5px 0 17px;color:var(--soft);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.card-metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:7px}.card-metrics div{padding:8px;background:#0d1014;border-radius:5px}.card-metrics b{display:block;font:600 17px ui-monospace,monospace}.warning{color:var(--yellow)}.error{color:var(--red)}
    .app{height:100vh;display:grid;grid-template-columns:230px minmax(560px,1fr) 330px}.sidebar{min-width:0;padding:17px 12px;border-right:1px solid var(--line);background:#0e1115;display:flex;flex-direction:column;gap:14px}.all-projects,.nav-button,.dag-button,.task,.run-card,.icon-button,.primary{border:0;border-radius:5px;cursor:pointer}.all-projects{background:transparent;text-align:left;color:var(--soft);padding:6px}.all-projects:hover{background:var(--raised);color:var(--ink)}.project-name{font-size:17px;font-weight:700;padding:0 6px;overflow:hidden;text-overflow:ellipsis}.git-status{padding:0 6px;color:var(--soft);font-size:12px}.view-nav,.dag-tabs{display:grid;gap:5px}.view-nav{grid-template-columns:1fr 1fr}.dag-tabs{grid-template-columns:repeat(3,1fr)}.nav-button{border:1px solid var(--line);background:transparent;padding:7px;font-size:13px}.nav-button.active{background:var(--raised);border-color:#4a535f}.dag-list{min-height:0;overflow:auto;display:grid;align-content:start;gap:3px}.dag-button{width:100%;background:transparent;padding:9px 8px;text-align:left;display:grid;grid-template-columns:8px 1fr;gap:8px}.dag-button:hover,.dag-button.active{background:var(--raised)}.dag-button.active{box-shadow:inset 2px 0 var(--green)}.dot{width:7px;height:7px;margin-top:6px;border-radius:50%;background:var(--soft)}.dot.running{background:var(--green)}.dot.paused,.dot.failed{background:var(--yellow)}.dag-name{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.subtle{color:var(--soft);font-size:12px}.slots{margin-top:auto;border-top:1px solid var(--line);padding:13px 6px 0}
    .workspace{min-width:0;min-height:0;display:grid;grid-template-rows:auto minmax(0,1fr) 170px}.topbar{padding:18px 20px 15px;border-bottom:1px solid var(--line)}.title-row{display:flex;align-items:center;justify-content:space-between;gap:15px}.title-row h1{font-size:22px;margin:2px 0}.status{color:var(--green);font-size:12px;text-transform:uppercase;font-weight:750}.metrics{display:flex;gap:28px;align-items:center;margin-top:14px}.metric b{display:block;font:600 18px ui-monospace,monospace}.progress{height:5px;flex:1;max-width:370px;background:#252a31;border-radius:4px;overflow:hidden}.progress span{display:block;height:100%;width:0;background:var(--green)}.board-wrap{min-height:0;padding:15px 20px;overflow:hidden}.board{height:100%;display:grid;grid-template-columns:repeat(6,minmax(125px,1fr));gap:8px;overflow:auto}.lane{background:#0f1216;border:1px solid var(--line);border-radius:6px;padding:9px;overflow:auto}.lane-title{text-transform:uppercase;color:var(--soft);font-size:11px;font-weight:700;display:flex;justify-content:space-between}.task{width:100%;border:1px solid #242a32;background:var(--raised);padding:9px;margin-top:6px;text-align:left}.task.active{border-color:var(--blue)}.runs-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));align-content:start}.run-card{border:1px solid var(--line);background:var(--surface);padding:11px;text-align:left}.events-panel{border-top:1px solid var(--line);padding:12px 20px;overflow:auto}.events{font:12px/1.65 ui-monospace,monospace;color:#aab1bb}.event{display:grid;grid-template-columns:75px 1fr}
    .rail{min-width:0;min-height:0;border-left:1px solid var(--line);background:#0e1115;display:grid;grid-template-rows:minmax(230px,1fr) minmax(270px,1fr)}.rail-panel{min-height:0;overflow:auto;padding:17px 15px;border-bottom:1px solid var(--line)}.task-detail h2{font-size:18px;margin:8px 0}.label{color:var(--soft);font-size:11px;text-transform:uppercase;font-weight:700;margin-top:13px}.code{font:12px ui-monospace,monospace;word-break:break-word}textarea{width:100%;height:75px;resize:none;margin-top:9px;padding:9px;color:var(--ink);background:#0a0c0f;border:1px solid #303640;border-radius:5px}.primary{padding:7px 10px;background:var(--ink);color:#101216;font-weight:700}.primary:disabled{opacity:.45}.compose{display:flex;justify-content:space-between;align-items:center;margin-top:7px}.inbox{margin-top:13px;display:grid;gap:6px}.inbox-item{border:1px solid var(--line);border-radius:5px;padding:9px;background:var(--surface)}.actions{display:flex;gap:5px;flex-wrap:wrap;margin-top:7px}.icon-button{background:transparent;color:var(--soft);padding:4px 6px}.icon-button:hover{color:var(--ink);background:var(--raised)}.diagnostics{font-size:12px;color:var(--yellow);padding:0 6px}.empty{color:var(--soft);padding:13px 0}
    .modal{position:fixed;inset:0;background:#050608bb;display:grid;place-items:center;padding:20px}.dialog{width:min(600px,100%);background:var(--surface);border:1px solid #3b424d;border-radius:9px;padding:17px}.messages{max-height:320px;overflow:auto;display:grid;gap:8px;margin:13px 0}.bubble{padding:9px;border-radius:7px;background:var(--raised);white-space:pre-wrap}.bubble.user{background:#254a7d;margin-left:15%}.phase-track{display:grid;grid-template-columns:repeat(6,1fr);gap:3px;margin:14px 0}.phase-step{padding:6px 2px;text-align:center;border-bottom:3px solid var(--line);font-size:11px;color:var(--soft)}.phase-step.done{color:var(--ink);border-color:var(--green)}
    @media(max-width:1000px){.app{grid-template-columns:200px minmax(500px,1fr)}.rail{grid-column:1/-1;grid-template-columns:1fr 1fr;grid-template-rows:320px}.workspace{min-height:700px}}
  </style>
</head>
<body>
  <section id="home" class="home">
    <header class="home-head"><div><div class="brand"><span class="mark"></span>Loom</div><h1>Projects</h1><div class="subtle">Work, runs, and agent activity across your registered projects.</div></div><div id="homeErrors" class="error"></div></header>
    <div id="projects" class="projects"></div>
  </section>
  <div id="projectApp" class="app hidden">
    <aside class="sidebar">
      <button id="allProjects" class="all-projects" type="button">← All projects</button>
      <div><div class="eyebrow">Project</div><div id="projectName" class="project-name">Project</div><div id="gitStatus" class="git-status"></div></div>
      <div class="view-nav"><button id="dagView" class="nav-button active">DAGs</button><button id="runsView" class="nav-button">Runs</button></div>
      <div id="dagTabs" class="dag-tabs"><button class="nav-button active" data-dag-view="active">Active <span id="activeCount">0</span></button><button class="nav-button" data-dag-view="history">History <span id="historyCount">0</span></button><button class="nav-button" data-dag-view="archived">Archived <span id="archivedCount">0</span></button></div>
      <div id="diagnostics" class="diagnostics"></div><div id="dagList" class="dag-list"></div>
      <div class="slots"><div class="eyebrow">Agent capacity</div><div id="slotSummary" class="subtle">Scanning…</div></div>
    </aside>
    <main class="workspace">
      <header class="topbar"><div class="title-row"><div><div id="dagMeta" class="eyebrow">Execution overview</div><h1 id="dagTitle">No DAG selected</h1></div><div><span id="dagStatus" class="status">Idle</span><span id="dagAction"></span></div></div><div class="metrics"><div class="metric"><b id="doneMetric">0/0</b><span class="subtle">tasks complete</span></div><div class="metric"><b id="failedMetric">0</b><span class="subtle">failed</span></div><div class="metric"><b id="percentMetric">0%</b><span class="subtle">progress</span></div><div class="progress"><span id="progressFill"></span></div></div></header>
      <section class="board-wrap"><div id="board" class="board"></div></section>
      <section class="events-panel"><div class="eyebrow">Recent activity</div><div id="events" class="events"></div></section>
    </main>
    <aside class="rail">
      <section class="rail-panel"><div class="eyebrow">Task inspector</div><div id="taskDetail" class="task-detail empty">Select a task to inspect it.</div></section>
      <section class="rail-panel"><div class="row"><strong>Todo inbox</strong><label class="subtle"><input id="autoRun" type="checkbox"> Auto-run easy work</label></div><textarea id="todoBody" aria-label="Describe work for Loom" placeholder="Describe what you want Loom to work on..."></textarea><div class="compose"><span class="subtle">Triaged for this project</span><button id="saveTodo" class="primary">Add todo</button></div><div id="inboxItems" class="inbox"></div></section>
    </aside>
  </div>
  <div id="chatModal" class="modal hidden"><section class="dialog" role="dialog" aria-modal="true" aria-labelledby="chatTitle"><div class="row"><div><strong id="chatTitle">Clarify todo</strong><div id="chatStatus" class="subtle"></div></div><button id="chatClose" class="icon-button">Close</button></div><div id="chatMessages" class="messages"></div><textarea id="chatAnswer" aria-label="Answer Loom" placeholder="Answer Loom..."></textarea><div id="chatActions" class="actions"></div><div class="compose"><span id="chatError" class="error"></span><button id="chatSend" class="primary">Send</button></div></section></div>
  <script>
    const state = {
      slug: null,
      generation: 0,
      csrfToken: null,
      project: null,
      view: 'dags',
      dagView: 'active',
      dags: [],
      detail: null,
      selectedDag: null,
      selectedTask: null,
      selectedRun: null,
      inbox: [],
      chatItemId: null,
      chatSubmitting: false,
      chatReturnFocus: null,
      conversationDrafts: {},
      autoOpenedQuestions: new Set(),
    };
    const el = (id) => document.getElementById(id);
    const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
    const requestContext = () => ({ slug: state.slug, generation: state.generation });
    const isCurrent = (context) => context.slug === state.slug && context.generation === state.generation;
    const rootFor = (slug) => '/api/projects/' + encodeURIComponent(slug);
    const root = () => rootFor(state.slug);
    const api = async (path, init = {}) => {
      const method = init.method || 'GET';
      const headers = new Headers(init.headers || {});
      if (method !== 'GET' && method !== 'HEAD' && state.csrfToken) headers.set('x-loom-csrf', state.csrfToken);
      const response = await fetch(path, { ...init, headers });
      const type = response.headers.get('content-type') || '';
      const body = type.includes('json') ? await response.json() : { error: { message: await response.text() } };
      if (!response.ok) throw new Error(body.error?.message || 'Request failed');
      return body;
    };
    const post = (path, body) => api(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      ...(body && { body: JSON.stringify(body) }),
    });
    const fmt = (timestamp) => {
      const date = new Date(timestamp);
      return Number.isNaN(date.valueOf()) ? '--:--:--' : date.toLocaleTimeString([], { hour12: false });
    };
    const fmtActivity = (timestamp) => timestamp ? new Date(timestamp).toLocaleString() : 'No activity yet';

    function clearDetail() {
      state.detail = null;
      state.selectedDag = null;
      state.selectedTask = null;
      state.selectedRun = null;
      el('dagMeta').textContent = 'Execution overview';
      el('dagTitle').textContent = 'No DAG selected';
      el('dagStatus').textContent = 'Idle';
      el('dagAction').innerHTML = '';
      el('doneMetric').textContent = '0/0';
      el('failedMetric').textContent = '0';
      el('percentMetric').textContent = '0%';
      el('progressFill').style.width = '0%';
      el('board').className = 'board';
      el('board').innerHTML = '';
      el('events').innerHTML = '';
      el('taskDetail').className = 'task-detail empty';
      el('taskDetail').textContent = 'Select a task to inspect it.';
    }

    function resetProjectState() {
      state.view = 'dags';
      state.dagView = 'active';
      state.dags = [];
      state.inbox = [];
      closeChat();
      clearDetail();
      el('dagView').classList.add('active');
      el('runsView').classList.remove('active');
      el('dagTabs').classList.remove('hidden');
      document.querySelectorAll('[data-dag-view]').forEach((button) => {
        button.classList.toggle('active', button.dataset.dagView === 'active');
      });
    }

    async function renderHome(autoSelect = false) {
      state.generation += 1;
      state.slug = null;
      state.project = null;
      resetProjectState();
      const context = requestContext();
      el('projectApp').classList.add('hidden');
      el('home').classList.remove('hidden');
      const data = await api('/api/projects');
      if (!isCurrent(context)) return;
      el('homeErrors').textContent = data.errors.map((error) => error.message).join(' · ');
      el('projects').innerHTML = data.projects.map((project) => {
        const git = project.git;
        const gitLabel = git ? (git.branch || 'detached') + ' · ' + (git.clean ? 'clean' : 'dirty') : 'unavailable';
        const runLabel = project.recentRun
          ? project.recentRun.mode + ' · ' + project.recentRun.status
          : 'No runs yet';
        const errorLabel = project.errors?.length
          ? '<div class="warning">' + project.errors.length + ' project warning' + (project.errors.length === 1 ? '' : 's') + '</div>'
          : '';
        return '<button class="project-card" data-project="' + esc(project.slug) + '" ' +
          (project.unavailable ? 'disabled' : '') + '><div class="card-head"><strong>' + esc(project.displayName) +
          '</strong><span class="subtle">' + esc(gitLabel) + '</span></div><div class="path" title="' +
          esc(project.projectPath) + '">' + esc(project.projectPath) + '</div><div class="subtle">' +
          esc(runLabel) + ' · ' + esc(fmtActivity(project.recentActivityAt)) + '</div>' + errorLabel +
          '<div class="card-metrics"><div><b>' + Number(project.dagCounts?.active || 0) +
          '</b><span class="subtle">active</span></div><div><b class="' +
          (project.dagCounts?.attention ? 'warning' : '') + '">' + Number(project.dagCounts?.attention || 0) +
          '</b><span class="subtle">attention</span></div><div><b>' + Number(project.openInboxCount || 0) +
          '</b><span class="subtle">todos</span></div></div></button>';
      }).join('') || '<div class="empty">No projects registered. Start Loom with --project=&lt;path&gt; to add one.</div>';
      el('projects').querySelectorAll('[data-project]').forEach((button) => {
        button.onclick = () => selectProject(button.dataset.project);
      });
      if (autoSelect && data.initialProjectSlug) await selectProject(data.initialProjectSlug);
    }

    async function selectProject(slug) {
      state.generation += 1;
      state.slug = slug;
      resetProjectState();
      el('home').classList.add('hidden');
      el('projectApp').classList.remove('hidden');
      await post(rootFor(slug) + '/intake/reconcile');
      await Promise.all([renderProject(), renderDags(), renderInbox()]);
    }

    async function renderProject() {
      const context = requestContext();
      if (!context.slug) return;
      const project = await api(rootFor(context.slug));
      if (!isCurrent(context)) return;
      state.project = project;
      el('projectName').textContent = project.displayName;
      el('projectName').title = project.projectPath;
      const git = project.git;
      el('gitStatus').textContent = git.isRepository
        ? [git.branch || 'detached', git.clean ? 'clean' : 'dirty', git.changedFiles ? git.changedFiles + ' changes' : ''].filter(Boolean).join(' · ')
        : 'not a Git repository';
      el('activeCount').textContent = project.dagCounts.active;
      el('historyCount').textContent = project.dagCounts.history;
      el('archivedCount').textContent = project.dagCounts.archived;
      el('slotSummary').textContent = project.slots.holders.length + ' active · ' + project.slots.waiters.length + ' queued / ' + project.slots.maxSlots;
      el('diagnostics').textContent = project.errors.length
        ? project.errors.length + ' project warning' + (project.errors.length === 1 ? '' : 's')
        : '';
    }

    async function renderDags() {
      const context = requestContext();
      if (!context.slug) return;
      const requestedView = state.dagView;
      const data = await api(rootFor(context.slug) + '/dags?view=' + requestedView);
      if (!isCurrent(context) || requestedView !== state.dagView) return;
      state.dags = data.dags;
      el('dagList').innerHTML = data.dags.map((dag) =>
        '<button class="dag-button ' + (state.selectedDag === dag.relativePath ? 'active' : '') +
        '" data-dag="' + esc(dag.relativePath) + '"><span class="dot ' + esc(dag.status) +
        '"></span><span><span class="dag-name">' + esc(dag.title) + '</span><span class="subtle">' +
        esc(dag.status) + '</span></span></button>'
      ).join('') || '<div class="empty">No ' + esc(state.dagView) + ' DAGs.</div>';
      el('dagList').querySelectorAll('[data-dag]').forEach((button) => {
        button.onclick = () => selectDag(button.dataset.dag);
      });
      el('diagnostics').textContent = data.errors.length
        ? data.errors.length + ' project warning' + (data.errors.length === 1 ? '' : 's')
        : '';
      if (!data.dags.length) clearDetail();
      else if (!state.selectedDag) await selectDag(data.dags[0].relativePath);
    }

    function renderBoard() {
      const groups = state.detail?.backlog || { ready: [], running: [], pending: [], blocked: [], failed: [], done: [] };
      el('board').className = 'board';
      el('board').innerHTML = ['ready', 'running', 'pending', 'blocked', 'failed', 'done'].map((name) =>
        '<div class="lane"><div class="lane-title"><span>' + name + '</span><span>' + groups[name].length +
        '</span></div>' + groups[name].map((task) => '<button class="task ' +
          (state.selectedTask === task.id ? 'active' : '') + '" data-task="' + esc(task.id) +
          '"><div class="code">' + esc(task.id) + '</div><div>' + esc(task.name) + '</div></button>').join('') + '</div>'
      ).join('');
      el('board').querySelectorAll('[data-task]').forEach((button) => {
        button.onclick = () => selectTask(button.dataset.task);
      });
    }

    async function selectDag(path, preserveTask = false) {
      const context = requestContext();
      state.selectedDag = path;
      if (!preserveTask) state.selectedTask = null;
      const detail = await api(rootFor(context.slug) + '/dags/detail?path=' + encodeURIComponent(path));
      if (!isCurrent(context) || state.selectedDag !== path) return;
      state.detail = detail;
      el('dagTitle').textContent = detail.dag.meta.source.title;
      el('dagStatus').textContent = detail.status;
      el('dagMeta').textContent = detail.relativePath;
      el('doneMetric').textContent = detail.progress.completedTasks + '/' + detail.progress.totalTasks;
      el('failedMetric').textContent = detail.progress.failedTasks;
      el('percentMetric').textContent = detail.progress.percent + '%';
      el('progressFill').style.width = detail.progress.percent + '%';
      el('events').innerHTML = detail.recentEvents.map((event) => '<div class="event"><span>' +
        fmt(event.ts) + '</span><span>' + esc(event.kind) + '</span></div>').join('') ||
        '<div class="empty">No events recorded.</div>';
      el('dagAction').innerHTML = state.dagView === 'history'
        ? '<button id="archiveDag" class="icon-button">Archive</button>'
        : state.dagView === 'archived' ? '<button id="restoreDag" class="icon-button">Restore</button>' : '';
      if (el('archiveDag')) el('archiveDag').onclick = archiveSelected;
      if (el('restoreDag')) el('restoreDag').onclick = restoreSelected;
      renderBoard();
      renderDagsListOnly();
      if (state.selectedTask) await selectTask(state.selectedTask);
    }

    function renderDagsListOnly() {
      el('dagList').querySelectorAll('[data-dag]').forEach((button) => {
        button.classList.toggle('active', button.dataset.dag === state.selectedDag);
      });
    }

    async function archiveSelected() {
      if (!confirm('Archive this completed DAG? This only hides it from normal history; no files or run evidence will be deleted.')) return;
      await post(root() + '/dags/archive', { path: state.selectedDag });
      clearDetail();
      await Promise.all([renderProject(), renderDags()]);
    }

    async function restoreSelected() {
      await post(root() + '/dags/restore', { path: state.selectedDag });
      clearDetail();
      await Promise.all([renderProject(), renderDags()]);
    }

    async function selectTask(id) {
      const context = requestContext();
      const dagPath = state.selectedDag;
      state.selectedTask = id;
      renderBoard();
      const detail = await api(rootFor(context.slug) + '/tasks/detail?dagPath=' + encodeURIComponent(dagPath) + '&taskId=' + encodeURIComponent(id));
      if (!isCurrent(context) || state.selectedDag !== dagPath || state.selectedTask !== id) return;
      el('taskDetail').className = 'task-detail';
      el('taskDetail').innerHTML = '<div class="status">' + esc(detail.task.status) + '</div><h2>' +
        esc(detail.task.name) + '</h2><p class="subtle">' + esc(detail.description) +
        '</p><div class="label">Files</div><div class="code">' + esc(detail.files.join(', ') || 'None declared') +
        '</div><div class="label">Worktree</div><div class="code">' + esc(detail.worktreePath || 'Not allocated') +
        '</div>' + (detail.error ? '<div class="label error">Error</div><div class="code error">' + esc(detail.error) + '</div>' : '');
    }

    const phaseIndex = (phase) => ['triage', 'plan', 'implement', 'verify', 'review', 'done'].indexOf(phase);

    async function renderRuns() {
      const context = requestContext();
      const data = await api(rootFor(context.slug) + '/intake/runs');
      if (!isCurrent(context) || state.view !== 'runs') return;
      el('board').className = 'board runs-list';
      el('board').innerHTML = data.runs.map((run) => '<button class="run-card ' +
        (state.selectedRun === run.id ? 'active' : '') + '" data-run="' +
        esc(run.id) + '"><div class="eyebrow">' + esc(run.mode) + '</div><strong>' + esc(run.title) +
        '</strong><div class="subtle">' + esc(run.status) + (run.phase ? ' · ' + esc(run.phase) : '') +
        '</div></button>').join('') || '<div class="empty">No agent runs yet.</div>';
      el('board').querySelectorAll('[data-run]').forEach((button) => {
        button.onclick = () => selectRun(button.dataset.run);
      });
    }

    async function selectRun(id) {
      if (state.view !== 'runs') return;
      const context = requestContext();
      state.selectedRun = id;
      el('board').querySelectorAll('[data-run]').forEach((button) => {
        button.classList.toggle('active', button.dataset.run === id);
      });
      const detail = await api(rootFor(context.slug) + '/intake/runs/' + encodeURIComponent(id));
      if (!isCurrent(context) || state.view !== 'runs' || state.selectedRun !== id) return;
      const run = detail.summary;
      el('dagTitle').textContent = run.title;
      el('dagStatus').textContent = run.status;
      el('dagMeta').textContent = run.mode + ' run';
      el('doneMetric').textContent = run.mode === 'dag' ? run.completedTasks + '/' + run.totalTasks : (run.phase || 'pending');
      el('failedMetric').textContent = run.mode;
      const percent = run.mode === 'dag'
        ? (run.totalTasks ? Math.round((run.completedTasks / run.totalTasks) * 100) : 0)
        : Math.max(0, Math.round((phaseIndex(run.phase) / 5) * 100));
      el('percentMetric').textContent = percent + '%';
      el('progressFill').style.width = percent + '%';
      el('dagAction').innerHTML = '';
      el('events').innerHTML = detail.recentLog?.map((line) => '<div>' + esc(line) + '</div>').join('') ||
        '<div class="empty">No runner output.</div>';
      if (run.mode === 'sequential') {
        const phases = ['triage', 'plan', 'implement', 'verify', 'review', 'done'];
        el('taskDetail').innerHTML = '<div class="status">' + esc(run.status) +
          '</div><h2>Sequential runner</h2><div class="phase-track">' + phases.map((phase, index) =>
            '<div class="phase-step ' + (index <= phaseIndex(run.phase) ? 'done' : '') + '">' + phase + '</div>'
          ).join('') + '</div><div class="label">Changed files</div><div class="code">' +
          esc(detail.checkpoint.changedFiles.join(', ') || 'None yet') + '</div><div class="label">Verification</div><div>' +
          esc(detail.checkpoint.verification || 'Pending') + '</div><div class="label">Review</div><div>' +
          esc(detail.checkpoint.reviewVerdict || 'Pending') + '</div>' +
          (detail.checkpoint.recoveryRequired ? '<p class="error">Recovery review required: inspect dirty project state.</p>' : '');
      } else {
        el('taskDetail').innerHTML = '<div class="status">' + esc(run.status) +
          '</div><h2>DAG runner</h2><div class="code">' + esc(detail.dagPath) + '</div>';
      }
    }

    function actionsFor(item) {
      let html = '';
      if (item.intakeStatus === 'awaiting-clarification') html += '<button class="icon-button" data-chat="' + esc(item.id) + '">Answer</button>';
      else if (item.clarificationMessages?.length) html += '<button class="icon-button" data-chat="' + esc(item.id) + '">View discussion</button>';
      if (item.intakeStatus === 'awaiting-approval') html += '<button class="icon-button" data-approve="' + esc(item.id) + '" data-revision="' + item.triage.proposalRevision + '">Approve</button>';
      if (item.intakeStatus === 'failed') html += '<button class="icon-button" data-triage="' + esc(item.id) + '">Retry</button>';
      if (['queued', 'running'].includes(item.intakeStatus)) html += '<button class="icon-button" data-cancel="' + esc(item.id) + '">Cancel</button>';
      return html + '<button class="icon-button" data-inbox-archive="' + esc(item.id) + '">Archive</button>';
    }

    function legacyQuestion(item) {
      const explicit = item.triage?.questions?.[0]?.trim();
      if (explicit) return explicit;
      const rationale = String(item.triage?.rationale || 'what outcome should Loom target').replace(/[.?!]+$/, '');
      return 'Could you clarify: ' + rationale + '?';
    }

    function conversationMessages(item) {
      const messages = item.clarificationMessages || [];
      if (messages.length || item.intakeStatus !== 'awaiting-clarification') return messages;
      return [{ id: 'legacy-question', role: 'loom', content: legacyQuestion(item) }];
    }

    async function renderInbox() {
      const context = requestContext();
      if (!context.slug) return;
      const data = await api(rootFor(context.slug) + '/inbox');
      if (!isCurrent(context)) return;
      state.inbox = data.items.filter((item) => item.status !== 'archived');
      el('autoRun').checked = data.policy.autoRunEnabled;
      el('inboxItems').innerHTML = state.inbox.map((item) => '<div class="inbox-item"><div>' +
        esc(item.triage?.summary || item.body) + '</div><div class="subtle">' + esc(item.intakeStatus || item.status) +
        '</div>' + (item.lastError ? '<div class="error subtle">' + esc(item.lastError) + '</div>' : '') +
        '<div class="actions">' + actionsFor(item) + '</div></div>').join('') ||
        '<div class="empty">Inbox is clear.</div>';
      el('inboxItems').querySelectorAll('[data-chat]').forEach((button) => {
        button.onclick = () => openChat(button.dataset.chat, button);
      });
      el('inboxItems').querySelectorAll('[data-triage]').forEach((button) => {
        button.onclick = () => inboxAction(button.dataset.triage, 'triage');
      });
      el('inboxItems').querySelectorAll('[data-cancel]').forEach((button) => {
        button.onclick = () => inboxAction(button.dataset.cancel, 'cancel');
      });
      el('inboxItems').querySelectorAll('[data-approve]').forEach((button) => {
        button.onclick = () => inboxAction(button.dataset.approve, 'approve', { proposalRevision: Number(button.dataset.revision) });
      });
      el('inboxItems').querySelectorAll('[data-inbox-archive]').forEach((button) => {
        button.onclick = () => inboxAction(button.dataset.inboxArchive, 'archive');
      });
      if (state.chatItemId) renderConversation();
      const pending = state.inbox.map((item) => {
        const question = [...(item.clarificationMessages || [])].reverse().find((message) => message.role === 'loom');
        return { item, key: state.slug + ':' + item.id + ':' + (question?.id || item.triage?.proposalRevision || 'legacy') };
      }).find((entry) => entry.item.intakeStatus === 'awaiting-clarification' && !state.autoOpenedQuestions.has(entry.key));
      if (pending && !state.chatItemId) {
        state.autoOpenedQuestions.add(pending.key);
        openChat(pending.item.id);
      }
    }

    async function inboxAction(id, action, body) {
      await post(root() + '/inbox/' + encodeURIComponent(id) + '/' + action, body);
      await renderInbox();
      if (state.view === 'runs') await renderRuns();
    }

    function renderConversation() {
      const item = state.inbox.find((candidate) => candidate.id === state.chatItemId);
      if (!item) return closeChat();
      const draftKey = state.slug + ':' + item.id;
      el('chatTitle').textContent = item.triage?.summary || 'Clarify todo';
      el('chatStatus').textContent = item.intakeStatus || item.status;
      el('chatMessages').innerHTML = conversationMessages(item).map((message) => '<div class="bubble ' +
        esc(message.role) + '"><div class="eyebrow">' + (message.role === 'loom' ? 'Loom' : 'You') +
        '</div>' + esc(message.content) + '</div>').join('');
      el('chatAnswer').disabled = item.intakeStatus !== 'awaiting-clarification';
      el('chatAnswer').value = state.conversationDrafts[draftKey] || '';
      el('chatSend').disabled = state.chatSubmitting || !el('chatAnswer').value.trim() || el('chatAnswer').disabled;
      el('chatActions').innerHTML = actionsFor(item).replace(/data-chat="[^"]+"/g, 'disabled');
      el('chatActions').querySelectorAll('[data-triage]').forEach((button) => button.onclick = () => inboxAction(button.dataset.triage, 'triage'));
      el('chatActions').querySelectorAll('[data-cancel]').forEach((button) => button.onclick = () => inboxAction(button.dataset.cancel, 'cancel'));
      el('chatActions').querySelectorAll('[data-approve]').forEach((button) => button.onclick = () => inboxAction(button.dataset.approve, 'approve', { proposalRevision: Number(button.dataset.revision) }));
      el('chatActions').querySelectorAll('[data-inbox-archive]').forEach((button) => button.onclick = () => inboxAction(button.dataset.inboxArchive, 'archive'));
      el('chatMessages').scrollTop = el('chatMessages').scrollHeight;
    }

    function openChat(id, trigger) {
      state.chatItemId = id;
      state.chatReturnFocus = trigger || document.activeElement;
      el('chatModal').classList.remove('hidden');
      renderConversation();
      if (!el('chatAnswer').disabled) el('chatAnswer').focus();
    }

    function closeChat() {
      const returnFocus = state.chatReturnFocus;
      state.chatItemId = null;
      state.chatReturnFocus = null;
      el('chatModal')?.classList.add('hidden');
      if (returnFocus?.focus) returnFocus.focus();
    }

    async function sendChat() {
      const item = state.inbox.find((candidate) => candidate.id === state.chatItemId);
      const answer = el('chatAnswer').value.trim();
      if (state.chatSubmitting || !answer || !item || item.intakeStatus !== 'awaiting-clarification') return;
      state.chatSubmitting = true;
      try {
        el('chatError').textContent = '';
        el('chatSend').disabled = true;
        await post(root() + '/inbox/' + encodeURIComponent(item.id) + '/clarify', {
          proposalRevision: item.triage.proposalRevision,
          answer,
        });
        delete state.conversationDrafts[state.slug + ':' + item.id];
        await renderInbox();
      } catch (error) {
        el('chatError').textContent = error.message;
      } finally {
        state.chatSubmitting = false;
        if (state.chatItemId === item.id) renderConversation();
      }
    }

    el('allProjects').onclick = () => renderHome(false);
    el('chatClose').onclick = closeChat;
    el('chatSend').onclick = sendChat;
    el('chatModal').onclick = (event) => { if (event.target === el('chatModal')) closeChat(); };
    el('chatAnswer').oninput = () => {
      if (state.chatItemId) state.conversationDrafts[state.slug + ':' + state.chatItemId] = el('chatAnswer').value;
      el('chatSend').disabled = !el('chatAnswer').value.trim();
    };
    el('chatAnswer').onkeydown = (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        void sendChat();
      }
    };
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !el('chatModal').classList.contains('hidden')) closeChat();
    });
    el('saveTodo').onclick = async () => {
      const body = el('todoBody').value.trim();
      if (!body) return;
      el('saveTodo').disabled = true;
      try {
        await post(root() + '/inbox', { body });
        el('todoBody').value = '';
        await renderInbox();
      } finally {
        el('saveTodo').disabled = false;
      }
    };
    el('autoRun').onchange = async () => {
      const context = requestContext();
      const enabled = el('autoRun').checked;
      const status = await api(rootFor(context.slug) + '/intake/status');
      if (!isCurrent(context)) return;
      await api(rootFor(context.slug) + '/intake/policy', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...status.policy, autoRunEnabled: enabled }),
      });
    };
    el('dagView').onclick = async () => {
      state.view = 'dags';
      state.selectedRun = null;
      el('dagView').classList.add('active');
      el('runsView').classList.remove('active');
      el('dagTabs').classList.remove('hidden');
      await renderDags();
      if (state.selectedDag) await selectDag(state.selectedDag, true);
    };
    el('runsView').onclick = async () => {
      state.view = 'runs';
      el('runsView').classList.add('active');
      el('dagView').classList.remove('active');
      el('dagTabs').classList.add('hidden');
      clearDetail();
      el('dagTitle').textContent = 'Agent runs';
      el('dagStatus').textContent = 'Live';
      await renderRuns();
    };
    document.querySelectorAll('[data-dag-view]').forEach((button) => {
      button.onclick = async () => {
        state.dagView = button.dataset.dagView;
        clearDetail();
        document.querySelectorAll('[data-dag-view]').forEach((candidate) => candidate.classList.toggle('active', candidate === button));
        await renderDags();
      };
    });

    async function bootstrap() {
      state.csrfToken = (await api('/api/session')).csrfToken;
      await renderHome(true);
    }

    bootstrap().catch((error) => { el('homeErrors').textContent = error.message; });
    setInterval(() => {
      if (!state.slug) return;
      Promise.all([
        renderProject(),
        renderInbox(),
        state.view === 'runs'
          ? renderRuns().then(() => state.view === 'runs' && state.selectedRun && selectRun(state.selectedRun))
          : (state.selectedDag ? selectDag(state.selectedDag, true) : renderDags()),
      ]).catch((error) => { el('diagnostics').textContent = error.message; });
    }, 5000);
  </script>
</body>
</html>`;
