---
description: Orchestrate full plan → implement → review → PR flow
argument-hint: <plan-path> [--dag] [--mode human]
phase: orchestration
disable-model-invocation: true
---

# Auto Implement

**Session model — depends on substrate (see [Execution Substrate](#execution-substrate-decide-this-first-before-phase-1) below):**

- **Supervised (default)** — this chat is only a launcher + gate monitor; its context stays ≥70% free by design, so **sonnet** is sufficient. The real per-phase models come from the supervisor's map (judgment=opus, mechanical=sonnet).
- **`--inline`** — the monolithic engine threads plan state, verdicts, and ten phases through one long context; run it on **Opus 4.8** for the larger window and sharper gate judgement.

If unsure which path you'll take, `/model opus` is the safe default. Heavy subagents (`code-reviewer`, `plan-reviewer`) pin Opus 4.8 themselves regardless.

You are the entry point for the implementation pipeline. **By default you launch the supervised flow** (checkpoint + background supervisor, one phase per fresh context) and then monitor it. On `--inline` you instead run the whole pipeline in this session: orchestrate `/implement-plan` (which includes a `/code-review` step) and manage the review-fix-retry loop with configurable human oversight.

**Output**: Progress is tracked via todo list. Final output is reviewed code ready for manual PR creation via `/create-pr`.

## Parameters

Parse from `$ARGUMENTS`:

- **Plan path** (required): Path to an approved `.claude/ai/plan-*.md` file
- **Mode** (optional): `autonomous` (default) or `human`
  - Autonomous runs through the full flow, pausing only for hard stops, max-retry escalation, and plan-issue gates
  - `--mode human` or `--human` opts into human mode
- **Substrate** (optional): `--inline` forces the monolithic in-session engine (Phases 1–10 below). Default is the **supervised** flow (background supervisor, fresh context per phase) — see [Execution Substrate](#execution-substrate-decide-this-first-before-phase-1). Use `--inline` when you want one foreground context or are running a **sequential** plan (the supervisor is DAG-only).
- **DAG mode** (optional): `--dag` forces the DAG executor for parallel implementation; `--no-dag` forces the sequential `/implement-plan` path. If neither is passed, mode is **auto-decided** by the Phase 2 thresholds based on the decomposition shape. (Mode = DAG-vs-sequential; substrate = supervised-vs-inline. A sequential mode always implies `--inline`.)
  - Requires a `decomposition_path` in the plan's YAML frontmatter pointing to a `.claude/ai/decomposition-*.json` file
  - `--dag-model=opus|sonnet|haiku` sets the model for DAG agent worker sessions on the **inline** path (default: `sonnet`). In supervised mode the worker model comes from the auto-run models map (`mode-selected` key) — use `/auto-run --models` for fine control. Use `claude-opus-4-8` only when tasks are reasoning-heavy.
- **Max retries** (optional): `--max-retries N` (default: 2)
- **Verify simulator** (optional): `--verify-simulator` passes through to `/implement-plan` to enable screenshot + devtools log checks after each phase

If no plan path is provided, search `.claude/ai/` for the most recent `plan-*.md` file and confirm with the user.

## Mode Definitions

### Human Mode (default)

The orchestrator **pauses at every gate** for human approval:

- After implementation completes → show summary, wait for "continue"
- After code review → show review results, wait for decision
- After fix cycle → show what changed, wait for approval
- Before PR creation → show PR draft, wait for approval

This mode gives full visibility and control. The human can redirect, skip steps, or abort at any gate.

### Autonomous Mode

The orchestrator **runs through the full flow without pausing**, except for:

- **Hard stops** that ALWAYS require human (see Guardrails below)
- **Max retry limit exceeded** → escalates via `/handoff`
- **Plan issues detected** → always requires human to update the plan

In autonomous mode, the orchestrator logs each decision and its reasoning so the human can audit the full trail afterward.

## Dependency Availability (Hybrid plugin model — read first)

This plugin ships the **execute + judge** half of the pipeline: the `plan-reviewer`, `code-reviewer`, and `review-triager` agents, the `/cleanup`, `/code-review`, and `/triage-review` skills, the `task-decomposer` agent, and `/decompose` / `/implement-dag`. Some phases below reference agents/skills the plugin **does not** ship — they are either frontend-only or left to the consumer project. Each such phase is **availability-gated**: if the referenced agent/skill is not installed in the current project, **skip that phase and log the skip** (one line: `Phase N skipped — <agent/skill> not available in this project`), then continue. A missing optional dependency is never a hard error.

| Dependency | Used by | If absent |
|---|---|---|
| `/implement-plan` (+ fix mode) | Phase 3 sequential, Phase 9 | **Ships with this plugin** (`dag-executor:implement-plan`) — always available. The legacy consumer-supplied fallback below is retained only for projects that intentionally shadow it. |
| `figma-differ` + figma-console MCP, `--verify-simulator` | Phase 4, simulator checks | Skip (frontend-only). Phase 4 writes its summary with the skip marker. |
| `/cleanup` | Phase 5 | **Ships with this plugin** — always available. Missing repo toolchain commands are skipped inside the skill. |
| `code-simplifier` | Phase 6 | Skip + log. (Ships as a separate marketplace plugin — usually present.) |
| `/enhance-plan`, `/handoff`, `/create-pr` | Phases 8–10 escalation/terminal | If absent, surface the equivalent message inline (describe the plan issue / handoff / PR steps in the response) instead of dispatching the skill. |

The plugin-owned agents (`plan-reviewer`, `code-reviewer`, `review-triager`) and skills (`/code-review`, `/triage-review`) are always available when this plugin is enabled — Phases 1, 3 (review), 7, 8 do not gate on them.

## Execution Substrate (decide this FIRST, before Phase 1)

This skill has two substrates for running the pipeline:

- **Supervised (DEFAULT)** — launch the headless supervisor: each phase runs in a fresh `claude -p` context with a per-phase model map, the chat session only monitors gates, and the run is checkpointed/resumable. The chat context stays ≥70% free for the whole run. **Recommended.** The supervisor is **DAG-only**.
- **Inline (`--inline`)** — run Phases 1–10 below **in this session**, in one long context. This is the only substrate that supports the **sequential** (`/implement-plan`) path, so it is the fallback for plans that do not decompose.

**Routing:**

1. **Resolve mode** (DAG vs sequential) exactly as [Phase 2](#phase-2-mode-selection-dag-vs-sequential) does — honor `--dag`/`--no-dag`; otherwise peek the plan's `decomposition_path`, derive the inputs via `dag-executor --decomposition-stats "<decomposition_path>"`, and apply the Phase 2 thresholds. (This is a cheap frontmatter read + one CLI call; the supervised path re-runs the authoritative mode-selection phase itself.)
2. **Resolve substrate:**
   - `--inline` passed → **inline**.
   - else mode resolved to **sequential** → **inline** (the supervisor cannot run sequential — log `Substrate: inline — supervised flow is DAG-only and this plan resolved sequential`).
   - else (mode = DAG) → **supervised** (default).
3. **Dispatch:**
   - **Supervised** → hand off to the `/auto-run` launcher: follow the procedure in `${CLAUDE_PLUGIN_ROOT}/skills/auto-run/SKILL.md` (init checkpoint → background supervisor → monitor gates), passing the plan path, `--mode <human|autonomous>`, and the resolved models. The supervisor runs the **same** Phases 1–10 defined below — do **not** also run them here. From this point this chat session **is** the auto-run monitor: ingest only compact checkpoint fields, route gates, never read plan/diff/review bodies. (Equivalent to the user running `/auto-run <plan> …` directly.)
   - **Inline** → run the phases below in this session.

## Orchestration Flow (Phases 1–10 — the inline engine; the supervised default runs these same phases via the supervisor)

### Phase 1: Validate Plan

1. Read the plan file completely
2. Verify it has all required sections (Overview, Phases, Success Criteria)
3. Check if the plan has a `status: approved` or similar indicator in frontmatter
4. If the plan looks incomplete or unapproved:
   - **Human mode**: Ask for confirmation to proceed
   - **Autonomous mode**: STOP — never implement an unapproved plan
5. **Run the plan-reviewer agent** to validate the plan against the actual codebase:
   - Spawn an agent with `subagent_type: "plan-reviewer"` and pass the plan path
   - The reviewer checks: file references exist, API/prop assumptions match code, persist whitelist, navigation wiring, translations, testIDs
   - Parse the verdict:
     - **READY**: Proceed to Phase 3
     - **NEEDS_REVISION**: Present the reviewer's findings to the user
       - **Human mode**: Ask if they want to fix the plan first or proceed anyway
       - **Autonomous mode**: STOP — do not implement a plan with known gaps
     - **BLOCKED**: STOP in any mode — the plan has fatal issues (e.g., references nonexistent files or APIs)

### Phase 2: Mode Selection (DAG vs Sequential)

> **Authoritative copy** of the mode-promotion contract (derivation + thresholds).
> `${CLAUDE_PLUGIN_ROOT}/references/auto-step-phases-mechanical.md` and `CLAUDE.md` reference
> this section — change thresholds here only.

If `--dag` was passed: skip this phase, force DAG.
If `--no-dag` was passed: skip this phase, force sequential.
Otherwise auto-decide from the plan's `decomposition_path`:

1. If no `decomposition_path` in plan frontmatter, OR the file does not exist: sequential (no DAG possible).
2. Otherwise derive the three inputs **programmatically** — do NOT eyeball the JSON (a model misread `has_heavy` and parked a DAG-worthy run; see BACKLOG "Supervised /auto-run hardening"):
   ```bash
   dag-executor --decomposition-stats "<decomposition_path>"
   # → {"task_count":N,"max_width":N,"has_heavy":<bool>}
   ```
   `task_count`, `max_width`, `has_heavy` come straight from this JSON. The subcommand derives them from the Zod-validated DAG (`tasks.length` / `max(layer.taskIds.length)` / `some(weight==='heavy')`) so they cannot drift from what the executor runs.
3. Promote to DAG if ANY of:
   - `task_count >= 8`
   - `max_width >= 3`
   - `has_heavy === true`
4. Log the decision verbatim:
   ```
   Mode: [dag|sequential] (auto) — task_count=N, max_width=N, has_heavy=[true|false]
   ```
5. **Human mode**: present the decision and one-line rationale, allow override (`use --dag` / `use sequential`) before Phase 3.
6. **Autonomous mode**: log and proceed.

Rationale: direct sequential bias is real on borderline jobs. Math beats vibes — let task shape decide.

### Phase 3: Implement

1. Create a todo list tracking: implementation, review, fixes, PR

**If DAG mode is selected** (parallel DAG execution, via `--dag` or auto-promotion in Phase 2):

2. Read the plan's YAML frontmatter and extract the `decomposition_path` field
3. Verify the decomposition JSON file exists at that path
   - If missing, run `/decompose --plan <plan-path>` to create the decomposition from the plan
   - This skips redundant research since the plan already has file references
   - Use the resulting decomposition path for the executor
4. Run `/implement-dag` with the decomposition path and model:
   - Pass the `<decomposition-path>` as the argument
   - Pass `--model=<dag-model>` where `<dag-model>` is from `--dag-model` (default: `claude-opus-4-8`)
5. Check the exit code:

   - **Exit 0** (success): All layers completed. Proceed to review.
   - **Exit 1** (error): Validation failure or unexpected crash.
     - **Human mode**: Present the error output and ask how to proceed
     - **Autonomous mode**: STOP and create `/handoff`
   - **Exit 2** (paused): Layer failure or merge conflict. State saved for resume.

     - **Human mode**: Present the failure details and offer options:

       ```
       DAG execution paused at Layer [N].
       Reason: [failure/conflict details from output]

       Options:
       1. Fix the issue manually and resume: /implement-dag <dag-path> --resume
       2. Abort and create handoff
       3. Fall back to sequential: /implement-plan <plan-path>
       ```

     - **Autonomous mode**: STOP and create `/handoff` (merge conflicts require human judgment)

**If sequential mode is selected** (no `--dag` and Phase 2 did not promote):

> **Now plugin-shipped**: the sequential path uses `dag-executor:implement-plan`, which **ships with this plugin** — it is no longer consumer-supplied, so the sequential path is always available. (Fallback, only if a project deliberately shadows/removes it: promote to the DAG path — if the plan has a `decomposition_path`, run `/implement-dag` on it; else run `/decompose --plan <plan-path>` first, then `/implement-dag`. Tell the user. Halt only if neither path is possible.)

2. Run `/implement-plan` with the plan path **plus `--orchestrated`** (and `--verify-simulator` if specified). The `--orchestrated` flag is required: it suppresses `/implement-plan`'s own self-contained finalize chain (simplify / triage / fix-loop) so those are not double-run — this orchestrator owns simplify (Phase 6), triage (Phase 7), and the fix loop (Phase 9). It leaves only the final `/code-review` step intact.
3. The implement-plan skill handles:
   - Phase-by-phase implementation
   - Test execution via test-runner agent
   - Linting and formatting of changed files
   - Checkbox updates in the plan
   - **Final `/code-review` step** (produces `.claude/ai/review-*.md` consumed by Phases 7 and 8). Under `--orchestrated`, `/implement-plan` stops after this step — it does **not** simplify, triage, or fix-loop.

**On completion (DAG path only)**: `/implement-dag` exits without running `/code-review` — the executor only runs tasks. Run `/code-review` here to produce the `.claude/ai/review-*.md` that Phases 7 and 8 read. Skip this step on the sequential path; `/implement-plan` already produced the review. Then proceed to Phase 4.

### Phase 4: Figma Verification (Post-Merge Diff)

> **Availability gate (frontend-only)**: this phase needs the `figma-differ` agent + figma-console MCP, neither shipped by this plugin. If `figma-differ` is not available in the project, skip the entire phase: write the aggregate summary (step 6) with the phase-status marker `"no decomposition_path in plan frontmatter — figma diff phase skipped"` (or, when there is a decomposition but no figma-differ, the closest applicable skip marker) and proceed to Phase 5. Do not pause. For non-UI repos (no `.tsx`+`style.ts` components) this phase is a no-op regardless.

Run `figma-differ` against each modified component to surface drift between the implemented code and the Figma source of truth. Findings flow into Phase 8's `code-reviewer` automatically (it auto-discovers diff reports in `.claude/ai/`) — no new verdict fields, no auto-fix loop. Diffs are advisory.

This phase runs **post-merge**, after `/implement-plan` (or `--dag` execution) has completed. It is single-pass — never per-task inside worktrees.

1. **Collect modified components**:
   - Run `git diff --name-only [base]...HEAD` (base is typically `develop` or `main`; use the same base the plan was branched from)
   - Filter to `.tsx` files that have a sibling `style.ts` in the same directory (these are the components `figma-differ` knows how to diff). Skip `.tsx` files without a `style.ts` sibling silently.

2. **Resolve each component's `figmaRef`**:
   - Read the plan's YAML frontmatter and extract `decomposition_path`
   - If `decomposition_path` is missing or the file does not exist, **short-circuit the component loop** — skip steps 3–5 entirely, jump directly to step 6 to write the aggregate summary using the phase-status marker `"no decomposition_path in plan frontmatter — figma diff phase skipped"`, then proceed to Phase 5.
   - Otherwise, load the decomposition JSON. For each modified component, find the originating task by matching the component's path against entries in `task.context.files`. Pull `task.context.figmaRef` from that task.
   - Components whose originating task has no `figmaRef` are **skipped silently**. Build the working list as `(componentPath, figmaRef)` pairs only for components that have a `figmaRef`.

3. **Check Figma MCP connectivity once**:
   - Call `mcp__figma-console__figma_get_status` **exactly once**, before the per-component loop begins
   - If the status indicates connected and ready: continue to step 4
   - If MCP is disconnected, **pause in both human and autonomous modes** with the prompt below — there is no silent skip path:

     ```
     Figma MCP is not connected, but the diff phase needs it to verify [N] component(s):
     [List of (componentPath, figmaRef.url || figmaRef.nodeId) that would have been diffed]

     Options:
     1. Reconnect Figma MCP (open the file with the Console plugin running) and resume
     2. Skip the diff phase explicitly — code-reviewer will not have Figma diff context
     3. Abort
     ```

     Wait for the user's decision. On option 1, re-check status and proceed. On option 2, write the aggregate summary (step 6) using the phase-status marker `"figma MCP disconnected — figma diff phase skipped explicitly"` and proceed to Phase 5. On option 3, stop the orchestration.

4. **Construct the Figma URL per component**:
   - When `figmaRef.url` is present, use it directly. (`figma-differ` parses the `nodeId` from the URL itself in its Step 1 — pass a URL the agent can parse.)
   - When `figmaRef.url` is missing, skip that component and note it in the aggregate summary as `"no figmaRef.url — cannot construct Figma URL"`. `TaskContext` does not currently carry a Figma file key, so a `nodeId`-only ref is not enough to build a URL.

5. **Spawn `figma-differ` per component (parallel)**:
   - Use the standard Agent-tool multi-call-in-one-message pattern (one `Agent` call per component, all in a single message)
   - Each invocation receives the component's Figma URL and component file path. The agent's input contract is `(figma_url, component_path)` — `figma-differ` parses `nodeId` from the URL itself.
   - Each agent produces a per-component report at `.claude/ai/figma-diff-YYYY-MM-DD-{component-name}.md` (the agent writes the file directly via its own tools).

6. **Write the aggregate summary**:
   - Always write `.claude/ai/figma-diff-summary-YYYY-MM-DD-{plan-slug}.md`, even when the diff phase was skipped. The plan slug is the plan filename minus the `plan-YYYY-MM-DD-` prefix and `.md` suffix.
   - The summary MUST include exactly one **phase-status marker** as a top-level line (one of these verbatim strings — `code-reviewer` greps for them in Phase 8 to detect skip vs. run state):
     - `"figma diff phase ran"` — at least one component was diffed
     - `"no components had figmaRef — nothing to diff"` — the working list was empty after step 2 resolved tasks
     - `"no decomposition_path in plan frontmatter — figma diff phase skipped"` — step 2 short-circuited because the plan has no decomposition reference
     - `"figma MCP disconnected — figma diff phase skipped explicitly"` — step 3 option 2 was chosen at the MCP-disconnected prompt
   - Beyond the marker, list components diffed (with paths to per-component reports), components skipped per-component (with reason: `"no figmaRef in originating task"` or `"no figmaRef.url — cannot construct Figma URL"`), and any aggregate observations.

7. **Proceed to Phase 5**. Findings will be picked up automatically by `code-reviewer` in Phase 8 — it scans `.claude/ai/` for `figma-diff-*.md` and `figma-diff-summary-*.md` files newer than the prior review (or branch base if no prior review) and folds findings into its existing CRITICAL/WARNING/SUGGESTION classification.

**Mode behavior**: Identical in human and autonomous modes — the only pause point is the MCP-disconnected prompt in step 3. There is no verdict-shaped sub-flow; the diff is advisory and `code-reviewer` makes the final call.

### Phase 5: Cleanup

Run `/cleanup` to fix TypeScript errors, ESLint violations, and formatting issues in files touched by the branch. This is a best-effort pass that reduces noise in the code review.

1. Run `/cleanup`
2. The cleanup skill handles:
   - Auto-fix pass (ESLint + Prettier), scoped to touched files
   - TypeScript and ESLint error detection, filtered to touched files
   - Automatic fixing of easy errors (unused vars, missing imports, simple type mismatches)
   - Prompting for hard errors (complex generics, cross-file issues)
3. Parse the cleanup summary output

**Mode behavior:**

- **Human mode**: Run `/cleanup` with no special instructions — it runs normally
- **Autonomous mode**: Before running `/cleanup`, instruct: "Skip Step 7 (Handle Hard Errors) entirely — classify all remaining errors as skipped and proceed directly to Step 8. Do not prompt for user input." Log any skipped errors for the code review to catch

**On completion**: Commit any cleanup changes (`dag-executor: cleanup`) so that Phase 6 has a clean revert target. Then proceed to Phase 6.

### Phase 6: Simplify

> **Availability gate**: `code-simplifier` ships as a separate marketplace plugin (usually present). If it is not available, skip this phase and log `Phase 6 skipped — code-simplifier not available in this project`, then proceed to Phase 7.
> **Repo-command note**: step 3 below uses `yarn test --changedSince=develop` and `git diff develop...HEAD` — those are the frontend repo's conventions. Use the **current repo's** test command and default branch instead (derive from CLAUDE.md / package.json — e.g. `npm run build && npm test`, base `main`).

Run the `code-simplifier` agent to remove bloat, unnecessary abstractions, and over-engineering introduced during implementation. This is a **separate agent with fresh context** — it has no knowledge of the implementation decisions, so it evaluates the code purely on its merits.

The simplification pass is distinct from cleanup (which fixes mechanical lint/type/format issues) and from code review (which evaluates correctness and quality). Its sole job is to make the code simpler while preserving functionality.

1. Collect the list of files modified on the branch:
   - Run `git diff --name-only develop...HEAD`
   - Filter to `.ts` and `.tsx` source files (skip configs, test snapshots, generated files)
2. Spawn a `code-simplifier:code-simplifier` agent with:
   ```
   Review the following files that were modified on this branch and simplify them.
   Focus on: removing unnecessary abstractions, reducing nesting, eliminating redundant
   code, consolidating related logic, and ensuring the code follows project conventions
   from CLAUDE.md.

   Modified files:
   [list of files from step 1]

   Rules:
   - Do NOT change functionality or behavior
   - Do NOT add new features or expand scope
   - Do NOT remove or weaken tests
   - Do NOT touch files that were not modified on this branch
   - Prefer clarity over brevity — explicit code beats clever one-liners
   ```
3. After the agent completes, verify no tests broke:
   - Run `yarn test --bail --changedSince=develop` on the modified files
   - If tests fail, **revert the simplification changes** (`git checkout -- [files]`) and log "Simplification reverted — broke tests" then proceed to Phase 8
4. If tests pass, the simplifications are kept

**Mode behavior:**

- **Human mode**: Show a summary of what the simplifier changed before proceeding
- **Autonomous mode**: Proceed automatically if tests pass; revert and log if they don't

**On completion**: Proceed to Phase 7 (Triage Review).

### Phase 7: Triage Review

Run a fresh-context judgment pass on the CRITICAL and WARNING findings produced by `/code-review` (run inside `/implement-plan` on the sequential path, or run explicitly at the end of Phase 3 on the DAG path). The reviewer and the triager disagree by design: the reviewer flags everything that *might* matter; the triager — running in a separate session with no context from the original review — judges each finding as one of `confirmed | deferred | rejected`. This gates Phase 9's fix loop so retries only chase real issues, not the same-context confirmation bias of the reviewer's own re-read.

The triager **also** tags `deferred` CRITICAL/WARNING blocks and SUGGESTIONS with `**Backlog:** yes | no` per a strict allow-list (perf / memory / a11y / non-blocking security / dep risk / cross-cutting arch / test-coverage-gap / observability / correctness-deferred). `correctness-deferred` is the catch for real latent bugs the reviewer deferred because nothing triggers them under the current call-graph (e.g. state not reset on prop identity change, dormant until a second consumer reuses the instance) — `deferred` CRITICAL/WARNING only, never SUGGESTIONS. `backlog_count` lands in frontmatter for later Jira-extraction tooling. This adds zero new compute (same agent pass) and does not affect verdict routing in Phase 8 — backlog tagging is informational only.

This phase always runs after Phase 6 and before Phase 8 — even in autonomous mode. There is no opt-out: the only short-circuit is the skip-on-zero path, which leaves the review file untouched.

1. Find the most recent `.claude/ai/review-*.md` file (same lookup Phase 8 uses to find the report — Phase 7 runs before Phase 8 so it precedes Phase 8's modification check).
2. Read the YAML frontmatter; parse `critical_count` and `warning_count` as integers.
3. **Skip path** — if `critical_count + warning_count == 0`, log `No CRITICAL or WARNING findings — skipping triage` and proceed directly to Phase 8. The review file is byte-identical after this step. Do NOT set `triaged: true` (Phase 8's back-compat branch handles missing `triaged` correctly).
4. **Dispatch path** — otherwise, run `/triage-review <review-path>` and wait for completion. The skill spawns the `review-triager` agent which edits the review file in place per its system prompt.
5. **Post-run validation (fail-loud)** — halt the pipeline with a clear error if any of the following are true after the dispatch path completes:
   - The triager agent crashed or exited non-zero.
   - Frontmatter is missing `triaged: true` after the run.
   - Frontmatter is missing `triaged_at` after the run.
   - Frontmatter is missing `backlog_count` after the run, OR it is negative / non-integer.
   - Any CRITICAL or WARNING finding lacks a `**Triage:**` line OR a `**Reason:**` line.
   - Any `**Triage:**` value is not in `{confirmed, deferred, rejected}`.
   - Any `deferred` CRITICAL/WARNING block lacks a `**Backlog:**` line OR a `**BacklogReason:**` line.
   - Any SUGGESTION block lacks a `**Backlog:**` line OR a `**BacklogReason:**` line (when the SUGGESTIONS section is non-empty).
   - Any `**Backlog:**` value is not in `{yes, no}`.
   - `backlog_count` ≠ actual count of `**Backlog:** yes` lines across CRITICAL/WARNING/SUGGESTIONS sections.
   - Post-triage `critical_count > raw_critical_count` (or post-triage `warning_count > raw_warning_count`) — counts can only shrink or stay equal across the triage run.
   - Post-triage `critical_count` or `warning_count` is negative or non-integer.
6. On halt, print which validation failed and — when applicable — the specific finding (file:line of the finding's `### C<n>` / `### W<n>` / `### S<n>` or `### CRITICAL <n>` / `### WARNING <n>` / `### SUGGESTION <n>` heading — both formats supported per the triager spec). Do NOT enter Phase 8 in any failure case; the operator must repair the review by hand, then re-run.

**Mode behavior**: identical in human and autonomous modes. There is no pause and no override on the validation checks — a malformed triage output is a hard fault.

**On completion**: Proceed to Phase 8 (Evaluate Review).

### Phase 8: Evaluate Review

A review file at `.claude/ai/review-*.md` exists by this point: `/implement-plan` produces one as its final step on the sequential path, and Phase 3's DAG branch runs `/code-review` explicitly on the DAG path. This phase reads that report.

If returning from a fix cycle (Phase 9), Cleanup and Simplify may have modified code since the last review. In that case, run `/code-review` to generate a fresh review before proceeding.

1. Check if any files were modified after the latest `.claude/ai/review-*.md` timestamp (i.e., Cleanup or Simplify made changes). If no review file exists at all, that is a pipeline error — Phase 3 should have produced one; halt and surface the missing-review error rather than silently running `/code-review` here.
2. If yes, run `/code-review` to generate a fresh review
3. Find the most recent `.claude/ai/review-*.md` file (by modification time)
4. Read the review file completely
5. Parse the YAML frontmatter verdict fields:
   - `triaged`: Boolean (optional) — `true` if Phase 7 ran on this file (skip-on-zero path leaves this absent or `false`)
   - `verdict`: String — `APPROVED` | `APPROVED_WITH_CONDITIONS` | `REJECTED`
   - `critical_count`, `warning_count`, `suggestion_count`: Integer — issue counts. **When `triaged: true` is set, these values are post-triage (confirmed-only); the original raw values are preserved as `raw_critical_count` and `raw_warning_count`.** When `triaged` is missing or `false`, the values are the raw reviewer counts as-is (back-compat path, including the Phase 7 skip-on-zero short-circuit).
   - `plan_issue`: Boolean — `true` if the plan itself needs rework
   - `fixable_by_ai`: Boolean — `true` if AI can fix issues without human guidance
   - `retry_recommended`: Boolean — `true` if a retry cycle is likely to succeed
   - `backlog_count`: Integer (optional, present only when `triaged: true`) — number of `**Backlog:** yes` tags across deferred CRITICAL/WARNING + SUGGESTIONS. Informational only; does NOT affect verdict routing.
6. **Recompute `verdict` from the (post-triage when present) `critical_count` and `warning_count`** using the Path A/B/C routing logic below. The routing is unchanged; only the input fields change. Path B's autonomous-mode `warning_count ≤ 3` threshold operates on the post-triage count when `triaged: true`. The originally-stored `verdict` field in the review file is informational — always trust the recomputed value.

Based on the (recomputed) verdict, follow the appropriate path:

#### Path A: APPROVED (0 critical, 0 warnings)

→ Proceed directly to **Phase 10: Done**

#### Path B: APPROVED_WITH_CONDITIONS (0 critical, N warnings)

- **Human mode**:

  ```
  Code review passed with [N] warnings. No critical issues found.

  Warnings:
  [List warning summaries from review]

  Options:
  1. Proceed to PR (warnings will be noted in PR description)
  2. Fix warnings before PR
  3. Abort
  ```

  Wait for human decision.

- **Autonomous mode**:
  - If `warning_count` ≤ 3: Proceed to Done, note warnings in summary
  - If `warning_count` > 3: Attempt to fix warnings (go to Phase 9)

#### Path C: REJECTED (N critical issues)

Check sub-conditions:

1. **If `plan_issue: true`**:

   - ALWAYS stop regardless of mode
   - Run `/enhance-plan [plan-path] [review-path]` to guide the user through plan updates
   - After enhancement is complete, re-run: `/auto-implement [plan-path]`

2. **If `plan_issue: false` AND `fixable_by_ai: true` AND `retry_recommended: true`**:

   - **Human mode**: Show issues and ask for approval to fix
   - **Autonomous mode**: Proceed to Phase 9 (auto-fix)

3. **If `fixable_by_ai: false` OR `retry_recommended: false`**:
   - ALWAYS stop regardless of mode
   - Present the issues and escalate to human
   - Create a `/handoff` document

### Decision Flow Summary

```
Phase 1: Validate Plan
    |
    v
Phase 2: Mode Selection (auto-decide DAG vs sequential)
    |-- --dag flag --> force DAG
    |-- --no-dag flag --> force sequential
    |-- no decomposition_path --> sequential
    |-- task_count >= 8 OR max_width >= 3 OR has_heavy --> DAG
    |-- else --> sequential
    |
    v
Phase 3: Implementation Complete
    |-- sequential: /implement-plan --orchestrated (includes /code-review as final step; finalize chain suppressed — this skill owns simplify/triage/fix)
    |-- DAG: /implement-dag, then run /code-review explicitly post-execution
    |
    v
Phase 4: Figma Verification (post-merge diff)
    |-- No decomposition_path --> SKIP (still write summary noting skip)
    |-- MCP connected --> spawn figma-differ per component, write per-component + aggregate reports, continue
    |-- MCP disconnected --> PAUSE (both modes), reconnect/skip/abort
    |
    v
Phase 5: Cleanup
    |-- Auto-fix easy errors (always)
    |-- Hard errors:
    |   |-- Human mode --> Ask user (fix/skip/abort)
    |   |-- Autonomous --> Skip, log for review
    |-- Always continues (best-effort)
    |
    v
Phase 6: Simplify
    |-- Spawn code-simplifier agent on branch diff
    |-- Run tests on simplified files
    |   |-- Tests pass --> keep simplifications
    |   |-- Tests fail --> revert, log, continue
    |
    v
Phase 7: Triage Review (fresh-context judgment of CRITICAL/WARNING findings)
    |-- critical_count + warning_count == 0 --> SKIP (file unchanged, no triaged flag)
    |-- otherwise --> dispatch /triage-review --> review-triager agent edits review file in place
    |   |-- post-run validation OK --> Phase 8
    |   |-- validation fails (missing triaged/triaged_at, missing **Triage:**/**Reason:**,
    |       invalid bucket, count grew, agent crash) --> HALT (clear error, do not enter Phase 8)
    |
    v
Phase 8: Evaluate Review (reads review-*.md, recomputes verdict from post-triage counts when triaged: true)
    |-- APPROVED --> Phase 10: Done (suggest /create-pr)
    |-- APPROVED_WITH_CONDITIONS
    |   |-- Human mode --> PAUSE for human decision
    |   |-- Autonomous + warnings <= 3 --> Done (note warnings)
    |   |-- Autonomous + warnings > 3 --> Fix cycle
    |-- REJECTED
        |-- plan_issue=true --> STOP (always, any mode)
        |-- fixable_by_ai=false --> STOP (always, any mode)
        |-- retry_recommended=false --> STOP (always, any mode)
        |-- fixable + retryable
            |-- Human mode --> PAUSE, ask to fix
            |-- Autonomous --> Fix cycle
    |
    v
Phase 9: Fix Issues (retry loop)
    |-- Fix --> Phase 5: Cleanup --> Phase 6: Simplify --> Phase 8: Evaluate (repeat)
    |-- Max retries exceeded --> /handoff
```

### Phase 9: Fix Issues (Retry Loop)

1. Increment retry counter
2. Check if retry counter exceeds max retries (default: 2):

   - **If exceeded**:

     ```
     Maximum retry limit ([N]) reached. Escalating to human.

     Retry history:
     [Summary of each attempt and what was fixed/failed]
     ```

     Create `/handoff` and STOP.

3. Apply fixes using `/implement-plan` fix mode (regardless of whether `--dag` was used for initial implementation):

   - Run `/implement-plan` with BOTH the plan path AND the review file path, **plus `--orchestrated`** (so the nested fix call does not start its own finalize chain — this Phase 9 loop owns re-review via Phase 5→6→8)
   - This triggers fix-from-review mode
   - The implementer reads review issues and applies targeted fixes
   - Only flagged code is modified — no re-implementation of passing work

4. After fixes are applied, return to **Phase 5: Cleanup**
   - Cleanup and simplification run again on the updated code
   - Evaluate Review re-reads the latest review in Phase 8
   - The cycle continues until APPROVED or max retries exceeded

### Phase 10: Done

After the review passes (APPROVED or APPROVED_WITH_CONDITIONS with acceptable warnings):

```
Implementation complete. Review passed.

Summary:
- Plan: [path]
- Review: [path]
- Files modified: [count]
- Verdict: [verdict]
- Backlog candidates: [backlog_count] (from triaged review — see `**Backlog:** yes` lines in review file for Jira-extraction)

Next steps (manual):
- Review the changes: git diff main...HEAD
- Create PR when ready: /create-pr
- Extract backlog tickets: grep `**Backlog:** yes` in the review file (or run a future `/extract-backlog` skill)
```

The pipeline stops here. PR creation is a separate manual step via `/create-pr`.

## Guardrails: Always Require Human

Regardless of mode, ALWAYS stop and require human approval for:

1. **Plan changes**: If `plan_issue: true` in any review
2. **Security findings**: If the review contains security-related CRITICAL issues
3. **Scope creep**: If implementation modified files not mentioned in the plan
4. **CI/CD changes**: If any `.github/workflows/` files were modified
5. **Max retries exceeded**: After N failed fix cycles
6. **Dependency changes**: If `package.json`, `Podfile`, or `build.gradle` were modified outside of plan scope

When hitting a guardrail:

```
GUARDRAIL TRIGGERED: [reason]

[Detailed explanation of what happened and why this needs human review]

Options:
1. [Contextual option]
2. [Contextual option]
3. Abort and create handoff
```

## Logging (Autonomous Mode)

In autonomous mode, maintain an audit log throughout the orchestration. After completion (or escalation), present:

```
## Auto-Implement Audit Log

**Plan**: [path]
**Mode**: autonomous
**Started**: [timestamp]
**Completed**: [timestamp]
**Result**: [PR created / Escalated to human / Aborted]

### Decisions Made:
1. [timestamp] Implementation completed - [N] phases, [N] tests passed
2. [timestamp] Code review: [verdict] - [N] critical, [N] warnings
3. [timestamp] Decision: [what was decided and why]
...

### Files Modified:
- [list of all files changed]

### Review Reports Generated:
- [list of review file paths]
```

## Error Recovery

If any step fails unexpectedly (tool error, network issue, etc.):

1. **Do NOT retry the failed step immediately**
2. Log the error with full context
3. **Human mode**: Present the error and ask how to proceed
4. **Autonomous mode**:
   - If the error is transient (network, timeout): retry once after explaining
   - If the error is persistent: escalate to human via `/handoff`

## Example Usage

### Supervised (default — background supervisor, fresh context per phase):

```
/auto-implement .claude/ai/plan-2026-02-11-add-user-auth.md
```

### Inline monolithic engine (one foreground context):

```
/auto-implement .claude/ai/plan-2026-02-11-add-user-auth.md --inline
```

### Inline sequential plan (no decomposition → in-session `/implement-plan`):

```
/auto-implement .claude/ai/plan-2026-02-11-add-user-auth.md --inline --no-dag
```

### Force DAG mode (parallel execution):

```
/auto-implement .claude/ai/plan-2026-02-11-add-user-auth.md --dag
```

### Inline DAG with Opus 4.8 agents (reasoning-heavy tasks):

```
/auto-implement .claude/ai/plan-2026-02-11-add-user-auth.md --inline --dag --dag-model=claude-opus-4-8
```

### Autonomous mode:

```
/auto-implement .claude/ai/plan-2026-02-11-add-user-auth.md --mode autonomous
```

### DAG + autonomous:

```
/auto-implement .claude/ai/plan-2026-02-11-add-user-auth.md --dag --autonomous
```

### With custom retry limit:

```
/auto-implement .claude/ai/plan-2026-02-11-add-user-auth.md --autonomous --max-retries 5
```
