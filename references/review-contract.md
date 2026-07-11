# Review-file contract

Single source of truth for the `.claude/ai/review-*.md` frontmatter shape and the
finding-block conventions that tie the review producer to its consumers:

- **The `/code-review` pipeline** (review-finder → review-verifier → in-session
  convergence) *writes* the file, fully pre-adjudicated — frontmatter, CRITICAL/
  WARNING/SUGGESTION sections, and every per-finding triage/backlog line, in one
  pass. The skill self-validates its own output against the invariants below
  before handing the file off.
- **The `/code-review` pipeline's own self-validation** (Step 8) and **`/auto-implement`
  Phase 8 verdict routing** *parse* / enforce it.

If any field name, value enum, or per-finding line shape changes, it must change in
both places at once. This file is the canonical reference — the skill and the
consumer link here rather than re-stating the contract divergently.

Historical note: pre-fan-out review files (written by the older single-agent review
flow and separately mutated in place by a standalone triage pass) predate the current
pipeline. Their output is a strict subset of this contract's shape — see the
back-compat note under Phase 7/8, below — and still parses.

## Filename

`.claude/ai/review-YYYY-MM-DD-description.md`

When a plan exists, `description` mirrors the plan filename (drop the `plan-YYYY-MM-DD-`
prefix). Plan `plan-2026-06-08-autocommit-export-output-scope.md` →
review `review-2026-06-08-autocommit-export-output-scope.md`.

## Frontmatter

### Emitted by review-finder (pre-adjudication)

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

### Finalized by review-verifier / convergence (always present — pre-adjudicated)

```yaml
triaged: true
triaged_at: <ISO 8601 with timezone>
raw_critical_count: <int>   # the pre-triage critical_count, set once, preserved verbatim on re-triage
raw_warning_count: <int>    # the pre-triage warning_count, set once, preserved verbatim on re-triage
critical_count: <int>       # RECOMPUTED to count of CRITICAL findings tagged **Triage:** confirmed
warning_count: <int>        # RECOMPUTED to count of WARNING findings tagged **Triage:** confirmed
backlog_count: <int>        # count of **Backlog:** yes lines across all sections (0 valid)
```

`triaged: true` is set unconditionally by convergence, even when `raw_critical_count`
and `raw_warning_count` are both 0 — the pipeline never emits an un-triaged file, so
consumers can rely on a single, uniform shape rather than branching on whether triage
ran.

Convergence **must not touch** `verdict`, `suggestion_count`, `plan_issue`,
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

## Finding-ID convention

review-finder assigns every candidate finding an ID of shape `[<dim>-<sev><ordinal>]`:

- `dim` — the dimension that surfaced it, one of `C` (correctness), `S` (security),
  `T` (testing), `V` (conventions), `Q` (quality).
- `sev` — severity, one of `C` (critical), `W` (warning), `S` (suggestion).
- `ordinal` — sequential within each `dim`+`sev` pair, starting at 1.

Examples: `[C-C1]`, `[C-C2]`, `[S-W2]`, `[T-C1]`. review-verifier and convergence use
this ID to track a finding across passes; it is internal to the pipeline and does not
replace the `###` finding-block heading grammar above, which stays as-is in the
written file.

## Per-finding lines written pre-adjudicated by the `/code-review` pipeline

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

## Phase 7 fail-loud invariants (self-validated by the pipeline, re-checked by `/auto-implement`)

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

A malformed pipeline output is a hard fault — `/code-review`'s self-validation halts
before handing off, and `/auto-implement` re-checks on ingest; the operator repairs
by hand.

### Phase 8 back-compat note

Review files predating the `/code-review` fan-out pipeline (produced by the retired
single-agent review flow, before a separate triage pass mutated them in place) may
lack `triaged`/`triaged_at`/`raw_*_count`/`backlog_count` entirely.
Phase 8 treats a missing `triaged` field as "un-triaged": it falls back to the
pre-triage `critical_count`/`warning_count` and skips the triage-specific
invariants above. This is a read path only — the pipeline itself never emits
this shape.
