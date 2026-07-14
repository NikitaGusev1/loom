---
description: Creates an approved implementation plan from an existing approved spec, skipping redundant research. When called by /explore with --auto-implement, it continues directly into autonomous implementation without another human gate.
argument-hint: <spec-path> [figma-url] [--auto-implement]
phase: planning
---

# Plan From Spec

**MANDATORY session model: sonnet.** The spec already contains the design decisions and acceptance criteria, so planning here is extraction + structuring rather than open-ended reasoning. Running on Opus 4.8 wastes tokens with no quality gain. Switch via `/model sonnet` before invoking.

Create an implementation plan using an existing spec document as the foundation. The spec already contains design decisions and acceptance criteria from the `/explore` dialogue, making the planning process faster and more focused — skip re-spawning research agents and go straight to structuring the plan.

**Output**:
- `.claude/ai/plan-YYYY-MM-DD-description.md` — the implementation plan

## Parameters

Parse from `$ARGUMENTS`:

- **Spec path** (required): Path to a `.claude/ai/spec-*.md` file
- **Figma URL** (optional): Figma design URL to analyze alongside the spec
- **Jira ticket** (optional): Jira ticket key (e.g., `VMM-1234`) for additional acceptance criteria
- **Auto implement** (optional): `--auto-implement` marks the generated plan approved and immediately
  invokes `/auto-implement <plan-path> --mode autonomous`. This is the standard `/explore` handoff.

If no spec path is provided, search `.claude/ai/` for the most recent `spec-*.md` file and confirm with the user.

## Process

### Step 1: Load Spec

1. Read the spec document completely
2. Extract from it:
   - **Acceptance criteria** — already structured as checkboxes, extract verbatim
   - **Design decisions** — chosen approach + rejected alternatives with reasoning
   - **Codebase context** — relevant files, patterns to follow, data flow
   - **Constraints** — in scope / out of scope lists
   - **Design specification** — Figma token mapping and layout (if present)
3. The spec already contains focused codebase context from the `/explore` dialogue — do NOT re-run locator/analyzer/pattern-finder unless gaps are found in Step 2

**Note**: Unlike research documents, specs already have design decisions made and acceptance criteria defined. There is no need to derive these or present options to the user.

### Step 2: Identify Gaps

Compare what the spec covers against what's needed for a plan:

- **Figma design**: Check whether the spec involves UI work (references components, screens, styling, or visual changes). If it does and has no Design Specification section, **STOP** — ask the user for a Figma URL before proceeding. Do not plan visual details from code patterns alone. If a Figma URL is provided (as a parameter or by the user), run Figma research (same as `/create-plan` Step 1.5 — use figma-extractor agent)
- **Missing patterns**: If the spec's Codebase Context lists relevant files but lacks implementation patterns to model after, spawn a **codebase-pattern-finder** agent for the specific gap
- **Missing data flow**: If the spec lists files but didn't trace how they connect for the chosen approach, spawn a **codebase-analyzer** agent for the specific gap

> **Agent namespacing**: `figma-extractor`, `codebase-pattern-finder`, and `codebase-analyzer` ship in the dag-executor plugin. If a bare subagent type does not resolve, use the namespaced form (e.g. `dag-executor:codebase-analyzer`).

- **Jira cross-reference**: If a Jira ticket is provided, fetch it and cross-reference against the spec's acceptance criteria — add any criteria from Jira not already captured in the spec

**Do NOT re-run locator/analyzer/pattern-finder for areas the spec already covers well.** Only fill gaps.

**Specs from `/explore` are typically comprehensive** — expect gaps to be small or nonexistent. Common gaps: a Figma URL that wasn't explored during the dialogue, or a specific data flow for the chosen approach that wasn't traced.

### Step 3: Confirm Understanding When Needed

Present your understanding to the user, combining spec content with any gap-filling:

```
Based on the spec:

**Building:** [chosen approach from spec's Design Decisions section]
**Acceptance criteria:** [N] criteria defined
**Codebase context:** [N] files identified, [N] patterns to follow

**Gap-filling (if any):**
- [Additional findings from Figma research or targeted agents]

Ready to plan. Any adjustments before I proceed?
```

When `--auto-implement` is set, do not present this checkpoint or ask for alignment. The user
already approved the source spec in `/explore`; continue unless a newly discovered contradiction
would materially change that approved design. Without the flag, get alignment before proceeding.

