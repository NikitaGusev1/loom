---
name: risk-scan
description: "Explicitly scan code adjacent to recent changes through integration, reliability, trust-boundary, and maintainability risk lenses, then write a durable report and optional deduplicated registry update."
---

# Risk Scan

Run a bounded, non-blocking project-health scan. This workflow is explicit only: never invoke it from `auto-implement`, `auto-run`, `implement-plan`, or `code-review`, and never feed ambient findings into an automatic fix loop.

## Artifact And Helper Contracts

Before scanning, load `../../references/artifact-repository.md` and `../../references/risk-lenses.md`, resolved relative to this skill. Use the central artifact repository only; never place durable risk-scan output in the target repository's `.claude/ai/` or `.codex/ai/` directories.

Use `loom-risk-helper` as the deterministic boundary:

- `loom-risk-helper context --repo <repo> [--base <ref>] [--paths <csv>]` emits one JSON object on stdout. Diagnostics are stderr. Nonzero means invalid input or context failure.
- `loom-risk-helper registry-merge --artifact-root <artifact-root> --registry <registry.json> --entries <candidate.json> --report <report-basename> --project-slug <slug>` validates and atomically merges candidates, then emits a compact JSON summary.
- `loom-risk-helper registry-validate --artifact-root <artifact-root> --registry <registry.json> --project-slug <slug>` fail-loud validates an existing registry.

Do not reproduce Git seed selection, path containment, fingerprinting, deduplication, or registry writes in prose or shell snippets.

## Parameters

Parse invocation arguments strictly:

- `--base <ref>` selects an explicit Git base.
- `--paths <comma-separated-repository-relative-files>` replaces diff-derived seeds.
- `--report-only` writes the immutable report and never invokes `registry-merge`.

Reject unknown flags, missing values, duplicate singleton flags, empty `--paths`, positional values, and the conflicting combination of `--base` with `--paths`.

## Step 1: Resolve Context Or Stop

Run `loom-risk-helper context` exactly once with the target repository and parsed arguments. Preserve its JSON output as the authoritative scan context. If it returns a successful zero-seed result, report the no-op and stop without dispatching agents or creating artifacts. On a nonzero exit, surface stderr and stop.

Resolve the project slug and artifact root using the artifact repository contract. The report directory is `projects/<slug>/risk-register/`.

## Step 2: Gather Shared Context Once

Build one bounded context bundle and reuse it unchanged for all four finders:

1. The helper's repository, branch, `HEAD`, base/merge-base, status, seed paths, and relevant diff metadata/content.
2. A convention digest from applicable `AGENTS.md`, `CLAUDE.md`, `ARCHITECTURE.md`, `CONTRIBUTING.md`, and representative README files.
3. The newest matching approved spec and plan and latest matching review, discovered central-first using the artifact contract.
4. Recent test/review evidence, including its source and timestamp/age. Missing or stale evidence must be stated and must not be described as runtime verification.
5. A digest of open and accepted registry entries overlapping seed paths or symbols. If the registry is absent, use an empty digest without validation. If it exists, run the complete command below before reading any entries:

```text
loom-risk-helper registry-validate \
  --artifact-root <artifact-root> \
  --registry <artifact-root>/projects/<slug>/risk-register/registry.json \
  --project-slug <slug>
```

Only consume the digest after successful validation. A malformed registry stops a normal scan before finder dispatch because persistence is unavailable. With `--report-only`, disclose the validation failure, exclude the invalid registry from the digest, and continue analysis without registry persistence. Never rewrite or silently ignore a malformed registry.

Do not run a broad test suite. Read-only code navigation and narrow static inspection are allowed.

## Step 3: Dispatch Four Generic Finders

Use the Codex collaboration agent mechanism directly. Spawn four independent generic agents concurrently, subject to the environment's concurrency limit: one each for `I`, `R`, `B`, and `M`. Do not reference Claude `Agent`, `subagent_type`, plugin-named agent roles, or `dag-executor:*` agents.

Each prompt must inline, rather than merely link:

- the complete shared exploration envelope and finder output contract from `risk-lenses.md`;
- the complete brief and severity/exclusion rules for that agent's one lens;
- the identical shared context bundle and overlapping registry digest;
- this role contract: operate read-only, inspect no further than the two-hop envelope except the documented shared-contract exception, return at most ten non-duplicate candidates, do not run broad tests, do not write files, do not dispatch nested agents, and do not propose automatic fixes.

Wait for all four results. If concurrency slots are fewer than four, start as many as possible, collect a completed result, then start the remaining lens; every lens must still receive the identical frozen context.

## Step 4: Normalize And Select Verification

Validate every candidate against the finder contract. Drop malformed, out-of-envelope, vague/style-only, and known-duplicate candidates. Enforce ten candidates per lens. Sort deterministically by severity, confidence, lens, and temporary ID.

Verification is mandatory for:

- every `bug`;
- every `critical` or `high` risk;
- every candidate with `disposition: change-related`.

Label unverified medium/low improvements `unverified-advisory`. Do not represent them as confirmed.

