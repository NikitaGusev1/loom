---
description: Fresh-context triage of CRITICAL and WARNING findings in a code-review report. Dispatches the review-triager agent to judge each finding as confirmed | deferred | rejected. Use when user says "triage", "retriage", or after a /code-review run that produced critical/warning findings.
argument-hint: <review-path>
phase: review
---

# Triage Review

Wraps the `review-triager` agent to triage CRITICAL and WARNING findings in an existing `.claude/ai/review-*.md` file. Each finding is judged in fresh context (separate from the original reviewer's session) as one of:

- **confirmed** — real, fix now
- **deferred** — real but out-of-scope or cost > value
- **rejected** — false positive (reviewer misread code or context)

The triager edits the review file in place: appends `**Triage:**` and `**Reason:**` lines to each CRITICAL/WARNING block, mutates frontmatter (sets `triaged: true`, `triaged_at: <ISO>`, initializes `raw_critical_count`/`raw_warning_count`, recomputes `critical_count`/`warning_count` to confirmed-only counts, sets `backlog_count`). The `## SUGGESTIONS` section and `verdict`/`suggestion_count`/`plan_issue`/`fixable_by_ai`/`retry_recommended` fields are preserved byte-for-byte. The full contract lives in `references/review-contract.md`.

**Standalone-runnable**: this skill can be invoked directly by the user (e.g. for retriage after manual edits) — it is not exclusive to `/auto-implement` Phase 7. `/auto-implement` Phase 7 dispatches this skill and adds its own fail-loud post-run validation on top.

## Parameters

- `<review-path>` (required, single arg) — path to a `.claude/ai/review-*.md` file. `$ARGUMENTS` carries it verbatim.

## Process

### Step 1 — Validate the path

Parse `$ARGUMENTS` as the review path. If the path does not exist or is not a regular file, print `Error: review file not found: <path>` and exit non-zero. Do not dispatch the agent.

### Step 2 — Read frontmatter

Read the YAML frontmatter at the top of the file. Extract `critical_count` and `warning_count` (integers).

### Step 3 — Skip-on-zero (write-through no-op)

If `critical_count + warning_count == 0`, print:

```
No critical or warning findings to triage — skipping (file unchanged)
```

and exit cleanly. **Do NOT** mutate the file. **Do NOT** set `triaged: true`. The file must be byte-identical pre and post invocation. Phase 8's back-compat branch handles the missing `triaged` flag correctly.

Note: skip-on-zero applies to CRITICAL/WARNING only. The triager still scans SUGGESTIONS for backlog candidates on every dispatch — but if there are zero CRITICAL/WARNING findings, this skill does not dispatch at all. Backlog extraction from a SUGGESTIONS-only review must be done by re-running with the dispatch path forced (or by editing a CRITICAL/WARNING into the file first — not currently automated).

### Step 4 — Dispatch the review-triager agent

If `critical_count + warning_count > 0`, spawn the `review-triager` agent via the Agent tool. Pass the review path as the agent's prompt input (`subagent_type: "review-triager"`, `prompt: <review-path>`). Wait for completion.

The agent edits the file in place per its system prompt (see `agents/review-triager.md` for the per-finding edit shape and frontmatter mutation contract).

### Step 5 — Print summary

After the agent returns, parse the post-triage frontmatter and print:

```
Triage complete — confirmed: <N>, deferred: <M>, rejected: <K> (raw critical/warning: <pre-triage>, post-triage: <post>); backlog candidates: <B>
```

Counts are derived from grepping `**Triage:** confirmed|deferred|rejected` against `## CRITICAL` and `## WARNINGS` sections. Backlog candidate count comes from `backlog_count` in frontmatter (sum of `**Backlog:** yes` across deferred CRITICAL/WARNING blocks plus eligible SUGGESTIONS). Idempotent re-runs preserve `raw_*` and refresh `triaged_at`.

This skill does NOT enforce post-run validation — `/auto-implement` Phase 7 layers its own fail-loud checks on top. Standalone invocation is intentionally permissive so the user can manually inspect or retriage.

## When to use

- After `/code-review` produces a report with at least one CRITICAL or WARNING finding, before running fix-from-review.
- For retriage of an already-triaged review (e.g. after manually editing buckets) — `raw_*` is preserved verbatim across re-runs; only `triaged_at` and the recomputed counts refresh.
- Triggered automatically by `/auto-implement` Phase 7 between Simplify and Evaluate Review.

## When NOT to use

- A review file with `critical_count: 0` and `warning_count: 0` — the skip path makes this a no-op anyway, but skipping the invocation entirely is fine.
- SUGGESTIONS-only triage — `confirmed | deferred | rejected` buckets are scoped to CRITICAL/WARNING. SUGGESTIONS are scanned for **backlog candidates only** (not bucketed); they pass through the fix loop unchanged.
