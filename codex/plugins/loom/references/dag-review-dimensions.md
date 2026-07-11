# DAG Review Dimensions

Five independent review briefs — Reference Staleness & Existence (R), Contract
Semantic Coherence (K), Spec Fidelity & Coverage (F), Granularity & Parallelism Shape
(G), Completion-Criteria Quality (Q) — meant to be inlined verbatim into a per-dimension
finder's dispatch prompt when reviewing a decomposition DAG (task-decomposer output)
against its source spec/plan. Each brief is self-contained: a finder assigned one
dimension should need nothing else to know its scope, what counts as CRITICAL in that
dimension specifically, and how to hunt for problems.

**Finding IDs**: every finding gets a stable ID `[<dim>-<sev><ordinal>]` — `dim` ∈
`{R,K,F,G,Q}`, `sev` ∈ `{C,W}` (Critical/Warning — no SUGGESTION tier for DAG review),
`ordinal` sequential within each dimension+severity pair. Examples: `[R-C1]`,
`[K-W2]`, `[G-W1]`, `[F-C1]`. IDs make findings addressable across refinement and
triage.

**Calibration (applies to every dimension)**: only assign CRITICAL when confident —
false positives at high severity erode trust in the whole review. When unsure whether
something rises to CRITICAL, file it as WARNING instead. Severity is per-axis: a
CRITICAL in Reference Staleness and a CRITICAL in Spec Fidelity do not mean the same
thing, and each brief below defines its own bar. CRITICAL findings make the DAG a
candidate for BLOCKED (routed to an adversarial verifier); WARNING findings feed a
NEEDS_REVISION refinement pass instead.

---

## R — Reference Staleness & Existence

**Scope**: does every file, symbol, and API the DAG's tasks assume exist actually
exist (or is it explicitly marked as new)? A decomposition drifts from the codebase
between the research/spec pass and the DAG being generated, or the decomposer
hallucinates a plausible-sounding path or export.

**Severity rubric (this dimension)**:
- **CRITICAL**: a task's `context.files` entry, `context.conventions` file reference,
  or a producer/consumer contract's `file`/`exportName` points at a path or symbol
  that does not exist and is not marked as a new file the task creates — the task
  cannot execute as written.
- **WARNING**: a referenced symbol exists but at a different location than implied
  (stale `file:line`), or an assumption about an API's shape is plausible but
  unverified against the actual signature.

**Methodology**:

1. **File existence** — for every path in every task's `context.files`, use Glob/LS
   to confirm it exists, unless the task's own description marks it as a file the
   task creates (new file). Flag any path that is neither.
2. **Contract export plausibility** — for every `outputContracts` entry with a `file`
   and `exportName`, check the export is a name the target module could plausibly
   produce (matches existing naming/casing conventions in that file or sibling
   files); for a new file, check the exportName is consistent with what the task
   description says it builds.
3. **API/symbol assumptions** — grep for every function, class, type, or export a
   task's description or conventions section asserts exists ("X exports Y",
   "reducer already handles Z"). If grep finds nothing, flag it — the decomposer may
   be describing something renamed, removed, or never real.
4. **Line-number staleness** — where a task cites `file:line`, verify the cited
   content is actually at (or near) that line; drifted line numbers are a common
   staleness signal even when the file and symbol are otherwise correct.

---

## K — Contract Semantic Coherence

**Scope**: do the producer→consumer contracts between DAG tasks actually line up in
meaning, not just in shape? A DAG can be structurally valid (schema-conformant JSON)
while its contracts are semantically broken — a consumer expecting one thing from a
producer that emits another.

**Severity rubric (this dimension)**:
- **CRITICAL**: a consumer task's input contract does not match what its declared
  producer's output contract actually produces — different file, different export,
  or a semantic mismatch (e.g. consumer expects a parsed object, producer emits a
  file path) that would break the consumer task outright.
