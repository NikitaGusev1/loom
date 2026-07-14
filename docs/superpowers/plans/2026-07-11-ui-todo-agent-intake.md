---
date: 2026-07-11
author: Codex
status: approved
implementation_status: implemented-pending-localhost-verification
related_spec: docs/superpowers/specs/2026-07-11-ui-todo-agent-intake.md
decomposition_path:
---

# UI Todo Agent Intake Implementation Plan

## Summary

Extend the localhost DAG Executor UI with automatic todo triage and two visible execution substrates:

- Trivial/small, relevant, low-risk, high-confidence todos run sequentially through Loom's inline `/implement-plan` path and create no DAG JSON.
- Medium, large, coupled, or usefully parallel work produces a plan/decomposition proposal and uses the existing DAG supervisor only after approval.

The first usable vertical slice is sequential: inbox v2 persistence, deterministic triage policy, durable sequential checkpoints, provider subprocess progress, normalized run APIs, and a Runs UI. DAG queue extraction and submission follow after the sequential path is verified.

## Preconditions

- Work continues on branch `dag-ui-spec` in `.worktrees/dag-ui-spec`.
- The approved source is `docs/superpowers/specs/2026-07-11-ui-todo-agent-intake.md`.
- Node 22+, `npm install`, and a working `codex` or `claude` CLI are available for manual end-to-end verification.
- Automated tests must inject fake triage/provider/runner adapters and must not spend model tokens or mutate a real project.
- The localhost server remains bound to `127.0.0.1` and keeps `cache-control: no-store`.
- Existing v1 inbox files, including news-app's `.dag-executor/ui-inbox.json`, must remain readable and migrate without losing the todo ID, body, timestamps, status, or links.

## Tasks

### 1. Define Inbox V2, Triage, And Runner Contracts

- Files:
  - Modify `src/ui/types.ts`
  - Create `src/ui/intake/types.ts`
  - Modify `src/ui/types.test.ts`
  - Create `src/ui/intake/types.test.ts`
- Changes:
  - Add controlled unions for intake lifecycle, relevance, complexity, risk, proposed action, execution mode, sequential phase, run status, approval state, and recovery state.
  - Extend `UiInboxItem` with optional `intakeStatus`, `triage`, `approval`, `executionMode`, `linkedPlanPath`, `linkedRunId`, `lastError`, and execution timestamps while preserving existing DAG/task links.
  - Define schema-versioned `UiInboxFileV1` and `UiInboxFileV2`; v2 owns `items`, `jobs`, and project intake policy.
  - Define normalized `UiRunSummary` and `UiRunDetail` unions with shared fields plus sequential checkpoint/log and DAG projection variants.
  - Define interfaces for injected `TriageProvider`, `SequentialProvider`, clock/ID generation, and runner event callbacks so tests do not spawn real agents.
  - Keep persisted types JSON-only and validate finite confidence values in `[0, 1]`.
- Tests:
  - Compile representative v1/v2 inbox records and sequential/DAG run summaries.
  - Reject invalid controlled values, confidence bounds, and incomplete terminal checkpoints through runtime validators.

### 2. Migrate Inbox Persistence And Add Intake Job Storage

- Files:
  - Modify `src/ui/inbox.ts`
  - Modify `src/ui/inbox.test.ts`
  - Create `src/ui/intake/persistence.ts`
  - Create `src/ui/intake/persistence.test.ts`
- Changes:
  - Read schema v1 without mutation and migrate to v2 on the first successful write.
  - Preserve all existing fields exactly during migration; initialize intake fields and default project policy separately.
  - Add atomic helpers for item/job/policy updates using temp-file write plus rename and existing malformed-file refusal behavior.
  - Store generated plans under `.dag-executor/intake/plans/`, checkpoints under `.dag-executor/intake/runs/`, and append-only logs beside checkpoints.
  - Add compare-and-swap proposal revisions so clarification and approval cannot act on stale triage output.
  - Add job claims with owner PID, lease timestamp, attempt count, and idempotency key derived from item ID plus proposal revision.
  - Cap persisted run-log reads by bytes/lines; never load an unbounded log into API memory.
