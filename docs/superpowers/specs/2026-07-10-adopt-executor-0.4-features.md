# Adopt Executor 0.4 Feature Set

## Context

The newer executor source is available at:

- `/Users/nikita/Downloads/dag-executor-main (1).zip`
- unpacked for inspection at `/tmp/dag-executor-new/dag-executor-main`

That archive reports `package.json` version `0.4.0`. This workspace reports `0.3.0`, but it also contains local work that is not present in the archive: Codex provider support, `--backlog`, quota pause metadata, DAG readiness checks, project memory injection, Loom supervisor commands, and Codex plugin packaging.

Do not replace this repository wholesale with the archive. Treat the archive as an upstream feature source and port the useful executor/plugin capabilities into the local branch while preserving local-only features.

## Goals

Adopt the upstream 0.4 capabilities that this workspace does not have:

1. Ready-work scheduling for the main executor.
2. Serialized eager landing through a writer lane.
3. Per-edge input-contract verification at unblock time.
4. Event-log analytics through `--metrics`.
5. Finished-run HTML diff viewer through `--diff-view`.
6. Machine-wide finished-run telemetry corpus.
7. Additive event fields that support metrics and diff viewing.
8. Run-wide DAG `meta.projectContext` prompt carrier.
9. Shipped `/cleanup` skill and updated autonomous review/decompose workflow docs.
10. Source-routed contract validation rule: each input source must be a declared dependency.
11. Usage arithmetic centralization in `src/usage.ts`.
12. Executor dependency-injection seam for loop tests.

Preserve local features:

1. `--provider=codex|claude`, Codex CLI execution, and provider-specific model mapping.
2. `--backlog` execution mode and backlog pause metadata.
3. Quota classification and `dag.paused.quota`.
4. `--dag-readiness` default preflight and `--skip-dag-readiness`.
5. `--memory` / `--no-memory` curated project memory injection.
6. Loom supervisor binaries/scripts and Codex plugin files.
7. Current descriptive commit-message support.

## Non-Goals

- Do not remove `src/backlog-executor.ts` or make backlog mode an alias for upstream ready-work scheduling.
- Do not drop `src/codex-cli.ts`.
- Do not remove local Loom supervisor scripts or package `bin` entries.
- Do not adopt archive model defaults blindly; reconcile with the provider model map already in `src/index.ts`.
- Do not remove project memory in favor of `meta.projectContext`; both solve different problems and should compose.

## Feature Delta

### Ready-Work Main Executor

Archive source:

- `src/executor.ts`
- `src/scheduler/ready.ts`
- `src/scheduler/writer-lane.ts`
- `src/executor/deps.ts`
- `src/executor.ready.test.ts`
- `src/scheduler/ready.test.ts`
- `src/scheduler/writer-lane.test.ts`

Current state:

- Main `src/executor.ts` is still a strict layer loop.
- `--backlog` is the only local mode that behaves like a persistent dependency-ready backlog.

Required behavior:

- Main layered mode should start a task as soon as all dependencies are complete.
- Successful producers merge eagerly before consumers are considered ready.
- Layers remain as Tier-2 verification checkpoints, not start barriers.
- Landing must be serialized: base-unchanged check, merge, read new base HEAD, and update `baseCommitSha` happen as one lane operation.
- Permanent failures should not immediately stop independent work; pause after no runnable work remains or a layer checkpoint determines the run cannot advance.
- Resume must reset crashed in-flight tasks and re-attempt transiently failed runnable tasks according to the retry policy.

Local integration constraints:

- Keep provider-aware execution from `src/executor/session.ts`.
- Keep project memory passed into prompt building.
- Keep quota decisions in retry policy and pause metadata.
- Decide whether trivial batching remains only in classic layered code or is removed from main mode. The archive removes `src/executor/trivial-batch.ts`; this repo still uses it. If adopting ready-work for main mode, prefer running trivial tasks as normal worktree tasks in that mode, and leave batching only if a compatibility path remains.

