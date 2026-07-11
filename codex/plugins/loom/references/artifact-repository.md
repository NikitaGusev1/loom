# Artifact Repository

Loom uses a central artifact repository for durable project knowledge:

```text
/Users/nikita/Desktop/repos/dag-executor-artifacts
```

Allow an override with `LOOM_ARTIFACTS_DIR` when present.

## Layout

```text
projects/
  <project-slug>/
    specs/
    plans/
    decompositions/
    reviews/
    runs/
```

## Project Slug

Use the target repo directory name as the default slug:

- `/Users/nikita/Desktop/repos/news-app` -> `news-app`
- `/Users/nikita/Desktop/repos/dag-executor-main` -> `dag-executor-main`

If the user names a different project, use that exact project folder when it exists. If no folder exists, create `projects/<project-slug>/` with the standard subdirectories before writing durable artifacts.

## Lookup Order

When a skill needs specs, plans, decompositions, reviews, or run knowledge:

1. Resolve the target project slug.
2. Read `projects/<slug>/README.md` in the central artifact repo when present.
3. Check the central artifact repo:
   - `projects/<slug>/specs/`
   - `projects/<slug>/plans/`
   - `projects/<slug>/decompositions/`
   - `projects/<slug>/reviews/`
   - `projects/<slug>/runs/`
4. Then check project-local working artifacts:
   - `.claude/ai/`
   - `.codex/ai/`
   - `docs/superpowers/specs/`
   - `docs/superpowers/plans/`
5. Prefer the newest approved artifact when no explicit path is provided.

## Write Policy

- Durable specs and plans should be written to the central artifact repo.
- During active implementation, it is acceptable to also copy or reference the artifact from the target repo's `.claude/ai/` when the executor expects that path.
- Keep frontmatter links stable. Prefer central paths for durable references and project-local paths only when a tool requires them.
- Do not delete or move project-local artifacts unless the user asks for cleanup.

## Minimum Project Index

Each project folder may include `README.md` summarizing:

- target repo path;
- current active specs/plans;
- MVP or product direction;
- deferred backlog themes.

Read that README first when present.
