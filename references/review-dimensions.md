# Review Dimensions

Five independent review briefs — Correctness (C), Security (S), Testing Integrity (T),
Conventions (V), Quality (Q) — meant to be inlined verbatim into a per-dimension finder's
dispatch prompt by `/code-review`. Each brief is self-contained: a finder assigned one
dimension should need nothing else to know its scope, what counts as CRITICAL in that
dimension specifically, and how to hunt for problems.

**Finding IDs**: every finding gets a stable ID `[<dim>-<sev><ordinal>]` — `dim` ∈
`{C,S,T,V,Q}`, `sev` ∈ `{C,W,S}` (Critical/Warning/Suggestion), `ordinal` sequential
within each dimension+severity pair. Examples: `[C-C1]`, `[C-C2]`, `[S-W2]`, `[T-C1]`.
IDs make findings addressable across the fix loop and triage.

**Calibration (applies to every dimension)**: only assign CRITICAL when confident —
false positives at high severity erode trust in the whole review. When unsure whether
something rises to CRITICAL, file it as WARNING instead. Severity is per-axis: a
CRITICAL in Security and a CRITICAL in Quality do not mean the same thing, and each
brief below defines its own bar.

---

## C — Correctness & Silent Failures

**Scope**: does the code do what it claims, including on error and edge-case paths?
Exception handling, edge cases, cleanup on failure, and — the sharpest sub-focus —
errors that get caught and never surface to anyone who could act on them. A caught
error that never reaches the caller is worse than an uncaught one.

**Severity rubric (this dimension)**:
- **CRITICAL**: produces wrong output, crashes, loses data, or silently swallows a
  failure so a caller believes an operation succeeded when it didn't.
- **WARNING**: an edge case is unhandled but doesn't corrupt state or data; cleanup is
  missing on a rare failure branch; an error message is misleading but the failure
  still surfaces somewhere.
- **SUGGESTION**: defensive hardening with no failure mode observed yet.

**Methodology**:

1. **Error handling & reliability** — proper exception handling with clear messages;
   edge cases considered and handled; no bandaid fixes (address root causes, not
   symptoms); resource management (file handles, child processes, connections,
   watchers, timers) cleaned up on *every* path, including failure — not just happy
   path.
2. **The six silent-failure / error-swallowing anti-patterns** — hunt each by name:
   - **Empty / no-op handlers** — a catch that does nothing, or logs and continues so
     the caller proceeds as if the operation succeeded when it did not.
   - **Overly-broad catches** — catching a base error type (or a bare `catch {}`) so
     wide it also absorbs unrelated failures (programming bugs, aborts, errors from
     another subsystem) that should crash loudly.
   - **No failure-path cleanup** — state written / a lock or slot taken / a temp file
     or connection opened before a call that can throw, with no cleanup when it does.
   - **Success-status-with-error-body** — returning HTTP 200 (or exit 0 / an
     `{ ok: true }`-shaped result) that carries error content; callers branching on
     status take the wrong path. Errors must be signalled through the channel the
     caller actually checks.
   - **Fallback masking** — silently degrading to a fallback without surfacing that
     the primary path failed, so nothing in logs or the return value records it.
   - **Suppressed propagation** — an error caught and converted into a neutral return
     value (empty array, `null`, `false`) the caller cannot distinguish from a
     genuine empty result.

---

## S — Security

**Scope**: anything that could leak secrets, admit malformed/malicious input, or open
an injection vector.

**Severity rubric (this dimension)**:
- **CRITICAL**: exploitable now — a committed secret/API key, an injection vector
  reachable from untrusted input, missing validation on a sensitive path.
- **WARNING**: latent risk — validation exists but is incomplete, sanitization is
  weak, a defense-in-depth layer is missing but the primary guard holds.
- **SUGGESTION**: hardening opportunity with no realistic exploit path today.

**Methodology**:

- No exposed secrets, API keys, tokens, or other sensitive data (including in logs,
  test fixtures, or committed config).
- Input validation and sanitization implemented wherever data crosses a trust
  boundary.
- No injection vectors: shell/command construction from unsanitized input, path
  traversal, unsafe deserialization.

---

## T — Testing Integrity & Behavioral Coverage

**Scope**: two halves of one dimension — (a) zero tolerance for tests manipulated to
pass rather than fixed, and (b) whether the tests that exist would actually catch a
regression.

**Severity rubric (this dimension)**:
- **CRITICAL**: any test-integrity violation — a test skipped, commented out, or
  weakened to dodge a real failure — is CRITICAL regardless of how small it looks.
  Also CRITICAL: a critical-path behavior (state mutation, event flow, retry/merge
  logic, a data-loss vector) with zero test coverage.
- **WARNING**: coverage theatre displacing real assertions (see below); missing
  coverage on a non-critical path; a platform-specific branch untested where a
  guarded test should exist.
- **SUGGESTION**: test readability/structure improvements that don't change what's
  covered.

**Methodology**:

1. **Test integrity violations (zero tolerance)** — detect and flag, always CRITICAL:
   - Commented-out test assertions or entire test functions.
   - Skip markers added to dodge a failure: `.skip`, `t.skip()`, `it.skip`, `xfail`,
     `--test-skip`.
   - Irrelevant code added just to make a test pass without solving the real problem.
   - Assertions weakened (e.g. a deep-equal downgraded to a truthiness check).
   - Tests modified to match an incorrect implementation instead of fixing the
     implementation.
   - Test logic artificially simplified to pass.
   - If tests are genuinely difficult to fix for a legitimate reason, that's a signal
     to flag for human judgment, not to work around.
