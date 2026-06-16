# Review Report Contract

This is the Codex plugin copy of Loom's review-file contract. It preserves the fields needed by Loom review and triage workflows while allowing Codex to be the reviewer.

## Filename

`.claude/ai/review-YYYY-MM-DD-description.md`

When a plan exists, the description should mirror the plan filename after removing the `plan-YYYY-MM-DD-` prefix.

## Frontmatter

```yaml
date: <ISO 8601 with timezone>
reviewer: Codex
git_commit: <current commit hash>
branch: <current branch>
repository: <repository name>
review_type: 'code-review'
tags: [code-review, quality-assurance, security]
status: complete
last_updated: <YYYY-MM-DD>
last_updated_by: Codex
related_plan: '<path to plan if found>' # omit field if none
related_research: '<path to research if found>' # omit field if none
verdict: 'APPROVED | APPROVED_WITH_CONDITIONS | REJECTED'
critical_count: <int>
warning_count: <int>
suggestion_count: <int>
plan_issue: <bool>
fixable_by_ai: <bool>
retry_recommended: <bool>
```

## Verdict Semantics

- `APPROVED`: 0 critical and 0 warnings.
- `APPROVED_WITH_CONDITIONS`: 0 critical and at least 1 warning.
- `REJECTED`: at least 1 critical.
- `plan_issue`: true when a critical issue traces to the plan's design rather than implementation.
- `fixable_by_ai`: true only when every critical and warning issue has a clear localized fix requiring no human judgment.
- `retry_recommended`: true when the issues are implementation defects, AI-fixable, and small enough for a retry cycle.

## Section Headings

Use these top-level sections:

- `## CRITICAL`
- `## WARNINGS`
- `## SUGGESTIONS`

## Finding Blocks

Use `### C1:`, `### W1:`, and `### S1:` style headings. Each block should include:

- `Issue`
- `Location`
- `Problem` or `Benefit`
- `Fix`

## Test Integrity

Test-integrity violations are always critical:

- skipped tests added to avoid failures;
- commented-out assertions;
- weakened assertions;
- test expectations changed to match broken behavior;
- irrelevant implementation solely to satisfy tests.
