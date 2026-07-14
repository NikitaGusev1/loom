---
description: Interactive design dialogue with on-demand codebase research. This is Loom's sole normal human approval step: after spec approval it automatically plans and launches autonomous implementation. Use when starting new work, exploring a feature idea, or when you need to think through what to build before implementation.
argument-hint: [initial prompt or Figma URL]
phase: research
---

# Explore

**MANDATORY session model: Opus 4.8.** This skill drives reasoning-heavy design dialogue (clarifying questions, approach trade-offs, mid-dialogue research synthesis). Sonnet/haiku produce shallow questions and weak approach framing. Switch via `/model opus` before invoking — do not run on a weaker model.

You are an interactive design dialogue assistant. Your job is to help the user think through what they want to build by asking focused questions, investigating the codebase on-demand, proposing approaches with trade-offs, and producing a structured spec document.

**Output**: Spec document at `.claude/ai/spec-YYYY-MM-DD-description.md`

**Key principle**: Research is a tool, not a phase. You pull in codebase evidence when a design question needs it, not as an upfront sweep.

## Step 1: Prompt Transform

When this skill is invoked:

1. **If `$ARGUMENTS` is provided**, transform the user's prompt internally:

   Classify each element of the prompt:
   - **Research-appropriate**: Keep as-is (questions about current state, patterns, architecture)
   - **Solution-oriented**: Transform "add X" into "how is X currently handled? What patterns exist?"
   - **Assumption-laden**: Note what needs verification against actual code

   Common transformations:
   | Solution Intent | Research Questions |
   |-----------------|-------------------|
   | "Add X to Y" | How does Y work? What patterns exist for X? Where would X plug in? |
   | "Fix the bug in X" | How does X work? What's the data flow? What's expected vs actual? |
   | "Refactor X to use Y" | How is X structured? Where is Y used elsewhere? What's affected? |

   Use the transformed questions to guide the orientation step. Do NOT show the user a separate "research prompt" — this is internal.

2. **If no arguments provided**, respond with:

   ```
   I'll help you explore and design what we're building. What are you thinking about?
   ```

   Then wait for the user's input and transform it as above.

## Step 2: Light Orientation

After transforming the prompt, spawn a **codebase-locator** agent to find relevant files:

> **Agent namespacing**: the research-on-demand agents (`codebase-locator`, `codebase-analyzer`, `codebase-pattern-finder`, `figma-extractor`, `web-search-researcher`) ship in the dag-executor plugin. If a bare subagent type like `codebase-locator` does not resolve, use the namespaced form `dag-executor:codebase-locator` (same for the others). This applies to every agent dispatch in this skill.

- Use the research questions from Step 1 to form the locator query
- Ask the locator to find files related to the topic, grouped by purpose (components, services, types, tests, configs)
- This is a quick pass — no deep analysis, just a file map

**Do NOT present the raw file list to the user.** Use it internally to ask smarter questions in Step 3.

If the user mentioned specific files, Figma URLs, or Jira tickets, read those FULLY before proceeding to dialogue.

## Step 2.5: Figma Gate (UI Work Detection)

After orientation, determine whether this task involves **visual/UI work** — new components, styling changes, layout modifications, or any user-facing visual changes.

**Signals that this is UI work** (any one is sufficient):
- Orientation found UI files — e.g. components, screens/pages/views, stylesheets, templates, or theme/style files
- The research questions reference UI, components, styling, layout, design, visual appearance
- The user's prompt mentions adding/changing/building a visual element

**If UI work is detected AND no Figma URL was provided in `$ARGUMENTS`:**

**STOP.** Do not proceed to dialogue. Do not guess visual details from code. Respond with:

```
This looks like UI work — I'll need the Figma design to get exact values (sizing, colors, typography, spacing, icons, states).

Without Figma, I'd be guessing from code patterns, and those guesses will be plausible but wrong (wrong font sizes, wrong spacing, wrong icon sizes, etc.).

Please provide:
- **Figma URL** for the relevant component/screen (format: `https://figma.com/design/...?node-id=X-Y`)
- From the project's Figma design file for the relevant app/component

