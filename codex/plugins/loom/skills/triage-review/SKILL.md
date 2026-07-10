---
name: triage-review
description: "Triage a structured review report, classifying CRITICAL and WARNING findings as confirmed, rejected, or deferred. Use after code-review when findings need independent validation before fixes."
---

# Triage Review

Validate findings in a `.claude/ai/review-*.md` report.

## Workflow

1. Read the review file fully. If no path is provided, find the newest `.claude/ai/review-*.md`.
2. For each CRITICAL and WARNING finding:
   - inspect the cited files and lines;
   - verify whether the finding is real in the current code;
   - classify as `confirmed`, `rejected`, or `deferred`.
3. Edit the review file in place, preserving its frontmatter and report contract.
4. Update counts/verdict only if the report contract requires it and the change is unambiguous.
5. Add concise rationale for every rejected or deferred finding.

Do not fix code in this skill. Its job is judgment, not implementation.
