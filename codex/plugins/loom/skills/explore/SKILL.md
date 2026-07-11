---
name: explore
description: "Explore and shape a feature or change before implementation. Use when the user wants to investigate an idea, compare approaches, turn rough requirements into a spec, or port Claude /explore behavior to Codex."
---

# Explore

Run an interactive design-and-research pass for a proposed change. The output is a spec that can feed `plan-from-spec`.

## Artifact Repository

Before reading or writing specs, load `../../references/artifact-repository.md`. Use the central artifact repo for durable project knowledge. For the active target project, read `projects/<project-slug>/README.md` when present, then inspect existing specs and plans there before writing a new spec.

## Workflow

1. Clarify the goal and constraints. Ask only the questions needed to avoid a bad design.
2. Inspect the codebase on demand:
   - use `rg`, `rg --files`, docs, tests, and nearby implementation;
   - use `tool_search` for multi-agent/subagent tools only when independent research would materially help;
   - for UI work, ask for the design source if exact visual values matter.
3. Present 2-3 viable approaches with tradeoffs and a recommendation.
4. After the user approves a direction, write the durable spec at `projects/<project-slug>/specs/spec-YYYY-MM-DD-description.md` in the central artifact repo. Also copy it to `.claude/ai/` only when the next tool requires a project-local path.
5. Include enough codebase context that `plan-from-spec` can plan without repeating broad research.

## Spec Shape

Use this structure:

```markdown
---
date: YYYY-MM-DD
author: Codex
status: approved
related_research: []
---

# <Title>

## Goal
## Non-Goals
## Current System
## Proposed Design
## Alternatives Considered
## Acceptance Criteria
## Risks and Open Questions
## Implementation Notes
```

Keep the spec concrete: file paths, APIs, data flow, edge cases, and test expectations.