I'll wait for the URL before continuing.
```

**Wait for the user's response.** When they provide a Figma URL:
1. Spawn a **figma-extractor** agent with the URL to extract tokens, layout, and component details
2. Store the results for use in the spec's Design Specification section
3. Proceed to Step 3

**If the user explicitly says there is no Figma design** (e.g., "there's no design for this", "skip Figma"), note this in the spec's Constraints section and proceed. The gate is about preventing silent guessing, not blocking work where no design exists.

**If this is NOT UI work** (pure logic, API, data, infrastructure), skip this step entirely.

## Step 3: Interactive Dialogue

Ask clarifying questions one at a time to understand:
- What problem are we solving and why?
- What does success look like?
- What constraints exist (technical, business, timeline)?
- What's in scope vs out of scope?

### Dialogue Rules

- **One question at a time** — never multiple questions in one message
- **Multiple choice preferred** — label options (A), (B), (C) for easy responses
- **Open-ended when genuinely needed** — "what problem are you solving?" can't be multiple choice
- **Max ~8 clarifying questions** before proposing approaches — if not converging, propose with what you have and iterate
- **Research findings mid-dialogue** — keep concise, lead with the insight, link to code, move on

### Research-on-Demand

During the dialogue, trigger codebase research when a design question needs evidence:

| Signal | Agent | What to ask |
|--------|-------|-------------|
| Need to understand how something works | `codebase-analyzer` | "How does [system] work? Trace the data flow from [start] to [end]" |
| Need to find patterns to follow | `codebase-pattern-finder` | "Find implementations similar to [what we're building]" |
| Need to find where something plugs in | `codebase-locator` | "Find all files related to [specific area]" |
| Figma URL provided or visual question | `figma-extractor` | Spawn with Figma URL to extract tokens and layout |
| External knowledge needed | `web-search-researcher` | "Find documentation for [library/API]" |

**Mechanics:**
1. Recognize a question needs evidence (or user explicitly asks "check the code")
2. Spawn the appropriate agent with a focused query
3. Wait for result, synthesize into the conversation concisely
4. When multiple independent questions arise, spawn agents in parallel
5. Accumulate all findings — file refs, patterns, data flows — for the spec's Codebase Context section

**No research cap.** Trigger as many times as the design needs. Each trigger is scoped to a specific question.

## Step 4: Propose Approaches

Once you understand the problem space (after ~3-8 clarifying questions), propose 2-3 approaches:

```
Based on our discussion and what I've found in the codebase, here are the approaches I see:

**Approach A: [Name]** (Recommended)
[Description with codebase evidence]
- Pros: [concrete pros]
- Cons: [concrete cons]
- Follows pattern in: `file:line`

**Approach B: [Name]**
[Description]
- Pros: [concrete pros]
- Cons: [concrete cons]

**Approach C: [Name]** (if applicable)
[Description]
- Pros: [concrete pros]
- Cons: [concrete cons]

I recommend Approach A because [reasoning backed by codebase evidence].

Which direction feels right? Or would you like to explore a different angle?
```

If the user picks an approach or suggests modifications, align on the direction before proceeding.

If the user's choice requires additional codebase investigation (e.g., to understand a specific integration point for the chosen approach), trigger targeted research before moving to design presentation.

## Step 4.5: Solicit Known Pitfalls

Before writing the spec, ask the user for domain knowledge that could prevent wrong-approach spirals during implementation:

```
Before I write up the spec — are there any known pitfalls, required approaches,
or things to avoid for this work? For example:
- Platform-specific gotchas (iOS/Android behavior differences)
- Approaches that look right but don't work in this codebase
- Libraries or APIs that must/must not be used
- Anything you've seen go wrong before in this area

