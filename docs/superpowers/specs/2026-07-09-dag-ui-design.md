# DAG Executor UI Design

## Goal

Build a localhost, one-browser-tab UI for observing what the DAG executor is doing in a selected project. The first version is read-only for executor artifacts and includes a local todo inbox where a user can describe future project work for agents.

## Decisions

- Use a dense ops-console layout rather than a timeline-first or todo-first layout.
- Start with read-only monitoring plus local inbox todos.
- Do not expose executor controls in v1.
- Store todos as inbox items first; do not automatically convert them into runnable DAG tasks.
- Launch against a project/repo path and discover recent DAG files, with a focused selected-DAG view.
- Capture executor controls and todo-to-agent conversion as follow-up todos.

## Architecture

V1 adds a local UI server to this TypeScript repo. The server starts against a project path, discovers DAG-related files under that project, parses executor artifacts, and serves a browser app in one localhost tab.

The executor remains the source of truth. The UI reads DAG JSON, event logs, derived state snapshots, and slot status. It does not start, stop, resume, rerun, reprioritize, mutate DAGs, append events, or run git commands.

The only v1 write path is the UI inbox file in the selected project:

```text
.dag-executor/ui-inbox.json
```

That file belongs to the UI, not to the executor event stream.

## Data Flow

```text
Project repo
  *.json DAG files
  *.events.jsonl logs
  *.state.json snapshots
  ~/.dag-executor/slots status
        |
        v
Local UI server
  discover DAGs
  validate DAG JSON
  parse/replay event logs
  read derived state snapshots
  expose JSON APIs
  persist UI inbox
        |
        v
One browser tab
  project overview
  selected DAG monitor
  backlog/task detail
  local todo inbox
```

## UI Surface

The UI uses an ops-console layout optimized for a local desktop browser tab.

The left sidebar shows project context, recent DAGs, inbox navigation, and slot summary. It should make read-only mode explicit.

The center workspace shows the selected DAG summary, progress, backlog board, recent events, and pause/blocker summary. The backlog board groups tasks by useful executor states such as ready, running, blocked, failed, and done. The exact grouping can be derived from current state and backlog-readiness analysis.

The right detail rail shows the selected task plus the todo inbox composer. Task detail should include description, dependencies, status, latest event, worktree path, branch, files changed, usage/cost, and error text when present.

The dashboard should fit in one browser tab without route changes. Dense panels may scroll internally for long task lists, event history, error output, and file lists. Mobile/tablet support is secondary for v1; stacking panels is acceptable, but the primary target is a desktop monitoring workflow.

## Backend Contract

V1 should provide a local web server command. The final command name can be chosen during implementation, but the behavior should be:

```text
start local HTTP server on localhost
serve static UI assets
read from a configured project path
expose JSON endpoints for dashboard data
persist inbox CRUD changes
```

Candidate command shapes:

```sh
dag-executor --ui --project=<path>
loom-ui <project>
```

The implementation plan should choose one command shape based on the existing CLI/bin conventions.

Expected endpoint capabilities:

- Project summary: selected project path, read errors, discovered DAG count, slot status.
- DAG list: discovered DAGs with status, updated time, task counts, and parse/read errors.
- DAG detail: validated DAG metadata, execution state projection, layers, task summaries, progress, pause/quota/blocker metadata, recent events.
- Task detail: task definition, state, related events, usage, files, worktree metadata, dependency/blocker context.
- Events: recent event-log entries for a DAG, with filtering by task when requested.
- Inbox: list, create, update status, and archive local inbox items.

Data derivation should reuse existing concepts and code where practical:

- Validate DAG JSON with `validateDAG`.
- Read events with the existing event-log parser.
- Prefer `.state.json` as a display cache when it is present and consistent enough for UI display.
- Fall back to replaying events when state is missing or stale.
- Use the existing slot scanner for machine-wide slot summary.
- Use backlog-readiness analysis where it helps explain ready and blocked tasks.

Malformed files should appear as per-DAG or per-project errors in the UI. A single malformed DAG or event log should not crash the whole dashboard.

## Inbox Model

The inbox stores human-authored project work requests. It is intentionally not a DAG task queue in v1.

Recommended item shape:

```json
{
  "id": "ui-todo-20260709-001",
  "createdAt": "2026-07-09T12:00:00.000Z",
  "updatedAt": "2026-07-09T12:00:00.000Z",
  "body": "Build a dashboard panel that explains quota pauses.",
  "status": "open",
  "source": "ui",
  "linkedDagPath": null,
  "linkedTaskId": null
}
```

Valid v1 statuses:

- `open`
- `converted`
- `archived`

`converted` is manual metadata in v1. The UI may let a user mark an item converted after separate agent work creates a DAG/task, but v1 does not perform the conversion.

## Error Handling

The server should show actionable read errors without mutating executor artifacts. Important cases:

- Project path does not exist or is not readable.
- No DAG files are found.
- A discovered JSON file is not a valid DAG.
- An event log contains malformed JSON or a partial trailing line.
- `.state.json` is missing, stale, or malformed.
- Inbox JSON is malformed.
- Slot status cannot be read.

For malformed inbox JSON, the server should refuse to overwrite it automatically. The UI should surface the file path and error so the user can repair or move it.

## Testing Strategy

Implementation should include focused tests for:

- Project DAG discovery.
- DAG summary projection from fixture DAG/event/state files.
- Event-log malformed-file handling.
- Fallback from missing or stale `.state.json` to event replay.
- Inbox create/update/archive persistence.
- Inbox malformed-JSON refusal.
- JSON endpoint responses.

UI verification can start lightweight:

- A render smoke test for fixture dashboard data.
- A browser-level check that the dashboard loads, shows discovered DAGs, selects a DAG, opens task detail, and creates an inbox item against a temporary project fixture.

## V1 Out Of Scope

- Starting, stopping, resuming, rerunning, or force-resetting executor tasks from the browser.
- Queue priority editing.
- Editing DAG JSON.
- Mutating `.events.jsonl` or `.state.json`.
- Running git operations.
- Automatic decomposition of inbox text into runnable DAG tasks.
- Authentication, remote deployment, or multi-user support.

## First Follow-Up Todos

These should be seeded as future product work, either in the spec follow-up section, the UI inbox once implemented, or a later planning document:

1. Add executor controls for start, stop, resume, rerun, and force worktree reset.
2. Add supervisor queue controls for priority, pause, resume, cancel, and queue status refresh.
3. Convert inbox items into DAG decomposition requests.
4. Link converted inbox items to generated DAG paths and task IDs.
5. Add richer timeline and cost analytics after the ops console is useful.

## Acceptance Criteria

- A user can start the UI for a project path and open one localhost browser tab.
- The UI discovers recent DAGs in the project and lets the user focus one DAG.
- The focused DAG view shows executor status, progress, backlog/task grouping, blockers, recent events, and selected task detail.
- The UI displays read errors without crashing the dashboard.
- A user can create, view, update, and archive local inbox items.
- V1 writes only `.dag-executor/ui-inbox.json`.
- V1 provides no browser controls that mutate executor state, DAG files, event logs, git state, or queue priority.
