---
description: Decompose a task into a structured DAG of agent-sized subtasks
argument-hint: <VMM-XXXX | "task description"> [--max-iterations 3] [--dry-run]
phase: planning
disable-model-invocation: true
---

# Decompose Task

You are a task decomposition orchestrator. You take a large task (Jira ticket
or natural language description) and produce a structured dependency graph
(DAG) of agent-sized subtasks, each with typed contracts, scoped context,
and completion criteria.

**Output**:
- `.claude/ai/decomposition-YYYY-MM-DD-description.json` — the DAG (machine-readable)
- `.claude/ai/decomposition-YYYY-MM-DD-description.md` — summary (human-readable)

## Parameters

Parse from `$ARGUMENTS`:

- **Task source** (required): Either a Jira ticket key (e.g., `VMM-1234`) or a quoted
  natural language description
- **Max iterations** (optional): `--max-iterations N` (default: 3) — max self-critique
  loop iterations
- **Dry run** (optional): `--dry-run` — run decomposition but don't save files, just
  show the result
- **Plan path** (optional): `--plan <plan-path>` — path to an existing plan file.
  When provided, skips research (Step 2) and builds context from the plan's file
  references and architecture notes instead. Only runs Figma researcher if Figma
  URLs are present and `layoutSpec` isn't already in the plan.

If no arguments provided, respond:
```
I'll decompose a task into agent-sized subtasks. Please provide:
- A Jira ticket key (e.g., VMM-1234), or
- A natural language task description in quotes

Example: /decompose VMM-1234
Example: /decompose "Add a weekend toggle to the employee calendar"
```

## Execution Flow

### Step 1: Parse Input and Fetch Source

**If Jira ticket key provided:**

1. Fetch ticket details using `mcp__atlassian__jira_get_issue`:
   - Get `summary`, `description`, `labels`, `status`, `issuetype`, `priority`
   - Also fetch with `fields: "*all"` to capture custom fields (acceptance criteria,
     story points, linked issues)
2. Extract from the ticket description:
   - **Acceptance criteria** — look for "Acceptance Criteria", "AC:", numbered
     criteria, or checkbox lists
   - **Figma URLs** — extract any `figma.com/design/` links
   - **Referenced tickets** — extract any VMM-XXXX, ME-XXXX references
   - **Technical notes** — any code references, file paths, or API mentions
3. If linked issues exist, fetch their summaries (to understand the broader epic context)

**If natural language description provided:**

1. Parse the description as the task source
2. If the description mentions a Jira ticket (e.g., "from VMM-1234"), fetch that ticket
3. If the description mentions Figma URLs, extract them
4. Ask the user for acceptance criteria if none are apparent:
   ```
   I don't see explicit acceptance criteria in the description. To produce
   a good decomposition, I need to know what "done" looks like.

   Please provide acceptance criteria, or say "derive from description"
   and I'll infer them.
   ```

### Step 2: Gather Context

If `.dag-executor/memory.md` exists, read it before spawning research agents.
Treat it as curated project memory: selected lessons from prior DAG runs,
common failure modes, estimate corrections, or conventions that held in
practice. Include only relevant excerpts in the context bundle and cap the
included memory to roughly 6,000 characters. Never paste raw event logs,
state snapshots, or unrelated history into the bundle.

**If `--plan` was provided:**

1. Read the plan file at the given path
2. Extract file references, architecture notes, and any embedded Figma data
3. Build the context bundle directly from plan content — no research agents needed
4. Only spawn **Figma researcher** if Figma URLs are present in the source AND
   `layoutSpec` is not already populated in the plan

**If `--plan` was NOT provided:**

Spawn research agents **in parallel** to build the context bundle:

> **Agent namespacing**: `codebase-locator` and `figma-extractor` ship in the dag-executor plugin. If a bare subagent type does not resolve, use the namespaced form (e.g. `dag-executor:codebase-locator`) — same pattern as `task-decomposer` below.

1. **Codebase locator** — Find all files related to the task:
   - "Find all files related to [feature area from ticket]. Include the implementation,
     entry points, types, state/data layer, services, and tests."

2. **Figma researcher** (if Figma URLs present) — Extract design specifications:
   - Spawns `figma-extractor` agent with the Figma URLs
   - Gets token mappings, layout specs, component structure

**Wait for ALL agents to complete before proceeding.**

### Step 3: Build Context Bundle

Synthesize all research into a context bundle:

```
Context Bundle:
- source: { ticket details, acceptance criteria, figma URLs }
- codebaseResearch: { file paths, data flows, architecture notes }
- figmaContext: { tokens, layout, components } (if applicable)
- layoutSpec: { Component Hierarchy and Spacing & Layout tables from Figma analysis }
- conventions: { project conventions relevant to this task }
- projectMemory: { relevant curated lessons from `.dag-executor/memory.md`, if present }
- projectContext: { run-wide repo facts, derived once }
```