### Contract Routing And Validation

Archive source:

- `src/contracts.ts`
- `src/validation.ts`
- `src/contracts.test.ts`
- `src/validation.test.ts`

Current state:

- Current validation does not enforce every input `source` as a declared dependency.

Required behavior:

- Reject DAGs where `task.contracts.inputs[*].source` is not a known task.
- Reject DAGs where an input source is a known task but is not listed in that task's `dependencies`.
- Verify consumer inputs strictly through the declared source producer's like-named output.
- Keep this as a minor-version breaking behavior in docs/changelog.

### Metrics

Archive source:

- `src/metrics.ts`
- `src/metrics.test.ts`
- CLI wiring in `src/index.ts`

Required CLI:

```sh
dag-executor --metrics <run.events.jsonl> [more.events.jsonl ...] [--human]
```

Required output:

- JSON by default.
- Human table when `--human` is present.
- Per-run task token/cost/work-time metrics.
- Per-layer barrier gap and parallel efficiency.
- Context footprint by model context window.
- Pause cause, resume count, contract-break rate.
- Aggregate across multiple logs.
- Weight rollups when sibling DAG JSON is available; degrade to `unknown` otherwise.

Local integration constraints:

- Extend pause-cause support to include local quota pauses. Either add `quota` to `DagPauseCause` or let metrics derive quota from `dag.paused.quota`; prefer adding a typed `quota` cause if it does not break compatibility.
- Keep existing `blockedTasks` and `quota` event fields.

### Diff View

Archive source:

- `src/diff-view.ts`
- `src/diff-view.test.ts`
- CLI wiring in `src/index.ts`

Required CLI:

```sh
dag-executor --diff-view <decomposition.json> [--no-open]
```

Required behavior:

- Read the DAG's sibling `.events.jsonl`.
- Write `<decomposition>.diff.html`.
- Include aggregate and per-task views.
- Render a side-by-side split diff with light/dark theme toggle.
- Annotate per-task sections with name, weight, dependencies, inputs, outputs, and changed-file count.
- Open the file unless `--no-open` is passed.
- Degrade gracefully to changed-file lists when SHA fields are missing or git diff fails.

Supporting event changes:

- Add `dag.started.baseStartSha`.
- Add `worktree.merged.baseShaBefore`.
- Add `worktree.merged.baseShaAfter`.
- Emit `worktree.merged` after the merge site knows the post-merge SHA.

Local integration constraints:

- Browser opening may require OS command execution; keep the implementation best-effort and non-fatal.
- In this Codex environment, tests should use `--no-open` and assert file output, not attempt to launch a browser.

### Corpus Archive

Archive source:

- `src/corpus.ts`
- `src/corpus.test.ts`
- CLI post-run wiring in `src/index.ts`

Required behavior:

- After a run finishes or pauses, best-effort copy the event log and sibling DAG into `~/.dag-executor/corpus`.
- Respect `DAG_EXECUTOR_CORPUS_DIR`.
- Respect `DAG_EXECUTOR_NO_CORPUS=1`.
- Never fail the executor because archiving failed.
- Avoid self-copy when the DAG already lives in the corpus directory.

Local integration constraints:

- Archive both layered and backlog runs.
- Preserve quota/backlog event fields in archived logs.

### Project Context Carrier

Archive source:

- `src/types.ts`
- `src/validation.ts`
- `src/prompt.ts`
- `agents/task-decomposer.md`
- `skills/decompose/SKILL.md`

Required schema:

- Optional `meta.projectContext.sharedComponents`.
- Optional `meta.projectContext.conventions`.
- Optional `meta.projectContext.figmaToolset`.
- Optional `meta.projectContext.themeTokensDoc`.
- Optional `meta.reviewVerdict` for DAG review flow.

Required prompt behavior:

- Inline conventions for all tasks.
- Inline shared components and design token document pointer only for UI tasks.
- Use `figmaToolset` instead of hardcoded tool names when present.
- Absent `projectContext` must preserve current generic prompt behavior.

