# Adopt Executor 0.4 Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-07-10-adopt-executor-0.4-features.md`

**Upstream source:** `/Users/nikita/Downloads/dag-executor-main (1).zip`, unpacked at `/tmp/dag-executor-new/dag-executor-main`.

**Goal:** Port the useful executor `0.4.0` features from the newer archive into this repository while preserving local Codex provider support, backlog mode, quota pauses, DAG readiness checks, project memory, Loom supervisor tooling, and Codex plugin packaging.

**Architecture:** Do not replace the repo wholesale. Adopt upstream modules and algorithms selectively. Main executor mode becomes ready-work scheduling by default; `--backlog` remains its own execution path. Add additive event fields and standalone analysis CLIs first, then port the main ready-work loop, then update prompts and plugin workflow docs.

**Resolved decisions:**

- Main non-backlog execution adopts ready-work scheduling by default, not behind a new flag.
- `DagPauseCause` gains local `quota`; existing `dag.paused.quota` metadata remains.
- Main ready-work mode runs trivial tasks as normal worktree tasks. Keep `src/executor/trivial-batch.ts` until a cleanup pass proves no local code/tests need it.
- Review fan-out and `/cleanup` migration are a final plugin/documentation phase, after executor behavior is stable.
- Bump `package.json` to `0.4.0` only in the final release/docs task.

---

## Current Code Map

- Modify: `src/index.ts`
  - Owns CLI parsing, provider/model selection, readiness preflight, and dispatch between layered and backlog execution.
  - Needs `--metrics`, `--diff-view`, `--no-open`, `--human`, corpus archiving, and no regression to `--provider`, `--backlog`, `--dag-readiness`, or memory flags.
- Modify: `src/executor.ts`
  - Current strict layer loop with trivial batching.
  - Needs ready-work dispatch, eager serialized land, per-edge contract checks, typed pause causes, SHA capture, dependency injection, and local quota/memory/provider preservation.
- Keep: `src/backlog-executor.ts`
  - Must remain selected only by `--backlog`.
  - Needs corpus archiving through `src/index.ts`, but not replacement by upstream executor.
- Create: `src/scheduler/ready.ts`, `src/scheduler/writer-lane.ts`
  - Pure scheduling and serialized land helpers from upstream.
- Create: `src/metrics.ts`, `src/diff-view.ts`, `src/corpus.ts`, `src/usage.ts`, `src/executor/deps.ts`
  - Upstream support modules, adapted to local types/events.
- Modify: `src/events/types.ts`, `src/events/emit.ts`, `src/state/reducer.ts`
  - Add pause causes, SHA fields, and compatibility with quota/backlog fields.
- Modify: `src/types.ts`, `src/validation.ts`, `src/contracts.ts`, `src/prompt.ts`
  - Add `ProjectContext`, `reviewVerdict`, source-routed contract rules, and prompt context composition.
- Modify/add tests:
  - `src/scheduler/ready.test.ts`
  - `src/scheduler/writer-lane.test.ts`
  - `src/usage.test.ts`
  - `src/corpus.test.ts`
  - `src/metrics.test.ts`
  - `src/diff-view.test.ts`
  - `src/executor.ready.test.ts`
  - existing validation/contracts/events/state/prompt/index tests as needed.
- Modify docs/plugin files:
  - `README.md`, `ARCHITECTURE.md`, `CHANGELOG.md`
  - `skills/cleanup/SKILL.md`
  - selected `skills/*`, `agents/*`, `references/*`
  - Codex plugin docs only where equivalent behavior actually exists.

## Behavioral Invariants

- `--provider=codex` remains the default provider.
- Claude model aliases and Codex model aliases continue to resolve through local provider-specific maps.
- `--backlog` still invokes `executeBacklog`.
- Backlog pause metadata `blockedTasks` and `quota` must remain in events and derived state.
- `--dag-readiness` still works as a standalone command and still gates normal execution unless `--skip-dag-readiness` is passed.
- `--memory` and `.dag-executor/memory.md` still inject curated project memory.
- `meta.projectContext` is additive and composes with memory in a separate prompt section.
- Old event logs replay without `baseStartSha`, `baseShaBefore`, `baseShaAfter`, or `cause`.
- Metrics and diff view degrade on old logs instead of failing.
- Corpus archiving is best-effort and must never fail an executor run.
- No implementation task may run destructive git commands or overwrite local untracked docs.

