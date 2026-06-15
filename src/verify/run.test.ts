import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runVerification, formatFailures } from './run.js';
import type { VerifyCommand, ResolvedCommands } from './detect.js';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'dag-verify-run-'));

// A direct (non-pm) command: spawns `node -e <code>`. requiresNodeModules:false
// so it runs regardless of cwd.
const nodeCmd = (code: string): VerifyCommand => ({
  argv: ['node', '-e', code],
  baseExtra: [],
  fileFlag: [],
  scopeFiles: false,
  needsSeparator: false,
  requiresNodeModules: false,
});

describe('runVerification', () => {
  const dirs: string[] = [];
  const dir = (): string => {
    const d = tmp();
    dirs.push(d);
    return d;
  };
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  it('all pass → ok:true', async () => {
    const cwd = dir();
    const commands: ResolvedCommands = { typecheck: nodeCmd('process.exit(0)'), test: nodeCmd('process.exit(0)') };
    const out = await runVerification({ commands, changedFiles: [], cwd, weight: 'standard' });
    assert.equal(out.ok, true);
    assert.ok(out.results.every((r) => r.status === 'pass' || r.status === 'skipped'));
  });

  it('non-zero exit → fail, ok:false, output captured', async () => {
    const cwd = dir();
    const commands: ResolvedCommands = { test: nodeCmd('console.error("boom"); process.exit(1)') };
    const out = await runVerification({ commands, changedFiles: [], cwd, weight: 'standard' });
    assert.equal(out.ok, false);
    const test = out.results.find((r) => r.kind === 'test');
    assert.equal(test?.status, 'fail');
    assert.match(test!.output, /boom/);
  });

  it('missing binary → skipped, never fail', async () => {
    const cwd = dir();
    const commands: ResolvedCommands = {
      test: {
        argv: ['definitely-not-a-real-binary-xyz'],
        baseExtra: [],
        fileFlag: [],
        scopeFiles: false,
        needsSeparator: false,
        requiresNodeModules: false,
      },
    };
    const out = await runVerification({ commands, changedFiles: [], cwd, weight: 'trivial' });
    assert.equal(out.ok, true);
    assert.equal(out.results.find((r) => r.kind === 'test')?.status, 'skipped');
  });

  it('node_modules-requiring command in a cwd without node_modules → skipped (worktree case)', async () => {
    const cwd = dir(); // no node_modules
    const commands: ResolvedCommands = {
      test: {
        argv: ['npm', 'run', 'test'],
        baseExtra: [],
        fileFlag: [],
        scopeFiles: false,
        needsSeparator: true,
        requiresNodeModules: true,
      },
    };
    const out = await runVerification({ commands, changedFiles: [], cwd, weight: 'standard' });
    assert.equal(out.ok, true);
    const test = out.results.find((r) => r.kind === 'test');
    assert.equal(test?.status, 'skipped');
    assert.match(test!.output, /node_modules absent/);
  });

  it('node_modules-requiring command runs when node_modules present', async () => {
    const cwd = dir();
    mkdirSync(join(cwd, 'node_modules'), { recursive: true });
    // Use a direct node command but flag it as requiring node_modules — present here.
    const commands: ResolvedCommands = { test: { ...nodeCmd('process.exit(0)'), requiresNodeModules: true } };
    const out = await runVerification({ commands, changedFiles: [], cwd, weight: 'standard' });
    assert.equal(out.results.find((r) => r.kind === 'test')?.status, 'pass');
  });

  it('unresolved kind → skipped, does not break ok', async () => {
    const cwd = dir();
    const out = await runVerification({ commands: {}, changedFiles: [], cwd, weight: 'standard' });
    assert.equal(out.ok, true);
    assert.equal(out.results.length, 3);
    assert.ok(out.results.every((r) => r.status === 'skipped'));
  });

  it('formatFailures renders only failing checks', async () => {
    const cwd = dir();
    const commands: ResolvedCommands = {
      typecheck: nodeCmd('process.exit(0)'),
      test: nodeCmd('console.error("E1"); process.exit(2)'),
    };
    const out = await runVerification({ commands, changedFiles: [], cwd, weight: 'standard' });
    const text = formatFailures(out);
    assert.match(text, /test failed/);
    assert.match(text, /E1/);
    assert.doesNotMatch(text, /typecheck failed/);
  });

  // W2: scoping must drop non-code paths so they aren't passed to eslint/jest as targets.
  it('scoped command receives only code-extension changed files (drops README.md/package.json)', async () => {
    const cwd = dir();
    const printArgv: VerifyCommand = {
      argv: ['node', '-e', 'console.error(JSON.stringify(process.argv.slice(1))); process.exit(1)'],
      baseExtra: [],
      fileFlag: [],
      scopeFiles: true,
      needsSeparator: false,
      requiresNodeModules: false,
    };
    const out = await runVerification({
      commands: { lint: printArgv },
      changedFiles: ['src/a.ts', 'README.md', 'package.json', 'yarn.lock', 'logo.png'],
      cwd,
      weight: 'standard',
    });
    const lint = out.results.find((r) => r.kind === 'lint');
    assert.equal(lint?.status, 'fail');
    assert.match(lint!.output, /src\/a\.ts/);
    assert.doesNotMatch(lint!.output, /README\.md|package\.json|yarn\.lock|logo\.png/);
  });

  // W3: an AbortSignal cancellation is a skip, never a (permanent) fail.
  it('aborted spawn → skipped, not fail', async () => {
    const cwd = dir();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const out = await runVerification({
      commands: { test: nodeCmd('setTimeout(() => {}, 10_000)') },
      changedFiles: [],
      cwd,
      weight: 'standard',
      signal: ac.signal,
    });
    assert.equal(out.ok, true);
    assert.equal(out.results.find((r) => r.kind === 'test')?.status, 'skipped');
  });

  // W3: maxBuffer overflow is a fail with its own message, not mislabeled a timeout.
  it('output over maxBuffer → fail labelled buffer limit (not timeout)', async () => {
    const cwd = dir();
    const out = await runVerification({
      commands: { test: nodeCmd("process.stdout.write('x'.repeat(20 * 1024 * 1024))") },
      changedFiles: [],
      cwd,
      weight: 'standard',
    });
    const test = out.results.find((r) => r.kind === 'test');
    assert.equal(test?.status, 'fail');
    assert.match(test!.output, /buffer limit/);
    assert.doesNotMatch(test!.output, /timed out/);
  });

  // W1: our heap cap must NOT clobber the repo's existing NODE_OPTIONS.
  it('merges NODE_OPTIONS rather than clobbering it', async () => {
    const cwd = dir();
    const prev = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = '--no-warnings';
    try {
      const out = await runVerification({
        commands: { test: nodeCmd('console.error(process.env.NODE_OPTIONS); process.exit(1)') },
        changedFiles: [],
        cwd,
        weight: 'standard',
      });
      const test = out.results.find((r) => r.kind === 'test');
      assert.match(test!.output, /--no-warnings/);
      assert.match(test!.output, /--max-old-space-size=2048/);
    } finally {
      if (prev === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = prev;
    }
  });
});
