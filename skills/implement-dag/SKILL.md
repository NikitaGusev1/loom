---
description: Executes a decomposition DAG using the dag-executor CLI. Spawns parallel Codex sessions in isolated git worktrees by default, with Claude retained as an explicit optional provider. Use when user says "run the dag", "execute dag", or provides a decomposition JSON path.
phase: implementation
disable-model-invocation: true
---

# Implement DAG

Execute a decomposition DAG with real process-level parallelism. Each task runs in its own git worktree as a separate provider session; Codex is the default.

This skill is a wrapper around the `dag-executor` binary (lives in the external [Visma-Manager/dag-executor](https://github.com/Visma-Manager/dag-executor) repo, exposed on PATH via `npm link`).

## Prerequisites

**Preflight — verify the binary is available before anything else:**

```bash
command -v dag-executor
```

If not found, set it up once (then re-check):

```bash
git clone git@github.com:Visma-Manager/dag-executor.git ~/Desktop/repos/dag-executor
cd ~/Desktop/repos/dag-executor
npm install && npm run build && npm link
```

> **nvm/volta caveat**: `npm link` installs into the *active* node version's global prefix. If the binary disappears after a node version switch, re-run `npm link` from the dag-executor repo. After pulling tool updates, `npm run build` is enough (no re-link).

## Parameters

Parse from `$ARGUMENTS`:

- **DAG path** (required): Path to a `.claude/ai/decomposition-*.json` file
- **`--dry-run`** (optional): Validate the DAG and show execution plan without spawning sessions
- **`--provider=codex|claude`** (optional): Provider backend (default: `codex`).
- **`--model=<id>`** (optional): explicit model supported by the selected provider (default for Codex: `gpt-5.6-terra`; heavy workers use `gpt-5.6-sol` when no override is supplied).
- **`--resume`** (optional): Resume from a previous interrupted execution
- **`--rerun=id1,id2`** (optional): Re-execute specific tasks from a previous run. Resets those tasks to pending and starts from the earliest affected layer. Other completed tasks in the same layer are skipped. Requires an existing state file.

## Usage

### Dry run — validate and preview

```bash
dag-executor <dag.json> --dry-run
```

Review the output to confirm layers, tasks, dependencies, and file scopes look correct before committing to a full run.

### Execute

```bash
dag-executor <dag.json> --provider=codex
```

The executor will:

1. Validate the DAG JSON (Zod schema + cycle detection)
2. Warn if the working tree has uncommitted changes
3. For each execution layer:
   - Create git worktrees (one per task, branched from current branch)
   - Spawn parallel Codex sessions through `codex exec`
   - Auto-commit any uncommitted agent work in each worktree
   - Sequentially merge worktree branches back into the working branch
   - Verify contracts between layers (hard gate — pauses if outputs are missing)
   - Clean up worktrees and branches
4. Run tests (`--findRelatedTests`) and lint on all modified files
5. Report final status

### Resume after interruption

If execution is interrupted (Ctrl+C) or a layer fails, state is saved to a `.state.json` file next to the DAG:

```bash
dag-executor <dag.json> --resume
```

Without `--resume`, an existing state file is discarded and execution starts fresh.

## Exit codes

- **0**: All layers completed successfully
- **1**: Error (validation failure, unexpected crash)
- **2**: Paused (interrupted or layer failure, state saved for resume)

## How it works

```
Decomposition JSON → Validate → For each layer:
  1. Create git worktrees (one per task)
  2. Spawn parallel provider sessions (Codex by default)
  3. Auto-commit agent work in each worktree
  4. Sequentially merge worktree branches back
  5. Verify contracts between layers
  → Next layer → Post-execution tests/lint
```

### Key properties

- **True parallelism**: Tasks within a layer run as separate OS processes with isolated filesystems
- **Local-only**: Worktree branches (`dag/<taskId>`) are ephemeral, never pushed to remote
- **Resumable**: State persisted after each layer
- **Cooperative shutdown**: First Ctrl+C waits for current layer to finish; second force-exits

## Creating a DAG

Use `/decompose` to create a decomposition DAG from a Jira ticket or task description. The output JSON is what this skill consumes.

## Tips

- **`dag-executor --slots`** — on-demand peek at live cross-window session status (slot holders + parked waiters); reads the shared slot dir, takes no DAG arg, exits 0
- **Prefer the weight-aware defaults** (`gpt-5.6-terra` standard, `gpt-5.6-sol` heavy) unless the user explicitly selects another Codex model
- **Commit before running** — the executor merges worktree branches into your current branch; uncommitted changes may cause merge conflicts
- **Check `git log` after execution** — you'll see merge commits from each worktree branch
- **Worktrees are cleaned up automatically** — if something goes wrong, check `git worktree list` and clean up manually with `git worktree remove`
