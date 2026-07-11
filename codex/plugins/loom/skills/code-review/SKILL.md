---
description: Conducts comprehensive code review of recent changes covering security, quality, correctness, testing, and conventions. Use when user says "review my code", "check my changes", after implementing features, or before creating a PR. Outputs a review report to .claude/ai/.
phase: review
---

# Code Review

A fan-out orchestrator: this skill runs entirely in-session (no single delegate agent). It gathers shared context once, dispatches five dimension-scoped finders in parallel, dispatches one adversarial verifier per CRITICAL/WARNING finding, converges everything in-session, and writes a single pre-adjudicated, contract-conformant review file — then self-validates its own output before returning.

> **Agent namespacing**: `review-finder` and `review-verifier` ship in the dag-executor plugin. If a bare subagent type does not resolve, use the namespaced form (`dag-executor:review-finder`, `dag-executor:review-verifier`) — same fallback pattern as `skills/explore/SKILL.md`'s `codebase-locator` dispatch.

The review-file frontmatter and finding-block shape are governed by `references/review-contract.md` — this skill populates every field the contract defines, including the post-triage set, in one pass (no separate triage step, no un-triaged intermediate file).

**Output**: Review report saved to `.claude/ai/review-YYYY-MM-DD-description.md`

## Step 1: Gather Metadata + Diff

- Collect git metadata: commit hash, branch name, repository name (from the git remote), current timestamp.
- Compute the diff scope: `git diff` and `git diff --staged`. When reviewing a whole branch's worth of work, use the merge-base against the default branch instead.
- This metadata + diff bundle is collected exactly once and reused verbatim in every finder dispatch in Step 4.

## Step 2: Derive Conventions + Run Tests (Once)

- **Load repo conventions**: read `CLAUDE.md` (root and any nested/package-level copies), plus `ARCHITECTURE.md` / `README.md` / `CONTRIBUTING.md` when present. Derive, for this repo: build/test commands and ordering gotchas (e.g. build-before-test, minimum runtime version); load-bearing invariants called out explicitly; paired invariants that must change together (emitter ↔ reducer, message string ↔ matching regex, schema ↔ mirrored type, producer ↔ consumer contract); registration/discovery steps a new artifact needs; the repo's stated module/style conventions. If the repo has no such docs, infer conventions from representative source files instead of importing conventions from another stack.
- Condense this into a short **convention digest** — this is the exact text that gets inlined into every finder's dispatch prompt in Step 4.
- **Run the repo's test command exactly once** (detected from `CLAUDE.md` / `package.json` scripts — respect any build-before-test ordering; never assume a package manager it doesn't declare). Capture pass/fail/skip counts and full failure output (error messages, stack traces). If the suite cannot run, say so explicitly rather than assuming green.
- This is the **only** test run in the entire pipeline. The captured results are inlined identically into all five finder prompts in Step 4 — finders consume them as ground truth and must not re-run tests themselves (re-running per finder would multiply cost 5x and race shared build artifacts across parallel finders).

## Step 3: Related-Docs / Figma-Diff Scan + Filename

- Search `.claude/ai/` for `plan-YYYY-MM-DD-*.md` and matching research/spec documents (by date, topic, or commit) — populates `related_plan` / `related_research` frontmatter (omit the field entirely when not found — never `"None"` or an empty string).
- Scan `.claude/ai/` for `figma-diff-*.md` files newer than the prior review (or newer than the branch base if no prior review exists) — a no-op when absent. Any flagged mismatches fold into the relevant finder's findings as extra context (no new verdict fields).
- Generate the filename: `.claude/ai/review-YYYY-MM-DD-description.md`, where `description` mirrors the related plan's filename (drop the `plan-` prefix) when a plan was found, else a descriptive kebab-case name.

## Step 4: Dispatch 5 Review-Finders (One Message, Parallel)

Dispatch all five review-finder agents in a **single message** so they run in parallel — one per dimension: Correctness (C), Security (S), Testing Integrity (T), Conventions (V), Quality (Q).

Each dispatch prompt carries all four inputs the finder's contract expects:

1. **Dimension brief** — copy the matching section of `references/review-dimensions.md` (`## C — Correctness & Silent Failures`, `## S — Security`, `## T — Testing Integrity & Behavioral Coverage`, `## V — Conventions & Paired Invariants`, `## Q — Quality & Scope Creep`) and paste its full text **verbatim** into the prompt — do not just link the file, the finder never reads it itself.
2. **Git metadata + diff scope** from Step 1.
3. **Test-suite results** from Step 2 — the same captured text in all five prompts.
4. **Convention digest** from Step 2.

Each finder returns findings as text only (no file writes), grouped by severity, each carrying an ID of shape `[<dim>-<sev><ordinal>]` per its own Finding-ID rule. Collect all five responses before proceeding.

## Step 5: Dispatch Verifiers (One Message, Parallel, Skip on Zero)

- Tally every CRITICAL and WARNING finding across all five finder responses. SUGGESTIONS are never verified.
- **If the tally is zero, skip this step entirely** — proceed to Step 6 with an empty verdict set.
- Otherwise dispatch one review-verifier agent **per** CRITICAL/WARNING finding, all in a **single message**. Each dispatch carries exactly one finding (its ID, cited `file:line`, and problem/fix text) — never a batch, never the whole review file.
- Collect each verdict: `confirmed | deferred | rejected`, a one-line reason, and an optional severity-downgrade recommendation (downgrade only — verifiers never upgrade severity).

## Step 6: In-Session Convergence

Fold the finder output and verifier verdicts into one pre-adjudicated finding set, entirely in-session:

1. **Apply verifier verdicts** — tag each CRITICAL/WARNING finding `confirmed` / `deferred` / `rejected`; apply any recommended severity downgrade.
2. **Systemic-pattern sweep** — when two or more findings across different dimensions trace to the same root cause, merge them into one escalated finding and preserve all merged IDs.
3. **Missed-by-all blind-spot check** — one more pass across all five finders' output plus the diff itself, looking for an issue no dimension caught.
4. **Dedupe cross-dimension duplicates** — the same `file:line` + root issue reported by two finders collapses to one finding; keep the more specific ID and note the duplicate.
5. **Compute `plan_issue` / `fixable_by_ai` / `retry_recommended`** from **CONFIRMED findings only** (per `references/review-contract.md`'s verdict-field semantics) — deferred and rejected findings never contribute to these three fields.
6. **Tag backlog candidates** — append `**Backlog:** yes | no` + `**BacklogReason:** ...` to every `deferred` CRITICAL/WARNING and every SUGGESTION. `yes` requires the finding to fall into one of: perf, memory, accessibility, security-non-blocking, dependency, architecture-cross-cutting, test-coverage-gap, observability, or correctness-deferred (a real bug already in the committed code with a specific named future trigger). Everything else — naming/formatting/taste, "consider extracting" without a measurable reason, documentation gaps, speculative future-proofing, anything already covered by a `confirmed` finding — is `no`. Never tag `confirmed` or `rejected` findings as backlog. When in doubt, prefer `no`.
7. **Recompute counts** — `raw_critical_count` / `raw_warning_count` = the pre-verify totals from Step 4 (set once); `critical_count` / `warning_count` = confirmed-only counts; `backlog_count` = total `**Backlog:** yes` lines.
8. **Preserve SUGGESTIONS byte-for-byte** apart from the appended `**Backlog:**` / `**BacklogReason:**` lines — no re-classification, no rephrasing.
9. **Finding IDs are preserved verbatim** from finder output into the written file — never renumbered during convergence.

## Step 7: Write the Review File

Write to the Step 3 filename with the **full post-triage field set always present** — including on a zero-finding review (uniform output; there is no separate no-op shape).

**Frontmatter**, per `references/review-contract.md`:
- Pre-adjudication: `date`, `reviewer: Claude`, `git_commit`, `branch`, `repository`, `review_type: "code-review"`, `tags`, `status: complete`, `last_updated`, `last_updated_by: Claude`, `related_plan` (omit if none), `related_research` (omit if none), `verdict`, `critical_count`, `warning_count`, `suggestion_count`, `plan_issue`, `fixable_by_ai`, `retry_recommended`.
- Always-present post-triage set: `triaged: true`, `triaged_at`, `raw_critical_count`, `raw_warning_count`, `critical_count` (recomputed, confirmed-only), `warning_count` (recomputed, confirmed-only), `backlog_count`.
- On a zero-finding review: `triaged: true` is still set, with `raw_critical_count: 0`, `raw_warning_count: 0`, `critical_count: 0`, `warning_count: 0`, and `backlog_count` reflecting any SUGGESTIONS-only backlog tags (0 if none).

**Body**: `## CRITICAL`, `## WARNINGS`, `## SUGGESTIONS` sections. Every finding block keeps its original ID and the finder's problem/fix text, plus:
- Every CRITICAL/WARNING block: `**Triage:** confirmed | deferred | rejected` + `**Reason:** <one-line>`.
- Every `deferred` CRITICAL/WARNING block, and every SUGGESTION block: `**Backlog:** yes | no` + `**BacklogReason:** <category + signal>`.
- SUGGESTIONS never get a `**Triage:**` line — they are backlog-tagged only, not bucketed.

## Step 8: Self-Validate (Fail-Loud)

Before returning, re-read the written file and check it against `references/review-contract.md`'s fail-loud invariants:

- `triaged: true` and `triaged_at` are present.
- `backlog_count` is present, a non-negative integer, and equals the actual count of `**Backlog:** yes` lines.
- Every CRITICAL/WARNING block has both a `**Triage:**` and a `**Reason:**` line.
- Every `**Triage:**` value is one of `confirmed`, `deferred`, `rejected`.
- Every `deferred` CRITICAL/WARNING block has `**Backlog:**` + `**BacklogReason:**`.
- Every SUGGESTION block has `**Backlog:**` + `**BacklogReason:**` (when SUGGESTIONS is non-empty).
- Every `**Backlog:**` value is `yes` or `no`.
- Post-triage `critical_count` ≤ `raw_critical_count`; `warning_count` ≤ `raw_warning_count`.
- All counts are non-negative integers.

**Any failed invariant is a HARD FAULT.** Do not report success, do not silently patch the file and continue as if nothing happened. Tell the user exactly which invariant failed, on which finding or line, and stop — this is a malformed-output condition the contract says must halt for manual repair, not something this skill papers over.

## Step 9: Summary

Present a concise summary to the user:
- Path to the review file.
- Verdict, plus raw and confirmed critical/warning/suggestion counts.
- Backlog candidate count.
- Any CRITICAL findings that need immediate attention.

## Important Notes

- Always run fresh git analysis — the review must reflect the current state of changes.
- The test suite runs exactly once, in Step 2 — every finder consumes those same results, none re-run it.
- The written file is always fully pre-adjudicated: a zero-CRITICAL/zero-WARNING review still carries `triaged: true` and zero counts, never an un-triaged shape.
- Finding IDs assigned by finders in Step 4 flow unchanged into the written file — convergence never renumbers them.
- A self-validation failure in Step 8 is reported to the user as a hard fault, never swallowed.