- Tests:
  - Migrate a fixture matching the current news-app v1 inbox and prove no data loss.
  - Preserve malformed JSON without overwrite.
  - Cover atomic update, stale revision rejection, duplicate idempotency key, abandoned claim recovery, and bounded log tails.

### 3. Implement Bounded Project Context And Deterministic Triage Policy

- Files:
  - Create `src/ui/intake/context.ts`
  - Create `src/ui/intake/context.test.ts`
  - Create `src/ui/intake/policy.ts`
  - Create `src/ui/intake/policy.test.ts`
  - Reuse `src/ui/discovery.ts`, `src/slots-status.ts`, and git helpers where appropriate
- Changes:
  - Collect project name/path, root guidance files, shallow file inventory, open inbox summaries, active DAG/task ownership, active sequential claims, and git cleanliness.
  - Reuse discovery ignore rules and add secret-sensitive filename exclusions; cap file counts, guidance bytes, and prompt size.
  - Represent deterministic blockers independently of model output: dirty/conflicting repository, active mutation lease, overlapping estimated files, mandatory-approval category, missing git repo, or auto-run disabled.
  - Implement the exact auto-run gate: relevant, trivial/small, low risk, confidence `>= 0.85`, no clarification, and no deterministic blocker.
  - Route medium/large/parallel work to `propose-dag`; ambiguity to clarification; unrelated work to defer/reject.
  - Ensure a one-task shape never promotes itself to DAG mode.
- Tests:
  - Cover threshold boundaries and every mandatory-approval category.
  - Verify the news-app fixture `test todo - move it to done after seeing it` cannot auto-run when triage reports ambiguity.
  - Verify ignored directories/secrets never enter context and prompt caps are deterministic.

### 4. Add Schema-Validated Asynchronous Triage

- Files:
  - Create `src/ui/intake/triage.ts`
  - Create `src/ui/intake/triage.test.ts`
  - Modify `src/codex-cli.ts`
  - Modify `src/codex-cli.test.ts`
  - Modify `src/ui/server.ts`
  - Modify `src/ui/server.test.ts`
- Changes:
  - Add an optional structured event/output callback to `runCodexCli` without changing current executor callers.
  - Build a strict triage prompt that requests JSON only and includes bounded context plus controlled value definitions.
  - Parse and validate the provider's final response; malformed or partial output becomes a persisted triage error and never executes.
  - Add an `IntakeService` owned by `createUiServer`; `POST /api/inbox` persists first, enqueues triage, and returns `201` without waiting for the provider.
  - Recover persisted unclaimed/expired triage jobs when the server starts and stop accepting new jobs during server shutdown.
  - Add retry-triage and clarification service methods with proposal revision checks.
- Tests:
  - Use a deferred fake provider to prove create returns before triage completes.
  - Cover valid classifications, invalid JSON, invalid schema, provider failure, retry, clarification, restart recovery, and duplicate-delivery suppression.
  - Verify no runner is invoked for clarification, unrelated, or blocked classifications.

### 5. Build Compact Sequential Plans And A Durable Sequential Runner

- Files:
  - Create `src/ui/intake/plan.ts`
  - Create `src/ui/intake/plan.test.ts`
  - Create `src/ui/intake/sequential-runner.ts`
  - Create `src/ui/intake/sequential-runner.test.ts`
  - Modify `src/codex-cli.ts`
  - Modify `src/claude-cli.ts`
  - Add focused adapter tests in `src/codex-cli.test.ts` and `src/claude-cli.test.ts`
- Changes:
  - Generate a compact approved Markdown plan containing source todo, project path, acceptance criteria, estimated files, repo-native verification commands, `execution_mode: sequential`, and no decomposition path.
  - Add provider-neutral sequential launch options; use argument arrays and stdin, never a shell command or todo interpolation.
  - For Codex, launch a headless prompt that explicitly invokes `loom:auto-implement <plan> --no-dag --inline --mode autonomous`; provide the equivalent installed Loom skill name for Claude.
  - Extend provider adapters with redacted progress callbacks while preserving existing usage/trace behavior.
  - Persist checkpoint transitions before side effects, append redacted logs, capture child PID/process group, and terminate with SIGTERM then SIGKILL after the existing grace pattern.
  - Enforce one project mutation lease and FIFO queueing for sequential runs.
  - Record base commit, terminal commit, changed files, verification summary, review outcome, usage, and error.
  - On restart, mark a missing child as `recovery-required`; inspect git status/base commit and never auto-relaunch when project state changed.