**Derive `projectContext` once.** Capture repo-level facts that are identical across
tasks in `meta.projectContext`, so executor prompts can inline them without every
spawned session re-reading the same references:
- `sharedComponents` — concise reusable UI component inventory and locations. Omit for non-UI work.
- `conventions` — run-wide conventions from root docs and research. Task-specific pitfalls still belong in each task's `context.conventions`.
- `figmaToolset` — only when the repo uses non-default Figma MCP tools.
- `themeTokensDoc` — path to the full design-token reference, as a pointer rather than an inline token dump.

Verify every path before emitting it. Do not duplicate run-wide facts into every
task's `context.conventions` or `relatedPatterns`.

**CRITICAL**: If the Figma research produced a Component Hierarchy (indented tree of
containers with flex directions, alignment, and nesting) and/or a Spacing & Layout
table, include these verbatim in the context bundle. The decomposer must pass the
relevant portions into each UI task's `context.layoutSpec` field so that implementing
agents know exactly how elements are nested and positioned.

Read ALL files identified by research agents to verify they exist and
understand their content. This is critical — the decomposer needs accurate
file references.

### Step 4: Initial Decomposition

Spawn a **task-decomposer** agent with the context bundle (ships in the dag-executor plugin — if plain `task-decomposer` does not resolve as a subagent type, use the namespaced form `dag-executor:task-decomposer`):

```
Decompose this task into a dependency graph of agent-sized subtasks.

## Source Task
[Paste ticket title, description, and acceptance criteria]

## Codebase Research
[Paste synthesized research findings with file:line references]

## Figma Context (if applicable)
[Paste design specifications]

## Conventions
[Project conventions derived from root CLAUDE.md and research — the concrete rules that constrain how tasks are implemented. Capture the ones that apply to THIS project, e.g.: module/export style, import conventions (path aliases vs relative), test file naming and location, styling approach, error-handling patterns. List the actual rules, not a generic checklist.]

## Curated Project Memory (if present)
[Paste only relevant excerpts from `.dag-executor/memory.md`. Current source task,
codebase research, and source code win on conflicts.]

Produce the full JSON DAG following the decomposition schema.
```

Parse the agent's JSON output. If the output is not valid JSON:
- Ask the agent to fix the JSON syntax
- If it fails twice, report the error and stop

### Step 5: Quality Checks

Run all 5 quality checks against the decomposition:

#### Check 1: Granularity
```
For each task in the DAG:
- Count files in context.files — flag if > 3
- Check estimatedScope — flag "cross-module" tasks
- Check description length — flag if > 3 sentences
- Check for "and" in task name — suggests multiple concerns
```
**Pass**: No tasks flagged, or all flagged tasks have justification.

#### Check 2: Contracts
```
For each task:
- Verify contracts.inputs is non-empty (except for root tasks that
  take their input from the original requirement)
- Verify contracts.outputs is non-empty
- For each input contract, verify `input.source` is a known task and is listed in
  the consumer task's `dependencies`
- For each dependency edge (task B depends on task A):
  - Verify A.contracts.outputs contains something B.contracts.inputs references
```
**Pass**: All tasks have contracts. All dependency edges have matching contracts.

#### Check 3: Dependencies
```
1. Collect all task IDs into a set
2. For each task's dependencies array:
   - Verify each referenced ID exists in the set
3. Perform topological sort:
   - If cycle detected, report the cycle path
4. Check for orphan tasks:
   - A task is orphan if it has no dependencies AND no other task depends on it
   - Root tasks (intentionally independent) are not orphans
   - Leaf tasks (final outputs) are not orphans
   - True orphans are tasks disconnected from the graph
```
**Pass**: No missing references. No cycles. No true orphans.

#### Check 4: Context
```
For each task:
- Verify context.files is non-empty
- For each file in context.files:
  - Use Glob to verify the file exists (or is marked as "new file to create")
- If the task creates new code, verify conventions are specified
```
**Pass**: All files exist or are marked as new. All new-code tasks have conventions.

#### Check 5: Coverage
```
For each acceptance criterion from the source:
- Search all tasks' completionCriteria for a match
- A criterion is "covered" if at least one task's automated or manual
  criteria addresses it
```
**Pass**: Every acceptance criterion is covered by at least one task.

### Step 6: Self-Critique Loop

```
iteration = 0
maxIterations = parsed from --max-iterations (default: 3)

while not allChecksPassed and iteration < maxIterations:
    iteration += 1

    # Run quality checks inline (no agent spawn — use Glob/Grep directly)
    failures = run checks 1-5 above using Glob, Grep, and JSON parsing

    # Only re-spawn task-decomposer if checks actually fail
    if failures:
      refinedDAG = spawn task-decomposer with:
        - The current DAG
        - The quality check results (which checks failed and why)
        - The original context bundle
        - Instruction: "Refine this decomposition to fix the failing quality checks.
          Produce the complete refined DAG as valid JSON with the same schema structure."

      currentDAG = parse(refinedDAG)
```

**If all checks pass**: Proceed to Step 7 (output generation).

