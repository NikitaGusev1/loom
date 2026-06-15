# Review-file contract

Single source of truth for the `.claude/ai/review-*.md` frontmatter shape and the
finding-block conventions that tie three agents together:

- **`code-reviewer`** *writes* the file (frontmatter + CRITICAL/WARNING/SUGGESTION sections).
- **`review-triager`** *edits it in place* (appends triage/backlog lines, mutates a fixed subset of frontmatter).
- **`/auto-implement` Phase 7 validation** and **Phase 8 verdict routing** *parse* it.

If any field name, value enum, or per-finding line shape changes, it must change in all
four places at once. This file is the canonical reference — the agents link here rather
than re-stating the contract divergently.

## Filename

`.claude/ai/review-YYYY-MM-DD-description.md`

When a plan exists, `description` mirrors the plan filename (drop the `plan-YYYY-MM-DD-`
prefix). Plan `plan-2026-06-08-autocommit-export-output-scope.md` →
review `review-2026-06-08-autocommit-export-output-scope.md`.

## Frontmatter

### Written by `code-reviewer` (pre-triage)

```yaml
date: <ISO 8601 with timezone>
reviewer: Claude
git_commit: <current commit hash>
branch: <current branch>
repository: dag-executor
review_type: "code-review"
tags: [code-review, quality-assurance, security]
status: complete
last_updated: <YYYY-MM-DD>
last_updated_by: Claude
related_plan: "<path to plan if found>"        # omit field entirely if none (never "None"/"")
related_research: "<path to research if found>" # omit field entirely if none
verdict: "APPROVED | APPROVED_WITH_CONDITIONS | REJECTED"
critical_count: <int>
warning_count: <int>
suggestion_count: <int>
plan_issue: <bool>
fixable_by_ai: <bool>
retry_recommended: <bool>
```

### Added/mutated by `review-triager` (post-triage)

```yaml
triaged: true
triaged_at: <ISO 8601 with timezone>
raw_critical_count: <int>   # the pre-triage critical_count, set once, preserved verbatim on re-triage
raw_warning_count: <int>    # the pre-triage warning_count, set once, preserved verbatim on re-triage
critical_count: <int>       # RECOMPUTED to count of CRITICAL findings tagged **Triage:** confirmed
warning_count: <int>        # RECOMPUTED to count of WARNING findings tagged **Triage:** confirmed
backlog_count: <int>        # count of **Backlog:** yes lines across all sections (0 valid)
```

The triager **must not touch** `verdict`, `suggestion_count`, `plan_issue`,
`fixable_by_ai`, `retry_recommended`, or any field not listed above.

## Verdict-field semantics (authoritative)

- **`verdict`** — `APPROVED` = 0 critical AND 0 warnings; `APPROVED_WITH_CONDITIONS` = 0 critical AND ≥1 warning; `REJECTED` = ≥1 critical. Phase 8 **recomputes** this from the (post-triage when present) counts — the stored field is informational.
- **`plan_issue`** — `true` if any critical issue traces to the plan's design/approach, not the implementation. Phase 8 routes plan-issue rejections to a hard stop in every mode.
- **`fixable_by_ai`** — `true` only if every critical+warning issue has a clear, localized fix needing no human judgment on business logic / security policy.
- **`retry_recommended`** — `true` if `fixable_by_ai` AND issues are implementation bugs (not design flaws) AND critical count is small (≤5) with clear fix paths. `false` if `plan_issue`, human judgment needed, or fixes too complex/numerous.

## Section headings

Three top-level sections, matched case-insensitively with optional leading emoji and
optional trailing parenthetical:

- `## CRITICAL` / `## 🚨 CRITICAL (Must Fix)`
- `## WARNINGS` / `## ⚠️ WARNINGS (Should Fix)`
- `## SUGGESTIONS` / `## 💡 SUGGESTIONS (Consider Improving)`

## Finding-block headings

Within each section, `###` blocks. All these styles are valid (convention has drifted):

- Compact: `### C1:` / `### W2:` / `### S3:`
- Expanded: `### CRITICAL 1 —` / `### WARNING 2 —` / `### SUGGESTION 3 —`
- Section-implicit: `### 1.` / `### 2 —` (C/W/S inferred from parent section)

Separators `:`, `.`, `—` all valid. Each block ends before the next `###` or section end.

## Per-finding lines appended by `review-triager`

Every CRITICAL and WARNING block gets, immediately before the next `###` / section end:

```
**Triage:** confirmed | deferred | rejected
**Reason:** <one-line rationale, optionally citing file:line>
```

Every `deferred` CRITICAL/WARNING block AND every SUGGESTION block gets:

```
**Backlog:** yes | no
**BacklogReason:** <category + measurable signal, or rejection reason>
```

SUGGESTIONS are **not** bucketed (no `**Triage:**` line) — only backlog-tagged.

## Phase 7 fail-loud invariants (what `/auto-implement` validates after triage)

- `triaged: true` and `triaged_at` present.
- `backlog_count` present, non-negative integer.
- Every CRITICAL/WARNING block has both a `**Triage:**` and a `**Reason:**` line.
- Every `**Triage:**` value ∈ {confirmed, deferred, rejected}.
- Every `deferred` CRITICAL/WARNING block has `**Backlog:**` + `**BacklogReason:**`.
- Every SUGGESTION block has `**Backlog:**` + `**BacklogReason:**` (when SUGGESTIONS non-empty).
- Every `**Backlog:**` value ∈ {yes, no}.
- `backlog_count` == actual count of `**Backlog:** yes` lines.
- Post-triage `critical_count` ≤ `raw_critical_count`; `warning_count` ≤ `raw_warning_count` (counts only shrink).
- Counts non-negative integers.

A malformed triage output is a hard fault — Phase 7 halts and the operator repairs by hand.