- Tests:
  - Assert generated plans contain no DAG/decomposition reference.
  - Use a fake child adapter to cover phase transitions, FIFO lease behavior, cancellation, forced kill, log redaction, provider failure, clean recovery, and dirty crash recovery.
  - Verify exactly-once execution per item proposal revision.

### 6. Add Intake, Approval, Cancellation, And Sequential Run APIs

- Files:
  - Modify `src/ui/server.ts`
  - Modify `src/ui/server.test.ts`
  - Create `src/ui/intake/service.ts`
  - Create `src/ui/intake/service.test.ts`
  - Create `src/ui/intake/projection.ts`
  - Create `src/ui/intake/projection.test.ts`
- Changes:
  - Orchestrate persistence, triage, deterministic policy, plan generation, and sequential queueing in one service boundary.
  - Add endpoints for triage retry, clarification, exact-revision approval, cancel, intake status/policy, run list, and run detail.
  - Normalize sequential checkpoints and existing discovered DAGs into `UiRunSummary`; include origin inbox links when present.
  - Return bounded recent logs for sequential detail and existing event/task projections for DAG detail.
  - Validate IDs, statuses, revisions, policy thresholds, and request bodies; use structured 400/404/409/500 errors with appropriate scope.
  - Abort active intake work and close child processes when the HTTP server closes.
- Tests:
  - Cover all endpoint success/error cases, stale approval `409`, cancel semantics by state, policy updates, normalized mixed run lists, bounded logs, and graceful server shutdown.

### 7. Implement Inbox Triage And Unified Runs UI

- Files:
  - Modify `src/ui/assets.ts`
  - Modify `src/ui/server.test.ts`
- Changes:
  - Add `Inbox` and `Runs` navigation with status counts while preserving the one-tab desktop console.
  - Expand inbox rows with triage status, rationale, complexity/risk/confidence, clarification questions, approval preview, and execution-mode label.
  - Add clarification response, exact-revision approval, retry-triage, cancel, and project auto-run controls with disabled/loading/error states.
  - Add a Runs list for normalized sequential and DAG entries.
  - Render sequential phase track `Triage -> Plan -> Implement -> Verify -> Review -> Done`, queue/lease reason, elapsed time, provider health, changed files, verification, review, commit, recovery state, and bounded redacted logs.
  - Keep the existing backlog/task/event view for DAG runs and add navigation to/from the originating inbox item.
  - Preserve the selected run during five-second polling; do not auto-scroll logs when the user has scrolled away from the bottom.
  - Maintain the 16px base typography, stable panel dimensions, internal scrolling, keyboard focus styles, and no overlapping controls at desktop/tablet widths.
- Tests:
  - Extend static HTML assertions for Runs/Inbox controls and sequential phase labels.
  - Add pure render/state helper tests if helpers are extracted from the HTML asset.
  - Add a browser smoke fixture when Playwright becomes available; otherwise manually verify create, clarify, approve, run selection, polling, cancel, and DAG selection against a temporary project.

### 8. Extract Typed Supervisor Queue Operations And Route DAG Work

- Files:
  - Create `src/supervisor-queue.ts`
  - Create `src/supervisor-queue.test.ts`
  - Modify `scripts/loom-supervisor.cjs`
  - Modify `scripts/loom-supervisor-smoke.sh`
  - Modify `src/ui/intake/service.ts`
  - Modify `src/ui/intake/projection.ts`
  - Modify related intake tests