- **WARNING**: an `exportKind` is a plausible but imprecise guess (e.g. `function`
  where the target is more naturally a `class` or `const`); a `behavioral` contract
  is used where a concrete `file`/`exportName` pair was available and would have been
  checkable; a `.claude/ai/`-directory output isn't declared as a `file`-kind
  contract even though it is a real file on disk.
- **WARNING → CRITICAL escalation**: an unresolved semantic mismatch that would
  cascade — the consumer's own downstream consumers also depend on the wrong shape.

**Methodology**:

1. **Producer↔consumer alignment** — for every edge in the DAG, read the producer
   task's output contract and the consumer task's input contract that names it; check
   they describe the same artifact (same file, same export, same semantic content —
   not just matching field names).
2. **exportKind realism** — check each contract's `exportKind` (`function`, `class`,
   `const`, `type`, `file`, `behavioral`, etc.) against what the producing task
   description says it builds; flag mismatches.
3. **Behavioral-contract overuse** — `behavioral` contracts (verified only by
   description, never checked structurally) should be the fallback, not the default.
   Flag any edge using `behavioral` where the producer's output is a concrete file
   with a nameable export — the DAG should prefer the checkable form.
4. **`.claude/ai/` outputs** — this repo's tooling writes ephemeral run artifacts
   (event logs, review reports, checkpoints) under `.claude/ai/`. Any task that
   produces one of these must declare it as a `file`-kind output contract with the
   actual path, not a vague behavioral description — downstream tasks that read it
   need the concrete path to depend on.
5. **Fan-in coherence** — where multiple producers feed one consumer, check the
   consumer's input contracts collectively cover what it needs without contradicting
   each other (e.g. two producers both claiming to be the source of the same file).

---

## F — Spec Fidelity & Coverage

**Scope**: does the DAG, taken as a whole, actually implement the spec/plan it was
decomposed from — no less, no more? This is the DAG-level analog of scope-creep and
missing-requirement checks, applied across the full task set rather than a single
diff.

**Severity rubric (this dimension)**:
- **CRITICAL**: an acceptance criterion (AC) or explicit requirement in the source
  spec/plan has no task covering it anywhere in the DAG — the DAG would ship
  incomplete relative to what was asked.
- **WARNING**: a task (or a task's declared scope) does work the spec/plan never
  asked for; an AC is covered but only partially (a sub-case dropped); a spec's
  "Known Pitfalls" or "Gotchas" section names a concern that never surfaces in any
  task's `context.conventions`, so an implementer would rediscover it the hard way.

**Methodology**:

1. **AC-to-task mapping** — read the source spec/plan's acceptance criteria /
   requirements list in full. For each one, find at least one DAG task whose
   description or completion criteria semantically covers it (exact wording is not
   required — the task's actual work must satisfy the AC's intent). List any AC with
   no covering task.
2. **Out-of-scope detection** — for each task, check its description and file scope
   against the spec/plan's stated boundaries (including any explicit "Out of Scope" /
   "What We're NOT Doing" section). Flag tasks doing something the spec never asked
   for or something explicitly excluded.
3. **Pitfall propagation** — if the spec/plan calls out known pitfalls, gotchas, or
   "watch out for X" notes, check that each one lands in the `context.conventions` (or
   equivalent) of every task it's actually relevant to — not just the first task that
   touches the area. A pitfall noted once in the spec but absent from a later task
   that hits the same hazard is a coverage gap.
4. **Cross-task requirement splitting** — where one AC spans multiple tasks (e.g. a
   paired invariant that must move in lockstep), verify every task on both sides
   actually appears in the DAG, not just the first half.

---

## G — Granularity & Parallelism Shape

**Scope**: are the DAG's tasks sized right for the substrate that runs them — one
isolated worktree and one agent context per task? Both directions of mis-sizing cost,
and this dimension is capped at WARNING because sizing is advisory, never a structural
blocker.

