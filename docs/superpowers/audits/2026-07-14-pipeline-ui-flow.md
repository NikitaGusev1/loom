# Loom Pipeline/UI Flow Audit

Date: 2026-07-14

## Cohesive paths

- Todo clarification is persisted as a revisioned transcript and the UI opens a focused chat dialog for each unanswered Loom question.
- Narrow sequential work uses an explicit `--no-dag --inline` contract, so it cannot accidentally enter automatic mode selection.
- DAG proposals invoke `loom:decompose`, validate the returned project-local DAG, and require approval before enqueueing execution.
- Automatic orchestration now ensures a valid linked decomposition before selecting mode or execution substrate. Direct supervised launch applies the same preflight before checkpoint creation.
- Completed DAG execution creates or reuses a pull request by default and records the result in the Loom supervisor checkpoint.

## Follow-up gaps

### P1 — DAG inbox lifecycle is not reconciled

`IntakeService.reconcile()` only follows `linkedRunId`, which exists for sequential runs. An approved DAG todo is set to `queued`, but its inbox status is never advanced from the supervisor queue/checkpoint to `running`, `completed`, `pr-failed`, or `failed`.

Follow-up: persist the queue item/run checkpoint identity on the inbox item and reconcile DAG status with the same terminal timestamps and error fields used by sequential runs.

### P1 — Pull-request outcome is invisible in the UI

The supervisor records `pullRequest.status`, `url`, and failures in `.loom-supervisor` checkpoints. The UI run projection discovers DAG event/state files only, so Runs cannot show `creating-pr`, `pr-failed`, or a clickable PR URL.

Follow-up: project the supervisor checkpoint into `UiDagRunSummary`/detail and render PR status, URL, and retry guidance.

### P1 — Approval lacks proposal context

The todo card and chat action expose an Approve button, but do not show the proposed plan path, DAG task count, decomposition rationale, or affected files. Approval is therefore technically gated but poorly informed.

Follow-up: add a concise proposal preview in the conversation: mode, task count, affected areas, risk rationale, and expandable agent detail.

### P2 — Planning has no distinct observable state

While a DAG proposal is being built, the item reuses `triaging`. Users cannot distinguish “Loom is understanding the request” from “Loom is creating the plan and decomposition,” and planner progress/errors are not streamed.

Follow-up: add `planning` status and a compact activity message; keep verbose planner output in expandable agent detail.

### P2 — DAG cancellation matches by path

Cancellation finds the first supervisor queue entry whose `dagPath` matches. Repeated or resumed submissions of the same artifact can target the wrong queue item.

Follow-up: persist the supervisor queue item ID when enqueueing and cancel by stable identity.

## Recommended next slice

Implement one end-to-end DAG run projection: persist queue identity, reconcile inbox status, read PR checkpoint fields, and render a proposal/run card with a PR link. This closes the largest interaction gap without changing execution semantics.
