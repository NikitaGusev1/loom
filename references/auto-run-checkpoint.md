# Auto-Run Checkpoint Schema

Authoritative schema for the durable checkpoint that lets the auto-run supervisor and the chat session coordinate across process boundaries.

The checkpoint is the lightweight, single-JSON-snapshot analogue of the dag-executor's event-sourced state (`src/state.ts` in the Visma-Manager/dag-executor repo). It exists to answer one question: **"what state should the next supervised relaunch resume from?"** It is intentionally NOT an event log.

## Path Convention

```
.claude/ai/auto-run-<slug>.json
```

- `<slug>` is derived from the run identifier (e.g. ticket key or plan filename, kebab-cased).
- Lives under `.claude/ai/` so it survives across worktree lifecycles. **Never** place this file inside `.worktrees/task-*/` — those directories are removed after merge.
- The checkpoint is a **runtime artifact**. It must NOT appear in any task's `contracts.outputs[]` or `context.files` in the DAG: the executor force-adds declared outputs only, and a `git add -A` fallback fires only when scoped paths are empty. Keeping the checkpoint out of those lists is the mechanism that keeps it un-swept.

## Fields

| Field          | Type                              | Writer        | Purpose                                                                  |
| -------------- | --------------------------------- | ------------- | ------------------------------------------------------------------------ |
| `runId`        | string                            | supervisor    | Stable identifier for the auto-run; never changes after `init`.          |
| `planPath`     | string (repo-relative)            | supervisor    | Implementation plan markdown the run is executing.                       |
| `dagPath`      | string (repo-relative)            | supervisor    | DAG JSON (if `--dag` mode); empty/absent in sequential mode.             |
| `reviewPath`   | string (repo-relative)            | supervisor    | Most recent review artifact path, when applicable.                       |
| `phase`        | string                            | supervisor + phases | Current phase name. Enumerated values are owned by `auto-step.md`'s dispatch table (single source of truth): `validate-plan`, `mode-selection`, `mode-selected`, `reviewing`, `figma-verified`, `cleaned`, `simplified`, `evaluate-review`, `fix-issues`, plus terminal `done` / `aborted` / `error` / `needs-decision`. |
| `retryCount`   | number                            | supervisor    | Per-phase retry counter, reset on phase transitions.                     |
| `mode`         | `'sequential' \| 'dag' \| null`   | Phase 2 (Mode Selection) | Execution mode. `null` at init; set ONCE by Phase 2 from the decomposition shape. |
| `runMode`      | `'human' \| 'autonomous'`         | /auto-run init | Gate dimension: whether judgment-phase gates pause for a human decision (`human`) or auto-route (`autonomous`). Written ONCE at init; **immutable** thereafter. |
| `status`       | enum (see below)                  | supervisor + chat | High-level state.                                                    |
| `pendingGate`  | string \| null                    | supervisor + phases | Name of the gate awaiting a human decision; `null` when not gated. Gate-name vocabulary (and human-facing prompts) is owned by `/auto-run`'s gate table in `skills/auto-run/SKILL.md` in the dag-executor plugin — includes `sequential-not-supported`, which Phase 2 writes when mode selection resolves `sequential` (the headless supervisor implements DAG mode only). |
| `decision`     | string \| null                    | **chat only** | The human's verdict for the pending gate.                                |
| `models`       | object                            | /auto-run init | Model assignment per phase name (with a `default` fallback).             |
| `lastUpdated`  | ISO-8601 string                   | helper        | Stamped on every merge write by the helper.                              |

### `status` enum

```
running         - phase is executing; no human input needed.
needs-decision  - supervisor has paused; chat must write `decision` to advance.
done            - auto-run completed successfully.
aborted         - human aborted; do not resume.
error           - supervisor crashed/failed; resume requires inspection.
```

## Field Ownership / Anti-Clobber Rules

The two writers MUST NOT contend on the same field:

| Writer        | May write                                                                            | May NOT write                              |
| ------------- | ------------------------------------------------------------------------------------ | ------------------------------------------ |
| **/auto-run init** | `runId`, `planPath`, `phase` (initial), `runMode`, `mode` (initial `null`), `status` (initial `running`), `retryCount` (initial `0`), `pendingGate`/`decision` (initial `null`), `models` | — (init-time only; never re-writes after launch) |
| **chat session** | `decision`, and the `status` flip `needs-decision` -> `running` after a decision  | everything else (including `runMode`, which is immutable after init) |
| **supervisor / headless phases** | `runId`, `planPath`, `dagPath`, `reviewPath`, `phase`, `retryCount`, `mode`, `status`, `pendingGate`, `models` | `runMode` (immutable after init); `decision` (chat owns it) — **except** the consuming phase MAY reset `decision` to `null` (and ONLY to `null`) immediately after reading it on the resume path; it may never set `decision` to a non-null value |

