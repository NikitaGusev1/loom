export const UI_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>DAG Executor</title>
  <style>
    :root { color-scheme: dark; --bg:#0b0d10; --surface:#111419; --raised:#171b21; --line:#272c34; --soft:#89919e; --ink:#f2f4f7; --green:#59d499; --yellow:#f2c94c; --red:#ff6b6b; --blue:#75a7ff; }
    * { box-sizing:border-box; }
    html, body { height:100%; }
    body { margin:0; overflow:hidden; background:var(--bg); color:var(--ink); font:16px/1.45 Inter, ui-sans-serif, system-ui, -apple-system, sans-serif; letter-spacing:0; }
    button, textarea { font:inherit; letter-spacing:0; }
    button { color:inherit; }
    .app { height:100vh; display:grid; grid-template-columns:220px minmax(560px,1fr) 320px; }
    .sidebar { min-width:0; padding:18px 12px 14px; border-right:1px solid var(--line); background:#0e1115; display:flex; flex-direction:column; gap:18px; }
    .brand { display:flex; align-items:center; gap:9px; padding:0 7px; font-weight:700; font-size:16px; }
    .mark { width:20px; height:20px; position:relative; }
    .mark:before,.mark:after { content:""; position:absolute; border:2px solid var(--green); width:6px; height:6px; transform:rotate(45deg); }
    .mark:before { left:1px; top:6px; }.mark:after { right:1px; top:6px; }
    .eyebrow { color:var(--soft); font-size:12px; font-weight:700; text-transform:uppercase; }
    .project { margin-top:3px; padding:0 7px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; color:#c6cbd3; }
    .git-status { margin:7px 7px 0; display:flex; align-items:center; gap:6px; color:var(--soft); font-size:12px; }
    .git-dot { width:7px; height:7px; border-radius:50%; background:var(--soft); }
    .git-status.clean .git-dot { background:var(--green); }.git-status.dirty .git-dot { background:var(--yellow); }
    .dag-list { min-height:0; overflow:auto; display:grid; gap:3px; }
    .dag-button { width:100%; border:0; border-radius:5px; background:transparent; padding:9px 8px; text-align:left; cursor:pointer; display:grid; grid-template-columns:8px 1fr; gap:8px; }
    .dag-button:hover,.dag-button.active { background:var(--raised); }
    .dag-button.active { box-shadow:inset 2px 0 var(--green); }
    .dag-button:disabled { cursor:default; opacity:.55; }
    .view-nav { display:grid; grid-template-columns:1fr 1fr; gap:5px; }
    .view-button { border:1px solid var(--line); border-radius:5px; background:transparent; padding:7px; cursor:pointer; }
    .view-button.active { background:var(--raised); border-color:#4a535f; }
    .dot { width:7px; height:7px; margin-top:5px; border-radius:50%; background:var(--soft); }
    .dot.running { background:var(--green); box-shadow:0 0 0 3px #59d49922; }
    .dag-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .subtle { color:var(--soft); font-size:13px; }
    .slots { border-top:1px solid var(--line); padding:14px 7px 0; }
    .slot-row { display:flex; justify-content:space-between; margin-top:7px; }
    .readonly { margin-top:auto; display:flex; gap:7px; align-items:center; color:var(--soft); padding:0 7px; font-size:13px; }
    .readonly:before { content:""; width:7px; height:7px; background:var(--blue); border-radius:50%; }
    .workspace { min-width:0; min-height:0; display:grid; grid-template-rows:auto minmax(0,1fr) 170px; }
    .topbar { padding:19px 20px 16px; border-bottom:1px solid var(--line); }
    .title-row,.section-head,.metric-row { display:flex; align-items:center; justify-content:space-between; gap:16px; }
    h1 { margin:2px 0 0; font-size:22px; line-height:1.2; }
    .status { color:var(--green); font-size:13px; text-transform:uppercase; font-weight:700; }
    .metric-row { margin-top:17px; justify-content:flex-start; gap:30px; }
    .metric strong { display:block; font:600 19px ui-monospace, monospace; }
    .progress { flex:1; max-width:380px; height:5px; background:#252a31; border-radius:4px; overflow:hidden; }
    .progress span { display:block; height:100%; background:var(--green); width:0; transition:width .25s ease; }
    .board-wrap { min-height:0; padding:16px 20px 18px; overflow:hidden; }
    .section-head { margin-bottom:11px; }
    .board { height:calc(100% - 28px); display:grid; grid-template-columns:repeat(6,minmax(125px,1fr)); gap:8px; overflow-x:auto; }
    .lane { min-width:125px; background:#0f1216; border:1px solid var(--line); border-radius:6px; padding:9px; overflow:auto; }
    .lane-title { position:sticky; top:-9px; margin:-9px -9px 7px; padding:9px; background:#0f1216; display:flex; justify-content:space-between; color:#aeb5bf; font-size:12px; font-weight:700; text-transform:uppercase; }
    .count { font-family:ui-monospace,monospace; }
    .task { width:100%; border:1px solid #242a32; border-radius:5px; background:var(--raised); padding:9px; margin-top:6px; text-align:left; cursor:pointer; }
    .task:hover { border-color:#4a535f; }.task.active { border-color:var(--blue); box-shadow:inset 2px 0 var(--blue); }
    .task-id { color:var(--soft); font:12px ui-monospace,monospace; margin-bottom:3px; }
    .events-panel { border-top:1px solid var(--line); padding:13px 20px; overflow:hidden; }
    .events { height:118px; overflow:auto; margin-top:8px; font:13px/1.6 ui-monospace,monospace; color:#aab1bb; }
    .event { display:grid; grid-template-columns:76px 1fr; gap:10px; }.event-kind { color:#d9dde3; }
    .rail { min-width:0; min-height:0; border-left:1px solid var(--line); background:#0e1115; display:grid; grid-template-rows:minmax(250px,1fr) minmax(270px,1fr); }
    .rail-panel { min-height:0; overflow:auto; padding:18px 16px; border-bottom:1px solid var(--line); }
    .task-detail h2 { font-size:18px; margin:10px 0 6px; }.task-detail p { margin:8px 0; }
    .label { color:var(--soft); font-size:12px; text-transform:uppercase; font-weight:700; margin-top:15px; }
    .code { font:13px ui-monospace,monospace; word-break:break-word; }
    textarea { width:100%; height:84px; resize:none; margin-top:11px; padding:10px; color:var(--ink); background:#0a0c0f; border:1px solid #303640; border-radius:5px; outline:none; }
    textarea:focus { border-color:var(--blue); }
    .compose-row { display:flex; justify-content:space-between; align-items:center; margin-top:8px; }
    .primary,.icon-button { border:0; border-radius:5px; cursor:pointer; }
    .primary { padding:7px 11px; background:var(--ink); color:#101216; font-weight:700; }.primary:disabled { opacity:.45; }
    .inbox { margin-top:16px; display:grid; gap:6px; }
    .inbox-item { border:1px solid var(--line); border-radius:5px; padding:9px; background:var(--surface); }
    .inbox-meta { margin-top:7px; display:flex; justify-content:space-between; align-items:center; }
    .icon-button { background:transparent; color:var(--soft); padding:2px 5px; font-size:14px; }.icon-button:hover { color:var(--ink); background:var(--raised); }
    .empty { color:var(--soft); padding:14px 0; }
    .error { color:var(--red); }
    .runs-list { display:grid; grid-template-columns:repeat(auto-fill,minmax(240px,1fr)); align-content:start; gap:8px; overflow:auto; }
    .run-card { border:1px solid var(--line); border-radius:5px; background:var(--surface); padding:11px; cursor:pointer; text-align:left; }
    .run-card:hover,.run-card.active { border-color:var(--blue); }
    .phase-track { display:grid; grid-template-columns:repeat(6,1fr); gap:3px; margin:14px 0; }
    .phase-step { padding:7px 3px; text-align:center; border-bottom:3px solid var(--line); font-size:12px; color:var(--soft); }
    .phase-step.done { color:var(--ink); border-color:var(--green); }
    .intake-actions { display:flex; gap:5px; margin-top:8px; flex-wrap:wrap; }
    .inbox-summary { width:100%; padding:0; border:0; background:transparent; color:inherit; text-align:left; cursor:pointer; }
    .chat-modal[hidden] { display:none; }
    .chat-modal { position:fixed; inset:0; z-index:20; display:grid; place-items:center; padding:20px; background:#050608bb; }
    .chat-dialog { width:min(620px,100%); max-height:min(760px,calc(100vh - 40px)); display:grid; grid-template-rows:auto minmax(180px,1fr) auto; background:var(--surface); border:1px solid #3b424d; border-radius:9px; box-shadow:0 24px 80px #000a; overflow:hidden; }
    .chat-head { padding:15px 17px; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; }
    .chat-head strong { display:block; }.chat-close { align-self:start; font-size:20px; }
    .chat-messages { overflow:auto; padding:18px; display:flex; flex-direction:column; gap:10px; }
    .chat-bubble { max-width:82%; padding:9px 11px; border-radius:9px; white-space:pre-wrap; word-break:break-word; }
    .chat-bubble.loom { align-self:flex-start; background:var(--raised); border:1px solid var(--line); }
    .chat-bubble.user { align-self:flex-end; background:#254a7d; }
    .chat-compose { border-top:1px solid var(--line); padding:12px 15px; }
    .chat-compose textarea { height:72px; margin:0; }.chat-compose .compose-row { margin-top:7px; }
    @media (max-width:1000px) { body { overflow:auto; }.app { height:auto; min-height:100vh; grid-template-columns:190px minmax(500px,1fr); }.rail { grid-column:1/-1; border-left:0; border-top:1px solid var(--line); grid-template-columns:1fr 1fr; grid-template-rows:340px; }.workspace { min-height:720px; } }
    @media (max-width:640px) { .chat-modal { padding:6px; }.chat-dialog { width:100%; max-height:calc(100vh - 12px); height:calc(100vh - 12px); }.chat-bubble { max-width:92%; } }
  </style>
</head>
<body>
  <div class="app">
    <aside class="sidebar">
      <div class="brand"><span class="mark"></span>DAG Executor</div>
      <div><div class="eyebrow">Project</div><div id="projectPath" class="project">Loading...</div><div id="gitStatus" class="git-status"><span class="git-dot"></span><span>Checking Git…</span></div></div>
      <div class="view-nav"><button id="dagView" class="view-button active" type="button">DAGs</button><button id="runsView" class="view-button" type="button">Runs</button></div>
      <div class="dag-list" id="dagList"></div>
      <div class="slots"><div class="eyebrow">Agent capacity</div><div id="slotSummary" class="slot-row subtle">Scanning slots...</div></div>
      <div class="readonly">Local agent intake</div>
    </aside>
    <main class="workspace">
      <header class="topbar">
        <div class="title-row"><div><div class="eyebrow">Execution overview</div><h1 id="dagTitle">No DAG selected</h1></div><div id="dagStatus" class="status">Idle</div></div>
        <div class="metric-row"><div class="metric"><strong id="doneMetric">0/0</strong><span class="subtle">tasks complete</span></div><div class="metric"><strong id="failedMetric">0</strong><span class="subtle">failed</span></div><div class="progress"><span id="progressFill"></span></div><div id="percentMetric" class="subtle">0%</div></div>
      </header>
      <section class="board-wrap"><div class="section-head"><strong>Backlog</strong><span id="dagMeta" class="subtle"></span></div><div id="board" class="board"></div></section>
      <section class="events-panel"><div class="section-head"><strong>Event stream</strong><span class="subtle">Newest first</span></div><div id="events" class="events"></div></section>
    </main>
    <aside class="rail">
      <section class="rail-panel"><div class="eyebrow">Task inspector</div><div id="taskDetail" class="task-detail empty">Select a task to inspect its context and runtime state.</div></section>
      <section class="rail-panel"><div class="section-head"><strong>Todo inbox</strong><label class="subtle"><input id="autoRun" type="checkbox" checked> Auto-run easy work</label></div><textarea id="todoBody" aria-label="Describe work for agents" placeholder="Describe what you want agents to work on..."></textarea><div class="compose-row"><span id="todoHint" class="subtle">Triaged for this project</span><button id="saveTodo" class="primary" type="button">Add todo</button></div><div id="inboxItems" class="inbox"></div></section>
    </aside>
  </div>
  <div id="chatModal" class="chat-modal" hidden>
    <section class="chat-dialog" role="dialog" aria-modal="true" aria-labelledby="chatTitle">
      <header class="chat-head"><div><strong id="chatTitle">Clarify todo</strong><span id="chatStatus" class="subtle"></span></div><button id="chatClose" class="icon-button chat-close" type="button" aria-label="Close conversation">×</button></header>
      <div id="chatMessages" class="chat-messages" aria-live="polite"></div>
      <div id="chatCompose" class="chat-compose"><textarea id="chatAnswer" aria-label="Answer Loom" placeholder="Answer Loom..."></textarea><div class="compose-row"><span id="chatHint" class="subtle"></span><button id="chatSend" class="primary" type="button">Send</button></div><div id="chatActions" class="intake-actions"></div><div id="chatError" class="error"></div></div>
    </section>
  </div>
  <script>
    const state={view:'dags',dags:[],runs:[],inboxItems:[],selectedDagPath:null,selectedRunId:null,detail:null,selectedTaskId:null,activeConversationId:null,conversationReturnFocus:null,conversationDrafts:{},autoOpenedQuestions:new Set()};
    const el=(id)=>document.getElementById(id);
    const esc=(v)=>String(v??'').replace(/[&<>"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const compact=(v,max)=>{const text=String(v??'').replace(/\s+/g,' ').trim();if(text.length<=max)return text;const slice=text.slice(0,max-1);const boundary=slice.lastIndexOf(' ');return (boundary>max*.6?slice.slice(0,boundary):slice)+'…';};
    const api=async(path,init)=>{const res=await fetch(path,init);const body=await res.json();if(!res.ok)throw new Error(body.error?.message||'Request failed');return body;};
    const fmtTime=(ts)=>{const d=new Date(ts);return Number.isNaN(d.valueOf())?'--:--:--':d.toLocaleTimeString([],{hour12:false});};
    async function renderProject(){const p=await api('/api/project');el('projectPath').textContent=p.projectPath;el('projectPath').title=p.projectPath;const g=p.git;const parts=g.isRepository?[g.branch||'detached',g.clean?'clean':'dirty',...(!g.clean?[g.changedFiles+' change'+(g.changedFiles===1?'':'s')]:[]),...(g.ahead?['ahead '+g.ahead]:[]),...(g.behind?['behind '+g.behind]:[])]:['not a Git repository'];el('gitStatus').className='git-status '+(g.clean?'clean':'dirty');el('gitStatus').innerHTML='<span class="git-dot"></span><span>'+esc(parts.join(' · '))+'</span>';el('slotSummary').innerHTML='<span>'+p.slots.holders.length+' active</span><span>'+p.slots.waiters.length+' queued / '+p.slots.maxSlots+'</span>';}
    async function renderDags(){const data=await api('/api/dags');state.dags=data.dags;el('dagList').innerHTML='<div class="eyebrow" style="padding:0 7px 5px">Discovered DAGs</div>'+data.dags.map(d=>'<button class="dag-button '+(d.path===state.selectedDagPath?'active':'')+'" '+(d.status==='invalid'?'disabled title="Not a valid DAG"':'data-dag="'+esc(d.path)+'"')+'><span class="dot '+esc(d.status)+'"></span><span><span class="dag-name">'+esc(d.title)+'</span><span class="subtle">'+esc(d.status)+'</span></span></button>').join('');el('dagList').querySelectorAll('[data-dag]').forEach(b=>b.onclick=()=>selectDag(b.dataset.dag));const firstValid=data.dags.find(d=>d.status!=='invalid');if(!state.selectedDagPath&&firstValid)await selectDag(firstValid.path);if(!data.dags.length)el('dagList').innerHTML+='<div class="empty" style="padding-left:7px">No DAG files found.</div>';}
    function renderBoard(){const groups=state.detail?.backlog||{ready:[],running:[],blocked:[],failed:[],done:[],pending:[]};el('board').innerHTML=['ready','running','pending','blocked','failed','done'].map(name=>'<div class="lane"><div class="lane-title"><span>'+name+'</span><span class="count">'+groups[name].length+'</span></div>'+groups[name].map(t=>'<button class="task '+(t.id===state.selectedTaskId?'active':'')+'" data-task="'+esc(t.id)+'"><div class="task-id">'+esc(t.id)+'</div><div>'+esc(t.name)+'</div></button>').join('')+'</div>').join('');el('board').querySelectorAll('[data-task]').forEach(b=>b.onclick=()=>selectTask(b.dataset.task));}
    async function selectDag(path,preserveTask=false){const selectedTask=preserveTask?state.selectedTaskId:null;state.selectedDagPath=path;state.selectedTaskId=selectedTask;state.detail=await api('/api/dags/detail?path='+encodeURIComponent(path));const d=state.detail;el('dagTitle').textContent=d.dag.meta.source.title;el('dagStatus').textContent=d.status;el('dagMeta').textContent=d.relativePath;el('doneMetric').textContent=d.progress.completedTasks+'/'+d.progress.totalTasks;el('failedMetric').textContent=d.progress.failedTasks;el('percentMetric').textContent=d.progress.percent+'%';el('progressFill').style.width=d.progress.percent+'%';el('events').innerHTML=d.recentEvents.map(e=>'<div class="event"><span>'+fmtTime(e.ts)+'</span><span class="event-kind">'+esc(e.kind)+'</span></div>').join('')||'<div class="empty">No events recorded yet.</div>';if(selectedTask){await selectTask(selectedTask);}else{el('taskDetail').className='task-detail empty';el('taskDetail').textContent='Select a task to inspect its context and runtime state.';}renderBoard();renderDags();}
    async function selectTask(id){state.selectedTaskId=id;renderBoard();const d=await api('/api/tasks/detail?dagPath='+encodeURIComponent(state.selectedDagPath)+'&taskId='+encodeURIComponent(id));el('taskDetail').className='task-detail';el('taskDetail').innerHTML='<div class="status">'+esc(d.task.status)+'</div><h2>'+esc(d.task.name)+'</h2><p class="subtle">'+esc(compact(d.description,96))+'</p><div class="label">Task ID</div><div class="code">'+esc(d.task.id)+'</div><div class="label">Files</div><div class="code">'+esc(d.files.join(', ')||'None declared')+'</div><div class="label">Worktree</div><div class="code">'+esc(d.worktreePath||'Not allocated')+'</div>'+(d.error?'<div class="label error">Error</div><div class="code error">'+esc(d.error)+'</div>':'');}
    const phaseIndex=(phase)=>['triage','plan','implement','verify','review','done'].indexOf(phase);
    async function renderRuns(){const data=await api('/api/intake/runs');state.runs=data.runs;el('board').className='board runs-list';el('board').innerHTML=data.runs.map(r=>'<button class="run-card '+(r.id===state.selectedRunId?'active':'')+'" data-run="'+esc(r.id)+'"><div class="eyebrow">'+esc(r.mode)+'</div><strong>'+esc(r.title)+'</strong><div class="subtle">'+esc(r.status)+(r.phase?' · '+esc(r.phase):'')+'</div></button>').join('')||'<div class="empty">No agent runs yet.</div>';el('board').querySelectorAll('[data-run]').forEach(b=>b.onclick=()=>selectRun(b.dataset.run));el('dagMeta').textContent=data.runs.length+' tracked';}
    async function selectRun(id){state.selectedRunId=id;const d=await api('/api/intake/runs/'+encodeURIComponent(id));const r=d.summary;el('dagTitle').textContent=r.title;el('dagStatus').textContent=r.status;el('doneMetric').textContent=r.mode==='sequential'?r.phase:r.completedTasks+'/'+r.totalTasks;el('failedMetric').textContent=r.mode;el('percentMetric').textContent='';el('progressFill').style.width=(r.mode==='sequential'?Math.max(0,phaseIndex(r.phase))*20:(r.totalTasks?r.completedTasks/r.totalTasks*100:0))+'%';if(r.mode==='sequential'){const phases=['triage','plan','implement','verify','review','done'];el('events').innerHTML=d.recentLog.map(line=>'<div>'+esc(line)+'</div>').join('')||'<div class="empty">No runner output yet.</div>';el('taskDetail').innerHTML='<div class="status">'+esc(r.status)+'</div><h2>Sequential runner</h2><div class="phase-track">'+phases.map((p,i)=>'<div class="phase-step '+(i<=phaseIndex(r.phase)?'done':'')+'">'+p+'</div>').join('')+'</div><div class="label">Changed files</div><div class="code">'+esc(d.checkpoint.changedFiles.join(', ')||'None yet')+'</div><div class="label">Verification</div><div>'+esc(d.checkpoint.verification||'Pending')+'</div><div class="label">Review</div><div>'+esc(d.checkpoint.reviewVerdict||'Pending')+'</div>'+(d.checkpoint.recoveryRequired?'<p class="error">Recovery review required: inspect dirty project state.</p>':'');}else{el('events').innerHTML='<div class="empty">Select this DAG from the DAGs view for task events.</div>';el('taskDetail').innerHTML='<div class="status">'+esc(r.status)+'</div><h2>DAG runner</h2><div class="code">'+esc(d.dagPath)+'</div>';}renderRuns();}
    function legacyQuestion(item){const q=item.triage?.questions?.[0]?.trim();if(q)return q;const rationale=String(item.triage?.rationale||'what outcome should Loom target').replace(/[.?!]+$/,'');return 'Could you clarify: '+rationale+'?';}
    function conversationMessages(item){const messages=item.clarificationMessages||[];if(messages.length||item.intakeStatus!=='awaiting-clarification')return messages;return [{id:'legacy-question',role:'loom',content:legacyQuestion(item)}];}
    function closeConversation(){const target=state.conversationReturnFocus;el('chatModal').hidden=true;state.activeConversationId=null;state.conversationReturnFocus=null;if(target?.focus)target.focus();}
    function openConversation(id,trigger){state.activeConversationId=id;state.conversationReturnFocus=trigger||document.activeElement;el('chatModal').hidden=false;renderConversation();if(!el('chatAnswer').disabled)el('chatAnswer').focus();}
    function renderConversation(){const item=state.inboxItems.find(i=>i.id===state.activeConversationId);if(!item){closeConversation();return;}const awaiting=item.intakeStatus==='awaiting-clarification';const busy=item.intakeStatus==='triaging';el('chatTitle').textContent=compact(item.triage?.summary||item.body,80);el('chatStatus').textContent=item.intakeStatus||item.status;const messages=conversationMessages(item);el('chatMessages').innerHTML=messages.map(m=>'<div class="chat-bubble '+esc(m.role)+'"><div class="eyebrow">'+(m.role==='loom'?'Loom':'You')+'</div>'+esc(m.content)+'</div>').join('')||(busy?'<div class="empty">Loom is reviewing this todo…</div>':'<div class="empty">No clarification needed yet.</div>');const answer=el('chatAnswer');answer.disabled=!awaiting;answer.value=state.conversationDrafts[item.id]||'';el('chatSend').disabled=!awaiting||!answer.value.trim();el('chatHint').textContent=busy?'Loom is reconsidering…':awaiting?'Enter to send · Shift+Enter for newline':'Conversation paused';el('chatActions').innerHTML=(item.intakeStatus==='awaiting-approval'?'<button class="icon-button" data-chat-approve="'+esc(item.id)+'" data-revision="'+item.triage.proposalRevision+'">Approve proposal</button>':'')+(item.intakeStatus==='failed'?'<button class="icon-button" data-chat-triage="'+esc(item.id)+'">Retry</button>':'')+(['queued','running'].includes(item.intakeStatus)?'<button class="icon-button" data-chat-cancel="'+esc(item.id)+'">Cancel</button>':'');el('chatActions').querySelector('[data-chat-approve]')?.addEventListener('click',e=>inboxAction('/api/inbox/'+encodeURIComponent(e.currentTarget.dataset.chatApprove)+'/approve',{proposalRevision:Number(e.currentTarget.dataset.revision)}));el('chatActions').querySelector('[data-chat-triage]')?.addEventListener('click',e=>inboxAction('/api/inbox/'+encodeURIComponent(e.currentTarget.dataset.chatTriage)+'/triage'));el('chatActions').querySelector('[data-chat-cancel]')?.addEventListener('click',e=>inboxAction('/api/inbox/'+encodeURIComponent(e.currentTarget.dataset.chatCancel)+'/cancel'));el('chatMessages').scrollTop=el('chatMessages').scrollHeight;}
    async function sendConversation(){const item=state.inboxItems.find(i=>i.id===state.activeConversationId);const answer=el('chatAnswer').value.trim();if(!item||!answer||item.intakeStatus!=='awaiting-clarification')return;el('chatSend').disabled=true;el('chatError').textContent='';try{await api('/api/inbox/'+encodeURIComponent(item.id)+'/clarify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({proposalRevision:item.triage.proposalRevision,answer})});state.conversationDrafts[item.id]='';await renderInbox();}catch(err){el('chatError').textContent=err.message;el('chatSend').disabled=false;}}
    async function renderInbox(){const data=await api('/api/inbox');const items=data.items.filter(i=>i.status!=='archived');state.inboxItems=items;el('autoRun').checked=data.policy.autoRunEnabled;el('inboxItems').innerHTML=items.map(i=>{const t=i.triage;const canChat=i.intakeStatus==='awaiting-clarification'||(i.clarificationMessages?.length>0);const actions=(i.intakeStatus==='awaiting-clarification'?'<button class="icon-button" data-clarify="'+esc(i.id)+'">Answer</button>':'')+(i.intakeStatus==='awaiting-approval'?'<button class="icon-button" data-approve="'+esc(i.id)+'" data-revision="'+t.proposalRevision+'">Approve</button>':'')+(i.intakeStatus==='failed'?'<button class="icon-button" data-triage="'+esc(i.id)+'">Retry</button>':'')+(['queued','running'].includes(i.intakeStatus)?'<button class="icon-button" data-cancel="'+esc(i.id)+'">Cancel</button>':'');return '<div class="inbox-item"><button class="inbox-summary" '+(canChat?'data-open-chat="'+esc(i.id)+'"':'')+' type="button"><div>'+esc(compact(t?.summary||i.body,120))+'</div><div class="subtle">'+esc(i.intakeStatus||i.status)+(t?' · '+esc(t.complexity)+' · '+Math.round(t.confidence*100)+'%':'')+'</div></button>'+(i.lastError?'<div class="error">'+esc(i.lastError)+'</div>':'')+'<div class="inbox-meta"><div class="intake-actions">'+actions+'</div><button class="icon-button" data-archive="'+esc(i.id)+'">Archive</button></div></div>';}).join('')||'<div class="empty">Inbox is clear.</div>';el('inboxItems').querySelectorAll('[data-archive]').forEach(b=>b.onclick=()=>inboxAction('/api/inbox/'+encodeURIComponent(b.dataset.archive)+'/archive'));el('inboxItems').querySelectorAll('[data-triage]').forEach(b=>b.onclick=()=>inboxAction('/api/inbox/'+encodeURIComponent(b.dataset.triage)+'/triage'));el('inboxItems').querySelectorAll('[data-cancel]').forEach(b=>b.onclick=()=>inboxAction('/api/inbox/'+encodeURIComponent(b.dataset.cancel)+'/cancel'));el('inboxItems').querySelectorAll('[data-approve]').forEach(b=>b.onclick=()=>inboxAction('/api/inbox/'+encodeURIComponent(b.dataset.approve)+'/approve',{proposalRevision:Number(b.dataset.revision)}));el('inboxItems').querySelectorAll('[data-clarify],[data-open-chat]').forEach(b=>b.onclick=()=>openConversation(b.dataset.clarify||b.dataset.openChat,b));if(state.activeConversationId)renderConversation();const pending=items.map(i=>{const question=[...(i.clarificationMessages||[])].reverse().find(m=>m.role==='loom');return {item:i,key:i.id+':'+(question?.id||i.triage?.proposalRevision||'legacy')};}).find(entry=>entry.item.intakeStatus==='awaiting-clarification'&&!state.autoOpenedQuestions.has(entry.key));if(pending&&!state.activeConversationId){state.autoOpenedQuestions.add(pending.key);openConversation(pending.item.id);}}
    async function inboxAction(path,body){await api(path,{method:'POST',headers:{'content-type':'application/json'},...(body&&{body:JSON.stringify(body)})});await renderInbox();if(state.view==='runs')await renderRuns();}
    el('saveTodo').onclick=async()=>{const body=el('todoBody').value.trim();if(!body)return;el('saveTodo').disabled=true;try{await api('/api/inbox',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({body})});el('todoBody').value='';await renderInbox();}finally{el('saveTodo').disabled=false;}};
    el('chatAnswer').oninput=()=>{if(state.activeConversationId)state.conversationDrafts[state.activeConversationId]=el('chatAnswer').value;el('chatSend').disabled=!el('chatAnswer').value.trim();};
    el('chatAnswer').onkeydown=(event)=>{if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();void sendConversation();}};
    el('chatSend').onclick=()=>void sendConversation();el('chatClose').onclick=closeConversation;el('chatModal').onclick=(event)=>{if(event.target===el('chatModal'))closeConversation();};document.addEventListener('keydown',(event)=>{if(event.key==='Escape'&&!el('chatModal').hidden)closeConversation();});
    el('autoRun').onchange=async()=>{const s=await api('/api/intake/status');await api('/api/intake/policy',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({...s.policy,autoRunEnabled:el('autoRun').checked})});};
    el('dagView').onclick=async()=>{state.view='dags';el('dagView').classList.add('active');el('runsView').classList.remove('active');el('board').className='board';await renderDags();if(state.selectedDagPath)await selectDag(state.selectedDagPath,true);};
    el('runsView').onclick=async()=>{state.view='runs';el('runsView').classList.add('active');el('dagView').classList.remove('active');el('dagTitle').textContent='Agent runs';el('dagStatus').textContent='Live';await renderRuns();};
    const showError=(err)=>{el('events').innerHTML='<div class="error">'+esc(err.message)+'</div>';};
    Promise.all([renderProject(),renderDags(),renderInbox()]).catch(showError);
    setInterval(()=>Promise.all([renderProject(),renderInbox(),state.view==='runs'?(state.selectedRunId?selectRun(state.selectedRunId):renderRuns()):(state.selectedDagPath?selectDag(state.selectedDagPath,true):renderDags())]).catch(showError),5000);
  </script>
</body>
</html>`;