2. **Behavioral-coverage heuristic** — for each new behavior ask: *if this broke or
   regressed, would a test here catch it?* Demand tests that pin observable outputs,
   side effects, state transitions, and rejection/failure paths — especially on
   critical paths.
3. **Reject low-value tests (coverage theatre)** — flag tests that only assert a
   function was called (mock-call assertions with no behavioral outcome) or that
   mirror the implementation line-by-line (would break on a pure refactor even when
   behavior is unchanged).
4. **Guarded tests are load-bearing** — a conditionally-skipped test (`skipif` / OS or
   env guard / `--test-skip`) still protects behavior on the platform it targets;
   never treat it as dead code, and flag its *absence* as a high-severity gap when a
   platform-specific code path exists untested.
5. Treat the supplied test-suite results as ground truth — never assume green,
   and never re-run the suite yourself (the orchestrator ran it once and passed
   the results into your prompt). A behavior the supplied results already fail
   on is CRITICAL evidence, not a guess.

---

## V — Conventions & Paired Invariants

**Scope**: does the change respect what *this* repo has already decided, not what
another stack would prefer? Two parts: loading the repo's actual conventions before
judging anything, then checking invariants that must move in lockstep.

**Severity rubric (this dimension)**:
- **CRITICAL**: the change violates a documented load-bearing invariant, or one side
  of a paired invariant changed without the other (e.g. a new event kind added but
  the reducer not updated) — will break at runtime or silently drift out of sync.
- **WARNING**: a new artifact isn't registered/wired into the discovery mechanism
  that should pick it up; a convention deviation that won't break anything today but
  fragments the codebase's style.
- **SUGGESTION**: minor naming, import-order, or style nit with no functional effect.

**Methodology**:

1. **Load conventions before judging anything convention-shaped** — read `CLAUDE.md`
   (root and any nested/package-level copies), plus `ARCHITECTURE.md` / `README.md` /
   `CONTRIBUTING.md` when present. Derive, for *this* repo:
   - Build/test commands and ordering gotchas (e.g. build-before-test, minimum
     runtime version).
   - Load-bearing invariants the repo calls out explicitly — a change that violates
     one is a strong CRITICAL/WARNING signal.
   - Paired invariants that must change together (emitter ↔ reducer, message string
     ↔ matching regex, schema ↔ mirrored type, producer ↔ consumer contract). Check
     both sides moved.
   - Registration/discovery steps a new artifact needs (a skill/agent a convention
     auto-discovers, a new event kind a reducer must handle, a case added to a
     switch).
   - The repo's stated module/style conventions (import style, naming, error-handling
     idioms).
   - If the repo has no such docs, infer conventions from representative source files
     instead of importing conventions from another stack.
2. **Convention & invariant adherence** — flag any documented invariant the change
   violates; confirm every paired invariant moved on both sides; confirm any new
   artifact needing registration/discovery actually got wired in.

---

## Q — Quality & Scope Creep

**Scope**: everything about the code that isn't correctness, security, tests, or
convention-adherence — clarity, duplication, efficiency, refactoring opportunities,
accessibility on user-facing surfaces, and unrequested scope.

**Severity rubric (this dimension)**:
- **CRITICAL**: scope creep large enough to constitute unreviewed, unrequested
  change — functionality, files, or behavior the plan/user never asked for, especially
  where it carries its own risk. Feature creep is CRITICAL in this dimension even
  though it isn't a correctness bug.
- **WARNING**: duplicated logic, unclear naming, oversized functions, unnecessary
  complexity, a "nice to have" addition that's small but still beyond the stated ask.
- **SUGGESTION**: refactoring opportunities (always SUGGESTION, never escalated),
  accessibility nits on UI surfaces, performance micro-optimizations with no observed
  bottleneck.

**Methodology**:

1. **Code quality & standards** — code is simple, clear, and easy to understand;
   functions and variables have descriptive, meaningful names; no duplicated code
   blocks or logic; follows the project's documented conventions; imports follow the
   repo's module conventions; functions are small and focused; interfaces have
   explicit inputs and outputs.
2. **Performance** — optimized without sacrificing readability; no obvious
   bottlenecks on hot paths.
3. **Refactoring & code context** — examine code in the context of adjacent code;
   look for opportunities to consolidate similar patterns; check whether new code
   follows existing architectural patterns in surrounding files. Refactoring
   suggestions are always classified as SUGGESTION, never higher.
4. **Accessibility** (only when the change touches a user-facing surface) — for
   UI/interactive surfaces: missing labels/roles, missing test hooks, insufficient
   affordances. For pure CLI/library/backend changes this is usually N/A — don't
   invent UI concerns where there is no UI.
5. **Feature creep & unnecessary additions (CRITICAL)** — flag any feature or
   behavior not explicitly requested by the user or the plan; functionality beyond
   the stated requirements; "nice to have" additions that weren't part of the
   original problem statement; complex solutions where simpler alternatives would
   meet the requirements; scope creep — files or behaviors changed that the plan
   never mentioned.
