# Auto-Step Phase Bodies — Mechanical Phases (2, 4, 5, 6)

Reusable phase-body prose for the `/auto-step` supervisor. Each section is a
self-contained headless script fragment — it reads the current checkpoint,
executes that phase's logic in **verdict-only** ingestion mode (numbers and
markers only, never diffs or firehoses), writes the updated checkpoint, and
exits with a status code the supervisor can branch on.

**Default model for all mechanical phases: `sonnet`.**  
The supervisor reads the actual model from `checkpoint.models` at dispatch time.
These phases are orchestration glue (read verdicts, branch on flags, write
state) — no generative reasoning, no heavy lifting.

**Checkpoint helper**: `dag-checkpoint` (dag-executor plugin bin/, on PATH)  
**Checkpoint schema**: `references/auto-run-checkpoint.md` in the dag-executor plugin

---

## Phase 2 — Mode Selection

### Purpose

Compute DAG vs sequential based on the decomposition shape and write the
decision back to the checkpoint. This is the sole place that sets `mode` and
`dagPath` — all downstream phases read those fields rather than re-deriving
them.

### Entry

```bash
CKPT=".claude/ai/auto-run-${SLUG}.json"
PLAN_PATH=$(dag-checkpoint get "$CKPT" planPath)
```

Read `planPath` from the checkpoint. All other inputs (decomposition JSON) are
derived from the plan file.

### Ingestion contract (verdict-only)

Read `decomposition_path` from the plan's YAML frontmatter, then derive the three
mode-selection inputs **programmatically** — do NOT load the decomposition body
into the prompt and eyeball it (a model misread `has_heavy` and wrongly parked a
DAG-worthy run; that is the bug this shell-out closes):

```bash
DECOMP_PATH=$(...)  # decomposition_path from plan frontmatter
dag-executor --decomposition-stats "$DECOMP_PATH"
# stdout: {"task_count":N,"max_width":N,"has_heavy":<bool>}  (exit 0)
```

The subcommand derives `task_count` / `max_width` / `has_heavy` from the
Zod-validated DAG (`tasks.length` / `max(layer.taskIds.length)` /
`some(weight==='heavy')`), so they cannot drift from what the executor runs.
Parse the three values from its stdout JSON; never hold the full body.

The launcher preflight must already have ensured a linked decomposition. If the
plan has no `decomposition_path`, the file does not exist, or the subcommand
exits non-zero, write `status:"error"` without advancing the phase and exit 1.
Never manufacture zero-valued statistics from missing evidence.

### Decision logic

The promotion thresholds are defined **authoritatively** in
`skills/auto-implement/SKILL.md` in the dag-executor plugin Phase 2 (Mode Selection) — read that
section and apply it verbatim. Do not copy the thresholds here: this section
previously duplicated them, and two independent copies of the mode-promotion
contract drift on the next threshold change.

Respect the explicit DAG override from the supervisor-level invocation stored in
the checkpoint: if `forceMode` is `'dag'`, skip the math and use DAG directly.
The only other valid value is `null`; supervised sequential forcing is unsupported.

Log the decision verbatim (to stderr / audit trail):

```
Mode: [dag|sequential] (auto) — task_count=N, max_width=N, has_heavy=[true|false]
```

### Checkpoint writes

```bash
# Sequential path — fail-closed: the headless supervisor implements DAG mode
# ONLY. Do NOT advance to `mode-selected` (that phase routes into the
# dag-executor CLI, which has no dagPath to run on the sequential path and would
# silently halt). Instead, record the decision and PARK for an operator gate.
# phase stays at `mode-selection`; dagPath stays null.
dag-checkpoint merge "$CKPT" \
  '{"mode":"sequential","status":"needs-decision","pendingGate":"sequential-not-supported"}'

# DAG path — dagPath is the decomposition_path value from plan frontmatter
dag-checkpoint merge "$CKPT" \
  "{\"mode\":\"dag\",\"dagPath\":\"${DECOMP_PATH}\",\"phase\":\"mode-selected\",\"status\":\"running\"}"
```

`dagPath` being non-null is how the supervisor knows Phase 3 must be a CLI
`/implement-dag` run rather than an in-session `/implement-plan` call.

**Sequential is not supported by the headless supervisor.** The supervised
relaunch loop implements DAG mode only. When Phase 2 resolves `sequential`, it
fails closed: it writes `mode:"sequential"` but does **not** advance the phase,
parking at the `sequential-not-supported` gate instead. The operator resolves
the gate by either:

- restarting through inline `/auto-implement` for the measured sequential plan, or
- replying `abort` to stop the run.

A sequential run must never reach `mode-selected` with a null `dagPath`.

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | Decision written successfully. DAG path: phase advanced to `mode-selected`; supervisor proceeds to Phase 3. Sequential path: `status:needs-decision` + `pendingGate:sequential-not-supported` written and phase left at `mode-selection`; supervisor parks at the gate (it does NOT advance). |
| `1` | Checkpoint read/write failure, plan unreadable, or ensured decomposition missing/invalid; phase writes `status:error` and supervisor must inspect. |

---