## Step 5: Dispatch Generic Verifiers

If no candidate requires verification, skip dispatch. Otherwise use generic Codex collaboration agents directly, one candidate per agent. Dispatch concurrently up to the environment's available slots and process additional candidates in batches as slots become available.

Each verifier prompt must inline:

- exactly one normalized candidate;
- the relevant shared context and registry/review duplicate digest;
- the complete verifier contract and outcome definitions from `risk-lenses.md`;
- this role contract: independently re-read cited code, attempt to refute the scenario by finding guards or contradictory contracts, verify the seed relationship and scope, perform no writes, run no broad tests, dispatch no nested agents, and return one of `confirmed`, `deferred`, `rejected`, or `promote-to-code-review` with reason, evidence, and optional downgrade.

Never batch multiple findings into one verifier. Wait for all verifier results before convergence.

## Step 6: Converge Findings

Apply verifier downgrades but never upgrades. Drop `rejected` candidates from active findings and count them for report metadata. Keep `deferred` candidates clearly labeled. Merge candidates with the same root cause while retaining all evidence and temporary IDs.

Separate results into:

- confirmed ambient bugs and risks;
- advisory improvements, including every `unverified-advisory`;
- `Change Review Candidates` for `promote-to-code-review` outcomes;
- deferred findings.

Do not edit a review artifact or source file and do not trigger fixes. For change-review candidates, tell the caller to run or refresh `/code-review`.

Before persistence, project finder/verifier records into registry candidates. Use the exact schema-v1 candidate-set envelope and projection contract in `../../references/risk-lenses.md`: map `I -> integration`, `R -> reliability`, `B -> trust-boundaries`, and `M -> maintainability`; map confirmed or unverified ambient entries to `open` and deferred entries to `deferred`; reduce confidence to `high | medium | low` and retain its rationale only in the report. Require non-empty `evidence`, non-empty `affectedPaths`, and a non-empty top-level `rootCause` copied from the concrete root-cause summary also used in `fingerprintInputs`.

The serialized envelope is exactly `{"schemaVersion":1,"projectSlug":"<slug>","entries":[<projected candidate>, ...]}`; do not add top-level orchestration metadata.

Copy only `kind`, `severity`, `title`, `evidence`, `affectedPaths`, `seedRelationship`, `failureScenario`, `suggestedAction`, required `rootCause`, and optional `primaryAnchor`, plus the mapped lens, confidence, and optional status. Copy `rootCause` verbatim from the finder field while omitting the `fingerprintInputs` container. Omit `temporaryId`, `fingerprintInputs`, `disposition`, verifier outcome/reason, confidence rationale, standalone hop metadata, and every other orchestration-only field. Exclude rejected findings and `Change Review Candidates`; never pass raw finder records to `registry-merge`.

## Step 7: Write An Immutable Report

Create the report with exclusive-create semantics beneath `projects/<slug>/risk-register/`. Prefer `risk-YYYY-MM-DD-<scan-slug>.md`; on collision append a UTC timestamp or stable scan ID. Never truncate or overwrite an existing report. Use the actual chosen basename for registry source-report updates.

The report must contain:

- metadata: UTC time, project, repository, branch, `HEAD`, resolved base, invocation, and report mode;
- scan envelope: seeds, two-hop boundary, shared-contract exceptions, and inspected paths;
- evidence sources: specs/plans/reviews, convention sources, and test evidence with source/age;
- confirmed ambient findings with exact evidence and verification result;
- advisory improvements, explicitly identifying `unverified-advisory` items;
- `Change Review Candidates`;
- deferred findings and rejected/deferred counts;
- a persistence section that records report creation and whether the registry is skipped or pending. In normal mode, point to the exclusive authoritative persistence sidecar described below; never place a post-creation merge result in the immutable report.

## Step 8: Persist Registry Unless Report-Only

For `--report-only`, finalize the report with `registry: skipped (--report-only)`, state that `registry.json` was untouched, and never call `registry-merge`.

Otherwise serialize only converged registry candidates to a temporary JSON file outside both the target source tree and the durable `risk-register` directory. Invoke `loom-risk-helper registry-merge` with `--artifact-root <artifact-root>`, the central `registry.json`, candidate path, actual report basename, and project slug. Do not include rejected or change-review candidates as active ambient entries.

After the immutable report exists, always write the merge success summary or exact structured failure with exclusive-create semantics to `<report-basename>.persistence.json`; this sidecar is the authoritative persistence result referenced by the report's pending section. Treat `durability-uncertain` and `lock-release-failed` as persistence failures, record the exact structured code, registry path, and helper diagnostic, and advise validation plus an idempotent retry; never claim success. Never reopen or rewrite the report. On merge failure, retain the report, write or surface the structured error, and do not fall back to project-local durable storage. Clean up the temporary candidate JSON after both success and failure.

## Step 9: Summary

Return the report path, seed count, confirmed/advisory/change-review/deferred counts, and registry merge summary or failure. State clearly that ambient findings do not alter the current code-review verdict.
