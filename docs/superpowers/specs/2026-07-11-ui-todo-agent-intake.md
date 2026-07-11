---
date: 2026-07-11
author: Codex
status: approved
related_research: []
---

# UI Todo Agent Intake

## Goal

Turn project-local UI todos into a controlled agent intake pipeline. Saving a todo should immediately start triage. Small, clearly relevant, high-confidence requests may execute automatically; ambiguous, broad, risky, or unrelated requests must wait for clarification or approval.

Every executable todo becomes a tracked DAG so its progress, events, verification, and outcome remain visible in the existing localhost UI.

## Non-Goals

- Executing arbitrary todo text directly in the UI server process.
- Bypassing DAG validation, worktree isolation, executor verification, or the supervisor queue.
- Automatically approving destructive operations, external side effects, secret handling, or work in a dirty/conflicting repository.
- Treating an LLM classification as a security boundary.
- Supporting remote or multi-user intake.

## Current System

The UI stores inbox items in `<project>/.dag-executor/ui-inbox.json`. Items have `open`, `converted`, or `archived` status and optional DAG/task links. The UI server is otherwise read-only for executor state.

The executor already provides the required execution substrate: validated DAG JSON, worktree isolation, event logs, state projection, verification, machine-wide slots, and supervisor queueing. Intake should compose these mechanisms rather than create a second task runner.

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
  "proposedAction": "execute-single-task",
  "evaluatedAt": "2026-07-11T14:00:00.000Z"
}
```

Controlled values:

- `relevance`: `relevant | adjacent | unrelated | unknown`
- `complexity`: `trivial | small | medium | large | unknown`
- `risk`: `low | elevated | high`
- `proposedAction`: `execute-single-task | propose-dag | clarify | defer | reject`

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
- No active DAG claims overlapping files.
- The request does not match a mandatory-approval category.

Mandatory-approval categories include destructive changes, migrations, authentication/authorization, secrets, dependency installation, network publishing, paid/external services, broad refactors, executor configuration changes, and ambiguous acceptance criteria.

Failure of any gate routes the item to `awaiting-clarification`, `awaiting-approval`, or `deferred`; it never silently executes.

### Conversion And Execution

For approved trivial/small work:

1. Generate a one-task decomposition using the existing DAG schema.
2. Write it under `<project>/.dag-executor/intake/<inbox-id>.json` using an atomic write.
3. Persist `linkedDagPath` before starting execution.
4. Submit the DAG through the existing supervisor queue with a normal priority and standard verification.
5. Mark the item `queued`, then derive `running`, `completed`, `failed`, or `blocked` from executor artifacts.

Medium work produces a proposed multi-task DAG and waits for explicit approval. Large work produces a planning summary and questions rather than a DAG that appears ready to run.

The UI server should invoke a narrow intake service API, not shell-concatenate commands. Process arguments must be passed as an argument array. Todo text must never become shell syntax.

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
- `linkedDagPath`
- `linkedTaskId`
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

Clarification items show the generated questions and a response field. Approval items show the proposed scope, complexity, risk, likely files, and DAG preview before an explicit Approve action. Executing items link to the selected DAG/task in the monitoring surface.

The composer includes an `Auto-run eligible work` toggle, enabled by default at the project level. Turning it off still performs triage but routes all executable work to approval.

### API

Add these local endpoints:

- `POST /api/inbox/:id/triage` retries triage.
- `POST /api/inbox/:id/clarify` appends a user response and re-triages.
- `POST /api/inbox/:id/approve` approves the exact persisted proposal revision.
- `POST /api/inbox/:id/cancel` cancels pending intake or requests supervisor cancellation for queued work.
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
- Only low-risk, relevant, trivial/small, high-confidence work can auto-run.
- Ambiguous todos, including the news-app ambiguity fixture, request clarification and launch no executor process.
- Medium work shows a DAG proposal and waits for explicit approval.
- Mandatory-approval categories cannot auto-run regardless of model confidence.
- Every execution uses a validated DAG, existing supervisor/executor pathways, worktree isolation, and verification.
- Inbox records link to generated DAGs and reflect queued/running/completed/failed state after restarts.
- Duplicate delivery or server restart cannot execute the same proposal twice.
- Disabling project auto-run still triages todos but requires approval for all execution.
- UI tests cover create-to-triage, clarification, approval, auto-run, rejection, restart recovery, and stale-proposal handling.

## Risks And Open Questions

- The exact model/provider used for cheap triage should be configurable and independently testable with fixtures.
- Git cleanliness may need a project policy that distinguishes known UI-inbox writes from unrelated changes.
- File-overlap detection is advisory until task ownership contracts are comprehensive.
- Supervisor queue APIs currently exist primarily as CLI/file operations; implementation should expose a typed internal module before wiring HTTP handlers.
- Cancellation semantics differ before queueing, while queued, and while an agent is running and must be represented explicitly.

## Implementation Notes

- Extend `src/ui/types.ts` and `src/ui/inbox.ts` with a backward-compatible schema migration and strict runtime validation.
- Add a dedicated `src/ui/intake/` boundary for context collection, triage schemas, deterministic policy, job recovery, DAG conversion, and supervisor submission.
- Keep model/provider invocation outside HTTP request handlers.
- Reuse DAG validation before writing or queueing generated decompositions.
- Refactor supervisor queue operations into importable typed functions instead of parsing CLI output.
- Add event/status projection from linked DAGs rather than duplicating executor state in the inbox file.
- Preserve localhost-only binding and the existing no-store response policy.