- Changes:
  - Extract queue schema validation, atomic persistence, locking, add/status/pause/resume/cancel/priority, stale-running recovery, and claim ordering into an importable typed module.
  - Keep `loom-supervisor` CLI output and queue file schema backward-compatible; have the CJS entry point call the shared implementation rather than maintaining a duplicate queue writer.
  - Generate plan/decomposition proposals for `propose-dag` items through an injected planner adapter; validate decompositions before queue insertion.
  - Require exact-revision approval before adding medium/large work to the supervisor queue.
  - Persist inbox plan/DAG links before queue submission and reconcile partial failures idempotently.
  - Project supervisor queue status and DAG events into the normalized Runs UI.
  - Do not add browser start/resume/rerun/priority controls beyond approval and cancellation included by this spec.
- Tests:
  - Preserve all existing supervisor smoke scenarios.
  - Add typed queue unit tests and integration coverage for proposal, approval, queue insertion, duplicate reconciliation, cancellation, and normalized run projection.

### 9. Harden Recovery, Security, Documentation, And End-To-End Behavior

- Files:
  - Modify `README.md`
  - Modify intake/runner/API/UI tests from prior tasks
  - Add fixtures under `src/ui/intake/__fixtures__/` as needed
- Changes:
  - Document intake policy, sequential versus DAG routing, generated local files, provider requirements, mutation lease, recovery behavior, cancellation, and how to disable auto-run.
  - Add centralized redaction patterns for API keys, bearer tokens, common provider environment names, and secret-looking command output; redact before disk writes.
  - Add size limits for todo/request bodies, context, provider output, logs, and retained run history.
  - Ensure generated files stay under `.dag-executor/intake` and paths cannot escape the selected project.
  - Verify shutdown does not orphan children and restart does not duplicate work.
  - Exercise news-app migration and ambiguity behavior with copied temporary fixtures, never by mutating the real repository in automated tests.
- Tests:
  - Full unit/integration suite, typecheck, formatter check on touched files, supervisor smoke, and local browser smoke.
  - Manual provider smoke with auto-run disabled first, then one explicitly approved harmless sequential fixture in a temporary git repository.

## Verification

Run after each task with the narrowest relevant test pattern, then complete with:

```sh
npm test
npm run lintTypes
npx prettier --check src README.md
npm run smoke:loom
git diff --check
```

Final local UI smoke:

```sh
npm run build
node build/index.js --ui --project=/path/to/temporary-fixture --port=0
```

Verify in one browser tab:

1. A v1 inbox migrates without data loss.
2. An ambiguous todo enters `Needs clarification` and starts no runner.
3. A qualifying easy todo creates a sequential plan, no DAG JSON, and appears in Runs.
4. The sequential phase track, bounded logs, changed files, verification, review, cancellation, and terminal result update on polling.
5. A second sequential todo waits for the project lease.
6. A crashed dirty run enters recovery-required and does not restart.
7. Medium work presents a DAG proposal, waits for approval, then enters the existing supervisor queue once.
8. Existing DAG discovery/backlog/task monitoring still works.

## Rollback

- Keep v1 inbox reading for at least one release so code rollback can still inspect original records.
- V2 migration writes only after a successful parse and keeps all v1 fields; malformed files remain untouched.
- Sequential plans, checkpoints, and logs are additive under `.dag-executor/intake` and can be ignored by the current executor.
- Disable intake globally through project policy to return the UI to passive inbox behavior without deleting records.
- If typed queue extraction regresses supervisor behavior, stop before Task 8 and ship the sequential runner/UI independently; do not retain dual queue writers.
- Never automatically clean or reset a project after a crashed sequential run.

## Open Questions

- Which provider should be the default for triage: account-default Codex, Claude Haiku, or a project setting? The implementation must keep this injectable; default selection can be made during Task 4 from existing CLI availability.
- Should sequential execution use the project's current branch directly or create a dedicated worktree? The approved spec requires project mutation safety but does not mandate worktrees for sequential mode. Recommended first implementation: require a clean project and run in the selected project, matching current inline `/implement-plan`, while recording base/terminal commits.
- Native supervised sequential support may land in Loom later. Keep checkpoint/run contracts provider-neutral so the custom wrapper can be replaced without changing the UI API.
