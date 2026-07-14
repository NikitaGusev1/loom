import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'node:test';
import { riskHelperDiagnostic } from './cli.js';
import { RiskRegistryPersistenceError } from './registry.js';
import type { RiskCandidateSet, RiskRegistry } from './types.js';

const cliPath = fileURLToPath(new URL('./cli.js', import.meta.url));
const directories: string[] = [];
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' });

const makeRepo = (): string => {
  const repo = mkdtempSync(join(tmpdir(), 'risk-cli-repo-'));
  directories.push(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'risk@test');
  git(repo, 'config', 'user.name', 'Risk Test');
  writeFileSync(join(repo, 'file.txt'), 'base\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'base');
  return repo;
};

const run = (...args: string[]) => spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' });

const makeArtifactRoot = (projectSlug: string): { artifactRoot: string; registryPath: string } => {
  const artifactRoot = mkdtempSync(join(tmpdir(), 'risk-cli-artifacts-'));
  directories.push(artifactRoot);
  const registryDirectory = join(artifactRoot, 'projects', projectSlug, 'risk-register');
  mkdirSync(registryDirectory, { recursive: true });
  return { artifactRoot, registryPath: join(registryDirectory, 'registry.json') };
};

const emptyRegistry = (projectSlug: string): RiskRegistry => ({
  schemaVersion: 1,
  projectSlug,
  updatedAt: '2026-07-14T00:00:00.000Z',
  entries: [],
});

const candidateSet = (projectSlug: string): RiskCandidateSet => ({
  schemaVersion: 1,
  projectSlug,
  entries: [
    {
      lens: 'reliability',
      kind: 'risk',
      severity: 'medium',
      confidence: 'high',
      title: 'Retry can duplicate an operation',
      evidence: ['src/retry.ts:20'],
      affectedPaths: ['src/retry.ts'],
      seedRelationship: 'direct dependency of seed',
      failureScenario: 'A timeout occurs after the operation commits.',
      suggestedAction: 'Add an idempotency key.',
    },
  ],
});

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('loom-risk-helper CLI', () => {
  it('retains structured persistence and secondary release diagnostics', () => {
    const releaseDiagnostic = { code: 'lock-release-failed' as const, message: 'release failed' };
    const diagnostic = riskHelperDiagnostic(
      new RiskRegistryPersistenceError('durability-uncertain', 'directory sync failed', undefined, [releaseDiagnostic]),
    );
    assert.deepEqual(diagnostic, {
      error: 'durability-uncertain',
      message: 'directory sync failed',
      diagnostics: [releaseDiagnostic],
    });
  });

  it('prints top-level help successfully', () => {
    for (const flag of ['--help', '-h']) {
      const result = run(flag);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /registry-merge/u);
      assert.equal(result.stderr, '');
    }
  });

  it('emits one stable JSON context object, including a successful no-seeds result', () => {
    const repo = makeRepo();
    const result = run('context', '--repo', repo, '--base', 'main');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout.trim().split('\n').length, 1);
    const context = JSON.parse(result.stdout) as { noSeeds: boolean; seedPaths: string[] };
    assert.equal(context.noSeeds, true);
    assert.deepEqual(context.seedPaths, []);
  });

  it('reports invalid explicit paths on stderr with a nonzero exit', () => {
    const repo = makeRepo();
    const result = run('context', '--repo', repo, '--paths', '../outside.ts');
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /must not contain/u);
  });

  it('merges candidates and validates the resulting registry with machine-readable stdout', () => {
    const { artifactRoot, registryPath } = makeArtifactRoot('project');
    const entriesPath = join(artifactRoot, 'entries.json');
    writeFileSync(registryPath, JSON.stringify(emptyRegistry('project')));
    writeFileSync(entriesPath, JSON.stringify(candidateSet('project')));

    const merged = run(
      'registry-merge',
      '--artifact-root',
      artifactRoot,
      '--registry',
      registryPath,
      '--entries',
      entriesPath,
      '--report',
      join(artifactRoot, 'risk-scan.md'),
      '--project-slug',
      'project',
    );
    assert.equal(merged.status, 0, merged.stderr);
    assert.deepEqual(Object.keys(JSON.parse(merged.stdout) as object), [
      'registryPath',
      'projectSlug',
      'added',
      'refreshed',
      'total',
      'report',
    ]);
    const validated = run(
      'registry-validate',
      '--artifact-root',
      artifactRoot,
      '--registry',
      registryPath,
      '--project-slug',
      'project',
    );
    assert.equal(validated.status, 0, validated.stderr);
    assert.equal((JSON.parse(validated.stdout) as { entries: number }).entries, 1);
  });

  it('fails loudly for malformed registries, missing candidates, and project mismatches', () => {
    const { artifactRoot, registryPath } = makeArtifactRoot('project');
    const entriesPath = join(artifactRoot, 'entries.json');
    writeFileSync(registryPath, '{bad json');
    let result = run(
      'registry-validate',
      '--artifact-root',
      artifactRoot,
      '--registry',
      registryPath,
      '--project-slug',
      'project',
    );
    assert.equal(result.status, 2);
    assert.match(result.stderr, /invalid-registry/u);

    result = run(
      'registry-merge',
      '--artifact-root',
      artifactRoot,
      '--registry',
      registryPath,
      '--entries',
      join(artifactRoot, 'missing.json'),
      '--report',
      'scan.md',
      '--project-slug',
      'project',
    );
    assert.equal(result.status, 2);
    assert.match(result.stderr, /invalid-candidates/u);

    writeFileSync(registryPath, JSON.stringify(emptyRegistry('project')));
    writeFileSync(entriesPath, JSON.stringify(candidateSet('other')));
    result = run(
      'registry-merge',
      '--artifact-root',
      artifactRoot,
      '--registry',
      registryPath,
      '--entries',
      entriesPath,
      '--report',
      'scan.md',
      '--project-slug',
      'project',
    );
    assert.equal(result.status, 2);
    assert.match(result.stderr, /project-mismatch/u);
  });

  it('rejects registries outside the project layout and registry symlinks', () => {
    const { artifactRoot, registryPath } = makeArtifactRoot('project');
    const entriesPath = join(artifactRoot, 'entries.json');
    const outside = join(artifactRoot, 'registry.json');
    writeFileSync(entriesPath, JSON.stringify(candidateSet('project')));
    writeFileSync(outside, JSON.stringify(emptyRegistry('project')));

    let result = run(
      'registry-merge',
      '--artifact-root',
      artifactRoot,
      '--registry',
      outside,
      '--entries',
      entriesPath,
      '--report',
      'scan.md',
      '--project-slug',
      'project',
    );
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Registry path must be/u);

    symlinkSync(outside, registryPath);
    result = run(
      'registry-validate',
      '--artifact-root',
      artifactRoot,
      '--registry',
      registryPath,
      '--project-slug',
      'project',
    );
    assert.equal(result.status, 2);
    assert.match(result.stderr, /must not be a symlink/u);
  });

  it('invokes the package bin through PATH', () => {
    const repo = makeRepo();
    const directory = mkdtempSync(join(tmpdir(), 'risk-bin-'));
    directories.push(directory);
    const binDirectory = join(directory, 'bin');
    mkdirSync(binDirectory);
    const packageJson = JSON.parse(readFileSync(join(dirname(cliPath), '../../package.json'), 'utf8')) as {
      bin: Record<string, string>;
    };
    assert.equal(packageJson.bin['loom-risk-helper'], './build/risk-scan/cli.js');
    chmodSync(cliPath, 0o755);
    symlinkSync(cliPath, join(binDirectory, 'loom-risk-helper'));
    const result = spawnSync('loom-risk-helper', ['context', '--repo', repo, '--base', 'main'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${binDirectory}:${process.env.PATH ?? ''}` },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal((JSON.parse(result.stdout) as { noSeeds: boolean }).noSeeds, true);
  });
});