## Phase 4 — Figma Verification (Post-Merge Diff)

### Purpose

Surface drift between the merged code and the Figma source of truth by running
`figma-differ` against modified components. Findings are advisory — they are
picked up automatically by `/code-review` in Phase 8. This phase never blocks
or hangs; it always writes an aggregate summary and advances.

### Entry

```bash
CKPT=".claude/ai/auto-run-${SLUG}.json"
PLAN_PATH=$(dag-checkpoint get "$CKPT" planPath)
```

### Ingestion contract (verdict-only)

At the end of this phase the checkpoint receives **one string**: the
phase-status marker from the aggregate summary. Never the diffs, never
per-component report content. The four valid marker values (verbatim — grep
targets for `/code-review`):

```
figma diff phase ran
no components had figmaRef — nothing to diff
no decomposition_path in plan frontmatter — figma diff phase skipped
figma MCP disconnected — figma diff phase skipped explicitly
```

### Execution steps

1. **Collect modified components**  
   `git diff --name-only [base]...HEAD` → filter to `.tsx` files that have a
   sibling `style.ts` in the same directory. Skip all others silently.

2. **Resolve `figmaRef` per component**  
   Read `decomposition_path` from the plan's YAML frontmatter. The supervised
   launcher ensured it before checkpoint init, so missing or unreadable data is
   a hard error here; write `status:"error"` and exit 1 rather than recording a
   successful Figma skip.
   Otherwise load the decomposition JSON and match each modified component path
   against `task.context.files` entries. Pull `task.context.figmaRef` from the
   matching task. Skip components whose task has no `figmaRef` (silent, noted
   in summary). Build working list as `(componentPath, figmaRef)` pairs.  
   If the working list is empty after this step, skip to step 6 with marker
   `"no components had figmaRef — nothing to diff"`.

3. **Check Figma MCP connectivity — once, before the component loop**  
   Call `mcp__figma-console__figma_get_status` exactly once.

   - **Connected and ready**: continue to step 4.
   - **Disconnected (headless context)**:  
     Write aggregate summary (step 6) with marker
     `"figma MCP disconnected — figma diff phase skipped explicitly"` and
     **advance immediately — do not hang, do not pause, do not prompt**.  
     Figma MCP in a bare `claude -p` headless session requires the Figma
     desktop app + Console plugin running and connected to the local WebSocket
     bridge; if they are not, there is no mechanism to reconnect
     non-interactively. Logging the skip is the correct behavior —
     `/code-review` detects this marker in Phase 8 and notes the missing diff
     context in its report.

4. **Construct Figma URL per component**  
   Use `figmaRef.url` directly when present. If `figmaRef.url` is absent, skip
   that component and note `"no figmaRef.url — cannot construct Figma URL"` in
   the aggregate summary.

5. **Spawn `figma-differ` per component (parallel)**  
   Use the standard Agent-tool multi-call-in-one-message pattern. Each
   invocation receives `(figma_url, component_path)`. Each agent writes its own
   per-component report to `.claude/ai/figma-diff-YYYY-MM-DD-{component-name}.md`.

6. **Write aggregate summary**  
   Always write `.claude/ai/figma-diff-summary-YYYY-MM-DD-{plan-slug}.md` —
   even when skipped. The file MUST contain exactly one of the four phase-status
   marker strings as a top-level line. Beyond the marker: list diffed
   components (paths to per-component reports), skipped components (with
   reason), and any aggregate observations.

### Checkpoint writes

```bash
dag-checkpoint merge "$CKPT" \
  "{\"phase\":\"figma-verified\",\"status\":\"running\",\"figmaMarker\":\"${MARKER}\"}"
```

`figmaMarker` is informational — the supervisor does not branch on it, but
storing it means a crashed resume can identify the prior skip reason without
re-reading the summary file.

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | Phase complete (ran, skipped, or MCP-disconnected skip); supervisor advances to Phase 5. |
| `1` | Checkpoint write failure or unrecoverable tool error; supervisor must inspect. |

---

## Phase 5 — Cleanup

### Purpose

Fix TypeScript errors, ESLint violations, and formatting issues in files touched
by the branch. Best-effort — always continues regardless of remaining hard
errors.

### Entry

```bash
CKPT=".claude/ai/auto-run-${SLUG}.json"
RUN_MODE=$(dag-checkpoint get "$CKPT" runMode)   # human | autonomous
```

### Ingestion contract (verdict-only)

After the cleanup skill completes, parse its summary output for **counts only**:

| Symbol | Source |
|--------|--------|
| `files_fixed` | Number of files where auto-fix made changes. |
| `errors_remaining` | Number of errors the auto-fixer could not resolve (hard errors). |
| `errors_skipped` | Hard errors classified as skipped (autonomous path). |

Never ingest file diffs, full error logs, or per-file detail. These counts are
sufficient for the checkpoint record and for the audit log.

### Execution steps