---

### Task 1: Branch For Implementation

**Files:** none

- [x] **Step 1: Create the implementation branch**

Run before code edits:

```bash
git switch -c adopt-executor-0.4-features
```

Expected: new branch exists and current untracked docs are still present.

- [x] **Step 2: Confirm worktree state**

Run:

```bash
git status --short
```

Expected: only intentional untracked/modified docs from the spec/plan pass are present before implementation edits begin.

---

### Task 2: Add Usage Arithmetic Module

**Files:**

- Create: `src/usage.ts`
- Create: `src/usage.test.ts`
- Modify: `src/claude-cli.ts`
- Modify: `src/executor/task-passes.ts`
- Modify: `src/executor/trivial-batch.ts` if still compiling against local helpers
- Modify: any local usage helpers found by `rg "sumUsage|divideUsage|ZERO_USAGE|USAGE_TOKEN_FIELDS"`

- [x] **Step 1: Port upstream usage module**

Adapt `/tmp/dag-executor-new/dag-executor-main/src/usage.ts`.

Local requirements:

- Export `ZERO_USAGE`, `addUsage`, `divideUsage`, and `USAGE_TOKEN_FIELDS`.
- Keep `Record<keyof TaskUsage, boolean>` exhaustiveness so new `TaskUsage` fields trigger a compiler error.
- Preserve local `TaskUsage` field roster exactly.

- [x] **Step 2: Port usage tests**

Adapt upstream `src/usage.test.ts`.

Add local assertions if current code has a local helper behavior not covered upstream.

- [x] **Step 3: Replace scattered usage arithmetic**

Use:

```bash
rg "sumUsage|divideUsage|ZERO_USAGE|USAGE_TOKEN_FIELDS|inputTokens|cacheCreationInputTokens" src
```

Replace duplicated arithmetic with imports from `src/usage.ts`.

- [x] **Step 4: Verify**

Run:

```bash
npm run build && node --test build/usage.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/usage.ts src/usage.test.ts src
git commit -m "refactor: centralize task usage arithmetic"
```

---

### Task 3: Add Ready Scheduler And Writer Lane Helpers

**Files:**

- Create: `src/scheduler/ready.ts`
- Create: `src/scheduler/ready.test.ts`
- Create: `src/scheduler/writer-lane.ts`
- Create: `src/scheduler/writer-lane.test.ts`

- [ ] **Step 1: Port pure ready scheduler**

Adapt upstream `src/scheduler/ready.ts`.

Local requirements:

- `completed` is the only status that satisfies a dependency.
- `in-progress` tasks are surfaced for reset on resume.
- deps-complete failed tasks are surfaced as retry candidates, not added directly to ready.
- Duplicate dependency entries are deduped.

- [ ] **Step 2: Port ready scheduler tests**

Adapt upstream `src/scheduler/ready.test.ts`.

Add local coverage for any local `TaskStatus` or state fields touched by quota/backlog additions only if necessary.

- [ ] **Step 3: Port writer lane**

Adapt upstream `src/scheduler/writer-lane.ts`.

Local requirements:

- `enqueue` must not poison later lands if one land rejects.
- `landWorktree` must return `merged`, `base-moved`, or `conflict`.
- It must read the post-merge base HEAD after successful merge.

- [ ] **Step 4: Port writer lane tests**

Adapt upstream `src/scheduler/writer-lane.test.ts`.

- [ ] **Step 5: Verify**

Run:

```bash
npm run build
node --test build/scheduler/ready.test.js
node --test build/scheduler/writer-lane.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/scheduler
git commit -m "feat: add ready-work scheduler helpers"
```

---

### Task 4: Add Corpus Archive Support

**Files:**

- Create: `src/corpus.ts`
- Create: `src/corpus.test.ts`

- [ ] **Step 1: Port corpus module**

Adapt upstream `src/corpus.ts`.

Local requirements:

