# dag-executor

CLI tool that drives multi-task LLM decompositions: loads a DAG JSON, starts tasks as soon as dependencies land, runs provider sessions per task in git worktrees, merges worktrees back through a serialized writer lane, and verifies contracts plus detected test/lint/typecheck gates.

**Design spec**: `.claude/ai/spec-2026-05-19-dag-executor-v2-event-sourced.md` (in the [vmm](https://github.com/Visma-Manager/vmm) repo, where this tool originated)

---

## Setup

Two parts: the **CLI binary** (npm link) and the **Claude Code plugin** (skills + agents).

### 1. CLI binary

One-time machine setup — exposes the `dag-executor` binary on PATH via `npm link`:

```sh
git clone https://github.com/Visma-Manager/dag-executor.git
cd dag-executor
npm install && npm run build && npm link
```

> If `npm link` fails with `EACCES` (root-owned `/usr/local`), switch to a user-level prefix first:
> `npm config set prefix ~/.npm-global` and add `export PATH="$HOME/.npm-global/bin:$PATH"` to your shell rc.

Verify from any directory:

```sh
dag-executor --slots
loom-risk-helper --help
loom-day-run --help
loom-supervisor --help
```

> **nvm/volta caveat**: `npm link` installs into the _active_ node version's global prefix. If you switch node versions, the `dag-executor` command disappears — re-run `npm link` from this repo under the new version.

After pulling changes: `npm run build` (the linked binary points at `build/index.js`, so a rebuild is all that's needed — no re-link).

### 2. Claude Code plugin

Ships the orchestration surface: `/auto-implement`, `/auto-run`, `/auto-step`, `/cleanup`, `/code-review`, `/risk-scan`, `/decompose`, `/implement-dag`, the review/risk finder and verifier agents, the `plan-reviewer` / `task-decomposer` / `code-simplifier` agents, the headless supervisor scripts, and the `dag-checkpoint` / `dag-auto-run-supervisor` helpers (added to the Bash tool's PATH while the plugin is enabled).

`/auto-implement` defaults to the **supervised** flow (backgrounds the supervisor, one fresh context per phase, chat just monitors gates); pass `--inline` for the monolithic in-session engine — the only substrate that runs sequential (`/implement-plan`) plans.

In Claude Code:

```
/plugin marketplace add Visma-Manager/dag-executor
/plugin install dag-executor@visma-manager
```

Requires GitHub auth that can clone this private repo over https (e.g. `gh auth login`). The plugin is unversioned on purpose — every commit is a new version, so `/plugin update dag-executor` after any push picks up the latest.

> The plugin does **not** install the CLI binaries — step 1 is still required. `/implement-dag` and the supervisors invoke `dag-executor` / `loom-supervisor` from PATH.

### 3. Codex plugin

The Codex-native plugin bundle lives under `codex/plugins/loom`. It ports the two review helpers that were Claude agents into Codex skills:

- `/simplify` — behavior-preserving simplification of the current diff.
- `/code-review` — comprehensive diff review with a structured report in `.claude/ai/`.
- `/risk-scan` — explicit, bounded inspection of adjacent project code with durable reports and a deduplicated central risk registry.

Install the local marketplace once from this repo:

```sh
codex plugin marketplace add ./codex
codex plugin add loom@loom-local
```

Start a new Codex thread after installing or updating the plugin so the slash-command surface is reloaded.

### Explicit risk scanning

`/risk-scan` is separate from change-gating code review. It uses changed files as seeds, follows direct callers, dependencies, shared contracts, and one analogous implementation within a two-hop boundary, then inspects that neighborhood through integration, reliability, trust-boundary, and maintainability lenses. It never runs automatically from `/auto-implement`, `/auto-run`, or `/code-review`.

```text
/risk-scan
/risk-scan --base origin/main
/risk-scan --paths src/executor.ts,src/contracts.ts
/risk-scan --paths src/executor.ts --report-only
```

Without `--paths`, committed branch changes plus staged, unstaged, and untracked non-ignored files provide the seeds. A clean repository is a successful no-op, not a whole-repository audit. `--report-only` writes the immutable scan report without changing the registry.

Durable output is stored outside the target repository under `${LOOM_ARTIFACTS_DIR:-/Users/nikita/Desktop/repos/dag-executor-artifacts}/projects/<project-slug>/risk-register/`:

- `risk-YYYY-MM-DD-<scan-slug>.md` — immutable evidence for one scan; collisions receive a unique UTC/scan-ID suffix.
- `registry.json` — schema-versioned findings deduplicated across scans while preserving human `accepted`, `fixed`, and `dismissed` statuses.

The internal `loom-risk-helper` binary provides deterministic Git seed discovery and race-safe registry updates for both plugin surfaces. Its stdout is machine-readable JSON; diagnostics are written to stderr.

Before `registry-merge`, the orchestrator projects only converged, non-rejected ambient findings into this strict schema-v1 candidate envelope:

```json
{
  "schemaVersion": 1,
  "projectSlug": "<slug>",
  "entries": [
    {
      "lens": "integration",
      "kind": "risk",
      "severity": "high",
      "confidence": "medium",
      "status": "open",
      "title": "<title>",
      "evidence": ["<evidence>"],
      "affectedPaths": ["<repository-relative-path>"],
      "seedRelationship": "<relationship>",
      "failureScenario": "<scenario>",
      "suggestedAction": "<action>",
      "primaryAnchor": "<optional-anchor>",
      "rootCause": "<optional-root-cause>"
    }
  ]
}
```

Lens codes map as `I` to `integration`, `R` to `reliability`, `B` to `trust-boundaries`, and `M` to `maintainability`. `kind` is `bug | risk | improvement`; severity is `critical | high | medium | low`; confidence is reduced to `high | medium | low`; optional status is `open | deferred`. `evidence` and `affectedPaths` must each contain at least one non-empty string. Change-review candidates and rejected findings are never projected.

The projection omits finder `temporaryId`, `fingerprintInputs`, `disposition`, confidence rationale, verifier outcome/reason, hop metadata not represented by `seedRelationship`, and all other orchestration-only or report-only fields. Registry identity matches the generated `rs1:` fingerprint first. Semantic alias matching is fallback-only for entries with legacy non-`rs1:` fingerprints, which retain their stored fingerprint when refreshed.

Registry persistence distinguishes pre-rename `write-failed` from two post-operation outcomes: `durability-uncertain` means the atomic rename completed but parent-directory sync failed, so new bytes may already be visible and validation/idempotent retry is required; `lock-release-failed` means the operation otherwise completed but its owned lock could not be released. Both are reported as structured persistence failures without modifying the immutable scan report.

---

## Overview

dag-executor is an event-sourced orchestrator. Every state transition emits a typed event appended to an append-only `.events.jsonl` file next to the DAG. State is derived by replaying events through a pure reducer — there is no separate mutable state machine.

```
DAG JSON
  └── .events.jsonl   ← append-only event log (source of truth)
  └── .state.json     ← derived snapshot (cache; never read as truth)
  └── .lock           ← concurrency lock (PID-based, auto-released on exit)
```

On resume, the executor reads the event log from disk and replays it to reconstruct state. Nothing is lost if the process crashes mid-layer.

## Project Memory

For curated lessons that should carry across DAG runs, add `.dag-executor/memory.md` in the target repo. The executor loads it by default, caps it to a small prompt-safe block, and injects it into spawned task sessions as "Curated Project Memory". Use `--memory=<path>` to point at a different curated file, or `--no-memory` to disable memory injection for a run.

Keep this file summarized and selective: useful conventions, recurring failure modes, estimate corrections, or lessons from prior event logs. Do not paste raw `.events.jsonl` or `.state.json` content into it.

---

## Event Log Format

Each line is a self-contained JSON object followed by `\n`. The file is append-only and never rewritten. Every event shares three envelope fields:

| Field           | Type     | Description                                 |
| --------------- | -------- | ------------------------------------------- |
| `kind`          | `string` | Discriminator — see Event Kinds table below |
| `schemaVersion` | `1`      | Always `1` for the current schema           |
| `ts`            | `string` | ISO-8601 wall-clock timestamp               |

### Tailing the log

```sh
tail -f path/to/decomposition.events.jsonl
```

### Parsing the log

```sh
# Pretty-print one event per line
cat decomposition.events.jsonl | while read line; do echo "$line" | jq .; done

# Filter to task failures only
jq -r 'select(.kind == "task.failed")' decomposition.events.jsonl

# Show timeline of a single task
jq -r 'select(.taskId == "my-task-id")' decomposition.events.jsonl
```

### Sample lines

```jsonl
{"kind":"dag.started","schemaVersion":1,"ts":"2026-05-19T12:00:00.000Z","dagPath":"/repo/.claude/ai/decomp.json","dagId":"decomp","branch":"feature/my-work","resume":false}
{"kind":"layer.started","schemaVersion":1,"ts":"2026-05-19T12:00:01.000Z","dagId":"decomp","layer":0,"taskIds":["task-a","task-b"]}
{"kind":"task.started","schemaVersion":1,"ts":"2026-05-19T12:00:01.100Z","dagId":"decomp","taskId":"task-a","taskName":"Implement auth module","layer":0,"worktreePath":".worktrees/task-a","worktreeBranch":"dag/task-a"}
{"kind":"worktree.created","schemaVersion":1,"ts":"2026-05-19T12:00:01.200Z","dagId":"decomp","taskId":"task-a","worktreePath":".worktrees/task-a","branch":"dag/task-a","baseBranch":"feature/my-work"}
{"kind":"contract.verified","schemaVersion":1,"ts":"2026-05-19T12:02:30.000Z","dagId":"decomp","taskId":"task-a","outputName":"auth-types","outputKind":"file"}
{"kind":"worktree.merged","schemaVersion":1,"ts":"2026-05-19T12:02:31.000Z","dagId":"decomp","taskId":"task-a","worktreePath":".worktrees/task-a","branch":"dag/task-a","targetBranch":"feature/my-work","filesChanged":["src/auth/types.ts","src/auth/service.ts"]}
{"kind":"worktree.removed","schemaVersion":1,"ts":"2026-05-19T12:02:32.000Z","dagId":"decomp","taskId":"task-a","worktreePath":".worktrees/task-a","branch":"dag/task-a","reason":"merged"}
{"kind":"task.completed","schemaVersion":1,"ts":"2026-05-19T12:02:32.100Z","dagId":"decomp","taskId":"task-a","taskName":"Implement auth module","layer":0,"durationMs":91000,"usage":{"inputTokens":12000,"outputTokens":3200,"cacheReadInputTokens":8000,"cacheCreationInputTokens":0,"costUSD":0.084,"numTurns":6,"durationMs":91000,"durationApiMs":62000},"filesModified":["src/auth/types.ts","src/auth/service.ts"],"finalState":{"status":"completed","startedAt":"2026-05-19T12:00:01.100Z","completedAt":"2026-05-19T12:02:32.100Z"}}
{"kind":"task.failed","schemaVersion":1,"ts":"2026-05-19T12:01:00.000Z","dagId":"decomp","taskId":"task-b","taskName":"Write tests","layer":0,"error":"ECONNRESET: socket hang up","durationMs":59000,"finalState":{"status":"failed","startedAt":"2026-05-19T12:00:01.100Z"}}
{"kind":"task.retry","schemaVersion":1,"ts":"2026-05-19T12:01:00.100Z","dagId":"decomp","taskId":"task-b","taskName":"Write tests","layer":0,"attempt":1,"delayMs":30000,"reason":"transient error","previousError":"ECONNRESET: socket hang up"}
{"kind":"task.timeout","schemaVersion":1,"ts":"2026-05-19T12:16:00.000Z","dagId":"decomp","taskId":"task-c","taskName":"Heavy refactor","layer":1,"timeoutMs":1800000,"durationMs":1800000,"finalState":{"status":"failed"}}
{"kind":"task.reset","schemaVersion":1,"ts":"2026-05-19T12:00:00.500Z","dagId":"decomp","taskId":"task-a","taskName":"Implement auth module","layer":0,"previousStatus":"failed","reason":"--rerun requested"}
{"kind":"layer.completed","schemaVersion":1,"ts":"2026-05-19T12:02:33.000Z","dagId":"decomp","layer":0,"taskIds":["task-a","task-b"],"durationMs":152000}
{"kind":"layer.completed-with-failures","schemaVersion":1,"ts":"2026-05-19T12:20:00.000Z","dagId":"decomp","layer":1,"taskIds":["task-c","task-d"],"failedTaskIds":["task-c"],"durationMs":1200000}
{"kind":"layer.failed","schemaVersion":1,"ts":"2026-05-19T12:20:00.000Z","dagId":"decomp","layer":1,"taskIds":["task-c","task-d"],"failedTaskIds":["task-c","task-d"],"reason":"all tasks in layer failed permanently"}
{"kind":"contract.broken","schemaVersion":1,"ts":"2026-05-19T12:03:00.000Z","dagId":"decomp","taskId":"task-b","inputName":"auth-types","expectedFrom":"task-a","outputName":"auth-types","outputType":"file","reason":"output file src/auth/types.ts not found"}
{"kind":"dag.paused","schemaVersion":1,"ts":"2026-05-19T12:20:01.000Z","dagId":"decomp","dagPath":"/repo/.claude/ai/decomp.json","reason":"layer 1 failed with permanent failures","currentLayer":1,"blockedTasks":[{"taskId":"task-d","kind":"dependency-blocked","blockedBy":["task-c"],"rootFailures":["task-c"],"reason":"depends on blocked task(s): task-c"}]}
{"kind":"dag.aborted","schemaVersion":1,"ts":"2026-05-19T12:05:00.000Z","dagId":"decomp","dagPath":"/repo/.claude/ai/decomp.json","reason":"SIGINT","signal":"SIGINT"}
{"kind":"dag.base-moved","schemaVersion":1,"ts":"2026-05-19T12:10:00.000Z","dagId":"decomp","dagPath":"/repo/.claude/ai/decomp.json","previousCommit":"abc123","newCommit":"def456","branch":"feature/my-work"}
{"kind":"dag.completed","schemaVersion":1,"ts":"2026-05-19T12:30:00.000Z","dagId":"decomp","dagPath":"/repo/.claude/ai/decomp.json","totalTasks":4,"succeededTasks":4,"failedTasks":0,"durationMs":1800000,"finalState":{"status":"completed"}}
```

---

## Event Kinds

### DAG-level

| Kind             | When emitted                                       | Payload fields                                                                                | Consumer                      |
| ---------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------- |
| `dag.started`    | Executor begins a fresh or resumed run             | `dagPath`, `dagId`, `branch`, `resume`, `baseStartSha?`                                       | Reducer (sets run start time) |
| `dag.completed`  | All layers finished (success or partial)           | `dagPath`, `dagId`, `totalTasks`, `succeededTasks`, `failedTasks`, `durationMs`, `finalState` | Reducer, human                |
| `dag.paused`     | Layer/backlog fails and executor stops (resumable) | `dagPath`, `dagId`, `reason`, `currentLayer`, `cause?`, `blockedTasks?`, `quota?`             | Reducer, human                |
| `dag.aborted`    | SIGINT / SIGTERM received or fatal internal error  | `dagPath`, `dagId`, `reason`, `signal`                                                        | Reducer, human                |
| `dag.base-moved` | Base branch HEAD changed between layer runs        | `dagPath`, `dagId`, `previousCommit`, `newCommit`, `branch`                                   | Reducer (abort trigger)       |

### Layer-level

| Kind                            | When emitted                                                          | Payload fields                                                          | Consumer                                       |
| ------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------- |
| `layer.started`                 | Executor begins dispatching a layer                                   | `dagId`, `layer`, `taskIds`                                             | Reducer, human                                 |
| `layer.completed`               | All tasks in layer succeeded                                          | `dagId`, `layer`, `taskIds`, `durationMs`                               | Reducer                                        |
| `layer.completed-with-failures` | Layer done but ≥1 task failed permanently (others passed)             | `dagId`, `layer`, `taskIds`, `failedTaskIds`, `durationMs`              | Reducer, human (partial-layer result)          |
| `layer.failed`                  | All tasks in layer failed permanently                                 | `dagId`, `layer`, `taskIds`, `failedTaskIds`, `reason`                  | Reducer (triggers `dag.paused`)                |
| `layer.verification-failed`     | Merged-whole (Tier-2) verification failed on this layer's merged main | `dagId`, `layer`, `taskIds`, `verificationKind`, `reason`, `durationMs` | Reducer (informational; triggers `dag.paused`) |

### Task-level

| Kind                       | When emitted                                                             | Payload fields                                                                                             | Consumer                                                 |
| -------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `task.started`             | Executor begins running a task                                           | `dagId`, `taskId`, `taskName`, `layer`, `worktreePath?`, `worktreeBranch?`                                 | Reducer (marks task in-progress)                         |
| `task.completed`           | Task finished successfully                                               | `dagId`, `taskId`, `taskName`, `layer`, `durationMs`, `usage`, `filesModified`, `truncated?`, `finalState` | Reducer, retry policy (→ `succeeded`)                    |
| `task.failed`              | Task threw a non-timeout error                                           | `dagId`, `taskId`, `taskName`, `layer`, `error`, `durationMs`, `usage?`, `finalState`                      | Reducer, retry policy (→ retry or permanent)             |
| `task.timeout`             | Task exceeded its weight-derived wall-clock deadline                     | `dagId`, `taskId`, `taskName`, `layer`, `timeoutMs`, `durationMs`, `usage?`, `finalState`                  | Reducer, retry policy (progressive backoff)              |
| `task.verification-failed` | Task's changes failed Tier-1 verification after the fix budget was spent | `dagId`, `taskId`, `taskName`, `layer`, `verificationKind`, `error`, `durationMs`, `usage?`, `finalState`  | Reducer, retry policy (→ permanent; worktree not merged) |
| `task.retry`               | Retry policy decided to re-run the task                                  | `dagId`, `taskId`, `taskName`, `layer`, `attempt`, `delayMs?`, `reason`, `previousError?`                  | Reducer (resets task for next run)                       |
| `task.reset`               | `--rerun=<id>` was requested for this task                               | `dagId`, `taskId`, `taskName`, `layer`, `previousStatus`, `reason`                                         | Reducer (clears task state; policy restarts)             |

> **Note on `task.completed`.`filesModified`**: capped at 20 entries (`FILES_MODIFIED_CAP`). When the actual list is longer, `truncated: true` is set and the full list is available in `.state.json`.

> **Note on `task.failed` vs `task.timeout` vs `task.verification-failed`**: these are deliberately distinct kinds because retry policy differs. `task.timeout` uses progressive backoff (30 s → 90 s → permanent). `task.failed` uses transient-vs-non-transient classification. `task.verification-failed` is always permanent (the in-task fix budget is already spent) and is classified ahead of the default `succeeded` fall-through so the broken worktree is never merged. Never conflate them.

### Worktree-level

| Kind               | When emitted                                      | Payload fields                                                                                                 | Consumer                          |
| ------------------ | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `worktree.created` | `git worktree add` succeeded for a task           | `dagId`, `taskId`, `worktreePath`, `branch`, `baseBranch`                                                      | Reducer (records worktree active) |
| `worktree.merged`  | Task branch merged back into base branch          | `dagId`, `taskId`, `worktreePath`, `branch`, `targetBranch`, `filesChanged`, `baseShaBefore?`, `baseShaAfter?` | Reducer, human (audit trail)      |
| `worktree.removed` | `git worktree remove` + `git branch -D` completed | `dagId`, `taskId`, `worktreePath`, `branch`, `reason`                                                          | Reducer (clears worktree record)  |

`worktree.removed.reason` values:

- `"merged"` — normal cleanup after successful merge
- `"cleanup"` — removed during abort/cleanup path
- `"error"` — removed because an error prevented merge

### Contract-level

| Kind                | When emitted                                   | Payload fields                                                                       | Consumer                          |
| ------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------- |
| `contract.verified` | An output contract from a prior task was found | `dagId`, `taskId`, `outputName`, `outputKind`                                        | Reducer                           |
| `contract.broken`   | A required input from a prior task is missing  | `dagId`, `taskId`, `inputName`, `expectedFrom`, `outputName`, `outputType`, `reason` | Reducer (task → failed, no retry) |

Input contracts are source-routed: each input's `source` must be a known direct dependency, and the input name is resolved only against that source task's like-named output. Same-named outputs from unrelated tasks do not satisfy the contract.

---

## Retry Policy

The retry policy (`src/policy/retry.ts`) is a pure function — no I/O, no `Date.now()`. It reads the event log for a specific task and returns a `Decision`:

```
Decision =
  | { kind: 'retry';     delayMs: number }
  | { kind: 'permanent'; reason: 'timeout-exhausted' | 'non-transient' }
  | { kind: 'succeeded' }
```

### Rules

| Trigger                                        | Decision                                | Emits        |
| ---------------------------------------------- | --------------------------------------- | ------------ |
| `task.completed` (any)                         | `succeeded`                             | —            |
| 1st consecutive `task.timeout`                 | `retry`, 30 000 ms delay                | `task.retry` |
| 2nd consecutive `task.timeout`                 | `retry`, 90 000 ms delay                | `task.retry` |
| 3rd consecutive `task.timeout`                 | `permanent`, reason `timeout-exhausted` | —            |
| `task.failed` with transient error message     | `retry`, 30 000 ms delay                | `task.retry` |
| `task.failed` with non-transient error message | `permanent`, reason `non-transient`     | —            |

### Transient error patterns

An error message is classified as transient if it matches any of:

| Pattern                              | Examples                            |
| ------------------------------------ | ----------------------------------- |
| `/rate.?limit/i`                     | "rate limit exceeded", "rate-limit" |
| `/5\d\d/`                            | "500 Internal Server Error", "503"  |
| `/ECONNRESET\|ETIMEDOUT\|ENOTFOUND/` | Node.js network errors              |
| `/overloaded/i`                      | "model overloaded, try again"       |

Everything else is non-transient and results in permanent failure.

### Timeout streak counting

The streak counter walks the event log newest-to-oldest, counting consecutive `task.timeout` events for the target task. The streak resets at `task.completed`, `task.failed`, or `task.reset`. `task.retry` and `task.started` events do **not** reset the streak — they are administrative.

### Weights and per-task deadlines

| Weight     | Deadline |
| ---------- | -------- |
| `trivial`  | 5 min    |
| `standard` | 15 min   |
| `heavy`    | 30 min   |

---

## Worktree Safety

### Concurrency lock

At startup, the executor acquires `<dagPath>.lock` (format: `{"pid": <n>, "startedAt": "<ISO>"}`).

- If the lock exists and the recorded PID is **alive** (`process.kill(pid, 0)` succeeds): the executor refuses to run with an error.
- If the lock exists and the recorded PID is **dead** (`ESRCH`): the executor logs a warning and reclaims the lock.
- The lock is released on `process.exit` and `SIGINT`.

> **Known edge case**: twice-Ctrl+C (force-kill before the exit handler fires) leaves a dangling `.lock` file. Delete it manually: `rm <dagPath>.lock`.

### Unmerged-branch guard

`createWorktreeSafe` checks whether `dag/<taskId>` already has unmerged commits vs the base branch:

```sh
git rev-list dag/<taskId> ^<baseBranch>
```

If unmerged commits exist:

- Without `--force-worktree-reset=<taskId>`: the executor **refuses** to clobber the branch and exits with an error.
- With `--force-worktree-reset=<taskId>`: the executor warns and proceeds, discarding the unmerged commits.

### Base-commit pin

At DAG start, the executor records the base branch HEAD SHA. Before merging each layer, it re-checks `git rev-parse refs/heads/<baseBranch>`. If the SHA changed:

1. A `dag.base-moved` event is emitted with `previousCommit` and `newCommit`.
2. The DAG execution is aborted.

Rationale: merging a task branch into a moved base can introduce conflicts or invalidate prior task outputs.

### Worktree lifecycle

```
task.started
  → createWorktreeSafe (git worktree add .worktrees/<taskId> -b dag/<taskId> <baseBranch>)
  → worktree.created emitted

task completes → git merge dag/<taskId> --no-edit
  → worktree.merged emitted
  → git worktree remove + git branch -D
  → worktree.removed emitted (reason: "merged")
```

Stale worktrees from a previous run are force-removed before creating a new one (only after the unmerged-branch guard passes).

---

## CLI Flags

### Local UI

Open Loom Home to see every registered project:

```sh
dag-executor --ui
```

Register or refresh a project and open its dashboard directly:

```sh
dag-executor --ui --project=/path/to/project
```

The command prints its local address, for example:

```text
DAG UI listening on http://127.0.0.1:51234
```

Project registration is stored in `${LOOM_ARTIFACTS_DIR:-/Users/nikita/Desktop/repos/dag-executor-artifacts}/projects/<slug>/project.json`. Existing artifact projects with a documented `Target repo:` line in their `README.md` remain visible as legacy entries. The dashboard shows the registered display name as the project identity; the full path is secondary metadata on Loom Home.

Within a project, Loom discovers only validated DAG JSON files, reads their event and state artifacts, shows machine-wide executor slot usage, and stores local todo items in `.dag-executor/ui-inbox.json`. Unrelated JSON such as package, plugin, and marketplace manifests is ignored instead of appearing as invalid DAGs.

The DAG navigation separates work into **Active** (not started, running, paused, or failed), **History** (completed), and **Archived**. Archiving a completed DAG is non-destructive: it records reversible UI metadata under the central project's `runs/ui-dag-archive.json` and does not move, delete, truncate, or rewrite the DAG, event log, state snapshot, plans, inbox links, or run evidence. Restore returns it to History.

Executor monitoring remains read-only. The browser does not directly start, stop, resume, rerun, or reorder executor tasks; edit DAGs; mutate state or event files; or run arbitrary git commands. Approved agent intake uses the controlled Loom runner paths described below.

#### Agent intake

Todos added in the UI are triaged against bounded project context. Clearly relevant, low-risk, high-confidence trivial or small work can run sequentially through Loom without creating a DAG. Medium, large, ambiguous, risky, or unrelated work waits for clarification or approval; work that benefits from decomposition is proposed as a DAG and enters the supervisor queue only after approval.

The Runs view monitors sequential and DAG work together. Sequential runs show their plan, implementation, verification, and review phases plus bounded redacted logs. DAG runs retain the backlog, task, and event views.

Local intake state is stored under:

```text
.dag-executor/ui-inbox.json
.dag-executor/intake/plans/
.dag-executor/intake/runs/
```

Only one sequential runner mutates a project at a time. Automatic execution requires a git repository with no project changes other than UI-owned `.dag-executor/` artifacts. A crashed run that leaves project changes requires inspection and is never automatically relaunched. Disable `Auto-run easy work` in the UI to keep triage enabled while requiring approval for every execution.

Sequential intake uses `gpt-5.6-terra` with medium reasoning and requires the Loom plugin to be installed. Triage uses `gpt-5.6-luna`/low, while DAG planning reserves `gpt-5.6-sol`/high for dependency design. DAG proposals use the existing `loom-supervisor` queue.

```
dag-executor <decomposition.json> [flags]
```

| Flag                             | Default                   | Description                                                                                      |
| -------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------ |
| `--ui`                           | false                     | Start the localhost operations UI instead of executing a DAG                                     |
| `--project=<path>`               | none                      | Register/refresh a project and select it when starting `--ui`; omit it to open Loom Home         |
| `--port=<port>`                  | ephemeral                 | Localhost port for `--ui` (`0` lets the OS choose)                                               |
| `--resume`                       | false                     | Resume a paused run from the event log                                                           |
| `--dry-run`                      | false                     | Print estimated task costs and exit without executing                                            |
| `--backlog`                      | false                     | Run dependency-ready tasks from the DAG as a persistent backlog instead of strict layer barriers |
| `--slots`                        | false                     | Print machine-wide slot snapshot and exit (no DAG argument needed)                               |
| `--dag-readiness`                | false                     | Check decomposition quality and exit without executing                                           |
| `--skip-dag-readiness`           | false                     | Bypass the default decomposition quality gate before execution                                   |
| `--metrics <log...>`             | —                         | Summarize one or more `.events.jsonl` logs and exit                                              |
| `--human`                        | false                     | Render `--metrics` output as a human-readable report                                             |
| `--diff-view <dag>`              | —                         | Render a self-contained HTML diff view for a completed DAG run                                   |
| `--no-open`                      | false                     | With `--diff-view`, write the HTML path without opening a browser                                |
| `--provider=codex\|claude`       | codex                     | Choose provider backend                                                                          |
| `--model=<model>`                 | weight-aware              | Codex defaults to Terra for standard/trivial and Sol for heavy; an explicit model overrides both |
| `--rerun=id1,id2`                | —                         | Re-execute specific tasks (emits `task.reset` before re-running)                                 |
| `--force-worktree-reset=id1,id2` | —                         | Allow clobbering unmerged branches for the listed task IDs                                       |
| `--test-cmd=<cmd>`               | detected                  | Override the verification test command (else auto-detected from `package.json`)                  |
| `--lint-cmd=<cmd>`               | detected                  | Override the verification lint command                                                           |
| `--typecheck-cmd=<cmd>`          | detected                  | Override the verification typecheck command                                                      |
| `--no-verify`                    | false                     | Disable both verification tiers entirely                                                         |
| `--memory=<path>`                | `.dag-executor/memory.md` | Use a specific curated project memory file for task prompts                                      |
| `--no-memory`                    | false                     | Disable curated project memory prompt injection                                                  |

Completed and paused runs are archived best-effort to `~/.dag-executor/corpus` for later metrics/review. Override with `DAG_EXECUTOR_CORPUS_DIR=<dir>` or disable with `DAG_EXECUTOR_NO_CORPUS=1`.

### DAG readiness gate

Before execution, the CLI rejects decompositions that violate the prompt-level `/decompose` quality rules: oversized tasks, cross-module scopes, missing or mismatched contracts, missing context files, behavioral outputs without automated checks, and uncovered acceptance criteria. Run the gate directly with:

```sh
dag-executor --dag-readiness path/to/decomposition.json
```

Use `--skip-dag-readiness` only when intentionally running a legacy or hand-authored DAG that does not satisfy the stricter agent-sized-task checks.

### Verification gates

After a task's session, the executor runs the target repo's **detected** test / lint / typecheck commands against the changes (Tier 1, per-task, before commit — re-invoking the session up to twice with the failures), and again on merged main after each layer (Tier 2, pause-on-fail). Commands are detected from the package manager + `package.json` scripts — **never defaulted to yarn**. A check that can't be detected (and has no override) is **skipped with a warning**, never a false failure; a fresh worktree without `node_modules` likewise skips JS checks, so Tier 2 on merged main is the real backstop. Override a command with `--test-cmd`/`--lint-cmd`/`--typecheck-cmd` (raw, whitespace-split, run as-is), or turn the whole thing off with `--no-verify`. Formatters are deliberately not in the gate set. Verification failures are a distinct, permanent event (`task.verification-failed` / `layer.verification-failed`) — never transient-retried.

### Backlog mode

Backlog mode (`--backlog`) uses dependency-driven ready-work scheduling: each task still runs in its own worktree and is merged through the same safety gates, but newly unblocked tasks can start as soon as their dependencies merge instead of waiting for unrelated same-round work. Permanent failures block only their dependency descendants; unrelated ready tasks continue. When no runnable task remains, `dag.paused.blockedTasks` and `.state.json.blockedTasks` distinguish direct `permanent-failure` tasks from transitive `dependency-blocked` tasks.

Resume is still event-log based:

```sh
dag-executor <dagPath> --backlog --resume
```

Quota / usage-limit errors pause the run instead of retrying in a tight loop. The pause event and derived state include `quota` metadata when retry policy can classify the provider message: `category`, original `reason`, and optional `resetAt` / `retryAfterMs`. After the account limit resets, run the same command with `--resume`; completed and merged tasks are skipped, and the quota-blocked task is attempted again.

### Loom supervisor

For day-long unattended backlog runs, use the narrow supervisor wrapper:

```sh
loom-day-run <dagPath> --provider=codex
```

`loom-day-run` starts a detached `loom-supervisor` process. The supervisor runs `dag-executor <dagPath> --backlog`, then supervises the run:

- completed DAG creates or reuses a `loom/<dag>-<sha>` feature branch, pushes it, opens a GitHub PR, records the URL in the checkpoint, and exits `0`
- quota / usage-limit pauses wait and retry with `--resume`, preferring `dag.paused.quota.resetAt` / `retryAfterMs` when available
- process crashes wait and restart with `--resume`
- ordinary pauses such as merge conflicts or verification failures stop with exit `2`

Automatic PR creation requires an authenticated GitHub CLI (`gh`). Pass `--no-create-pr` (or set `LOOM_SUPERVISOR_CREATE_PR=0`) when a run should stop after merging the DAG commits. `LOOM_SUPERVISOR_PR_BASE` and `LOOM_SUPERVISOR_PR_REMOTE` override the DAG base branch and the default `origin` remote.

The supervisor writes a checkpoint next to the DAG at `<dag>.supervisor.json`, including `nextRunAt` for waits and quota metadata when available. It writes the detached supervisor log at `<dag-dir>/.loom-supervisor/supervisor.log`, and logs attempts under `<dag-dir>/.loom-supervisor/logs/`.

Foreground mode is still available:

```sh
loom-supervisor <dagPath> --provider=codex
```

Detached runs refuse to start a second active supervisor for the same DAG. Use `--force-detach` only after checking the old PID is stale.

Before starting, the supervisor runs preflight checks: DAG JSON validation, `dag-executor` / provider CLI / `git` / `gh` availability, stale DAG lock and supervisor PID detection, a git worktree creation probe, dirty-repo detection, and a cheap provider `--version` smoke check. Dirty repos are blocked by default; pass `--allow-dirty-repo` only when the current working tree state is intentional.

Stop a detached run:

```sh
loom-supervisor --stop <dagPath>
```

Check run status:

```sh
loom-status <dagPath>
# or: loom-supervisor --status <dagPath>
```

Status output includes the supervisor state, attempt number, last exit code, last attempt log, next retry time, latest pause reason, PR status/URL, and DAG task counts. It exits non-zero when the checkpoint is missing or the run is blocked.

### Multi-DAG queue

For all-day runs across more than one DAG, `loom-supervisor` also has a persistent queue. The default queue file is `.loom-supervisor/queue.json`; override it with `--queue=<path>` or `LOOM_SUPERVISOR_QUEUE`.

Add DAGs with optional priority and normal `dag-executor` flags:

```sh
loom-supervisor --queue-add path/to/a.json --priority=10 --provider=codex
loom-supervisor --queue-add path/to/b.json --priority=1 --provider=codex
```

Run the queue in the foreground, or detach it:

```sh
loom-supervisor --queue-run
loom-supervisor --queue-run --detach
```

The queue worker claims the highest-priority queued item, runs the existing single-DAG supervisor for that DAG, records the final item status, then takes the next queued item. Queue state is written atomically and protected by a short lock file so restarts can recover stale `running` items.

Manage queue items:

```sh
loom-supervisor --queue-status
loom-supervisor --queue-pause <item-id>
loom-supervisor --queue-resume <item-id>
loom-supervisor --queue-cancel <item-id>
loom-supervisor --queue-priority <item-id> 20
```

On macOS, detached runs use `caffeinate` when available so the machine does not sleep mid-run.

Useful knobs:

```sh
LOOM_SUPERVISOR_MAX_WALLCLOCK_SEC=86400
LOOM_SUPERVISOR_QUOTA_DELAY_SEC=1800
LOOM_SUPERVISOR_CRASH_DELAY_SEC=60
LOOM_SUPERVISOR_CHECKPOINT=/path/to/status.json
LOOM_SUPERVISOR_LOG_DIR=/path/to/logs
LOOM_SUPERVISOR_DETACH_LOG=/path/to/supervisor.log
```

### Provider models

Codex is the default provider. Omit `--model` to use the token-efficient weight-aware policy: `gpt-5.6-terra` for standard/trivial workers and `gpt-5.6-sol` for heavy workers. Pass `--model=account-default` to deliberately use the authenticated account configuration for every weight, or pass an explicit Codex model ID to override both worker tiers.

When `--provider=claude` is explicitly selected, the legacy aliases remain available:

| Alias    | Resolved model              |
| -------- | --------------------------- |
| `opus`   | `claude-opus-4-8`           |
| `sonnet` | `claude-sonnet-4-6`         |
| `haiku`  | `claude-haiku-4-5-20251001` |

Full model IDs supported by the selected provider are also accepted.

---

## Troubleshooting

### "Lock conflict: dag-executor is already running"

Another executor process (PID printed in the error) holds the lock on this DAG file. If that process is not running:

```sh
rm <dagPath>.lock
```

### "Cannot resume — no event log found"

`--resume` requires `.events.jsonl` to exist. If only `.state.json` exists (e.g. the event log was deleted), the executor refuses to resume — start a fresh run without `--resume`. If neither file exists, `--resume` silently starts a fresh run.

### "Refusing to clobber branch: it has unmerged commits"

A prior run left unmerged commits on `dag/<taskId>`. Options:

1. Merge the branch manually: `git checkout <baseBranch> && git merge dag/<taskId>`
2. Delete it and re-run: `git branch -D dag/<taskId>` then re-run without `--force-worktree-reset`
3. Discard and force-reset: `--force-worktree-reset=<taskId>` (loses the prior work)

### "dag.base-moved" — DAG aborted unexpectedly

The base branch moved while the DAG was running (a push, a merge, etc.). Fix the base branch state and resume:

```sh
# Check what changed
git log <previousCommit>..<newCommit> --oneline

# Then resume (executor will re-check the base)
dag-executor <dagPath> --resume
```

### Event log parse error

A line in `.events.jsonl` failed JSON parsing (typically a partial write from a force-killed process). The error reports the offending line number. The culprit is almost always the trailing partial line — drop it manually:

```sh
# macOS
sed -i '' '$d' <dagPath>.events.jsonl
# Linux
sed -i '$d' <dagPath>.events.jsonl
```

Then resume with `--resume`.
