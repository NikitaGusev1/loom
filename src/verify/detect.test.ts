import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveVerifyCommands } from './detect.js';

// Build a throwaway repo fixture and return its path.
const fixture = (files: Record<string, string>): string => {
  const dir = mkdtempSync(join(tmpdir(), 'dag-verify-detect-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
};

const pkg = (scripts: Record<string, string>, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ name: 'fix', ...extra, scripts });

describe('resolveVerifyCommands — package manager detection', () => {
  const dirs: string[] = [];
  const make = (files: Record<string, string>): string => {
    const d = fixture(files);
    dirs.push(d);
    return d;
  };
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  it('npm (package-lock) → npm run, with separator', () => {
    const d = make({ 'package.json': pkg({ test: 'jest' }), 'package-lock.json': '{}' });
    const cmds = resolveVerifyCommands(d);
    assert.deepEqual(cmds.test?.argv, ['npm', 'run', 'test']);
    assert.equal(cmds.test?.needsSeparator, true);
  });

  it('yarn (yarn.lock) → yarn, no separator', () => {
    const d = make({ 'package.json': pkg({ test: 'jest' }), 'yarn.lock': '' });
    const cmds = resolveVerifyCommands(d);
    assert.deepEqual(cmds.test?.argv, ['yarn', 'test']);
    assert.equal(cmds.test?.needsSeparator, false);
  });

  it('pnpm (pnpm-lock.yaml) → pnpm run', () => {
    const d = make({ 'package.json': pkg({ test: 'jest' }), 'pnpm-lock.yaml': '' });
    assert.deepEqual(resolveVerifyCommands(d).test?.argv, ['pnpm', 'run', 'test']);
  });

  it('bun (bun.lockb) → bun run', () => {
    const d = make({ 'package.json': pkg({ test: 'jest' }), 'bun.lockb': '' });
    assert.deepEqual(resolveVerifyCommands(d).test?.argv, ['bun', 'run', 'test']);
  });

  it('packageManager field wins over lockfile', () => {
    const d = make({ 'package.json': pkg({ test: 'jest' }, { packageManager: 'pnpm@9.0.0' }), 'yarn.lock': '' });
    assert.deepEqual(resolveVerifyCommands(d).test?.argv, ['pnpm', 'run', 'test']);
  });

  it('no lockfile → npm (never yarn)', () => {
    const d = make({ 'package.json': pkg({ test: 'jest' }) });
    assert.deepEqual(resolveVerifyCommands(d).test?.argv, ['npm', 'run', 'test']);
  });
});

describe('resolveVerifyCommands — script presence + scoping', () => {
  const dirs: string[] = [];
  const make = (files: Record<string, string>): string => {
    const d = fixture(files);
    dirs.push(d);
    return d;
  };
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  it('jest test → related-tests scoping + ci flags', () => {
    const d = make({ 'package.json': pkg({ test: 'jest --config x' }), 'package-lock.json': '{}' });
    const t = resolveVerifyCommands(d).test;
    assert.equal(t?.scopeFiles, true);
    assert.deepEqual(t?.fileFlag, ['--findRelatedTests']);
    assert.deepEqual(t?.baseExtra, ['--ci', '--passWithNoTests']);
  });

  it('non-jest test (node --test) → whole, no scoping', () => {
    const d = make({ 'package.json': pkg({ test: 'tsc && node --test' }), 'package-lock.json': '{}' });
    const t = resolveVerifyCommands(d).test;
    assert.equal(t?.scopeFiles, false);
    assert.deepEqual(t?.baseExtra, []);
  });

  it('eslint lint → file scoping', () => {
    const d = make({ 'package.json': pkg({ lint: 'eslint .' }), 'package-lock.json': '{}' });
    assert.equal(resolveVerifyCommands(d).lint?.scopeFiles, true);
  });

  it('absent script → undefined (skipped, never faked)', () => {
    const d = make({ 'package.json': pkg({ test: 'jest' }), 'package-lock.json': '{}' });
    const cmds = resolveVerifyCommands(d);
    assert.equal(cmds.lint, undefined);
  });

  it('typecheck via lintTypes alias', () => {
    const d = make({ 'package.json': pkg({ lintTypes: 'tsc --noEmit' }), 'package-lock.json': '{}' });
    const tc = resolveVerifyCommands(d).typecheck;
    assert.deepEqual(tc?.argv, ['npm', 'run', 'lintTypes']);
    assert.equal(tc?.scopeFiles, false);
  });

  it('typecheck tsc fallback when tsconfig + local tsc bin exist, no script', () => {
    const d = make({
      'package.json': pkg({}),
      'package-lock.json': '{}',
      'tsconfig.json': '{}',
      'node_modules/.bin/tsc': '#!/bin/sh\n',
    });
    const tc = resolveVerifyCommands(d).typecheck;
    assert.ok(tc, 'expected tsc fallback');
    assert.ok(tc!.argv[0].endsWith('node_modules/.bin/tsc'));
    assert.deepEqual(tc!.argv[1], '--noEmit');
  });

  it('no tsc fallback when bin missing', () => {
    const d = make({ 'package.json': pkg({}), 'package-lock.json': '{}', 'tsconfig.json': '{}' });
    assert.equal(resolveVerifyCommands(d).typecheck, undefined);
  });
});

describe('resolveVerifyCommands — overrides + disable', () => {
  const dirs: string[] = [];
  const make = (files: Record<string, string>): string => {
    const d = fixture(files);
    dirs.push(d);
    return d;
  };
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  it('override wins over detected script and runs raw (no separator, no node_modules requirement)', () => {
    const d = make({ 'package.json': pkg({ test: 'jest' }), 'yarn.lock': '' });
    const cmds = resolveVerifyCommands(d, { test: 'npm test' });
    assert.deepEqual(cmds.test?.argv, ['npm', 'test']);
    assert.equal(cmds.test?.needsSeparator, false);
    assert.equal(cmds.test?.requiresNodeModules, false);
    assert.equal(cmds.test?.scopeFiles, false);
  });

  it('disable → empty (all skipped)', () => {
    const d = make({
      'package.json': pkg({ test: 'jest', lint: 'eslint', typecheck: 'tsc' }),
      'package-lock.json': '{}',
    });
    assert.deepEqual(resolveVerifyCommands(d, {}, true), {});
  });

  it('missing package.json → all undefined, no throw', () => {
    const d = make({ 'README.md': 'hi' });
    assert.deepEqual(resolveVerifyCommands(d), {});
  });
});
