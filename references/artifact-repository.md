# Artifact Repository

Loom uses a central artifact repository for durable project knowledge:

```text
/Users/nikita/Desktop/repos/dag-executor-artifacts
```

Use `LOOM_ARTIFACTS_DIR` as the artifact root when it is set.

## Layout

```text
projects/
  <project-slug>/
    specs/
    plans/
    decompositions/
    reviews/
    runs/
    risk-register/
      registry.json
      risk-YYYY-MM-DD-<scan-slug>.md
```

## Project Slug

Use the target repository directory name as the default slug. Read `projects/<project-slug>/README.md` first when present. If the user explicitly names a different project, use that project folder when it exists.

## Lookup Order

1. Resolve the artifact root and target project slug.
2. Read the central project README when present.
3. Search the relevant central `specs/`, `plans/`, `decompositions/`, `reviews/`, `runs/`, and `risk-register/` directories.
4. For specs, plans, decompositions, reviews, and run context only, fall back to `.claude/ai/`, `.codex/ai/`, `docs/superpowers/specs/`, and `docs/superpowers/plans/`.
5. Prefer the newest approved matching artifact when no explicit path is supplied.

Risk reports and `registry.json` are durable central artifacts. Never fall back to project-local storage for risk-scan output.

## Write Policy

- Write durable specs, plans, and risk-scan artifacts to the central repository.
- A project-local copy is allowed only when an executor explicitly requires it; this exception does not apply to risk reports or registries.
- Risk reports are immutable. Create them exclusively and choose a collision-free basename; never truncate or overwrite an existing report.
- Registry updates must go through `loom-risk-helper registry-merge`. On validation or persistence failure, retain the immutable report and surface the error.
- Do not delete or move artifacts unless the user explicitly asks.

## Minimum Project Index

Each project README may summarize the target repo path, active specs/plans, product direction, and deferred backlog themes.
