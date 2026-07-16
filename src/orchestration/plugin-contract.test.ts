import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const assertOrdered = (body: string, markers: string[]) => {
  let cursor = 0;
  for (const marker of markers) {
    const next = body.indexOf(marker, cursor);
    assert.ok(next >= cursor, `expected ${JSON.stringify(marker)} after offset ${cursor}`);
    cursor = next + marker.length;
  }
};

const surfaces = {
  claude: {
    autoImplement: 'skills/auto-implement/SKILL.md',
    autoRun: 'skills/auto-run/SKILL.md',
    autoStep: 'skills/auto-step/SKILL.md',
    decompose: 'skills/decompose/SKILL.md',
    mechanical: 'references/auto-step-phases-mechanical.md',
  },
  codex: {
    autoImplement: 'codex/plugins/loom/skills/auto-implement/SKILL.md',
    autoRun: 'codex/plugins/loom/skills/auto-run/SKILL.md',
    autoStep: 'codex/plugins/loom/skills/auto-step/SKILL.md',
    decompose: 'codex/plugins/loom/skills/decompose/SKILL.md',
    mechanical: 'codex/plugins/loom/references/auto-step-phases-mechanical.md',
  },
};

describe('Loom decomposition-before-mode contract', () => {
  for (const [name, paths] of Object.entries(surfaces)) {
    it(`${name} ensures decomposition before automatic mode selection`, () => {
      const autoImplement = read(paths.autoImplement);
      assert.match(autoImplement, /Ensure decomposition before resolving mode or substrate/i);
      assert.match(autoImplement, /--no-dag.*sole bypass/i);
      assert.match(autoImplement, /--decomposition-stats/);
      assert.match(autoImplement, /--dag-readiness/);
      assert.match(autoImplement, /one-task analysis DAG is valid mode evidence but is not execution-ready/i);
      assertOrdered(autoImplement, [
        'Ensure decomposition before resolving mode or substrate',
        '--decomposition-stats',
        '/decompose --plan',
        'hard stop',
        '**Resolve mode**',
        '**Resolve substrate:**',
        '**Dispatch:**',
      ]);
      assert.match(autoImplement, /passing the plan path[\s\S]*--dag.*explicitly forced DAG/i);
      assert.doesNotMatch(autoImplement, /no decomposition_path --> sequential/i);
      assert.doesNotMatch(autoImplement, /no DAG possible/i);
    });

    it(`${name} runs direct auto-run preflight before checkpoint initialization`, () => {
      const autoRun = read(paths.autoRun);
      const preflight = autoRun.indexOf('Ensure Decomposition Before Checkpoint Init');
      const checkpointInit = autoRun.indexOf('Step 5 — Init Checkpoint');
      assert.ok(preflight >= 0, 'preflight heading is present');
      assert.ok(checkpointInit > preflight, 'preflight precedes checkpoint initialization');
      assert.match(autoRun, /Refuse measured sequential|measured mode is sequential/i);
      assert.match(autoRun, /--dag-readiness/);
      const preflightBody = autoRun.slice(preflight, checkpointInit);
      assert.match(preflightBody, /runId[\s\S]*planPath[\s\S]*canonical path/i);
      assert.match(preflightBody, /predictable slug must never select another plan's checkpoint/i);
      assert.match(preflightBody, /equal canonical checkpoint `dagPath`[\s\S]*decompositionDigest/i);
      assert.match(preflightBody, /both are absent on a legacy checkpoint[\s\S]*atomically backfill both digests/i);
      assert.match(preflightBody, /only one digest exists[\s\S]*corrupt partial migration/i);
      assert.match(preflightBody, /pre-selection phase `validate-plan` or `mode-selection`/);
      assert.match(preflightBody, /\/decompose --plan/);
      assert.match(preflightBody, /hard error|hard-stop/i);
      assert.match(preflightBody, /If `--dag` was supplied[\s\S]*select DAG regardless of automatic thresholds/i);
      assert.match(preflightBody, /When `dagPath` is present[\s\S]*--decomposition-stats[\s\S]*--dag-readiness/i);
      assert.match(read(paths.mechanical), /forceMode` is `'dag'`[\s\S]*skip the math and use DAG directly/i);
      const checkpointEnd = autoRun.indexOf('Step 6 — Background the Supervisor');
      const checkpointBody = autoRun.slice(checkpointInit, checkpointEnd);
      assert.match(checkpointBody, /"forceMode": "<dag\|null>"/);
      assert.match(checkpointBody, /"planDigest": "<sha256/);
      assert.match(checkpointBody, /"decompositionDigest": "<sha256/);
    });

    it(`${name} fails closed when ensured decomposition evidence is invalid`, () => {
      const phase = read(paths.mechanical);
      const autoStep = read(paths.autoStep);
      assert.match(phase, /status:\s*"error"/);
      assert.match(phase, /Never manufacture zero-valued statistics/i);
      assert.match(autoStep, /Missing or invalid decomposition is a hard error/i);
      assert.doesNotMatch(phase, /treat `task_count = 0`/i);
    });

    it(`${name} preserves one-task decompositions as analysis artifacts`, () => {
      const decompose = read(paths.decompose);
      assert.match(decompose, /one-task.*analysis artifact/is);
      assert.match(decompose, /too-few-tasks/);
      assert.match(decompose, /\.claude\/ai\/decomposition-/);
      assert.match(decompose, /--decomposition-stats/);
      if (name === 'codex') {
        assert.match(decompose, /executionLayers/);
        assert.match(decompose, /completionCriteria/);
        assert.doesNotMatch(decompose, /trivial\|light\|medium\|heavy/);
      }
    });
  }

  it('keeps the project-scoped planning handoff aligned with the orchestration invariant', () => {
    const sequential = read('src/ui/intake/sequential-runner.ts');
    const dagPlanner = read('src/ui/intake/dag-planner.ts');
    const service = read('src/ui/intake/service.ts');

    assert.match(sequential, /--no-dag --inline/);
    assert.match(dagPlanner, /loom:decompose/);
    assert.match(dagPlanner, /validated DAG/);
    assert.match(service, /projectId/);
    assert.match(service, /intakeStatus:\s*'awaiting-approval'/);
  });
});