### Step 3.5: Solicit Known Pitfalls When Needed

Before structuring the plan, ask the user for domain knowledge that prevents wrong-approach spirals:

```
Before I structure this into phases — are there known pitfalls or required approaches
for any of these areas? For example:
- "Use X, don't try Y" constraints
- Platform-specific gotchas
- Approaches that look right but fail in this codebase

If nothing comes to mind, that's fine — I'll proceed.
```

If the user provides constraints, fold them into the relevant phase notes so the implementing session sees them inline with the work they apply to.

Skip this prompt when `--auto-implement` is set. `/explore` already solicited known pitfalls.

### Step 4: Structure the Plan

From here, follow the same plan-writing process as `/create-plan` Step 5 — structure the work into sequential implementation phases directly from the spec's acceptance criteria and codebase context:

1. **Group the acceptance criteria into phases** — each phase a coherent, independently verifiable chunk of work, ordered so later phases build on earlier ones. Use the spec's acceptance criteria verbatim and the spec's design decisions as the chosen approach — do not re-present options.
2. **Carry design details into the plan**: If the spec includes a Design Specification section with a Component Hierarchy or Spacing & Layout table from Figma analysis, copy these tables verbatim into the plan's design details so the implementing session has exact tokens, spacing, and layout to follow.
3. **Fold in pitfalls and constraints** from Step 3.5 as notes on the phases they apply to.
4. **Run quality checks** on the structured plan — confirm each phase has clear scope, the phases cover every acceptance criterion (Coverage), and dependencies between phases are explicit and correctly ordered. Revise (max 3 iterations) if a check fails.
5. **Write the plan** — use the same plan template as `/create-plan`, but add `spec_path` to the YAML frontmatter pointing to the spec document used as input (e.g., `spec_path: ".claude/ai/spec-2026-03-26-feature.md"`).
6. **Save the plan** to `.claude/ai/plan-YYYY-MM-DD-description.md`. Use `status: approved`
   when `--auto-implement` is set; otherwise use `status: draft`.
7. **Iterate** based on user feedback only in interactive mode.

### Step 5: Optional — Run Plan Reviewer

After the plan is saved, run the plan reviewer automatically when `--auto-implement` is set.
Apply focused, non-design-changing corrections and re-run it, up to 3 times. If the reviewer still
reports a fatal issue or fixing it would change the approved design, stop and show the exception.

Without `--auto-implement`, ask the user:

```
Plan saved. Would you like me to run the plan-reviewer agent to validate it against the codebase before implementation?
```

If yes, spawn the **plan-reviewer** agent with the plan path and spec path.

When `--auto-implement` is set and review passes, invoke:

```
/auto-implement [plan path] --mode autonomous
```

Do not ask for plan approval or implementation confirmation. The pipeline may still pause at its
documented hard stops and safety guardrails. Without the flag, hand the saved plan back to the user.

## Key Differences

| Aspect | `/create-plan` | `/plan-from-research` | `/plan-from-spec` |
|--------|---------------|----------------------|-------------------|
| Research phase | Full — spawns locator + analyzer from scratch | Minimal — reads existing research, fills gaps only | Minimal — reads existing spec, fills gaps only |
| Design decisions | Made during planning | Not in research doc — must be made during planning | Already in spec — extracted directly |
| Acceptance criteria | Derived during planning or from Jira | Not in research doc — must be defined | Already in spec as checkboxes — extracted directly |
| Figma research | Always runs if URL provided | Only runs if research didn't cover it | Only runs if spec didn't cover it |
| Interactive questions | Two rounds (initial + post-research) | One round (post-gap-analysis) | One round (post-gap-analysis), simpler |
| Input required | Task description or Jira ticket | Research document path | Spec document path |
| Best for | Starting from scratch | After `/research-codebase` | After `/explore` |

## When NOT to Use

- If the spec document is old (check the date in frontmatter — if it's more than a few days old, the codebase may have changed significantly, consider re-running `/explore`)
- If the spec covers a different topic than what you want to plan
- If you want the full interactive research + planning flow — use `/create-plan` instead
- If you only have a research document (no design decisions or acceptance criteria) — use `/plan-from-research` instead

**Note**: If the spec was produced by `/explore`, it's likely fresh and complete — the explore dialogue resolves open questions and verifies against the codebase before writing the spec.