- Default corpus directory is `~/.dag-executor/corpus`.
- `DAG_EXECUTOR_CORPUS_DIR` support is provided through options at the call site.
- `DAG_EXECUTOR_NO_CORPUS=1` support is provided through options at the call site.
- Copy sibling DAG JSON when it exists.
- Archive logs from both normal and backlog runs.
- Return skipped reasons instead of throwing for expected no-op cases.

- [ ] **Step 2: Port corpus tests**

Adapt upstream `src/corpus.test.ts`.

Add coverage for disabled archive and already-in-corpus no-op if not already present.

- [ ] **Step 3: Verify**

Run:

```bash
npm run build && node --test build/corpus.test.js
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/corpus.ts src/corpus.test.ts
git commit -m "feat: add run corpus archiving"
```

---

### Task 5: Add Event Fields And Pause Causes

**Files:**

- Modify: `src/events/types.ts`
- Modify: `src/events/emit.ts`
- Modify: `src/events/emit.test.ts`
- Modify: `src/state/reducer.ts`
- Modify: `src/state/reducer.test.ts`
- Modify: `src/types.ts`

- [ ] **Step 1: Extend event types**

Adapt upstream event additions:

- `dag.started.baseStartSha?: string`
- `worktree.merged.baseShaBefore?: string`
- `worktree.merged.baseShaAfter?: string`
- `dag.paused.cause?: DagPauseCause`

Local `DagPauseCause` must include:

```ts
'base-moved' | 'verification-failed' | 'contract-broken' | 'all-tasks-failed' | 'merge-conflict' | 'signal' | 'unexpected-error' | 'quota'
```

Keep local fields:

- `dag.paused.blockedTasks?`
- `dag.paused.quota?`

- [ ] **Step 2: Update event emit helpers**

Update `emitWorktreeMerged` or equivalent helper to accept optional base SHA fields.

Do not force every caller to provide them yet.

- [ ] **Step 3: Update reducer compatibility**

Confirm reducer ignores additive fields unless local state already records quota/blocked data.

Keep existing tests for `blockedTasks` and `quota`.

- [ ] **Step 4: Add tests**

Add or adapt tests proving:

- Old `dag.paused` without `cause` reduces.
- New `dag.paused` with `cause: 'quota'` and `quota` metadata reduces.
- `worktree.merged` with SHA fields reduces like old `worktree.merged`.
- `dag.started` with `baseStartSha` reduces like old `dag.started`.

- [ ] **Step 5: Verify**

Run:

```bash
npm run build
node --test build/events/emit.test.js
node --test build/state/reducer.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/events src/state src/types.ts
git commit -m "feat: add run pause causes and diff sha events"
```

---

### Task 6: Add Metrics CLI Support Module

**Files:**

- Create: `src/metrics.ts`
- Create: `src/metrics.test.ts`
- Modify: `src/consts.ts` if model context-window constants are missing.

- [ ] **Step 1: Port metrics module**

Adapt upstream `src/metrics.ts`.

Local requirements:

- Preserve local provider config shape in `ExecutionState.config`.
- Resolve model context windows for both Claude aliases and Codex models.
- Treat `dag.paused.cause` as authoritative when present.
- If `cause` is absent and `dag.paused.quota` exists, classify pause cause as `quota`.
- Preserve back-compat reconstruction from preceding events for old logs.
- Join sibling DAG JSON for task weights and degrade to `unknown` when absent.

- [ ] **Step 2: Port metrics tests**

Adapt upstream `src/metrics.test.ts`.

Add local tests:

- quota pause via typed `cause: 'quota'`
- quota pause via legacy `dag.paused.quota` without cause
- local provider config does not crash metrics

- [ ] **Step 3: Verify**

Run:

```bash
npm run build && node --test build/metrics.test.js
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/metrics.ts src/metrics.test.ts src/consts.ts
git commit -m "feat: add event log metrics"
```

---

### Task 7: Add Diff View Support Module

**Files:**

- Create: `src/diff-view.ts`
- Create: `src/diff-view.test.ts`

- [ ] **Step 1: Port diff-view module**

Adapt upstream `src/diff-view.ts`.

Local requirements:

- Read event log path through local `events/log.ts`.
- Load sibling DAG for annotations without requiring strict validation.
- Use `git diff baseShaBefore..baseShaAfter` for per-task diffs.
- Use `git diff baseStartSha..finalBaseShaAfter` for aggregate diff.
- Degrade to file lists on missing SHAs or git failure.
- Keep the rendered HTML self-contained with no new dependency.

- [ ] **Step 2: Port diff-view tests**

Adapt upstream `src/diff-view.test.ts`.

Tests should stub git diff and must not open a browser.

- [ ] **Step 3: Verify**

Run:

```bash
npm run build && node --test build/diff-view.test.js
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/diff-view.ts src/diff-view.test.ts
git commit -m "feat: add finished-run diff view"
```

---

### Task 8: Add Project Context Schema And Source-Routed Contracts

**Files:**

- Modify: `src/types.ts`
- Modify: `src/validation.ts`
- Modify: `src/validation.test.ts`
- Modify: `src/contracts.ts`
- Modify: `src/contracts.test.ts`

- [ ] **Step 1: Add `ProjectContext` and `reviewVerdict` types**

Adapt upstream `ProjectContext` and optional `DAGMeta.reviewVerdict`.

Keep all fields optional so old DAGs validate.

- [ ] **Step 2: Add Zod schema coverage**

Update `src/validation.ts` to accept optional:

- `meta.projectContext.sharedComponents`
- `meta.projectContext.conventions`
- `meta.projectContext.figmaToolset`
- `meta.projectContext.themeTokensDoc`
- `meta.reviewVerdict`

- [ ] **Step 3: Enforce source dependency rule**

Update validation so every input source:

- is a known task id
- is listed in the consumer task's `dependencies`

This is intentionally breaking for invalid DAGs.

- [ ] **Step 4: Route contract verification by source**

Adapt upstream contract checks so an input resolves only through `taskMap.get(input.source)` and that producer's like-named output.

Do not satisfy an input from an unrelated same-named output.

- [ ] **Step 5: Add tests**

Cover:

- valid old DAG without `projectContext`
- valid DAG with full `projectContext`
- invalid unknown input source
- invalid input source not listed in dependencies
- same output name on unrelated task does not satisfy contract

- [ ] **Step 6: Verify**

Run:

```bash
npm run build
node --test build/validation.test.js
node --test build/contracts.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/validation.ts src/validation.test.ts src/contracts.ts src/contracts.test.ts
git commit -m "feat: validate source-routed DAG contracts"
```

---

### Task 9: Wire Standalone CLI Features And Corpus Archiving

**Files:**

- Modify: `src/index.ts`
- Modify: `src/index` related tests if present
- Modify: `src/self-host-guard.test.ts` only if standalone command ordering affects it

- [ ] **Step 1: Parse positionals separately**

Change CLI parsing so:

- `positionals` includes every non-flag arg.
- normal `dagPath` is `positionals[0]`.
- `--metrics` can consume all positionals as log paths.

Preserve local flags:

- `--provider`
- `--backlog`
- `--dag-readiness`
- `--skip-dag-readiness`
- `--memory`
- `--no-memory`

- [ ] **Step 2: Add `--metrics` handling**

Run before the normal `!dagPath` guard and before execution-only guards.

Expected usage:

```bash
dag-executor --metrics <run.events.jsonl> [more.events.jsonl ...] [--human]
```

- [ ] **Step 3: Add `--diff-view` handling**

Run before the normal execution path and before self-host staleness checks.

Expected usage:

```bash
dag-executor --diff-view <decomposition.json> [--no-open]
```

Implement best-effort opener:

- `open` on macOS
- `xdg-open` on Linux
- `cmd /c start` on Windows

Opening failure must only print the path.

- [ ] **Step 4: Add corpus archiving after execution**

After either `executeDAG` or `executeBacklog` returns, call `archiveRun(config.dagPath, ...)`.

Options:

- `disabled: process.env.DAG_EXECUTOR_NO_CORPUS === '1'`
- `corpusDir` from `DAG_EXECUTOR_CORPUS_DIR` when present

Catch and warn on errors.