`runMode` (gate dimension: `human`/`autonomous`) is written ONCE by `/auto-run` at init and is never overwritten by any writer. It is distinct from `mode` (execution dimension: `sequential`/`dag`), which is `null` at init and set ONCE by Phase 2. Keeping these two orthogonal dimensions in separate fields is what prevents Phase 2's `mode` write from clobbering the gate-routing flag.

Both writers go through `auto-run-checkpoint.cjs`, which performs **single-field merge** semantics (see Atomic-Write Contract). The helper itself does not enforce ownership - it ensures that whichever field you write does not disturb fields you did not touch. Owner discipline + merge semantics together guarantee no clobber.

## Atomic-Write Contract

Every write MUST be atomic and merge-aware. The helper (`scripts/auto-run-checkpoint.cjs` in the dag-executor plugin (invoke via the `dag-checkpoint` wrapper)) implements this; both writers MUST use it rather than re-rolling JSON edits in bash.

1. **Read latest** - `fs.readFileSync` of the current checkpoint (treat missing/empty as `{}`).
2. **Patch in-memory** - assign only the requested field(s) onto a shallow clone.
3. **Stamp `lastUpdated`** - ISO-8601 from helper, never from caller.
4. **Write temp file** - `<dir>/.<basename>.tmp-<pid>-<ts>-<rand>` opened with `O_CREAT|O_EXCL` (`fs.openSync(tmp, 'wx')`). Best-effort `fsync` before close.
5. **Rename over target** - `fs.renameSync(tmp, target)`. POSIX rename is atomic on the same filesystem; readers observe either the old or new file, never a half-written one.
6. **On failure** - temp file is unlinked; the previous checkpoint stays intact byte-for-byte.

The helper writes structured logs to **stderr only**. `stdout` is reserved for the requested value (so callers can safely do `VALUE=$(dag-checkpoint get <path> decision)`).

## CLI Surface

```
dag-checkpoint get   <path> <field>
dag-checkpoint set   <path> <field> <value>
dag-checkpoint merge <path> <jsonObject>
dag-checkpoint init  <path> <jsonObject>
dag-checkpoint dump  <path>
```

- `set` coerces stringy CLI values: `null`/`true`/`false`/numeric strings become typed primitives; values starting with `{` or `[` are JSON-parsed; everything else stays a string.
- `set` coerces any all-digit value to a Number (e.g. `007` becomes `7`); all-digit identifiers that must stay strings (a future all-digit slug or gate value) must go via `merge` with explicit JSON string quoting, e.g. `merge <path> '{"someField":"007"}'`.
- `set status <value>` and `merge` payloads containing `status` validate against the enum above and fail with exit code `1` on mismatch.
- `init` is a no-op when the checkpoint already exists (idempotent supervisor startup).

Exit codes: `0` ok | `1` usage/validation error | `2` IO error | `3` missing file or missing field.

## Typical Sequences

**A judgment phase records a gate and pauses** (phase names per `auto-step.md`'s
dispatch table — e.g. Phase 8 `evaluate-review` parking at the warnings gate):

```bash
dag-checkpoint merge .claude/ai/auto-run-vmm-7218.json \
  '{"status":"needs-decision","pendingGate":"warnings-gate","phase":"evaluate-review"}'
```

**Chat session writes the decision (does NOT touch phase/status until cleared by supervisor):**

```bash
dag-checkpoint set .claude/ai/auto-run-vmm-7218.json decision continue
```

**Supervisor on resume reads the decision, clears it, flips status:**

```bash
DECISION=$(dag-checkpoint get .claude/ai/auto-run-vmm-7218.json decision)
dag-checkpoint merge .claude/ai/auto-run-vmm-7218.json \
  '{"status":"running","pendingGate":null,"decision":null}'
```

## Non-Goals

- **Not an event log** - only the latest state matters; for full execution history use the dag-executor's own state files.
- **No multi-machine coordination** - POSIX rename atomicity is local-filesystem only.
- **No schema validation beyond `status`** - the helper trusts callers on field names so it can serve both writers without per-field allowlists.
