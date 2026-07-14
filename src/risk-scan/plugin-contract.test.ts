import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseRiskCandidateSet } from './registry.js';

const read = (path: string): string => readFileSync(resolve(path), 'utf8');

const claudeSkill = 'skills/risk-scan/SKILL.md';
const codexSkill = 'codex/plugins/loom/skills/risk-scan/SKILL.md';
const claudeLenses = 'references/risk-lenses.md';
const codexLenses = 'codex/plugins/loom/references/risk-lenses.md';
const artifactReferences = [
  'references/artifact-repository.md',
  'codex/plugins/loom/references/artifact-repository.md',
];

describe('risk-scan plugin contract', () => {
  it('exposes equivalent inputs and outcomes on Claude and Codex', () => {
    const requiredTokens = [
      '--base',
      '--paths',
      '--report-only',
      'ambient',
      'change-related',
      'confirmed',
      'deferred',
      'rejected',
      'promote-to-code-review',
      'Change Review Candidates',
      'loom-risk-helper',
    ];

    for (const path of [claudeSkill, codexSkill]) {
      const content = read(path);
      for (const token of requiredTokens) {
        assert.match(content, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${path} missing ${token}`);
      }
    }
  });

  it('keeps both skills discoverable and Codex on generic collaboration agents', () => {
    assert.match(read(claudeSkill), /^---[\s\S]*description:[\s\S]*---/);
    assert.match(read(codexSkill), /^---[\s\S]*name: risk-scan[\s\S]*---/);

    const claudeMetadata = `${read('.claude-plugin/plugin.json')}\n${read('.claude-plugin/marketplace.json')}`;
    assert.match(claudeMetadata, /risk-scan/);
    assert.match(read('codex/plugins/loom/.codex-plugin/plugin.json'), /risk-scan/);

    const codex = read(codexSkill);
    assert.match(codex, /generic Codex collaboration agents/i);
    assert.match(codex, /Do not reference Claude `Agent`, `subagent_type`/);
    assert.doesNotMatch(codex, /Spawn an agent with `subagent_type/);
  });

  it('keeps the four risk lenses and bounded exploration contract aligned', () => {
    const requiredTokens = [
      'Integration and Blast Radius',
      'Reliability and Operations',
      'Trust Boundaries',
      'Maintainability and Evolution',
      'two-hop',
      'seed relationship',
    ];

    for (const path of [claudeLenses, codexLenses]) {
      const content = read(path);
      for (const token of requiredTokens)
        assert.ok(content.toLowerCase().includes(token.toLowerCase()), `${path} missing ${token}`);
    }
  });

  it('defines the same strict finder-to-registry projection on both surfaces', () => {
    const projectionTokens = [
      '{"schemaVersion":1,"projectSlug":"<slug>","entries"',
      'I -> integration',
      'R -> reliability',
      'B -> trust-boundaries',
      'M -> maintainability',
      'open',
      'deferred',
      'non-empty `evidence`',
      'non-empty `affectedPaths`',
      'temporaryId',
      'fingerprintInputs',
      'disposition',
      'verifier outcome/reason',
      'confidence rationale',
      'rootCause',
      'Change Review Candidates',
    ];

    for (const path of [claudeSkill, codexSkill, claudeLenses, codexLenses]) {
      const content = read(path);
      for (const token of projectionTokens)
        assert.ok(content.includes(token), `${path} projection contract missing ${token}`);
    }
  });

  it('requires stable finder identity and projectable evidence fields', () => {
    const finder = read('agents/risk-finder.md');
    for (const token of [
      '**ConfidenceRationale**',
      '**AffectedPaths**',
      '**RootCause**',
      'use this same summary in FingerprintInputs',
    ])
      assert.ok(finder.includes(token), `finder contract missing ${token}`);

    for (const path of [claudeLenses, codexLenses, claudeSkill, codexSkill]) {
      const content = read(path);
      assert.match(content, /required (?:non-empty )?`rootCause`|non-empty top-level `rootCause`/i);
      assert.match(content, /rootCause[\s\S]{0,220}(?:same|also used|verbatim)[\s\S]{0,180}fingerprintInputs/i);
    }
  });

  it('accepts projected schema-v1 candidates and rejects raw finder records', () => {
    const rawFinderRecord = {
      temporaryId: '[R-H1]',
      lens: 'R',
      kind: 'bug',
      severity: 'high',
      confidence: { value: 'high', rationale: 'Directly reachable error path.' },
      title: 'Lock release failure is hidden',
      evidence: ['src/risk-scan/registry.ts:477'],
      affectedPaths: ['src/risk-scan/registry.ts'],
      seedRelationship: 'registry.ts seed -> paired acquire/release path (hop 1)',
      failureScenario: 'A completed merge reports success while its lock remains held.',
      suggestedAction: 'Return a structured failure when owned-lock release fails.',
      primaryAnchor: 'mergeRiskRegistry',
      rootCause: 'Release errors are suppressed after an otherwise successful merge.',
      fingerprintInputs: {
        lens: 'R',
        kind: 'bug',
        primaryPath: 'src/risk-scan/registry.ts',
        primaryAnchor: 'mergeRiskRegistry',
        rootCause: 'Release errors are suppressed after an otherwise successful merge.',
      },
      disposition: 'ambient',
      verifier: { outcome: 'confirmed', reason: 'No release guard exists.' },
    } as const;
    const projectedEntry = {
      lens: 'reliability',
      kind: rawFinderRecord.kind,
      severity: rawFinderRecord.severity,
      confidence: rawFinderRecord.confidence.value,
      status: 'open',
      title: rawFinderRecord.title,
      evidence: rawFinderRecord.evidence,
      affectedPaths: rawFinderRecord.affectedPaths,
      seedRelationship: rawFinderRecord.seedRelationship,
      failureScenario: rawFinderRecord.failureScenario,
      suggestedAction: rawFinderRecord.suggestedAction,
      primaryAnchor: rawFinderRecord.primaryAnchor,
      rootCause: rawFinderRecord.rootCause,
    } as const;
    const projected = { schemaVersion: 1 as const, projectSlug: 'dag-executor-main', entries: [projectedEntry] };

    assert.equal(rawFinderRecord.rootCause, rawFinderRecord.fingerprintInputs.rootCause);
    assert.deepEqual(parseRiskCandidateSet(projected), projected);

    assert.throws(() =>
      parseRiskCandidateSet({ schemaVersion: 1, projectSlug: 'dag-executor-main', entries: [rawFinderRecord] }),
    );
  });

  it('validates an existing registry before either surface consumes its digest', () => {
    const commandTokens = [
      'loom-risk-helper registry-validate',
      '--artifact-root <artifact-root>',
      '--registry <artifact-root>/projects/<slug>/risk-register/registry.json',
      '--project-slug <slug>',
    ];

    for (const path of [claudeSkill, codexSkill]) {
      const content = read(path);
      for (const token of commandTokens)
        assert.ok(content.includes(token), `${path} missing validation token ${token}`);

      const validation = content.indexOf('loom-risk-helper registry-validate');
      const consumption = content.indexOf('Only consume the digest after successful validation');
      assert.ok(validation >= 0 && consumption > validation, `${path} must validate before digest consumption`);
      assert.match(content, /registry is absent, use an empty digest without validation/i);
      assert.match(content, /malformed registry stops a normal scan before finder dispatch/i);
      assert.match(content, /With `--report-only`[\s\S]{0,180}exclude the invalid registry from the digest/i);
    }
  });

  it('routes current-diff integration findings through change review on both surfaces', () => {
    for (const path of [claudeLenses, codexLenses]) {
      const content = read(path);
      assert.doesNotMatch(content, /(?:issues|failures) caused solely by the current diff[^\n]*belong in code review/i);
      assert.match(content, /caused solely by the current diff[\s\S]{0,120}`disposition: change-related`/i);
    }

    for (const path of [claudeSkill, codexSkill, claudeLenses, codexLenses]) {
      const content = read(path);
      assert.match(content, /change-related/);
      assert.match(content, /promote-to-code-review/);
      assert.match(content, /Change Review Candidates/);
    }
  });

  it('names post-commit and release persistence failures on both surfaces', () => {
    for (const path of [claudeSkill, codexSkill]) {
      const content = read(path);
      assert.match(content, /durability-uncertain/);
      assert.match(content, /lock-release-failed/);
      assert.match(content, /idempotent retry/);
    }
  });

  it('documents central risk-register storage on both surfaces', () => {
    for (const path of artifactReferences) {
      const content = read(path);
      assert.match(content, /LOOM_ARTIFACTS_DIR/);
      assert.match(content, /risk-register\//);
    }
  });

  it('requires immutable collision handling and report-only registry isolation', () => {
    for (const path of [claudeSkill, codexSkill]) {
      const content = read(path);
      assert.match(content, /exclusive-create/i, `${path} must create reports exclusively`);
      assert.match(content, /persistence\.json/, `${path} must use a persistence sidecar`);
      assert.match(content, /never (?:truncate|overwrite)/i, `${path} must preserve existing reports`);
      assert.match(content, /--report-only[\s\S]{0,240}never (?:call|invoke)[^\n]*registry-merge/i);
    }
  });

  it('keeps temporary candidates isolated and always records Codex persistence in a sidecar', () => {
    const codex = read(codexSkill);
    assert.match(
      codex,
      /temporary JSON file outside both the target source tree and the durable `risk-register` directory/i,
    );
    assert.match(
      codex,
      /always write the merge success summary or exact structured failure[\s\S]{0,160}\.persistence\.json/i,
    );
    assert.match(codex, /Clean up the temporary candidate JSON after both success and failure/i);
    assert.doesNotMatch(codex, /summary for the report/i);
  });

  it('does not wire risk scanning into automatic workflows', () => {
    const automaticSkills = [
      'skills/auto-implement/SKILL.md',
      'skills/auto-run/SKILL.md',
      'skills/auto-step/SKILL.md',
      'skills/implement-dag/SKILL.md',
      'skills/implement-plan/SKILL.md',
      'skills/code-review/SKILL.md',
      'codex/plugins/loom/skills/auto-implement/SKILL.md',
      'codex/plugins/loom/skills/auto-run/SKILL.md',
      'codex/plugins/loom/skills/auto-step/SKILL.md',
      'codex/plugins/loom/skills/implement-dag/SKILL.md',
      'codex/plugins/loom/skills/implement-plan/SKILL.md',
      'codex/plugins/loom/skills/code-review/SKILL.md',
    ];

    const automaticScripts = [
      'scripts/auto-run-checkpoint.cjs',
      'scripts/auto-run-smoke.sh',
      'scripts/auto-run-supervisor.sh',
      'scripts/dag-smoke-run.sh',
      'scripts/loom-supervisor-smoke.sh',
      'scripts/loom-supervisor.cjs',
    ];
    const manifests = [
      '.claude-plugin/plugin.json',
      '.claude-plugin/marketplace.json',
      'codex/plugins/loom/.codex-plugin/plugin.json',
    ];
    const riskInvocation =
      /(?<![-/])\b(?:call|execute|start|run|invoke|dispatch|launch|trigger)\b[^\n]{0,100}(?:\$loom:risk-scan|\/?risk-scan\b|loom-risk-helper\b)/i;
    const explicitRiskCommand = /\$loom:risk-scan\b/i;

    for (const path of [...automaticSkills, ...automaticScripts]) {
      const content = read(path);
      assert.doesNotMatch(content, riskInvocation, `${path} invokes risk-scan`);
      assert.doesNotMatch(content, explicitRiskCommand, `${path} references the explicit risk command`);
      assert.doesNotMatch(content, /loom-risk-helper\b/i, `${path} references the risk helper`);
    }

    for (const path of manifests) {
      assert.doesNotMatch(read(path), riskInvocation, `${path} invokes risk-scan from plugin metadata`);
    }
  });
});