1. **Run `/cleanup`**  
   In headless autonomous mode, prepend the instruction:  
   > "Skip Step 7 (Handle Hard Errors) entirely — classify all remaining
   > errors as skipped and proceed directly to Step 8. Do not prompt for user
   > input."  
   The cleanup skill handles: ESLint + Prettier auto-fix (scoped to touched
   files), TypeScript + ESLint error detection, automatic fixing of easy errors,
   and (in human mode) prompting for hard errors.

2. **Parse cleanup summary** for `files_fixed`, `errors_remaining`,
   `errors_skipped`.

3. **Commit cleanup changes**  
   ```bash
   git add -u  # stage modifications to already-tracked touched files (no TTY prompt)
   git commit -m "dag-executor: cleanup"
   ```
   Commit even when `files_fixed === 0` (idempotent; gives Phase 6 a clean
   revert target).

### Checkpoint writes

```bash
dag-checkpoint merge "$CKPT" \
  "{\"phase\":\"cleaned\",\"status\":\"running\",\"cleanupSummary\":{\"filesFixed\":${FILES_FIXED},\"errorsRemaining\":${ERRORS_REMAINING},\"errorsSkipped\":${ERRORS_SKIPPED}}}"
```

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | Cleanup complete (with or without remaining hard errors); supervisor advances to Phase 6. Cleanup is always best-effort — remaining hard errors are not a phase failure. |
| `1` | `/cleanup` itself crashed (tool error), or checkpoint write failure; supervisor must inspect. |

---

## Phase 6 — Simplify

### Purpose

Remove bloat, unnecessary abstractions, and over-engineering introduced during
implementation. Runs as a **separate agent with fresh context** — no knowledge
of implementation decisions, pure code-quality evaluation. If the simplifier
breaks tests, revert and log; always continue to Phase 7.

### Entry

```bash
CKPT=".claude/ai/auto-run-${SLUG}.json"
```

### Ingestion contract (verdict-only)

After the code-simplifier agent and the test run complete, the checkpoint
receives **one flag**:

| Symbol | Value |
|--------|-------|
| `simplifyOutcome` | `'kept'` — simplifications kept (tests passed) \| `'reverted'` — simplifications reverted (tests failed) |

Never ingest the simplifier's diff, its change descriptions, or the full test
output. The binary kept/reverted outcome is sufficient.

### Execution steps

1. **Collect modified source files**  
   ```bash
   git diff --name-only develop...HEAD
   ```
   Filter to `.ts` and `.tsx` files. Exclude configs (e.g. `*.config.*`),
   snapshot files (`*.snap`), and generated files (`src/gql/`, codegen output).

2. **Spawn `code-simplifier:code-simplifier` agent**  
   Pass the filtered file list with this prompt (verbatim):
   ```
   Review the following files that were modified on this branch and simplify them.
   Focus on: removing unnecessary abstractions, reducing nesting, eliminating redundant
   code, consolidating related logic, and ensuring the code follows project conventions
   from CLAUDE.md.

   Modified files:
   [list from step 1]

   Rules:
   - Do NOT change functionality or behavior
   - Do NOT add new features or expand scope
   - Do NOT remove or weaken tests
   - Do NOT touch files that were not modified on this branch
   - Prefer clarity over brevity — explicit code beats clever one-liners
   ```

3. **Test bail**  
   ```bash
   yarn test --bail --changedSince=develop
   ```
   - **Tests pass**: `simplifyOutcome='kept'`. Simplifications are kept.
   - **Tests fail**: revert simplification changes:
     ```bash
     git checkout -- [files that the simplifier modified]
     ```
     Set `simplifyOutcome='reverted'`. Log:
     `"Simplification reverted — broke tests"`. Continue to Phase 7.

### Checkpoint writes

```bash
dag-checkpoint merge "$CKPT" \
  "{\"phase\":\"simplified\",\"status\":\"running\",\"simplifyOutcome\":\"${OUTCOME}\"}"
```

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | Phase complete — simplifications kept or reverted cleanly; supervisor advances to Phase 7. A test-fail + revert is a normal outcome, not a phase failure. |
| `1` | code-simplifier agent crashed, git revert failed, or checkpoint write failure; supervisor must inspect. |

---

## Cross-Phase Notes

### Checkpoint read pattern (all phases)

Every phase reads only the fields it needs at the top of its script:

```bash
FIELD=$(dag-checkpoint get "$CKPT" fieldName)
```

Use `merge` for multi-field writes to avoid clobbering concurrent chat-session
writes to `decision`.

### No-hang guarantee (Phase 4 specifically)

The pause-on-disconnected-MCP behavior in the interactive `/auto-implement`
Phase 4 is **not present** in the headless phase body. Bare `claude -p`
sessions cannot prompt for reconnection. The skip-with-marker path is the only
valid headless branch when `figma_get_status` reports disconnected.

### Model selection

The supervisor reads `checkpoint.models` and passes `--model` to the
`claude -p` invocation. The phase bodies do not hard-code a model — they
document that `sonnet` is the **default** if the `models` map has no entry for
the phase role. Override via the `models` map written at `/auto-run` init, or
via `--dag-model` on the original `/auto-implement` invocation (mapped to the
executor's `--model=` flag — the executor CLI itself has no `--dag-model`, and
`/auto-step` takes no model argument).
