---
name: decompose
description: "Decompose an approved implementation plan into a DAG JSON for dag-executor. Use when work should be split into parallelizable tasks with dependencies, ownership boundaries, and verification criteria."
---

# Decompose

Create a DAG from an approved plan.

## Artifact Repository

Before locating a plan or writing decomposition outputs, load `../../references/artifact-repository.md`. Prefer central plans under `projects/<project-slug>/plans/`.

## Workflow

1. Read the plan fully. If no plan path is provided, find the newest central `projects/<project-slug>/plans/plan-*.md`, then fall back to `.claude/ai/plan-*.md`, and confirm.
2. Identify independent implementation units, dependency edges, and verification contracts.
3. Keep tasks cohesive and reviewable. Do not split tightly coupled edits just to increase parallelism.
4. Write:
   - `projects/<project-slug>/decompositions/decomposition-YYYY-MM-DD-description.json`
   - `projects/<project-slug>/decompositions/decomposition-YYYY-MM-DD-description.md`
5. Update the plan frontmatter `decomposition_path` if the plan is in scope and safe to edit.

## DAG Contract

Use this task shape:

```json
{
  "schemaVersion": 1,
  "tasks": [
    {
      "id": "task-id",
      "title": "Short title",
      "description": "Concrete implementation work",
      "dependencies": [],
      "files": [],
      "weight": "trivial|light|medium|heavy",
      "verification": []
    }
  ]
}
```

Before finishing, validate the JSON with the repo's DAG schema or tests when available.
