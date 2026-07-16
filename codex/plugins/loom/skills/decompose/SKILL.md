---
name: decompose
description: "Decompose an approved implementation plan into a DAG JSON for dag-executor. Use when work should be split into parallelizable tasks with dependencies, ownership boundaries, and verification criteria."
---

# Decompose

Model policy: use `gpt-5.6-sol` with high reasoning because dependency design and contract coverage are judgment-heavy.

Create a DAG from an approved plan.

## Artifact Repository

Before locating a plan or writing decomposition outputs, load `../../references/artifact-repository.md`. Prefer central plans under `projects/<project-slug>/plans/`.

## Workflow

1. Read the plan fully. If no plan path is provided, find the newest central `projects/<project-slug>/plans/plan-*.md`, then fall back to `.claude/ai/plan-*.md`, and confirm.
2. Identify independent implementation units, dependency edges, and verification contracts.
3. Keep tasks cohesive and reviewable. Do not split tightly coupled edits just to increase parallelism.
4. Write the execution artifacts under the target project's `.claude/ai/` directory:
   - `.claude/ai/decomposition-YYYY-MM-DD-description.json`
   - `.claude/ai/decomposition-YYYY-MM-DD-description.md`
5. Also keep durable copies under `projects/<project-slug>/decompositions/` in the central artifact repository.
6. Update plan frontmatter `decomposition_path` to the project-local JSON path. The executor must never be linked only to the central copy.

When invoked from a plan preflight, always write and link a schema-valid result. If analysis yields one task, preserve it as a one-task **analysis artifact** so measured mode can select sequential; do not claim it is parallel execution. Forced DAG must still pass `dag-executor --dag-readiness` and its `too-few-tasks` gate. Automatic mode selection hard-stops if the linked artifact remains absent or invalid.

## DAG Contract

Emit the executor's complete `DecompositionDAG` shape (mirroring `src/types.ts` and the Zod validator), not a reduced planning summary:

```json
{
  "meta": {
    "id": "feature-slug",
    "source": {
      "type": "description",
      "title": "Feature title",
      "description": "Approved plan summary",
      "figmaUrls": [],
      "acceptanceCriteria": ["Observable acceptance criterion"]
    },
    "createdAt": "ISO-8601 timestamp",
    "gitCommit": "current commit SHA",
    "branch": "current branch",
    "qualityReport": {
      "iterations": 1,
      "checksRun": ["contracts", "dependencies", "acceptance-coverage"],
      "allPassed": true
    }
  },
  "tasks": [
    {
      "id": "task-id",
      "name": "Short title",
      "description": "Concrete implementation work",
      "dependencies": [],
      "contracts": {
        "inputs": {},
        "outputs": {
          "implementation": {
            "kind": "file",
            "path": "src/example.ts",
            "description": "Implemented behavior"
          }
        }
      },
      "context": { "files": ["src/example.ts"] },
      "completionCriteria": {
        "automated": ["npm test"],
        "manual": []
      },
      "estimatedScope": "single-component",
      "weight": "standard"
    }
  ],
  "executionLayers": [
    { "layer": 0, "description": "Independent implementation", "taskIds": ["task-id"] }
  ]
}
```

Allowed `estimatedScope` values are `single-component`, `multi-file`, and `cross-module`; allowed weights are `trivial`, `standard`, and `heavy`. Before finishing, require `dag-executor --decomposition-stats <project-local-json>` to succeed. Require `dag-executor --dag-readiness` only when execution is being forced to DAG; a one-task analysis artifact is intentionally stats-valid but readiness-invalid.
