---
description: Explicitly scans a bounded neighborhood around changed or supplied seed paths through integration, reliability, trust-boundary, and maintainability lenses. Writes an immutable central report and optionally updates the risk registry.
argument-hint: [--base <ref>] [--paths <comma-separated-paths>] [--report-only]
phase: review
---

# Risk Scan

Run an explicit, non-blocking project-health scan. This skill is independent from `/code-review` and every automatic implementation flow. It never edits source, review files, plans, or checkpoints and never triggers fixes.

The `risk-finder` and `risk-verifier` agents ship with this plugin. If a bare subagent type does not resolve, use `dag-executor:risk-finder` or `dag-executor:risk-verifier`.

## Step 1: Parse Arguments

Accept only:

- `--base <ref>` once.
- `--paths <comma-separated-repository-relative-paths>` once.
- `--report-only` once, with no value.

Reject unknown flags, missing/empty values, positional arguments, duplicate flags, and `--base` combined with `--paths`. Do not interpret or normalize paths in the skill; the helper is the path-containment authority.

## Step 2: Resolve Artifacts and Context

Load `../../references/artifact-repository.md`. Resolve the artifact root from `LOOM_ARTIFACTS_DIR`, otherwise `/Users/nikita/Desktop/repos/dag-executor-artifacts`. Resolve the target repository with `git rev-parse --show-toplevel` and use its directory name as the project slug.

Call `loom-risk-helper context` exactly once:

```text
loom-risk-helper context --repo <repo> [--base <ref>] [--paths <paths>]
```

Capture its single JSON stdout object; diagnostics belong to stderr. A nonzero exit is a hard input/context failure. Do not dispatch agents. If the successful object reports zero seeds, return a concise no-op result and stop without creating artifacts or dispatching agents. Never widen a no-seed scan to the repository.

## Step 3: Gather Shared Context Once

Build one immutable shared-context bundle and reuse it verbatim in all four finder prompts:

1. The complete context JSON, seed list, and relevant committed/staged/unstaged/untracked diff supplied or identified by the helper.
2. A concise convention digest from applicable `AGENTS.md`, `CLAUDE.md`, `ARCHITECTURE.md`, `CONTRIBUTING.md`, and README files.
3. The newest matching approved spec and plan and newest matching review from central `projects/<slug>/`, with the local fallbacks allowed by the artifact contract.
4. The newest relevant test evidence, including its artifact source and timestamp/age. Mark absent or stale evidence explicitly. Historical evidence is not runtime verification and the scan does not run broad tests.
5. A digest of central `risk-register/registry.json` entries with `open` or `accepted` status whose paths or symbols overlap the seeds. If the registry is absent, use an empty digest without validation. If it exists, run the complete command below before reading any entries:

```text
loom-risk-helper registry-validate \
  --artifact-root <artifact-root> \
  --registry <artifact-root>/projects/<slug>/risk-register/registry.json \
  --project-slug <slug>
```

Only consume the digest after successful validation. A malformed registry stops a normal scan before finder dispatch because persistence is unavailable. With `--report-only`, disclose the validation failure, exclude the invalid registry from the digest, and continue analysis without registry persistence. Never rewrite or silently ignore a malformed registry.

## Step 4: Dispatch Four Finders in Parallel

Read `../../references/risk-lenses.md`. In one parallel fan-out, dispatch exactly four `risk-finder` agents, one each for `I`, `R`, `B`, and `M`.

Each prompt must inline:

- The complete shared exploration envelope, candidate contract, and assigned lens brief verbatim.
- The identical shared-context bundle from Step 3.
- The identical overlapping registry digest.
- The read-only constraint and ten-candidate cap.

Do not merely link the reference. Collect all four responses. Reject malformed blocks, enforce at most ten candidates per lens, normalize enum spelling, and sort candidates by severity (`critical`, `high`, `medium`, `low`) then confidence (`high`, `medium`, `low`).

## Step 5: Dispatch Required Verifiers

A candidate requires independent verification when any condition holds:

- kind is `bug`;
- severity is `critical` or `high`;
- disposition is `change-related`.

If none qualify, dispatch no verifiers. Otherwise dispatch one `risk-verifier` per required candidate in a parallel fan-out. Each verifier receives exactly one complete candidate plus the shared context needed to inspect it, never the other candidates. When the environment limits concurrency, use parallel batches and collect every result before convergence.

Medium/low improvements that do not qualify for verification must be labeled `unverified-advisory`; they cannot appear as confirmed.

## Step 6: Converge

1. Apply verifier outcomes and permitted severity downgrades.
2. Drop `rejected` candidates from active findings, while counting them in report metadata.
3. Keep `deferred` candidates labeled deferred.
4. Put `promote-to-code-review` candidates only in `Change Review Candidates`. Do not edit or create a code-review artifact and do not trigger a fix; recommend running or refreshing `/code-review`.
5. Merge candidates with the same root cause, retaining all evidence, seed relationships, and temporary IDs.
6. Separate confirmed/deferred ambient bugs and risks from `unverified-advisory` improvements.
7. Prepare registry candidates only from converged non-rejected ambient entries. Preserve status semantics for the helper; change-review candidates are report-only.