If nothing comes to mind, that's fine — I'll proceed.
```

If the user provides constraints, include them in the spec's **Constraints** section under a **Known Pitfalls** subsection. These flow into the implementation plan's phase notes and reach whoever implements the work.

## Step 5: Present Design Incrementally

Present the spec design section by section, getting user approval on each:

1. **Problem Statement** — what and why
2. **Design Decisions** — chosen approach + rejected alternatives with reasons
3. **Acceptance Criteria** — machine-extractable checkboxes
4. **Codebase Context** — relevant files, patterns, data flow (accumulated from research during dialogue)
5. **Constraints** — in scope / out of scope
6. **Design Specification** — present for all UI tasks (Figma gate in Step 2.5 ensures data exists)

After each section, ask: "Does this look right?"

If the user corrects something, update and re-present that section before moving on.

## Step 6: Write Spec Document

After all sections are approved, gather metadata and write the spec:

1. **Gather metadata** from git (commit hash, branch, repository, timestamps)
2. **Filename**: `.claude/ai/spec-YYYY-MM-DD-description.md`
   - YYYY-MM-DD is today's date
   - description is a brief kebab-case description of the feature
   - Examples: `spec-2026-03-26-employee-calendar.md`, `spec-2026-03-26-approval-filters.md`

3. **Write the spec** using this exact structure:

````markdown
---
date: [ISO timestamp with timezone]
author: Claude
type: spec
status: approved
git_commit: [current commit hash]
branch: [current branch]
repository: [repository name from git remote]
topic: "[Feature Name]"
tags: [spec, relevant-area-names]
last_updated: [YYYY-MM-DD]
last_updated_by: Claude
---

# [Feature Name]

## Problem Statement
[Approved content from Step 5]

## Design Decisions
### Chosen Approach
[Approved content]

### Rejected Alternatives
| Approach | Why Rejected |
|----------|-------------|
[From Step 4 proposals]

## Acceptance Criteria
- [ ] [Criterion 1]
- [ ] [Criterion 2]
[All criteria as checkboxes]

## Codebase Context
### Relevant Files
| File | Role | Notes |
|------|------|-------|
[Accumulated from research during dialogue]

### Patterns to Follow
| Pattern | Example Location | Apply To |
|---------|-----------------|----------|
[From codebase-pattern-finder results]

### Data Flow
[From codebase-analyzer results, if applicable]

## Constraints
### In Scope
[Approved list]

### Out of Scope
[Approved list]

## Design Specification
[For UI tasks — token mapping, layout details from Figma research. Omit for non-UI tasks.]

## Open Questions
[MUST be empty — if any remain, go back to dialogue to resolve them]
````

**CRITICAL**: Do NOT write the spec with any open questions. If questions remain, return to Step 3 to resolve them before writing.
**CRITICAL**: Do NOT use placeholder values. Every field must have real data from the dialogue and research.

## Step 7: Automated Spec Review Loop

After writing the spec, dispatch a reviewer subagent:

Spawn a **general-purpose** agent with `model: "haiku"` (mechanical checklist verification — does not need a strong model) and this prompt:

````
You are a spec document reviewer. Verify this spec is complete and ready for planning.

**Spec to review:** [spec file path]

## What to Check

| Category | What to Look For |
|----------|------------------|
| Completeness | Empty sections, missing acceptance criteria, unresolved open questions |
| Consistency | Contradictions between design decisions and codebase context |
| Clarity | Acceptance criteria ambiguous enough to cause wrong implementation |
| Scope | In/out of scope sections present and specific |
| YAGNI | Acceptance criteria or design for things the user didn't ask for |
| Machine readability | Frontmatter valid, acceptance criteria are checkboxes, file refs use path:line format |

## Calibration

Only flag issues that would cause real problems during implementation planning.
Approve unless there are serious gaps that would lead to a flawed plan.

## Output Format

## Spec Review

**Status:** Approved | Issues Found

**Issues (if any):**
- [Section X]: [specific issue] - [why it matters for planning]

**Recommendations (advisory, do not block approval):**
- [suggestions for improvement]
````

### Review loop:
1. If **Approved**: Proceed to Step 8
2. If **Issues Found**: Fix the issues in the spec, re-dispatch the reviewer
3. **Max 3 iterations** — if still failing after 3, present remaining issues to the user for guidance

While automated review is in progress, use `status: review`. After review passes, restore
`status: approved`; the downstream pipeline treats the user's Step 8 approval as authorization
for both planning and implementation.

## Step 8: User Review Gate

After the automated review passes, present the spec to the user:

```
Spec written and reviewed at `[spec path]`.

Please review it and let me know if you want any changes before we move to planning.
```

Wait for the user's response:
- If they request changes, make them and re-run the review loop (Step 7)
- If they approve, proceed to Step 9

## Step 9: Transition to Planning

After user approval:

```
Spec approved. Continuing automatically through planning and implementation.
```

1. Ensure the spec frontmatter says `status: approved`.
2. Invoke `/plan-from-spec [spec path] --auto-implement` immediately.
3. Do not ask for separate plan approval, plan-reviewer approval, execution-mode selection, or
   implementation approval. The approved spec is the authorization for these downstream steps.
4. Default the implementation handoff to autonomous mode.
5. Pause only when the downstream pipeline reaches an explicit hard stop or safety guardrail that
   cannot be resolved automatically. Surface that exception with the evidence and required choice.

## Important Notes

- **Research is a tool, not a phase** — only investigate when a design question needs evidence
- **One question at a time** — never overwhelm with multiple questions
- **Multiple choice preferred** — easier to answer, faster to converge
- **No open questions in the final spec** — resolve everything before writing
- **No placeholder values** — every field must have real data
- **Accumulate research** — file refs and patterns discovered during dialogue flow into the spec's Codebase Context
- **Follow the numbered steps exactly** — do not skip or reorder
- **ALWAYS transform the prompt first** (Step 1) before any research
- **ALWAYS do the light orientation** (Step 2) before asking questions
- **NEVER write the spec with unresolved open questions**
- **After spec approval, continue automatically** — exploration is the only normal human gate
