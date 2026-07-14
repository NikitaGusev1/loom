# Risk Scan Lenses

These four lenses are intentionally non-overlapping. A finder owns exactly one lens, may return at most ten candidates, and must omit duplicates from the supplied registry digest. All lenses use the same two-hop boundary and require a seed relationship for every candidate.

## Shared Exploration Envelope

- Start only from the supplied seed paths and symbols.
- Inspect direct callers/dependents (hop 1), then their direct callers/dependents or directly paired lifecycle operations (hop 2).
- Shared contracts, schemas, persistence, state, and configuration may be inspected beyond two hops only when the contract itself provides concrete evidence of a cross-cutting failure. Mark this exception explicitly.
- Associated tests and operational documentation may be read as evidence. Do not run broad tests.
- Every candidate must state its seed relationship and hop count. Omit repository-wide speculation, style preferences, and vague cleanup.

Severity calibration is shared across lenses:

- `critical`: immediately exploitable boundary failure, likely irreversible data loss, or broadly reachable production outage.
- `high`: credible severe failure with a realistic trigger and material blast radius.
- `medium`: bounded failure or maintenance cost with concrete evidence and a plausible trigger.
- `low`: localized, low-impact issue with a specific failure or measurable cost.

Improvements cannot exceed `medium` unless they eliminate an independently verified high-severity risk.

## I - Integration and Blast Radius

Inspect callers, consumers, data contracts, paired APIs, registration/discovery, compatibility behavior, and one representative analogous implementation. Trace incomplete propagation, producer/consumer disagreement, lifecycle asymmetry, and compatibility gaps that can break adjacent workflows.

Method: identify contracts and paired APIs touched by each seed; trace direct producers and consumers; check registration and one analogous implementation; then describe the reachable failing workflow.

Exclude internal retry/cleanup mechanics (lens R), input trust and privilege boundaries (lens B), and maintainability-only concerns without a present integration failure (lens M).

Emit integration failures caused solely by the current diff with `disposition: change-related`; they require independent verification and routing to `Change Review Candidates` / `promote-to-code-review`, without automatic fixes.

## R - Reliability and Operations

Inspect retries, timeouts, concurrency, cleanup, idempotency, crash recovery, state transitions, observability, and degraded modes. Check paired acquire/release and start/stop behavior, partial failures, stale state, duplicate execution, and recovery after interruption.

Method: trace resource and state ownership across success, failure, cancellation, retry, timeout, and restart; then establish whether the failure is bounded, observable, and recoverable.

Exclude API propagation mismatches (lens I), hostile/untrusted input handling (lens B), and general abstraction or test-architecture improvements (lens M).

## B - Trust Boundaries

Inspect external input, filesystem/process/network boundaries, authorization assumptions, secret exposure, unsafe interpolation, path handling, and validation gaps. Follow data from its trust boundary to a sensitive operation and identify the missing or ineffective guard.

Method: identify the less-trusted source, trace normalization and validation to the first privileged sink, and state the attacker or malformed-input capability and concrete impact.

Exclude ordinary internal contract mismatches (lens I), non-adversarial operational failures (lens R), and general code quality (lens M).

## M - Maintainability and Evolution

Inspect concrete duplication, fragile coupling, scaling limits, upgrade hazards, obsolete compatibility paths, and missing architectural tests. Report an improvement only when evidence shows a plausible future failure or measurable recurring maintenance cost and the suggested action is bounded.

Method: identify the repeated contract or implicit coupling, show its current coordination cost or trigger, check one analogous implementation or architectural test, and propose the smallest bounded action.

Exclude stylistic preferences, speculative rewrites, generic test requests, and issues that already qualify as integration, reliability, or trust-boundary failures.

## Candidate Contract

Return each candidate with all fields below:

- `temporaryId`: `[<lens>-<severity-letter><ordinal>]`, using lens `I`, `R`, `B`, or `M` and severity letter `C`, `H`, `M`, or `L`.
- `lens`, `kind` (`bug | risk | improvement`), `severity`, `confidence` (`high | medium | low`), a concise confidence rationale, and `title`.
- Exact `file:line` evidence and affected paths/symbols.
- `seedRelationship`, including the seed, relationship chain, hop count, and any shared-contract exception.
- Concrete `failureScenario` or measurable maintenance cost.
- Bounded `suggestedAction`.
- `rootCause`: a non-empty concrete root-cause summary, identical to the root-cause summary used in `fingerprintInputs`.
- `fingerprintInputs`: normalized lens, kind, primary path, symbol/line anchor, and root-cause summary.
- `disposition`: `ambient | change-related`.

Return no more than ten candidates for the assigned lens.

## Registry Candidate Projection

Finder output is an orchestration record, not registry input. Immediately before persistence, project only converged, non-rejected ambient entries into this exact schema-v1 candidate-set envelope:

```json
{"schemaVersion":1,"projectSlug":"<slug>","entries":[{"lens":"integration | reliability | trust-boundaries | maintainability","kind":"bug | risk | improvement","severity":"critical | high | medium | low","confidence":"high | medium | low","status":"open | deferred (optional)","title":"<non-empty>","evidence":["<non-empty file:line>"],"affectedPaths":["<non-empty repository-relative path>"],"seedRelationship":"<non-empty>","failureScenario":"<non-empty>","suggestedAction":"<non-empty>","primaryAnchor":"<optional non-empty>","rootCause":"<non-empty; copied from finder rootCause>"}]}
```

Apply these mappings exactly:

- lens mapping: `I -> integration`, `R -> reliability`, `B -> trust-boundaries`, `M -> maintainability`;
- convergence mapping: confirmed or unverified ambient entry `-> open`; deferred entry `-> deferred`;
- confidence mapping: retain only `high | medium | low`; keep its rationale in the report.

Copy `kind`, `severity`, `title`, non-empty `evidence`, non-empty `affectedPaths`, `seedRelationship`, `failureScenario`, `suggestedAction`, required non-empty `rootCause`, and optional `primaryAnchor`. The copied `rootCause` must be the same concrete summary used inside the finder record's `fingerprintInputs`; omit the `fingerprintInputs` container itself. Reject projection when evidence, affected paths, or root cause are empty. Omit `temporaryId`, `fingerprintInputs`, `disposition`, verifier outcome/reason, confidence rationale, standalone hop metadata, and every other orchestration-only field. Exclude rejected findings and `Change Review Candidates`; change-related findings are report-only and never registry candidates.

## Verification Policy

Independently verify every `bug`, every `critical` or `high` risk, and every `change-related` candidate. Medium/low improvements that do not otherwise require verification must be labeled `unverified-advisory` and must never be represented as confirmed.

Verifier outcomes are `confirmed`, `deferred`, `rejected`, and `promote-to-code-review`.