- [ ] **Step 5: Verify standalone CLI paths**

Run:

```bash
npm run build
node build/index.js --slots
node build/index.js --decomposition-stats scripts/smoke-dag.json
node build/index.js --dag-readiness scripts/smoke-dag.json
node build/index.js --metrics
```

Expected:

- first three commands preserve existing behavior
- `--metrics` without logs exits with usage and code 1

- [ ] **Step 6: Verify with fixture logs**

Use existing tests/fixtures or create temporary fixture files under `/tmp`.

Run:

```bash
node build/index.js --metrics /tmp/<fixture>.events.jsonl --human
node build/index.js --diff-view /tmp/<fixture>.json --no-open
```

Expected:

- metrics prints a human report
- diff-view writes `/tmp/<fixture>.diff.html`

- [ ] **Step 7: Commit**

```bash
git add src/index.ts src
git commit -m "feat: wire metrics diff view and corpus cli"
```

---

### Task 10: Add Executor Dependency Seam

**Files:**

- Create: `src/executor/deps.ts`
- Modify: `src/executor.ts`

- [ ] **Step 1: Port dependency interface**

Adapt upstream `src/executor/deps.ts`, but include local functions/types as needed:

- `executeTaskPasses`
- `settleNoOpGate`
- `createWorktreeSafe`
- `mergeLayerWorktrees`
- `getFilesModified`
- `verifyBaseUnchanged`

If main ready-work no longer uses trivial batching, do not include it in the dependency seam.

- [ ] **Step 2: Thread optional deps into `executeDAG`**

Add optional dependency injection in `ExecuteOptions` only if needed, or use an internal default parameter matching upstream.

Preserve public caller behavior from `src/index.ts`.

- [ ] **Step 3: Verify**

Run:

```bash
npm run build
```

Expected: PASS, with no behavior change yet.

- [ ] **Step 4: Commit**

```bash
git add src/executor/deps.ts src/executor.ts src/types.ts
git commit -m "refactor: add executor dependency seam"
```

---

### Task 11: Port Main Ready-Work Executor

**Files:**

- Modify: `src/executor.ts`
- Modify: `src/types.ts` if `ExecuteOptions` changes
- Modify: `src/events/emit.ts`
- Modify: `src/state/pending-merge.ts` only if pending merge semantics change
- Create/modify: `src/executor.ready.test.ts`
- Modify: existing executor/worktree/state tests as needed

- [ ] **Step 1: Study local executor-only features before editing**

Read and note local behavior that must survive:

```bash
rg -n "provider|projectMemory|quota|pendingMerge|trivial|pauseDag|emitWorktreeMerged|verifyLayerContracts|executeTaskPasses|settleNoOp" src/executor.ts src/backlog-executor.ts src/executor src/policy src/prompt.ts
```

Expected: implementation notes are clear before replacing the loop.

- [ ] **Step 2: Replace strict layer dispatch with ready-work loop**

Adapt upstream `src/executor.ts` algorithm:

- call `reconstructReadyState`
- dispatch while local in-flight count is below `MAX_GLOBAL_SLOTS`
- use `Promise.race` over in-flight task promises
- mark completed tasks and push newly-ready consumers
- keep layers as Tier-2 checkpoints
- treat trivial tasks as normal task worktree runs in this main mode

Preserve local:

- provider-aware `executeTaskPasses`
- project memory loading and passing
- quota handling from retry decisions
- DAG path/config fields
- readiness preflight remains in `src/index.ts`

- [ ] **Step 3: Add serialized land path**

Use `createWriterLane` and `landWorktree`.

On successful land:

- capture `baseShaBefore`
- merge
- read `baseShaAfter`
- update mutable `baseCommitSha`
- emit `worktree.merged` with SHA fields

On failure:

- base moved -> emit `dag.base-moved`, pause with cause `base-moved`
- conflict -> pause with cause `merge-conflict`
- unexpected throw -> pause with cause `unexpected-error`

- [ ] **Step 4: Add pause cause threading**

Change `pauseDag` in main executor to require `DagPauseCause`.

Local mappings:

- quota retry decision -> `quota`, with `quota` metadata
- Tier-1 or Tier-2 verification failure -> `verification-failed`
- contract failure -> `contract-broken`
- all permanent failures/no runnable work -> `all-tasks-failed`
- signal -> `signal`

- [ ] **Step 5: Add per-edge contract checks**

When a producer lands:

- call `markCompleted`
- verify each newly-ready consumer's inputs before adding it to `ready`
- on broken contract, emit `contract.broken` and pause with `contract-broken`

On resume:

- verify contracts for the ready seed before dispatch.

- [ ] **Step 6: Add checkpoint behavior**

When every task in a layer has terminal status:

- if any task in the layer permanently failed, emit non-advancing `layer.failed` and pause with `all-tasks-failed`
- otherwise run Tier-2 verification on merged main
- on Tier-2 failure emit `layer.verification-failed`, pause with `verification-failed`
- on pass emit `layer.completed`

Resume must re-run a missing Tier-2 checkpoint only after all lower layers are complete.

- [ ] **Step 7: Handle retry/resume edge cases**

Implement upstream fixes:

- transiently failed deps-complete tasks from `failedRunnable` re-enter ready on resume when `decide()` says retry
- in-progress tasks reset to pending and force-reset worktrees
- `task.reset` / `--rerun` force-resets leftover branches
- no in-flight promise may reject out of `Promise.race`

Preserve local quota behavior:

- quota pauses stop launching new work
- already-completed work should be landed before pause where practical
- pause carries quota metadata

- [ ] **Step 8: Port ready-work executor tests**

Adapt upstream `src/executor.ready.test.ts`.

Add local coverage for:

- Codex provider config survives execution setup with stubbed deps
- quota decision pauses with `cause: 'quota'` and quota metadata
- `--backlog` dispatch remains in `src/index.ts`, not this executor
- project memory is passed to task prompt execution path

- [ ] **Step 9: Update existing tests**

Run:

```bash
npm run build
```

Fix compile errors first.

Then run:

```bash
node --test build/executor.ready.test.js
node --test build/state/reducer.test.js
node --test build/events/emit.test.js
node --test build/worktree.test.js
```

Expected: PASS.

- [ ] **Step 10: Full verification**

Run:

```bash
npm run test
```

Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add src
git commit -m "feat: adopt ready-work executor scheduling"
```

---

### Task 12: Compose Project Context Into Prompts

**Files:**

- Modify: `src/prompt.ts`
- Modify: `src/prompt.test.ts`
- Modify: `src/executor/task-passes.ts` if prompt call signature changes
- Modify: `src/executor/trivial-batch.ts` only if still compiling and using prompt helpers
- Modify: `src/executor.ts`
- Modify: `src/backlog-executor.ts`

- [ ] **Step 1: Add prompt options for project context**

Current local `buildTaskPrompt` accepts `PromptOptions` for memory.

Extend it to include:

```ts
projectContext?: ProjectContext
```

Do not replace memory.

- [ ] **Step 2: Port upstream project-context rendering**

Adapt upstream prompt sections:

- conventions for all tasks
- shared components for UI tasks
- theme token document pointer for UI tasks
- configurable Figma toolset for UI/Figma guidance

Keep local memory rendering in its own section.

- [ ] **Step 3: Thread project context through execution**

Pass `dag.meta.projectContext` into:

- main ready-work task execution
- backlog execution
- any remaining trivial batch prompt path

- [ ] **Step 4: Add prompt tests**

Cover:

- memory-only prompt still works
- projectContext-only prompt works
- memory and projectContext both render as separate sections
- non-UI task omits UI-only shared components/theme token pointer
- UI task uses `figmaToolset` when present

- [ ] **Step 5: Verify**

Run:

```bash
npm run build && node --test build/prompt.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/prompt.ts src/prompt.test.ts src/executor.ts src/backlog-executor.ts src/executor
git commit -m "feat: add dag project context prompts"
```

---

### Task 13: Update Decomposer Schema Docs

**Files:**

- Modify: `agents/task-decomposer.md`
- Modify: `skills/decompose/SKILL.md`
- Modify: any schema references found by `rg "projectContext|reviewVerdict|contracts.inputs|input.source|source.*dependencies" agents skills references README.md ARCHITECTURE.md`

- [ ] **Step 1: Document `meta.projectContext`**

Port the upstream decomposer instructions for deriving project context once per DAG.

Make clear:

- small repeated facts are inlined
- large token maps are referenced by path
- UI-only context should not be forced onto non-UI tasks

- [ ] **Step 2: Document source dependency rule**

Update DAG authoring docs:

- every input `source` must be a direct dependency
- input name resolves against the source producer's output of the same name
- same-named outputs from unrelated tasks do not satisfy contracts

- [ ] **Step 3: Document `meta.reviewVerdict` only where review flow uses it**

Add or update decompose-first review docs without breaking existing local workflow.

- [ ] **Step 4: Verify docs references**

Run:

```bash
rg -n "projectContext|reviewVerdict|source.*depend|input.source" agents skills references README.md ARCHITECTURE.md
```

Expected: docs consistently describe the new schema and validation rule.

- [ ] **Step 5: Commit**

```bash
git add agents skills references README.md ARCHITECTURE.md
git commit -m "docs: document dag project context and contract sources"
```

---

### Task 14: Add Cleanup Skill And Workflow Updates

**Files:**

- Create: `skills/cleanup/SKILL.md`
- Modify: `skills/auto-implement/SKILL.md`
- Modify: `skills/auto-run/SKILL.md`
- Modify: `skills/auto-step/SKILL.md`
- Modify: `skills/code-review/SKILL.md`
- Modify: `skills/explore/SKILL.md`
- Modify: `skills/plan-from-spec/SKILL.md`
- Modify: `references/auto-step-phases-mechanical.md`
- Optionally add:
  - `agents/review-finder.md`
  - `agents/review-verifier.md`
  - `agents/dag-review-finder.md`
  - `references/review-dimensions.md`
  - `references/dag-review-dimensions.md`

- [ ] **Step 1: Add `/cleanup` skill**

Port upstream `skills/cleanup/SKILL.md`.

Local requirements:

- generic toolchain detection
- skip-don't-fail for absent commands
- autonomous mode can skip hard-error prompting
- compatible phase numbering with local `/auto-implement`

- [ ] **Step 2: Update auto-implement cleanup phase**

Remove language saying this plugin does not ship `/cleanup`.

Make `/cleanup` a normal Phase 5 dependency.

- [ ] **Step 3: Decide and apply review fan-out migration**

Before editing review flow, inspect local Codex/Loom review skills:

```bash
find codex/plugins/loom skills agents references -maxdepth 4 -type f | sort
```

If adopting upstream fan-out:

- add `review-finder`
- add `review-verifier`
- add `dag-review-finder`
- add review dimension references
- update `/code-review` to produce pre-adjudicated findings
- remove references to separate triage only where no longer used

If not adopting for Codex yet:

- update Claude-facing skill docs only
- leave Codex plugin docs unchanged
- document the intentional difference in `README.md` or `ARCHITECTURE.md`

- [ ] **Step 4: Update autonomous workflow docs**

Port upstream workflow language:

- `/auto-implement` and `/auto-run` default autonomous
- `--mode human` opts into pause-at-every-gate
- `/explore` auto-advances after spec reviewer approval
- `/plan-from-spec` auto-runs plan reviewer and advances only on READY
- decompose-first path uses DAG review gate

- [ ] **Step 5: Verify references**

Run:

```bash
rg -n "cleanup not available|triage-review|review-triager|--mode human|autonomous|dag-review|review-finder|review-verifier" skills agents references README.md ARCHITECTURE.md codex/plugins/loom
```

Expected:

- no stale claim that `/cleanup` is unavailable
- review-triage references are either still valid or consciously replaced
- Codex plugin docs do not claim missing agents exist

- [ ] **Step 6: Commit**

```bash
git add skills agents references README.md ARCHITECTURE.md codex/plugins/loom
git commit -m "feat: ship cleanup skill and update workflow docs"
```

---

### Task 15: Update README, Architecture, Changelog, And Version

**Files:**

- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `CHANGELOG.md`
- Modify: `CHEATSHEET.md` if adopting from upstream
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Update README CLI flags**

Document:

- `--metrics <log...> [--human]`
- `--diff-view <dag> [--no-open]`
- `--backlog` remains separate
- `--provider` remains local
- `--dag-readiness` remains local
- `--memory` remains local
- corpus archive environment variables

- [ ] **Step 2: Update event documentation**

Document:

- `dag.started.baseStartSha`
- `dag.paused.cause`
- `dag.paused.quota`
- `worktree.merged.baseShaBefore`
- `worktree.merged.baseShaAfter`
- source-routed contract behavior

- [ ] **Step 3: Update architecture**

Describe:

- ready-work main executor
- writer lane
- layers as Tier-2 checkpoints
- metrics/diff/corpus support modules
- provider/backlog/memory local extensions

- [ ] **Step 4: Update changelog**

Add `0.4.0` or `[Unreleased]` entries covering:

- breaking validation rule for input sources
- ready-work main executor
- metrics CLI
- diff-view CLI
- corpus archive
- projectContext
- cleanup skill
- local preservation of Codex/backlog/quota/memory/readiness

- [ ] **Step 5: Bump package version**

Update:

- `package.json` to `0.4.0`
- `package-lock.json` version fields

Do not remove local `bin` entries for Loom supervisor unless explicitly obsolete.

- [ ] **Step 6: Verify docs and package**

Run:

```bash
npm install --package-lock-only
npm run build
npm run test
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add README.md ARCHITECTURE.md CHANGELOG.md CHEATSHEET.md package.json package-lock.json
git commit -m "docs: document executor 0.4 adoption"
```

---

### Task 16: Final Smoke Verification

**Files:** none unless fixes are required

- [ ] **Step 1: Full test suite**

Run:

```bash
npm run test
```

Expected: PASS.

- [ ] **Step 2: Standalone command smoke**

Run:

```bash
node build/index.js --slots
node build/index.js --decomposition-stats scripts/smoke-dag.json
node build/index.js --dag-readiness scripts/smoke-dag.json
node build/index.js --metrics
```

Expected:

- first three commands succeed
- `--metrics` without logs exits 1 with usage

- [ ] **Step 3: Diff and metrics fixture smoke**

Create or reuse a small temporary DAG/event fixture under `/tmp`, then run:

```bash
node build/index.js --metrics /tmp/<fixture>.events.jsonl --human
node build/index.js --diff-view /tmp/<fixture>.json --no-open
```

Expected:

- metrics prints a report
- diff-view writes `/tmp/<fixture>.diff.html`

- [ ] **Step 4: Backlog dispatch smoke**

Run a no-execution or stub-safe check proving `--backlog` still dispatches through local backlog code.

At minimum:

```bash
rg -n "executeBacklog|backlog \\?" src/index.ts
```

Expected: `executeBacklog` remains imported and selected only when `--backlog` is passed.

- [ ] **Step 5: Final status**

Run:

```bash
git status --short
```

Expected: clean or only intentionally untracked spec/plan docs if they were not committed with the implementation branch.

- [ ] **Step 6: Final commit if fixes were needed**

```bash
git add .
git commit -m "test: verify executor 0.4 adoption"
```

Only run this if Step 1-5 required additional changes.

## Rollback Notes

- If ready-work executor port becomes too invasive, stop after Tasks 2-9. That still delivers usage, scheduler helpers, metrics, diff-view, corpus, event fields, schema validation, and CLI additions without changing execution scheduling.
- If plugin workflow migration conflicts with Codex/Loom behavior, ship `/cleanup` alone and defer review fan-out to a separate spec.
- If `--diff-view` browser opening causes platform-specific failures, keep `--no-open` behavior and make auto-open best-effort only.

## Done Criteria

- All tests pass with `npm run test`.
- Main non-backlog execution uses ready-work scheduling.
- `--backlog` still uses `executeBacklog`.
- `--metrics` and `--diff-view --no-open` work from built CLI.
- New event fields are additive and old logs replay.
- Invalid input sources fail validation.
- Project memory and DAG project context both render correctly.
- Corpus archiving is best-effort and configurable.
- Docs and package version describe the adopted `0.4.0` feature set.
