# Risk Scan Lenses

Use these four lenses independently. Each finder receives one complete lens brief and the same shared scan context. A finder may return at most ten candidates and must omit known registry duplicates, style-only feedback, and vague cleanup suggestions.

## Shared Exploration Envelope

Start from the supplied seed paths. Inspect only:

- direct callers and direct dependencies of changed symbols;
- shared contracts, schemas, state, configuration, or persistence touched by a seed;
- paired lifecycle operations such as acquire/release, start/stop, write/read, and encode/decode;
- one representative analogous implementation;
- directly associated tests and operational documentation.

Stop beyond the two-hop boundary from a seed. A shared contract may justify an exception only when it directly demonstrates a concrete cross-cutting failure; identify the contract and evidence for the exception. Every candidate must state its seed relationship in `seedRelationship`.

## I - Integration and Blast Radius

Inspect callers, consumers, data contracts, paired APIs, feature registration, compatibility behavior, and one analogous implementation. Look for incomplete propagation, mismatched assumptions, or pre-existing contract failures that can break adjacent workflows.

Method:

1. Identify the externally visible contracts and paired operations touched by each seed.
2. Trace direct producers and consumers for incompatible shapes, state, ordering, or lifecycle assumptions.
3. Check registration and discovery paths and one analogous implementation for missing propagation.
4. Describe a concrete reachable workflow that fails.

Exclude local readability and hypothetical integrations without a caller.

Emit integration failures caused solely by the current diff with `disposition: change-related`; they require independent verification and routing to `Change Review Candidates` / `promote-to-code-review`, without automatic fixes.

## R - Reliability and Operations

Inspect retries, timeouts, concurrency, cleanup, idempotency, crash recovery, state transitions, observability, resource limits, and degraded modes. Look for failures that happy-path tests are unlikely to expose.

Method:

1. Trace state and resource ownership through success, error, cancellation, restart, and timeout paths.
2. Check concurrency and retry behavior for lost updates, duplication, deadlock, stale ownership, and non-idempotent effects.
3. Check whether failures are bounded, observable, and recoverable.
4. State the trigger, operational impact, and evidence from the actual path.

Exclude generic requests for more logging, unsupported scale speculation, and availability concerns without a concrete failure condition.

## B - Trust Boundaries

Inspect external input, filesystem, process, network, authorization, secrets, unsafe interpolation, path handling, and validation boundaries. Follow adjacent boundary code even when it is pre-existing.

Method:

1. Identify where untrusted or less-trusted data enters and where authority or interpretation changes.
2. Trace validation and normalization through the first privileged sink.
3. Check containment, permission, command argument, credential, and confused-deputy assumptions.
4. Describe the attacker or malformed-input capability and the concrete impact.

Exclude threats that require impossible capabilities, security hardening without an abuse path, and duplicate diff-scoped security findings.

## M - Maintainability and Evolution

Inspect concrete duplication, fragile coupling, scaling limits, upgrade hazards, obsolete compatibility paths, and missing architectural tests. Report an improvement only when evidence identifies a plausible future failure or measurable maintenance cost and the action is bounded.

Method:

1. Identify a repeated contract, implicit coupling, or version/scale assumption adjacent to a seed.
2. Show the current duplication, coordination cost, or likely failure trigger using exact code evidence.
3. Check one analogous implementation or architectural test to confirm the inconsistency or missing invariant.
4. Propose the smallest bounded action that reduces the evidenced cost.

Exclude taste, naming, formatting, speculative rewrites, broad refactors, and unactionable technical-debt statements.

## Severity Calibration

- `critical`: immediately exploitable trust boundary, likely data loss, or broadly reachable production failure.
- `high`: serious failure with a credible trigger and material blast radius.
- `medium`: bounded failure or maintenance hazard with concrete evidence and moderate impact.
- `low`: narrow, low-impact issue with a demonstrated trigger or measurable cost.

Improvements cannot exceed `medium` unless they eliminate an independently verified high-severity risk.

## Finder Output Contract

Return structured candidates as JSON or clearly delimited records. Every candidate must include:

- `temporaryId`: `[<lens>-<severity-letter><ordinal>]`, for example `[R-H1]`;
- `lens`: `I`, `R`, `B`, or `M`;
- `kind`: `bug`, `risk`, or `improvement`;
- `severity`: `critical`, `high`, `medium`, or `low`;
- `confidence`: a concise calibrated value and rationale;
- `title`;
- `evidence`: exact repository-relative `file:line` citations;
- `affectedPaths` and affected symbols;
- `seedRelationship`, including hop count or documented shared-contract exception;
- `failureScenario` or measurable maintenance cost;
- `suggestedAction`: bounded work, not an automatic fix;
- `rootCause`: a non-empty concrete root-cause summary, identical to the root-cause summary used in `fingerprintInputs`;
- `fingerprintInputs`: normalized lens, kind, primary path, symbol/line anchor, and root-cause summary;
- `disposition`: `ambient` or `change-related`.

Use the supplied registry digest to omit known duplicates. Return no candidate rather than padding the result to the ten-candidate cap.

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

## Verifier Contract

The verifier receives exactly one candidate plus enough shared context to re-read its citations. It is adversarial: re-read the cited code, trace the claimed scenario, look for guards or invariants that refute it, check for registry/review duplication, and only then decide.

Return exactly one outcome:

- `confirmed`: evidence supports the claim and classification;
- `deferred`: the concern may be real but evidence or urgency is insufficient for active status;
- `rejected`: false positive, duplicate, out of envelope, or unsupported speculation;
- `promote-to-code-review`: caused by the current change or required to establish its safety.

Include a concise reason, exact evidence, and an optional severity downgrade. Never upgrade severity. Every `bug`, every `critical` or `high` risk, and every `change-related` candidate requires verification. Unverified medium/low improvements must be labeled `unverified-advisory`, never `confirmed`.

Finders and verifiers are read-only. They must not write source or artifacts, run broad tests, dispatch nested agents, or apply fixes.