**Severity rubric (this dimension)**:
- **WARNING (ceiling for this dimension)**: too-fine splitting that forces context
  reacquisition between tightly-coupled steps, or serializes work that should have
  filled parallel slots; too-coarse bundling that mixes unrelated changes under one
  task so no single completion criterion can verify it and a reviewer can't read it
  as one unit.
- There is no CRITICAL tier here — a granularity problem never blocks the DAG on its
  own (structural correctness — missing files/APIs, broken contracts — is what
  blocks; those live in **R** and **K**). At most, granularity findings push the DAG
  to NEEDS_REVISION.

**Methodology**:

1. **Too fine** — look for many small tasks that force an agent to re-acquire context
   between steps, or that split a single in-context data flow (e.g. a
   data→hook→UI slice, or a schema-change→mirrored-type slice) across separate tasks
   that then need explicit handoffs via contracts. Symptom: a task that only makes
   sense as setup for the next one, or a cluster of tasks sharing so much context
   they'd have been cheaper as one.
2. **Too coarse** — look for a task bundling unrelated changes (an "and" in its
   description, touching disjoint subsystems), or one so large its own completion
   criteria can't verify it as a single unit.
3. **Calibration — do not impose a fixed task-count target.** There is no "right"
   number of tasks for a given spec. Only flag granularity when it would concretely
   hurt: lost context between coupled steps, an increment that can't be verified on
   its own, or independent work needlessly serialized.
4. **Weigh the counter-forces before flagging "too fine"**:
   - Splitting a **wide independent layer** is what fills parallel slots — merging it
     serializes concurrent work that could have run at once.
   - A task is the unit of **retry blast radius** and worktree clobber — a finer task
     means a failed retry redoes less.
   - Finer seams can map to more **reviewable units** (each task's diff reviewed on
     its own).
   A split that buys any of these is correct even if it looks small — don't flag it.
5. **Weigh the counter-forces before flagging "too coarse"**: a single task is
   sometimes correct when the work is inherently one atomic change that can't be
   contract-split without inventing an artificial intermediate artifact nobody else
   needs.

---

## Q — Completion-Criteria Quality

**Scope**: can the DAG's stated completion criteria — automated and manual — actually
be used to tell whether a task succeeded? Vague or unrunnable criteria let a broken
task slip through as "done."

**Severity rubric (this dimension)**:
- **CRITICAL**: an automated criterion references a command, script, or test file
  that does not exist or is not runnable in this repo (wrong package manager, wrong
  path, a test file the task never creates) — the criterion cannot execute at all.
- **WARNING**: a manual criterion is too vague to verify ("it works correctly",
  "works as expected", "properly handles edge cases" with no named edge case); an
  automated criterion is runnable but checks something weaker than what the task
  actually needed to prove (e.g. only a type-check where a behavioral test was
  warranted).

**Methodology**:

1. **Automated-criterion runnability** — for every automated completion criterion,
   confirm the command exists for this repo (check `package.json` scripts / the
   commands this repo's CLAUDE.md documents — e.g. `npm run build`, `npm test`) and
   that any file path it names (a test file, a fixture) either already exists or is
   itself one of the task's declared outputs.
2. **Manual-criterion specificity** — for every manual completion criterion, check it
   names a concrete, observable thing to check (a specific behavior, a specific file
   section, a specific rendered output) rather than a global adverb of confidence.
   Reject phrasing equivalent to "it works correctly" or "handles it properly" with
   nothing to point at.
3. **Criterion-to-contract alignment** — check that a task's completion criteria
   actually exercise its declared output contracts (no criterion checking something
   unrelated to what the task was supposed to produce, and no declared output with
   zero criterion touching it).
4. **Coverage of failure/edge paths where the task warrants it** — if a task's own
   description calls out an edge case or failure mode, at least one completion
   criterion should be capable of catching a regression there; a criteria list that
   only covers the happy path for a task explicitly about edge-case handling is a
   gap.
