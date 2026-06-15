---
description: Conducts comprehensive code review of recent changes covering security, quality, correctness, testing, and conventions. Use when user says "review my code", "check my changes", after implementing features, or before creating a PR. Outputs a review report to .claude/ai/.
phase: review
---

# Code Review

Use the code-reviewer agent to conduct a comprehensive review of all recent code changes. The agent examines the code for security vulnerabilities, code quality issues, correctness/reliability problems, test integrity, and convention adherence, then writes a structured report.

The review-file frontmatter and finding-block shape are governed by `references/review-contract.md` — the agent populates the verdict fields (`verdict`, `critical_count`, `warning_count`, `suggestion_count`, `plan_issue`, `fixable_by_ai`, `retry_recommended`) that `/auto-implement` Phase 8 reads.

**Output**: Review report saved to `.claude/ai/review-YYYY-MM-DD-description.md`

## Steps to follow

1. **Gather metadata for the review report:**
   - Collect git metadata (commit hash, branch name, repository name, timestamps).
   - Filename `.claude/ai/review-YYYY-MM-DD-description.md` where `YYYY-MM-DD` is today and `description` is brief kebab-case (mirror the related plan name when one exists — drop the `plan-` prefix).
     - Examples: `review-2026-06-08-autocommit-export-output-scope.md`, `review-2026-06-08-bug-fixes.md`

2. **Use the code-reviewer agent with metadata:**
   - Pass the metadata to the code-reviewer agent for structured report generation.
   - The agent examines code for security, quality, correctness, test integrity, and convention concerns.
   - The agent generates the report with proper frontmatter per `references/review-contract.md`.

3. **Save and present review completion:**
   - The agent saves the report to `.claude/ai/review-YYYY-MM-DD-description.md`.
   - Present a concise summary of findings to the user.
   - Include the path to the generated report.
   - Highlight any critical issues that require immediate attention.

## Important Notes

- Always run fresh git analysis — the review must reflect the current state of changes.
- The review report must be self-contained with all necessary context.
- Include temporal context (when the review was conducted) via metadata.
- Focus on concrete security issues, correctness/quality problems, and maintainability concerns.
- Provide specific file paths and line numbers for developer reference.
- Ensure all verdict frontmatter fields are populated per the contract — automated orchestration depends on them.