**If max iterations reached with failures still present**:
```
Decomposition completed with quality warnings after [N] iterations.

Remaining issues:
- [Check name]: [What still fails and why]

The decomposition has been saved but may need manual review.
Consider:
1. Accept as-is (some checks are advisory)
2. Re-run with --max-iterations [higher N]
3. Simplify the original task description
```
Save the DAG anyway but mark `qualityReport.allPassed: false` in the metadata.

### Step 7: Generate Output Files

#### JSON DAG file

Save to `.claude/ai/decomposition-YYYY-MM-DD-description.json`:
- The full JSON DAG with metadata, tasks, and execution layers
- `description` is derived from the Jira ticket key (lowercase) or a
  kebab-case summary of the task description

#### Link the decomposition into the source plan (only when `--plan` was provided)

When `--plan <plan-path>` was passed (Step 2), write the decomposition's path
**back into the plan's YAML frontmatter** so downstream mode-selection can find
it. Without this link, `/auto-implement` Phase 2 (and the supervised `/auto-run`
Phase 2) read no `decomposition_path` → see `task_count=0` → silently route the
plan to `sequential` and park at `sequential-not-supported`. This is the only
mechanism that connects a decomposition to its plan.

Upsert the key into the plan file's `---` fenced frontmatter block:

- **Key**: `decomposition_path`, value = the **repo-relative** JSON path written
  above, quoted (e.g. `decomposition_path: ".claude/ai/decomposition-2026-06-08-foo.json"`).
- **Idempotent**: if `decomposition_path` already exists, replace its value in
  place; never add a second line.
- **Insert position**: if the key is absent, append it as the **last line of the
  frontmatter block** (immediately before the closing `---`). Never reorder or
  reformat the plan's other frontmatter keys (`spec_path`, `git_commit`, `tags`,
  …).
- Touch nothing outside the frontmatter block.

Skip this step entirely when `--plan` was not provided (a Jira-only or `--dry-run`
decomposition has no plan to link).

#### Markdown Summary file

Save to `.claude/ai/decomposition-YYYY-MM-DD-description.md`:
- YAML frontmatter with metadata
- Dependency graph visualization (text-based, showing layers)
- Per-subtask summaries with contracts and completion criteria
- Coverage mapping table
- Quality report table
- Link to the JSON file

Use this markdown template:

```markdown
---
date: [ISO timestamp]
type: decomposition-summary
source: [jira key or "description"]
json_path: .claude/ai/decomposition-YYYY-MM-DD-description.json
task_count: [N]
layer_count: [N]
quality_iterations: [N]
all_checks_passed: true
---

# Task Decomposition: [Title]

**Source**: [Jira key with link, or "User description"]
**Tasks**: [N] subtasks across [N] execution layers
**Quality**: All checks passed after [N] iterations

## Dependency Graph

Layer 0 (parallel):
  [task-id] Task name
  [task-id] Task name

Layer 1 (depends on Layer 0):
  [task-id] Task name → depends on [dep-id], [dep-id]

Layer 2 (depends on Layer 1):
  [task-id] Task name → depends on [dep-id]

## Subtasks

### [task-id] Task Name
**Scope**: single-component | **Dependencies**: none (root task)

[description]

**Inputs**: input name (type)
**Outputs**: output name (type)

**Files**: `path/to/file`, `path/to/related-file`
**Completion**: [automated + manual criteria]

---
[repeat for each task]

## Coverage Mapping

| Acceptance Criterion | Covered by |
|---|---|
| Criterion text | task-id, task-id |

## Quality Report

| Check | Result | Notes |
|---|---|---|
| Granularity | PASS | Notes |
| Contracts | PASS | Notes |
| Dependencies | PASS | Notes |
| Context | PASS | Notes |
| Coverage | PASS | Notes |
```

### Step 8: Present Results

```
## Task Decomposition Complete

**Source**: [VMM-1234: Task title] or [User description]
**Subtasks**: [N] across [M] execution layers
**Quality**: [All checks passed | N/5 checks passed after M iterations]

### Execution Layers:
Layer 0 (parallel): [task names]
Layer 1: [task names] → depends on Layer 0
...

### Files:
- DAG: `.claude/ai/decomposition-YYYY-MM-DD-description.json`
- Summary: `.claude/ai/decomposition-YYYY-MM-DD-description.md`

[If --dry-run]: Files were not saved (dry run mode).
```

## Important Rules

- **Never create subtasks for work not in the source requirement** — decomposition
  is about breaking down the existing scope, not expanding it
- **Never skip quality checks** — even if the decomposition "looks good", run all 5
- **Never produce subtasks that modify test files to make tests pass** — tests
  validate the implementation, not the other way around
- **Always verify file paths** — use Glob to confirm files exist before including
  them in context slices
- **Always include acceptance criteria mapping** — every AC must map to at least
  one subtask's completion criteria
- **Limit to 15 subtasks maximum** — if decomposition produces more than 15 tasks,
  the granularity is likely too fine; consider merging related tasks
- **Minimum 2 subtasks** — if the task decomposes into a single subtask, it's
  already agent-sized and doesn't need decomposition; report this and stop
