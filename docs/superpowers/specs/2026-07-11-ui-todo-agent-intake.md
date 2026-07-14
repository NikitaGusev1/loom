---
date: 2026-07-11
author: Codex
status: approved
related_research: []
---

# UI Todo Agent Intake

## Goal

Turn project-local UI todos into a controlled agent intake pipeline. Saving a todo should immediately start triage. Small, clearly relevant, high-confidence requests may execute automatically; ambiguous, broad, risky, or unrelated requests must wait for clarification or approval.

Every executable todo becomes a tracked Loom run so its progress, verification, and outcome remain visible in the existing localhost UI. Easy work runs sequentially and must not create a DAG. Work that benefits from decomposition or parallelism uses the existing DAG executor.

## Non-Goals

- Executing arbitrary todo text directly in the UI server process.
- Bypassing Loom review and verification gates, worktree safety, or the selected execution substrate's checkpointing.
- Automatically approving destructive operations, external side effects, secret handling, or work in a dirty/conflicting repository.
- Treating an LLM classification as a security boundary.
- Supporting remote or multi-user intake.

## Current System

The UI stores inbox items in `<project>/.dag-executor/ui-inbox.json`. Items have `open`, `converted`, or `archived` status and optional DAG/task links. The UI server is otherwise read-only for executor state.

Loom already supports sequential implementation through inline `/auto-implement --no-dag`, which routes to `/implement-plan`. The headless supervisor is currently DAG-only and parks when mode selection resolves to sequential. Intake therefore needs a durable sequential-run wrapper around the existing inline Loom capability; it must not model easy work as a one-task DAG.

The DAG executor remains the substrate for larger or parallel work. Intake composes both existing Loom paths rather than creating another implementation engine.

The news-app inbox currently contains this useful ambiguity fixture:

```text
test todo - move it to done after seeing it
```

Because "it" has no reliable referent and the requested repository change is unclear, triage must request clarification and must not execute it automatically.

## Proposed Design

### Lifecycle

```text
saved
  -> triaging
  -> awaiting-clarification | awaiting-approval | queued
  -> running
  -> completed | failed | blocked | cancelled
```

Archiving remains an orthogonal user action. A completed execution does not automatically delete its intake record.

Saving a todo enqueues an asynchronous triage job and returns immediately. The HTTP request must not wait for a model call or agent process. Triage state is persisted before work starts so a server restart can recover incomplete intake.

### Triage Result

Each inbox item gains an optional structured `triage` record:

```json
{
  "version": 1,
  "status": "complete",
  "relevance": "relevant",
  "complexity": "small",
  "risk": "low",
  "confidence": 0.92,
  "summary": "Add an empty-state message to the digest screen.",
  "rationale": "The request names an existing project surface and has a narrow outcome.",
  "needsClarification": false,
  "questions": [],
  "estimatedFiles": ["app/screens/DigestScreen.tsx"],
  "proposedAction": "execute-sequential",
  "evaluatedAt": "2026-07-11T14:00:00.000Z"
}
```

Controlled values:

- `relevance`: `relevant | adjacent | unrelated | unknown`
- `complexity`: `trivial | small | medium | large | unknown`
- `risk`: `low | elevated | high`
- `proposedAction`: `execute-sequential | propose-dag | clarify | defer | reject`

The triage response must be schema-validated. Invalid model output becomes a visible triage error and never defaults to execution.

### Context Used For Triage

Triage receives bounded, read-only project context:

- Project path and repository name.
- Root guidance files such as `AGENTS.md`, `CLAUDE.md`, and `README.md`.
- A shallow file inventory excluding dependencies, build output, git metadata, worktrees, caches, and secrets.
- Current DAG titles, statuses, task names, and files claimed by running tasks.
- Existing open inbox items to identify duplicates or contradictions.
- Git cleanliness and active executor/supervisor state from deterministic local checks.

File contents are not loaded wholesale. A later planning step may inspect relevant files after triage identifies a plausible scope.

### Deterministic Execution Gate

The model proposes an action, but application code owns the final gate. Automatic execution is allowed only when all conditions are true:

- Relevance is `relevant`.
- Complexity is `trivial` or `small`.
- Risk is `low`.
- Confidence is at least `0.85`.
- `needsClarification` is false.
- The project is a readable git repository with an acceptable clean-state policy.
- No active sequential or DAG run claims overlapping files.
- The request does not match a mandatory-approval category.

Mandatory-approval categories include destructive changes, migrations, authentication/authorization, secrets, dependency installation, network publishing, paid/external services, broad refactors, executor configuration changes, and ambiguous acceptance criteria.

