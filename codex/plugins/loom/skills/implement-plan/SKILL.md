---
name: implement-plan
description: "Execute an approved implementation plan phase by phase with test, lint, and typecheck verification. Use when the user says implement the plan, start implementing, execute plan, or provides a plan file path."
---

# Implement Plan

**MANDATORY session model: sonnet.** This is the implementation tier — sonnet handles plan-driven coding with full quality. Opus wastes tokens on mechanical plan execution; haiku is too weak for code edits. Switch via `/model sonnet` before invoking.

You are tasked with implementing an approved technical plan. These plans contain phases with specific changes and success criteria.

## Artifact Repository

Before locating a plan or related review, load `../../references/artifact-repository.md`. Prefer central artifacts under `projects/<project-slug>/` over project-local `.claude/ai/` unless the user gives an explicit path. If the next executor step needs a project-local path, copy or reference the central artifact into `.claude/ai/` rather than moving it.

## Getting Started

When given a plan path:

- Read the plan completely and check for any existing checkmarks (`- [x]`)
- Read the source spec/ticket (the plan's `spec_path` frontmatter, if present) and all files mentioned in the plan
- **Read files fully** — never use limit/offset parameters, you need complete context
- Think deeply about how the pieces fit together
- Create a todo list to track your progress
- Run **Step 0: Bootstrap** (below) to learn this repo's verification commands before you write any code
- Start implementing once you understand what needs to be done

If no plan path is provided, ask for one.

## Step 0: Bootstrap — learn THIS repo's verification commands

This skill ships in a portable plugin and must not assume a package manager, test runner, or toolchain. Before verifying anything, derive the repo's own commands **once** and reuse them for the whole run:

1. Read `CLAUDE.md` / `AGENTS.md` / `README` / `CONTRIBUTING` at the repo root — projects usually document their build/test/lint/typecheck commands there. Trust an explicit "Commands" section over inference.
2. Identify the toolchain from the manifest:
   - `package.json` → JS/TS. Read `scripts` for the real command names (`test`, `lint`, `typecheck`/`lintTypes`, `build`, `format`). Pick the package manager from the lockfile: `yarn.lock`→`yarn`, `pnpm-lock.yaml`→`pnpm`, `package-lock.json`→`npm run`, `bun.lockb`→`bun run`. Do **not** assume yarn.
   - `pyproject.toml` / `setup.cfg` → Python (`pytest`, `ruff`/`flake8`, `mypy`).
   - `go.mod` → Go (`go test ./...`, `go vet`, `golangci-lint`).
   - `Cargo.toml` → Rust (`cargo test`, `cargo clippy`, `cargo fmt --check`).
   - `Makefile` / `Justfile` → prefer documented targets (`make test`, `make lint`) over raw tool calls.
3. Record the resolved commands: **test**, **lint**, **typecheck**, **format** (any may be absent). An absent check is **skipped**, never faked. If a command can't be derived and isn't documented, note it and move on — do not invent one.

Everywhere below that says "the repo's test/lint/typecheck command", use what Step 0 resolved — not a hardcoded `yarn …`.

## Parameters

Parse from the invocation:

- **Plan path** (required): Path to an approved `.claude/ai/plan-*.md` file
- **Review path** (optional): A second path argument triggers fix-from-review mode
- **`--verify-simulator`** (optional, frontend/mobile only): After each phase, capture a simulator/device screenshot and check devtools logs for runtime errors. **Availability-gated** — see [Simulator Verification](#simulator-verification-when---verify-simulator-is-set). Skipped silently in repos without the required MCP tooling.
- **`--orchestrated`** (optional, internal): Set by `/auto-implement`'s inline path. Suppresses this skill's own finalize chain (simplify → fix-loop), leaving **only** the final `/code-review` step — because the orchestrator owns simplify (its Phase 6) and the fix loop (Phase 9). **Omit it when invoking `/implement-plan` directly**: standalone runs the full self-contained finalize chain. See [After Implementation is Complete](#after-implementation-is-complete).
- **`--max-retries N`** (optional, default `2`): Cap on the standalone finalize fix-loop iterations. Ignored under `--orchestrated`.

## Fix-from-Review Mode

When a review file path is also provided (in addition to the plan path), you are in **fix mode** — applying targeted fixes from a code review rather than implementing from scratch.

### Invocation format:
```
/implement-plan <plan-path> <review-path>
```

The first argument is always the plan path. The second argument (when present) is the review file path, which triggers fix mode.

### How to operate in fix mode:

1. **Read the review file completely** — parse the YAML frontmatter and all issue sections
2. **Read the plan file** — understand the original intent so fixes stay aligned
3. **Extract all CRITICAL and WARNING items** from the review, applying adjudication filtering:
   - Note each item's file path and line number reference
   - Note the **Problem** description and **Fix** code example
   - Check for a **Triage:** tag at the end of each finding's block (written by the `/code-review` fan-out pipeline):
     - **Triage:** confirmed → include this finding (act on it)
     - **Triage:** deferred → **skip** this finding entirely (real issue but deferred out of scope)
     - **Triage:** rejected → **skip** this finding entirely (false positive, reviewer misread)
     - No **Triage:** line present → include (back-compat: un-triaged review files are treated the same as confirmed)
   - SUGGESTIONS have no **Triage:** tags — always include them (unchanged behavior)
4. **For each included issue, in priority order** (CRITICAL first, then WARNINGS, skipping any deferred or rejected):
   - Navigate to the referenced file and line
   - Read surrounding context to understand the code
   - Apply the suggested fix, adapting it if the exact code has shifted
   - If the review's suggested fix doesn't apply cleanly, use your judgment to achieve the same goal
5. **Re-run affected tests** (the repo's test command from Step 0) after each batch of related fixes
6. **Run lint + format** only on files you modified, using the repo's commands from Step 0
7. **Update the plan checkboxes** if fixes change previously completed items

### Fix mode guardrails:

- **Do NOT re-implement phases** that passed review — only fix flagged issues
- **Do NOT change code** that wasn't flagged in the review unless it's directly required by a fix
- If a fix requires changes beyond the scope of the original plan, STOP and explain the situation
- If a suggested fix seems wrong or would break other things, explain why and propose an alternative
- **Fix mode does NOT run the [finalize chain](#after-implementation-is-complete)** (simplify / code-review / fix-loop). It applies the fixes and returns control to its caller — the standalone Step 3 fix-loop (or `/auto-implement` Phase 9) owns re-running review and deciding whether to loop again.

## Understand Before Changing

Before modifying any existing code, read enough of its context that no property surprises you:

1. **Read the full chain you're touching** — the target file, the modules it imports, and the callers/parents that use it. Understand every existing property, prop, option, or config that affects behavior before adding or changing one — an overlooked setting (a default, a flag, a layout/style property, a side effect) can silently conflict with your change.
2. **Search for similar implementations** — use Grep/Glob to find code with a similar purpose or shape elsewhere in the repo. If an existing component/module solves a similar problem, model your change after its approach rather than inventing a new pattern. Match the surrounding code's conventions.
3. **Trace the integration context** — understand how the thing you're changing sits inside its caller (data flow in/out, ordering, state ownership, lifecycle). A change to a leaf often has to account for assumptions made by what calls it.

This step is especially critical for changes to existing code. Plans describe the target state but may not enumerate every existing property or constraint that affects it. You must discover those yourself by reading the code.

## Implementation Philosophy

Plans are carefully designed, but reality can be messy. Your job is to:

- Follow the plan's intent while adapting to what you find
- Implement each phase fully before moving to the next
- Verify your work makes sense in the broader codebase context
- Update checkboxes in the plan as you complete sections

When things don't match the plan exactly, think about why and communicate clearly. The plan is your guide, but your judgment matters too.

If you encounter a mismatch:

- STOP and think deeply about why the plan can't be followed
- Present the issue clearly:

  ```
  Issue in Phase [N]:
  Expected: [what the plan says]
  Found: [actual situation]
  Why this matters: [explanation]

  How should I proceed?
  ```

## Verification Approach

After implementing a phase:

- **Run the success-criteria checks** using the repo's test command from Step 0.
  - **If the project ships a `test-runner` agent**, dispatch it — it returns detailed results (full error messages, stack traces). Otherwise run the test command directly via Bash and read the **complete** output (do not truncate; failures need the full trace).
  - Scope to the changed surface where the runner supports it (related-tests / changed-since); otherwise run the relevant suite.
- **For lint + format**: ONLY run on files you modified, using the repo's commands from Step 0.
  - Run the lint command per changed file (or scoped to the changed set).
  - Run the format command per changed file.
  - DO NOT lint/format the entire codebase.
- **Typecheck** if the repo has a typecheck command (Step 0) — whole-program is fine.
- An absent check (no command resolved in Step 0) is **skipped**, never faked.
- Fix any issues before proceeding, based on the detailed output.
- Update your progress in both the plan and your todos. Check off completed items in the plan file using Edit.

Don't let verification interrupt your flow — batch it at natural stopping points.

## Simulator Verification (when `--verify-simulator` is set)

> **Availability gate (frontend/mobile only).** This needs a simulator/device-control MCP and a devtools-bridge MCP, neither shipped by this plugin. If the required MCP tools are **not** connected in the current project, log `Simulator verification requested but the required MCP tooling is unavailable — skipping runtime verification.` and continue with normal test-only verification. Never block implementation on it.

When the tooling is present, after running tests for each phase also perform runtime verification:

1. **Capture a screenshot** via the simulator MCP — visually confirm the UI looks correct.
2. **Check devtools logs** in parallel: console errors (level `error`, small window — this phase only) and network 5xx failures (small window).
3. **Evaluate**: if new console errors or 5xx failures appeared since the phase started, **report them alongside the test results** and pause for the user's decision. If none, note "Runtime verification passed" and continue.
4. **Record the result** in the phase's plan-checkbox update.

## Translation / i18n Handling

> **Availability gate (i18n projects only).** If the project ships an `/add-translations` skill (or an equivalent localization flow) and the phase added user-facing text, run it after that phase to detect hardcoded strings and register translation keys. If no such skill exists, skip this — most repos have no i18n step.

## If You Get Stuck

When something isn't working as expected:

- First, make sure you've read and understood all the relevant code
- Consider whether the codebase has evolved since the plan was written
- Present the mismatch clearly and ask for guidance

Use sub-tasks sparingly — mainly for targeted debugging or exploring unfamiliar territory.

## Resuming Work

If the plan has existing checkmarks:

- Trust that completed work is done
- Pick up from the first unchecked item
- Verify previous work only if something seems off

Remember: you're implementing a solution, not just checking boxes. Keep the end goal in mind and maintain forward momentum.

## After Implementation is Complete

Once all phases are implemented, verified, and the plan checkboxes are fully checked off, run the finalize chain. Do not ask the user — just run it. **What runs depends on `--orchestrated`:**

- **`--orchestrated` set** (invoked by `/auto-implement` inline) — run **only step 2 (`/code-review`)** and stop. The orchestrator owns simplify (its Phase 6) and the fix loop (Phase 9); running them here would double the work. The review report is what `/auto-implement`'s Phase 8 consumes.
- **`--orchestrated` NOT set** (standalone `/implement-plan`) — run the **full chain, steps 1→3**, so a direct invocation is self-contained and mirrors the DAG/`auto-implement` path end to end.

### Step 1 — `/simplify` (skip under `--orchestrated`)

Quality cleanup of the changed code (reuse, simplification, efficiency, altitude). It applies its fixes to the working tree. Run this **first** so the review sees the cleaned-up code that will actually be committed, and so simplify's own edits don't land un-reviewed. (`/simplify` is quality-only — it does not hunt for bugs; that's `/code-review`'s job.) After it finishes, re-run the repo's **test** command from Step 0 as a safety gate: if the simplifications broke tests, revert only the files simplify touched (`git checkout -- <those files>`), note "Simplification reverted — broke tests", and continue. An absent test command (Step 0 resolved none) skips this gate.

### Step 2 — `/code-review` (always)

Comprehensive review of all changes made during implementation (including simplify's edits when step 1 ran). (When invoked from inside this plugin, the skill resolves as `dag-executor:code-review`; the bare `/code-review` works when no other plugin shadows it.) The review fan-out writes a fully pre-adjudicated `.claude/ai/review-*.md` report with `triaged: true`, confirmed-only counts, raw counts, and backlog tags. Parse the output path of that file — later steps read it.

**If `--orchestrated`: stop here.** The review file is what `/auto-implement`'s Phase 8 consumes.

### Step 3 — Evaluate verdict + fix-loop (skip under `--orchestrated`)

Recompute the verdict from the (post-triage when `triaged: true`, else raw) counts:

```
critical_count > 0  →  REJECTED
warning_count  > 0  →  APPROVED_WITH_CONDITIONS
else                →  APPROVED
```

Route on the recomputed verdict (the stored `verdict` field is informational):

- **APPROVED** — done. Report completion.
- **APPROVED_WITH_CONDITIONS** (warnings only, 0 critical) — done. List the warnings in the completion summary; do not fix-loop on warnings alone.
- **REJECTED** (≥1 confirmed critical) — check sub-conditions in order:
  - `plan_issue: true` → **stop**. The plan itself needs rework; tell the user to revise the plan (and re-run), do not fix-loop.
  - `fixable_by_ai: false` OR `retry_recommended: false` → **stop** and escalate to the user with the issue list; the loop won't converge.
  - otherwise (fixable + retryable) → **enter the fix-loop** below.

**Fix-loop** (only on a fixable REJECTED verdict):

1. If the retry counter has reached `--max-retries` (default 2): **stop**, summarize each attempt and what remained unfixed, and escalate to the user. Do not loop further.
2. Increment the retry counter. Re-invoke **this skill's own fix-from-review mode** — `/implement-plan <plan-path> <review-path> --orchestrated` — passing the pre-adjudicated review path. (`--orchestrated` here prevents the nested call from starting its own finalize chain; this outer loop owns it.) Fix mode applies only the `confirmed` CRITICAL/WARNING findings, skipping `deferred`/`rejected`.
3. After fixes land, return to **Step 1** (simplify → code-review → evaluate) on the updated code. The cycle repeats until APPROVED / APPROVED_WITH_CONDITIONS or the retry cap is hit.
