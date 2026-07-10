# Changelog

All notable changes to dag-executor are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Under 0.x, a MINOR bump signals a breaking CLI-surface change.

---

## [Unreleased]

### Added

- Prettier (pinned, `printWidth: 120`, `singleQuote`), scoped to `src/` — skills/references markdown deliberately excluded. New `lint` (check) / `format` (write) scripts; CI runs the check. Side effect: the verify-detect layer now finds a `lint` script in this repo, so self-hosted DAG runs gate spawned tasks' formatting through the Tier-1/Tier-2 gates. One-time reformat is listed in `.git-blame-ignore-revs`.

### Changed

- Auto-commit messages are now descriptive instead of `dag-executor: <task.id>`. New `src/executor/commit-message.ts`: per-task commits use the task `name` as subject (capped at 72 chars) + `description` as body + a `task-id: <id>` trailer; the trivial batch uses a summary subject + one bulleted `- <name> (<id>)` line per task. Deterministic — no extra model call.
- `engines.node` raised `>=20` → `>=22`: Node 20 is EOL (2026-04-30) and its `node --test` lacks native glob expansion (the suite silently found zero tests there). No CLI-surface change.
- CI: `actions/checkout` and `actions/setup-node` bumped v4 → v5 (v4 runs on the deprecated Node 20 runner, forced to Node 24 from 2026-06-16).

---

## [0.4.0] - 2026-07-10

### Added

- Main executor ready-work scheduling: tasks start as soon as dependencies land, then merge through a serialized writer lane while layers remain Tier-2 verification checkpoints.
- Standalone `--metrics <log...> [--human]` and `--diff-view <dag> [--no-open]` CLI modes.
- Best-effort run corpus archiving with `DAG_EXECUTOR_CORPUS_DIR` and `DAG_EXECUTOR_NO_CORPUS`.
- Diff-friendly event fields: `dag.started.baseStartSha`, `worktree.merged.baseShaBefore/baseShaAfter`, and typed `dag.paused.cause`.
- DAG `meta.projectContext` prompt support and `/cleanup` skill.

### Changed

- Input contracts are source-routed: `input.source` must be a known direct dependency and only that producer's like-named output can satisfy the input.
- Preserved local Codex defaults, Claude provider support, backlog mode, quota pause metadata, DAG readiness gates, Loom supervisor binaries, and curated project memory.

---

## [0.3.0] - 2026-06-09

### Added

- **Two-tier pre-merge verification gates** (`src/verify/`). **Tier 1** runs the target repo's detected test/lint/typecheck against a task's changes *before* `autoCommit` and re-invokes the session up to twice (`VERIFICATION_MAX_FIX_ATTEMPTS`) with the failing output; exhaustion leaves the worktree unmerged. **Tier 2** runs on merged main after *every* layer (including the last) and pauses on failure. Verification commands are **detected** from the package manager + `package.json` scripts — never defaulted to yarn; an undetected check (or a deps-less worktree) is **skipped with a warning**, never a false-fail. Formatters are deliberately excluded from the gate set.
- CLI flags `--test-cmd`, `--lint-cmd`, `--typecheck-cmd` (override detection, run raw), and `--no-verify` (disable both tiers). `ExecutorConfig.verifyCommands` / `disableVerification`.
- New events `task.verification-failed` and `layer.verification-failed`, classified **permanent** by the retry policy (never transient-retried; classified ahead of the default `succeeded` fall-through so a verify-failed worktree is never merged). Consts `WEIGHT_VERIFICATION_TIMEOUT_MS`, `VERIFICATION_MAX_FIX_ATTEMPTS`.

### Changed

- Task + trivial-batch completion prompts no longer ask the agent to self-report a (yarn-hardcoded) verification block — verification now runs automatically in the executor loop, and the session is re-invoked with errors on failure.

### Removed

- **`runPostExecution`** — the old single, post-all-layers, yarn-hardcoded test/lint/prettier pass that merely warned on failure. Superseded by Tier 2 (per-layer, detected commands, pause-on-fail).

This is the orchestrator-loop design from `.claude/ai/spec-2026-06-09-pre-merge-verification-gates.md` — verification lives in the executor loop, not in Claude Code hooks (target-repo hooks remain honored for free via `--setting-sources user,project,local`).

## [0.2.1] - 2026-06-08

### Added

- **Review pipeline shipped into the plugin** (Hybrid-C — the plugin owns "execute + judge"): the `plan-reviewer`, `code-reviewer`, and `review-triager` agents, the `/code-review` and `/triage-review` skills, and `references/review-contract.md` — the single source of truth for the `review-*.md` verdict-frontmatter contract that `/auto-implement` Phases 7–8 parse.
- `/explore` and `/plan-from-spec` skills (interactive design dialogue → spec, and spec → plan without re-running research).

### Changed

- **Command surface migrated to the skills convention**: every `commands/*.md` is now `skills/<name>/SKILL.md` (same `/dag-executor:<name>` invocation, auto-discovered). The five orchestrators (`auto-implement`, `auto-run`, `auto-step`, `decompose`, `implement-dag`) carry `disable-model-invocation: true` (explicit-only — a model shouldn't auto-fire a DAG run).
- **`/auto-implement` now defaults to the supervised flow** — it backgrounds the supervisor via `/auto-run` (one fresh `claude -p` context per phase, chat stays ≥70% free). `--inline` runs the previous monolithic in-session engine, which remains the only substrate that supports the sequential `/implement-plan` path.
- **Opus model references pinned to `claude-opus-4-8`** across plugin and CLI. The `--model=opus` alias now resolves to `claude-opus-4-8` (was `claude-opus-4-7`); the default heavy-task model and the cost-table key moved with it. No flag-surface change — the `opus`/`sonnet`/`haiku` aliases are unchanged; only what `opus` resolves to.

### Removed

- `commands/` directory — fully migrated to `skills/`.

---

## [0.2.0] - 2026-06-03

### BREAKING

CLI flags removed — any invocation passing these flags will now error:

- `--failure-model` — removed; it selected the legacy v1 sequential execution body (superseded by the default v2 DAG path). The flag was wired into branch selection, but v1 was dead-by-default — no supported invocation reached it.
- `--migrate-state` — removed; migration path was dead code with no active callers.
- `--validate-events` — removed; a standalone event-log validation/diff mode (bespoke `sortKeys`/`collectDiffs` differ) with no callers in the normal execution or resume paths.

Update any scripts or skill invocations that reference these flags before upgrading.

### Removed (internal, non-breaking)

Dead code excised as part of the same cleanup pass. No observable behaviour change for callers not using the removed flags:

- v1 sequential execution path (superseded by DAG executor in 0.1.x).
- Dead event guards and never-emitted event branches.
- `loadStateCache` helper (read side of the old state cache; write side / `saveState` / `.state.json` and the `--resume` path are **retained**).
- Legacy DAG coercion shims for pre-0.1 task shape.
- Dev scaffold stubs left over from initial prototyping.

---

## [0.1.0] - 2026-05-01

### Added

- Initial DAG executor: parallel layer execution, worktree isolation, `--resume` support.
- `saveState` / `.state.json` persistence for mid-run checkpointing.
- Core CLI flags: `--resume`, `--dry-run`. (This 0.1.0 entry is reconstructed; the exact historical flag set is approximate — see `index.ts` for the current authoritative surface.)