Failure of any gate routes the item to `awaiting-clarification`, `awaiting-approval`, or `deferred`; it never silently executes.

### Execution Substrate Selection

Triage proposes a substrate and deterministic application policy verifies it:

| Work shape | Substrate | Artifact |
| --- | --- | --- |
| Trivial/small, narrow, sequential | Inline Loom `/implement-plan` | Compact approved plan and sequential run checkpoint |
| Medium, coupled, or approval-worthy | Proposed DAG | Plan and decomposition awaiting approval |
| Large or usefully parallel | DAG executor/supervisor | Plan, validated decomposition, events, and state |
| Ambiguous, risky, or unrelated | No execution | Clarification, approval, defer, or reject state |

One task is not a reason to create a DAG. DAG mode is selected only when decomposition, dependency modeling, isolated parallel work, or useful concurrency justifies it.

### Sequential Runner

For approved trivial/small work:

1. Generate a compact approved plan at `<project>/.dag-executor/intake/<inbox-id>.plan.md`. It contains the request, acceptance criteria, likely files, verification commands, and `execution_mode: sequential`, but no `decomposition_path`.
2. Persist `linkedPlanPath` and a unique proposal revision before execution.
3. Create `<project>/.dag-executor/intake/runs/<run-id>.json` plus an append-only log.
4. Launch a headless provider session through a typed process adapter. It invokes Loom's inline sequential path, equivalent to `/auto-implement <plan> --no-dag --inline --mode autonomous`.
5. Persist coarse phases: `starting`, `implementing`, `verifying`, `reviewing`, and terminal status.
6. Store resulting commits, changed files, verification summary, and review outcome.

Only one sequential runner per project may hold the mutation lease. Additional eligible todos remain queued in creation order. The wrapper owns subprocess lifecycle, cancellation, checkpoint recovery, and log capture until Loom supports native supervised sequential execution. Loom remains responsible for editing, tests, formatting, and review.

### DAG Runner

Medium work produces a proposed multi-task DAG and waits for explicit approval. Large or usefully parallel work follows the existing validated decomposition and supervisor queue path. The inbox links to the plan and DAG and derives detailed progress from normal executor events and state.

The UI server invokes narrow typed services. Process arguments are passed as an argument array; todo text never becomes shell syntax.

### Persistence

Extend the inbox schema to version 2 while preserving version-1 migration:

```json
{
  "schemaVersion": 2,
  "items": [],
  "jobs": []
}
```

An item gains:

- `intakeStatus`
- `triage`
- `approval`
- `executionMode`
- `linkedPlanPath`
- `linkedDagPath`
- `linkedTaskId`
- `linkedRunId`
- `lastError`
- `executionStartedAt`
- `executionCompletedAt`

Jobs record claim/lease information so restarts can retry abandoned `triaging` jobs without executing one item twice. All updates use the existing atomic temp-file-and-rename pattern.

### UI Changes

Each todo displays a compact state and its most important reason:

- `Triaging`
- `Needs clarification`
- `Approval required`
- `Queued`
- `Running`
- `Completed`
- `Blocked` or `Failed`

Clarification items show generated questions and a response field. Approval items show scope, complexity, risk, likely files, and either a sequential plan preview or DAG preview before an explicit Approve action.

### Runner Monitoring

The main monitoring surface treats sequential and DAG execution as two runner kinds under one `Runs` view. The existing DAG sidebar remains, but the default project navigation gains `Inbox` and `Runs` tabs with counts.

The Runs list shows:

- Todo summary and runner kind: `Sequential` or `DAG`.
- Queue position, current phase, status, start time, and elapsed time.
- Provider/model and process or supervisor health.
- Changed-file count, verification result, review verdict, and resulting commit when available.
- A clear `Waiting for project lease` reason when another sequential runner owns mutation access.

Selecting a sequential run replaces the backlog board with a phase track:

```text
Triage -> Plan -> Implement -> Verify -> Review -> Done
```

The detail area shows bounded live log output, proposed/changed files, current command category, last checkpoint, verification failures, review findings, and crash-recovery state. Logs auto-scroll only while the user is already at the bottom. Secrets and provider credentials must be redacted before persistence and display.

Selecting a DAG run uses the existing backlog, task inspector, event stream, and progress UI. The shared header still shows the originating todo and provides navigation back to its inbox record.

Runner controls are state-aware:

- `Cancel` for queued or running sequential work.
- `Approve` or `Answer questions` at intake gates.
- `Inspect dirty state` after a crash.
- `Retry` only after deterministic recovery checks pass.
- DAG controls remain delegated to the supervisor-control follow-up.

