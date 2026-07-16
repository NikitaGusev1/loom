import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listProjects, registerProject } from './projects.js';

let artifactsDir: string;
let reposDir: string;

beforeEach(() => {
  artifactsDir = mkdtempSync(join(tmpdir(), 'loom-projects-artifacts-'));
  reposDir = mkdtempSync(join(tmpdir(), 'loom-projects-repos-'));
});

afterEach(() => {
  rmSync(artifactsDir, { recursive: true, force: true });
  rmSync(reposDir, { recursive: true, force: true });
});

describe('project registry', () => {
  it('registers a project atomically with standard directories', () => {
    const repo = join(reposDir, 'demo');
    mkdirSync(repo);
    const project = registerProject(artifactsDir, repo, {
      displayName: 'Demo',
      now: () => '2026-07-14T10:00:00.000Z',
    });

    assert.equal(project.slug, 'demo');
    assert.equal(project.displayName, 'Demo');
    assert.equal(project.source, 'manifest');
    const root = join(artifactsDir, 'projects', 'demo');
    assert.equal(existsSync(join(root, 'project.json')), true);
    for (const child of ['specs', 'plans', 'decompositions', 'reviews', 'runs', 'risk-register']) {
      assert.equal(existsSync(join(root, child)), true);
    }
  });

  it('preserves display name and registration time on refresh', () => {
    const repo = join(reposDir, 'demo');
    mkdirSync(repo);
    registerProject(artifactsDir, repo, { displayName: 'My Demo', now: () => 'first' });
    registerProject(artifactsDir, repo, { now: () => 'second' });

    const manifest = JSON.parse(readFileSync(join(artifactsDir, 'projects', 'demo', 'project.json'), 'utf-8'));
    assert.equal(manifest.displayName, 'My Demo');
    assert.equal(manifest.registeredAt, 'first');
    assert.equal(manifest.updatedAt, 'second');
  });

  it('loads legacy README projects and isolates malformed manifests', () => {
    const legacyRepo = join(reposDir, 'legacy');
    mkdirSync(legacyRepo);
    const legacyRoot = join(artifactsDir, 'projects', 'legacy');
    mkdirSync(legacyRoot, { recursive: true });
    writeFileSync(join(legacyRoot, 'README.md'), `# Legacy\n\nTarget repo: \`${legacyRepo}\`\n`);
    const badRoot = join(artifactsDir, 'projects', 'bad');
    mkdirSync(badRoot, { recursive: true });
    writeFileSync(join(badRoot, 'project.json'), '{bad');

    const result = listProjects(artifactsDir);

    assert.deepEqual(
      result.projects.map((project) => project.slug),
      ['legacy'],
    );
    assert.equal(result.projects[0].source, 'legacy-readme');
    assert.equal(result.errors.length, 1);
  });

  it('keeps missing repositories visible with an error', () => {
    const root = join(artifactsDir, 'projects', 'missing');
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, 'project.json'),
      JSON.stringify({
        schemaVersion: 1,
        slug: 'missing',
        displayName: 'Missing',
        repoPath: join(reposDir, 'gone'),
        registeredAt: 'first',
        updatedAt: 'first',
      }),
    );

    const project = listProjects(artifactsDir).projects[0];
    assert.equal(project.available, false);
    assert.equal(project.errors.length, 1);
  });

  it('rejects slug collisions that target another repository', () => {
    const first = join(reposDir, 'one', 'demo');
    const second = join(reposDir, 'two', 'demo');
    mkdirSync(first, { recursive: true });
    mkdirSync(second, { recursive: true });
    registerProject(artifactsDir, first);

    assert.throws(() => registerProject(artifactsDir, second), /already registered/);
  });

  it('validates manifest values before writing them', () => {
    const repo = join(reposDir, 'demo');
    mkdirSync(repo);

    assert.throws(() => registerProject(artifactsDir, repo, { displayName: '' }));
    assert.equal(existsSync(join(artifactsDir, 'projects', 'demo', 'project.json')), false);
  });
});
