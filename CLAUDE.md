# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Two deliverables in one repo:

1. **dag-executor CLI** (`src/` → `build/`) — event-sourced orchestrator that executes decomposition DAGs: spawns a Claude Agent SDK session per task in an isolated git worktree, runs layers in dependency order, merges worktrees back, and verifies inter-layer contracts. Consumed as an npm-linked binary (`npm link` once; after changes a plain `npm run build` is enough — no re-link).
2. **Claude Code plugin** (`.claude-plugin/`, `skills/`, `agents/`, `scripts/`, `bin/`, `references/`) — the orchestration surface: `/auto-implement`, `/auto-run`, `/auto-step`, `/decompose`, `/implement-dag`, `/implement-plan` (the sequential implementer + fix-from-review mode behind `/auto-implement`'s non-DAG path) (plus the review skills `/code-review`, `/triage-review`) — skills under `skills/<name>/SKILL.md` — the `plan-reviewer` / `code-reviewer` / `review-triager` / `task-decomposer` agents, and the headless supervisor loop. The plugin marketplace is this same repo. Plugin changes ship by commit + push (the plugin is deliberately unversioned — every commit is a new version), then `/plugin update dag-executor` on the consumer side. The plugin does **not** install the CLI; that is the separate npm-link step.

## Commands

- Build: `npm run build` (tsc → `build/`)
- Typecheck only: `npm run lintTypes`
- Format: `npm run format` / check: `npm run lint` (prettier, `src/` only — skills/references markdown is deliberately excluded; CI runs the check)
- Test: `npm test` (compiles, then `node --test "build/**/*.test.js"`)
- Single test file: `npm run build && node --test build/semaphore.test.js`
- Supervisor smoke harness (stubbed binaries, no model/network calls): `scripts/auto-run-smoke.sh`

**Node version**: `engines` requires >=22 (Node 20 is EOL since 2026-04, and `node --test "<glob>"` needs ≥21 for native glob expansion — on 20 the quoted pattern is treated as a literal path and the suite finds zero tests). CI uses Node 22.

Tests are colocated `*.test.ts` files using `node:test`, executed against compiled output — always build before running them directly.

ESM throughout (`"type": "module"`, Node16 resolution): relative imports in `.ts` source must use the `.js` extension.

## Architecture

`ARCHITECTURE.md` is the authoritative deep-dive (end-to-end flow + invariants). The five load-bearing invariants, condensed:

1. **Cross-process slot semaphore** (`src/semaphore.ts`) — concurrency is bounded machine-wide, not in-process, via atomic `O_CREAT|O_EXCL` slot files in `~/.dag-executor/slots/` (`MAX_GLOBAL_SLOTS = 4` in `src/consts.ts`). This is the OOM guard when multiple terminal windows run DAGs simultaneously. Stale slots from dead PIDs are reclaimed on poll.
2. **One worktree per task, branch named after the task ID** (`src/worktree.ts`) — resume/retry reuses the same base; `--force-worktree-reset=id` is the only way to clobber a branch with unmerged commits.
3. **Base-unchanged check before every merge** (`verifyBaseUnchanged`) — if the base branch HEAD moved while tasks were running, emit `dag.base-moved` and pause instead of merging. `baseCommitSha` is mutable within a run: updated after each trivial batch and after each layer merge.
4. **Events appended THEN reduced** (`emitHelper` in `src/state.ts`) — every state mutation goes through `emitHelper`: synchronous append to `<dag>.events.jsonl`, then fold through the pure reducer (`src/state/reducer.ts`). The log is the source of truth; in-memory state is a projection.
5. **`.state.json` is a derived cache, never read on the normal path** — `--resume`/`--rerun` reconstruct state exclusively by replaying `.events.jsonl` (`loadStateFromEvents` in `src/state.ts`).

### Execution model

The layer loop lives in `src/executor.ts` (the heart of the codebase). Per layer, tasks split by `weight`:

- `trivial` — all trivial tasks in the layer batched into **one** SDK session running on the main branch (no worktree), auto-committed.
- `standard` / `heavy` — one worktree each, executed concurrently (`Promise.allSettled`), each session gated by a slot claim and a weight-derived deadline (trivial 5 min / standard 15 / heavy 30; max turns 50/100/150 in `src/consts.ts`). `heavy` tasks get the heavy model (opus by default; sonnet for the rest).

**Two-tier verification gates** (`src/verify/`) wrap this. Commands are *detected* from the target repo (package manager + `package.json` scripts — never defaulted to yarn; absent → skipped, never false-fail; CLI overrides via `--test-cmd`/`--lint-cmd`/`--typecheck-cmd`, off via `--no-verify`). **Tier 1** runs the detected checks against a task's changes *before* `autoCommit` — per-worktree for standard/heavy, post-no-op-loop for the trivial batch — and re-invokes the session up to `VERIFICATION_MAX_FIX_ATTEMPTS` (2) with the errors; exhaustion emits `task.verification-failed` and leaves the worktree unmerged (the trivial batch pauses, since its work is already on main). Tier 1 in a fresh worktree without `node_modules` skips JS checks — **Tier 2** on merged main (which has deps) is the real backstop. **Tier 2** runs after each layer's merge, for *every* layer including the last; failure emits `layer.verification-failed` and pauses (no auto-fix). This replaced the old toothless, yarn-hardcoded `runPostExecution`.

After each layer: Tier-1 results gate the merge → base-unchanged check → merge worktrees → **Tier-2 merged-whole verification** → verify next layer's input contracts (`src/contracts.ts`: file existence, export regex scan, behavioral always passes) → on any failure, pause (resumable with `--resume`).

Retry policy (`src/policy/retry.ts`) is a pure function over the event log: `task.timeout` gets progressive backoff (30 s → 90 s → permanent); `task.failed` is retried only if the error message matches transient patterns (rate limit, 5xx, ECONNRESET/ETIMEDOUT/ENOTFOUND, overloaded); `task.verification-failed` is always **permanent** (the in-task fix budget is already spent — never transient-retried, and `decide` must classify it ahead of the default `succeeded` fall-through or the broken worktree would merge). `task.timeout`, `task.failed`, and `task.verification-failed` are deliberately distinct event kinds — never conflate them.

CLI exit codes: 0 completed, 2 paused (resume with `--resume`), 1 error.

### Plugin / supervisor side

`skills/auto-run/SKILL.md` launches `scripts/auto-run-supervisor.sh` in the background. The supervisor loop reads a JSON checkpoint (managed by `scripts/auto-run-checkpoint.cjs`), runs exactly one phase per iteration in a **fresh** process (`claude -p "/dag-executor:auto-step ..."` for chat phases; the `dag-executor` CLI for the implement phase), and routes on exit code: 0 advance, 1 halt + `/handoff`, 2 park for a human gate decision. `bin/dag-checkpoint` and `bin/dag-auto-run-supervisor` are PATH-visible wrappers (the Bash tool adds plugin `bin/` to PATH while the plugin is enabled). `CLAUDE_BIN` / `DAG_EXECUTOR_BIN` env vars are the stub seam used by the smoke harness.

`/auto-implement` **defaults to launching this supervised flow** (it delegates to `/auto-run`: init checkpoint → background supervisor → monitor gates; the chat only monitors). `--inline` runs the monolithic in-session engine (Phases 1–10 in one context) instead — the only substrate that supports the sequential `/implement-plan` path. Mode (DAG vs sequential) is resolved first; a sequential result forces `--inline` because the supervisor is DAG-only.

`references/` holds the per-phase instructions consumed by `/auto-step`; `agents/task-decomposer.md` defines the DAG JSON schema that `src/validation.ts` (Zod) and `src/types.ts` mirror.

## Documentation accuracy

`CHANGELOG.md` 0.2.0 removed `--failure-model`, `--migrate-state`, and `--validate-events` (README's stale migration section + flag tables were dropped in a later docs pass). Current flag surface — trust `src/index.ts`: `--resume`, `--dry-run`, `--slots`, `--model`, `--rerun`, `--force-worktree-reset`, `--test-cmd`, `--lint-cmd`, `--typecheck-cmd`, `--no-verify`.

Under 0.x versioning, a MINOR bump signals a breaking CLI-surface change.