The UI polls runner checkpoints with the existing five-second refresh initially. Streaming can be added later; it is not required for the first runner view.

The composer includes an `Auto-run eligible work` toggle, enabled by default at the project level. Turning it off still performs triage but routes all executable work to approval.

### API

Add these local endpoints:

- `POST /api/inbox/:id/triage` retries triage.
- `POST /api/inbox/:id/clarify` appends a user response and re-triages.
- `POST /api/inbox/:id/approve` approves the exact persisted proposal revision.
- `POST /api/inbox/:id/cancel` cancels pending intake, terminates a sequential child session, or requests supervisor cancellation for DAG work.
- `GET /api/intake/runs` lists sequential and DAG runs in a normalized summary shape.
- `GET /api/intake/runs/:id` returns a run checkpoint and bounded recent logs/events.
- `GET /api/intake/status` returns worker health and project policy.
- `PATCH /api/intake/policy` updates local auto-run eligibility and thresholds.

Creating an inbox item triggers triage automatically. Mutating endpoints reject stale proposal revisions to prevent approval of a changed plan.

## Alternatives Considered

### Execute Every Todo Immediately

Rejected. Ambiguous language, unrelated requests, and high-risk changes would cross into repository mutation without a meaningful control point.

### Require Approval For Every Todo

Safe but too slow for narrow chores. It defeats the desired inbox-to-agent immediacy while adding little value for obvious low-risk work.

### Let The Triage Model Decide Autonomy Directly

Rejected. Model output informs the decision, but deterministic application policy must enforce thresholds and mandatory-approval categories.

## Acceptance Criteria

- Saving a todo persists it before asynchronous triage starts.
- Triage produces schema-validated relevance, complexity, risk, confidence, rationale, questions, estimated scope, and a proposed action.
- Only low-risk, relevant, trivial/small, high-confidence work can auto-run sequentially.
- Ambiguous todos, including the news-app ambiguity fixture, request clarification and launch no executor process.
- Medium work shows a DAG proposal and waits for explicit approval.
- Mandatory-approval categories cannot auto-run regardless of model confidence.
- Easy work creates no DAG JSON and runs through Loom's sequential `/implement-plan` path.
- Sequential work has a durable checkpoint and redacted log, runs one-at-a-time per project, and exposes implementation, verification, and review progress.
- DAG execution uses validated decompositions and existing supervisor/executor pathways.
- Inbox records link to sequential runs or generated DAGs and reflect queued/running/completed/failed state after restarts.
- Duplicate delivery or server restart cannot execute the same proposal twice.
- A crashed sequential run with a dirty repository never auto-restarts without review.
- Disabling project auto-run still triages todos but requires approval for all execution.
- The Runs view lists both runner kinds and shows sequential phases, logs, files, verification, review, cancellation, and recovery state.
- UI tests cover create-to-triage, clarification, approval, sequential auto-run, DAG routing, runner monitoring, cancellation, rejection, restart recovery, and stale-proposal handling.

## Risks And Open Questions

- The exact model/provider used for cheap triage should be configurable and independently testable with fixtures.
- Git cleanliness may need a project policy that distinguishes known UI-inbox writes from unrelated changes.
- File-overlap detection is advisory until task ownership contracts are comprehensive.
- Supervisor queue APIs currently exist primarily as CLI/file operations; implementation should expose a typed internal module before wiring HTTP handlers.
- Cancellation semantics differ before queueing, while queued, and while an agent is running and must be represented explicitly.
- A process crash may leave uncommitted project changes. Recovery must inspect git state and require approval rather than blindly relaunching.
- The sequential wrapper temporarily duplicates lifecycle capabilities from the DAG-only supervisor and should be replaceable by native Loom supervised-sequential support later.

## Implementation Notes

- Extend `src/ui/types.ts` and `src/ui/inbox.ts` with a backward-compatible schema migration and strict runtime validation.
- Add a dedicated `src/ui/intake/` boundary for context collection, triage schemas, deterministic policy, job recovery, execution-mode selection, and run projection.
- Add a typed sequential runner that atomically checkpoints, appends redacted logs, owns a per-project mutation lease, launches the provider CLI without a shell, and handles cancellation.
- Generate compact approved plan files for sequential work; never generate one-task decompositions.
- Keep model/provider invocation outside HTTP request handlers.
- Reuse DAG validation before writing or queueing generated decompositions.
- Refactor supervisor queue operations into importable typed functions instead of parsing CLI output.
- Project status from linked sequential checkpoints or DAG artifacts rather than duplicating detailed run state in the inbox file.
- Preserve localhost-only binding and the existing no-store response policy.