Local integration constraints:

- Compose with existing curated project memory:
  - `projectContext` is DAG-authored, task-relevant run context.
  - `.dag-executor/memory.md` is operator-authored persistent memory.
  - Both may appear in prompts. Keep them in separate prompt sections.

### Cleanup Skill And Review Fan-Out

Archive source:

- `skills/cleanup/SKILL.md`
- `skills/auto-implement/SKILL.md`
- `skills/auto-run/SKILL.md`
- `skills/auto-step/SKILL.md`
- `skills/code-review/SKILL.md`
- `skills/decompose/SKILL.md`
- `skills/explore/SKILL.md`
- `skills/plan-from-spec/SKILL.md`
- `agents/review-finder.md`
- `agents/review-verifier.md`
- `agents/dag-review-finder.md`
- `references/review-dimensions.md`
- `references/dag-review-dimensions.md`

Required behavior:

- Ship `/cleanup` instead of treating it as consumer-supplied.
- Default `/auto-implement` / `/auto-run` to autonomous mode with `--mode human` opt-in.
- Make `/explore` and `/plan-from-spec` auto-advance after reviewer approval.
- Move DAG review into the decompose-first path with fan-out review dimensions.
- Replace separate `/triage-review` flow with `/code-review` producing pre-adjudicated findings, if local workflows can accept the change.

Local integration constraints:

- This repo has Codex plugin equivalents under `codex/plugins/loom`; update only if the same behavior is intended for Codex.
- Current local agents include `code-reviewer.md`, `code-simplifier.md`, and `review-triager.md`; archive replaces some of this review pipeline. Make this a conscious migration, not a file copy.

## Implementation Plan

### Phase 0: Branch For Implementation

Before changing executor code, create a dedicated implementation branch:

```sh
git switch -c adopt-executor-0.4-features
```

Do this after the spec is reviewed, not during this spec-only pass.

### Phase 1: Add Pure Supporting Modules

Add modules and tests that have low integration risk:

- `src/usage.ts` and migrate usage arithmetic callers.
- `src/scheduler/ready.ts` plus tests.
- `src/scheduler/writer-lane.ts` plus tests.
- `src/corpus.ts` plus tests.
- `src/metrics.ts` plus tests.
- `src/diff-view.ts` plus tests.

Acceptance:

- `npm run test` passes.
- No runtime behavior changes yet except any callers intentionally moved to `src/usage.ts`.

### Phase 2: Add Event And Schema Fields

Update:

- `src/events/types.ts`
- `src/events/emit.ts`
- `src/state/reducer.ts` if needed for new event shape compatibility.
- `src/types.ts`
- `src/validation.ts`
- tests for events, validation, reducer.

Acceptance:

- Old logs without `baseStartSha`, `baseShaBefore`, `baseShaAfter`, or `cause` replay.
- New logs include typed pause cause where possible.
- DAGs with invalid input sources fail validation.
- DAGs without `projectContext` still validate.

### Phase 3: Wire Standalone CLI Features

Update `src/index.ts`:

- Parse `positionals` separately so multi-log `--metrics` works.
- Add `--metrics`.
- Add `--diff-view`.
- Add `--no-open` and `--human`.
- Keep `--dag-readiness`, provider flags, memory flags, and backlog flags.
- Run standalone read-only commands before DAG readiness and self-host execution guards.
- Archive corpus after layered and backlog runs complete or pause.

Acceptance:

- `dag-executor --metrics` with no logs exits 1 with usage.
- `dag-executor --metrics sample.events.jsonl` emits JSON.
- `dag-executor --metrics sample.events.jsonl --human` emits a table.
- `dag-executor --diff-view sample.json --no-open` writes `sample.diff.html`.
- Existing `--dag-readiness`, `--slots`, `--decomposition-stats`, and normal execution still work.

### Phase 4: Port Main Ready-Work Executor

Update main `src/executor.ts` around the archive algorithm, but preserve local dependencies:

- Provider-aware sessions.
- Project memory.
- Quota decisions.
- Existing verification detection.
- Self-host guard behavior from `src/index.ts`.

Add or adapt:

- `src/executor/deps.ts`.
- `src/executor.ready.test.ts`.
- Current tests that assert strict layer barriers must be rewritten to assert checkpoint-only layer semantics.

Acceptance:

- Dependent task starts after its producer lands, even if another same-layer task is still running.
- Independent work continues after an unrelated permanent failure.
- A consumer's input contracts are checked before dispatch.
- Base movement pauses before merge.
- Merge conflicts pause resumably.
- Unexpected task/land throws become resumable pauses, not escaped process crashes.
- Tier-2 still runs at layer checkpoints.
- Backlog mode still runs through `executeBacklog` when `--backlog` is passed.

### Phase 5: Prompt And Decomposer Context

Update:

- `src/prompt.ts`
- `src/prompt.test.ts`
- `agents/task-decomposer.md`
- `skills/decompose/SKILL.md`

Acceptance:

- Prompts include project memory when available.
- Prompts include `projectContext` conventions for all tasks.
- UI tasks include shared components, theme token pointer, and configured Figma tools.
- Non-UI tasks do not carry UI-only context.

### Phase 6: Plugin And Workflow Migration

Update skills, agents, and references after executor behavior is stable:

- Add `skills/cleanup/SKILL.md`.
- Add review-fanout agents/references if adopting the archive review model.
- Update `/auto-implement`, `/auto-run`, `/auto-step`, `/explore`, `/plan-from-spec`, `/decompose`, and `/code-review` docs.
- Reconcile Claude plugin files and Codex plugin files separately.

Acceptance:

- `/cleanup` is documented as shipped.
- Autonomous default is explicit and `--mode human` is documented.
- The decompose-first path's DAG review gate is documented.
- Existing Codex/Loom workflow docs do not refer to removed Claude-only agents unless equivalents exist.

## Test Strategy

Run the full suite after each phase:

```sh
npm run test
```

Targeted tests to add or preserve:

- `src/scheduler/ready.test.ts`
- `src/scheduler/writer-lane.test.ts`
- `src/executor.ready.test.ts`
- `src/metrics.test.ts`
- `src/diff-view.test.ts`
- `src/corpus.test.ts`
- `src/usage.test.ts`
- `src/validation.test.ts`
- `src/contracts.test.ts`
- `src/prompt.test.ts`
- `src/state/reducer.test.ts`
- `src/events/emit.test.ts`

Manual smoke checks:

```sh
npm run build
node build/index.js --slots
node build/index.js --decomposition-stats scripts/smoke-dag.json
node build/index.js --dag-readiness scripts/smoke-dag.json
node build/index.js --metrics path/to/run.events.jsonl --human
node build/index.js --diff-view path/to/decomposition.json --no-open
```

## Risks

- The archive's ready-work executor removed local features, so a direct copy would regress Codex execution, backlog mode, quota pauses, and memory.
- Adding strict `input.source` validation can break existing DAGs that were accepted before. This is intended but must be documented.
- `--diff-view` depends on SHAs remaining reachable in git history. It must degrade to file lists when history was rewritten.
- Metrics over older logs must tolerate missing pause cause and missing SHA fields.
- Ready-work scheduling changes timing. Tests should assert dependency and event invariants, not exact interleavings.
- Corpus writes outside the repo can fail due to permissions; archiving must remain best-effort.

## Open Decisions

1. Should main layered mode be fully replaced by ready-work scheduling, or should ready-work become a separate flag first?
2. Should `DagPauseCause` include local `quota`, or should quota remain separate metadata only?
3. Should trivial batching be removed from main mode now, kept only in a legacy path, or reintroduced later as opportunistic batching?
4. Should the archive's Claude review fan-out replace the current local review-triage flow in both Claude and Codex plugin surfaces?
5. Should `package.json` move to `0.4.0` only after the executor behavior changes land, or earlier when additive CLI flags land?