Before persistence, project finder/verifier records into registry candidates. Use the exact schema-v1 candidate-set envelope and projection contract in `../../references/risk-lenses.md`: map `I -> integration`, `R -> reliability`, `B -> trust-boundaries`, and `M -> maintainability`; map confirmed or unverified ambient entries to `open` and deferred entries to `deferred`; reduce confidence to `high | medium | low` and retain its rationale only in the report. Require non-empty `evidence`, non-empty `affectedPaths`, and a non-empty top-level `rootCause` copied from the concrete root-cause summary also used in `fingerprintInputs`.

The serialized envelope is exactly `{"schemaVersion":1,"projectSlug":"<slug>","entries":[<projected candidate>, ...]}`; do not add top-level orchestration metadata.

Copy only `kind`, `severity`, `title`, `evidence`, `affectedPaths`, `seedRelationship`, `failureScenario`, `suggestedAction`, required `rootCause`, and optional `primaryAnchor`, plus the mapped lens, confidence, and optional status. Copy `rootCause` verbatim from the finder field while omitting the `fingerprintInputs` container. Omit `temporaryId`, `fingerprintInputs`, `disposition`, verifier outcome/reason, confidence rationale, standalone hop metadata, and every other orchestration-only field. Exclude rejected findings and `Change Review Candidates`; never pass raw finder records to `registry-merge`.

## Step 7: Create the Immutable Report

Use UTC timestamps in content and the current local date in the filename. Derive a short kebab-case scan slug from the branch or explicit seeds. The preferred path is:

```text
<artifact-root>/projects/<slug>/risk-register/risk-YYYY-MM-DD-<scan-slug>.md
```

Create the directory when needed. Create the report with exclusive-create semantics. If the preferred name exists, append a UTC timestamp or stable scan-ID suffix and retry exclusive creation. Never truncate, replace, or modify an existing report.

The report must include:

- Metadata: repository, project slug, branch, `HEAD`, resolved base/merge-base, timestamp, invocation mode, and actual report basename.
- Scan envelope: seeds, relationship/hop boundary, shared-contract exceptions, and working-tree state.
- Evidence sources: conventions, spec/plan/review, registry digest, and test evidence with source/age and an explicit runtime-verification disclaimer.
- `Ambient Findings`, with verification status and exact evidence.
- `Advisory Improvements`, clearly marking `unverified-advisory` entries.
- `Change Review Candidates`.
- Rejected and deferred counts.
- A `Persistence Result` section. In report-only mode it states `registry: skipped (--report-only)`; in normal mode it states that the authoritative merge result is recorded in the exclusive persistence sidecar.

Re-read the chosen file and confirm its basename and required sections before registry persistence. The actual chosen basename, not the preferred name, is the source report passed to the helper.

## Step 8: Persist the Registry Unless Report-Only

For `--report-only`, do not create a candidate JSON file and never call `registry-merge`. The report already contains `registry: skipped (--report-only)`; stop without reopening it.

In normal mode, serialize the converged registry candidates to a temporary JSON file outside the durable risk-register directory, validate that it parses, then call:

```text
loom-risk-helper registry-merge \
  --artifact-root <artifact-root> \
  --registry <artifact-root>/projects/<slug>/risk-register/registry.json \
  --entries <temporary-candidate-json> \
  --report <actual-report-basename> \
  --project-slug <slug>
```

The resolved registry target must be exactly the central `<artifact-root>/projects/<slug>/risk-register/registry.json` path. `--artifact-root` binds the helper's containment check; never omit it, substitute a project-local root, or bypass a containment/symlink rejection.

Capture the compact JSON merge summary. Write the success summary, or the exact failure and intended registry path, to an exclusively created `<report-basename>.persistence.json` sidecar. Treat `durability-uncertain` and `lock-release-failed` as persistence failures, record the exact structured code, registry path, and helper diagnostic, and advise validation plus an idempotent retry; never claim success. Never reopen the report. On failure, retain the report and do not fall back to `.claude/ai/`, `.codex/ai/`, or any other project-local durable storage. Clean up only the temporary candidate file.

The sidecar must contain the report basename, registry path, attempted-at UTC timestamp, outcome, and helper summary or error. Create it exclusively and never overwrite an existing sidecar. This preserves the report byte-for-byte while making persistence auditable.

## Step 9: Fail-Loud Validation and Summary

- Run `loom-risk-helper registry-validate --artifact-root <artifact-root> --registry <registry> --project-slug <slug>` after a successful merge.
- Confirm every active bug, critical/high risk, and change-related candidate has a verifier outcome.
- Confirm every unverified medium/low improvement says `unverified-advisory`.
- Confirm no rejected candidate is persisted and no change-review candidate was sent to registry merge.
- Confirm the report remained byte-for-byte unchanged after exclusive creation.

Return the report path, ambient/advisory/change-review counts, rejected/deferred counts, and registry result. A registry error is a persistence failure, not an analysis failure; report both accurately.
