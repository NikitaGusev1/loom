#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRiskScanContext } from './context.js';
import { loadRiskCandidateSet, loadRiskRegistry, mergeRiskRegistry, RiskRegistryPersistenceError } from './registry.js';

type ParsedArgs = Record<string, string>;

const usage = (): string => `Usage:
  loom-risk-helper context --repo <path> [--base <ref>] [--paths <comma-separated-files>]
  loom-risk-helper registry-merge --artifact-root <path> --registry <path> --entries <path> --report <path> --project-slug <slug>
  loom-risk-helper registry-validate --artifact-root <path> --registry <path> --project-slug <slug>`;

const parseOptions = (args: string[], allowed: Set<string>): ParsedArgs => {
  const options: ParsedArgs = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected positional argument: ${token}`);
    const equals = token.indexOf('=');
    const name = equals >= 0 ? token.slice(0, equals) : token;
    if (!allowed.has(name)) throw new Error(`Unknown option: ${name}`);
    if (name in options) throw new Error(`Duplicate option: ${name}`);
    const value = equals >= 0 ? token.slice(equals + 1) : args[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
    options[name] = value;
  }
  return options;
};

const requireOption = (options: ParsedArgs, name: string): string => {
  const value = options[name];
  if (!value) throw new Error(`Missing required option: ${name}`);
  return value;
};

const emit = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

export const riskHelperDiagnostic = (error: unknown): { error: string; message: string; diagnostics?: unknown[] } => ({
  error: error instanceof RiskRegistryPersistenceError ? error.code : 'invalid-input',
  message: error instanceof Error ? error.message : String(error),
  ...(error instanceof RiskRegistryPersistenceError && error.diagnostics.length > 0
    ? { diagnostics: error.diagnostics }
    : {}),
});

const resolveRegistryPath = async (
  artifactRoot: string,
  registryPath: string,
  projectSlug: string,
): Promise<string> => {
  if (!projectSlug || projectSlug === '.' || projectSlug === '..' || /[/\\]/u.test(projectSlug)) {
    throw new Error(`Invalid project slug: ${projectSlug}`);
  }
  const root = await realpath(resolve(artifactRoot));
  const expectedDirectory = join(root, 'projects', projectSlug, 'risk-register');
  const expectedRegistry = join(expectedDirectory, 'registry.json');
  const supplied = resolve(registryPath);
  if (basename(supplied) !== 'registry.json') throw new Error('Registry path must end in risk-register/registry.json');

  let suppliedDirectory: string;
  try {
    suppliedDirectory = await realpath(dirname(supplied));
  } catch {
    throw new Error(`Registry directory does not exist: ${dirname(supplied)}`);
  }
  if (suppliedDirectory !== expectedDirectory) {
    throw new Error(`Registry path must be ${expectedRegistry}`);
  }

  try {
    const existing = await realpath(supplied);
    if (existing !== expectedRegistry) throw new Error('Registry path must not be a symlink');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return expectedRegistry;
};

export const runRiskHelper = async (argv: string[]): Promise<void> => {
  const [command, ...rest] = argv;
  if (command === '--help' || command === '-h') {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (command === 'context') {
    const options = parseOptions(rest, new Set(['--repo', '--base', '--paths']));
    emit(
      await buildRiskScanContext({
        repo: requireOption(options, '--repo'),
        base: options['--base'],
        paths: options['--paths'],
      }),
    );
    return;
  }

  if (command === 'registry-merge') {
    const options = parseOptions(
      rest,
      new Set(['--artifact-root', '--registry', '--entries', '--report', '--project-slug']),
    );
    const candidates = await loadRiskCandidateSet(requireOption(options, '--entries'));
    const projectSlug = requireOption(options, '--project-slug');
    emit(
      await mergeRiskRegistry({
        registryPath: await resolveRegistryPath(
          requireOption(options, '--artifact-root'),
          requireOption(options, '--registry'),
          projectSlug,
        ),
        candidates,
        report: requireOption(options, '--report'),
        projectSlug,
      }),
    );
    return;
  }

  if (command === 'registry-validate') {
    const options = parseOptions(rest, new Set(['--artifact-root', '--registry', '--project-slug']));
    const requestedProject = requireOption(options, '--project-slug');
    const registryPath = await resolveRegistryPath(
      requireOption(options, '--artifact-root'),
      requireOption(options, '--registry'),
      requestedProject,
    );
    const registry = await loadRiskRegistry(registryPath);
    if (registry.projectSlug !== requestedProject) {
      throw new RiskRegistryPersistenceError(
        'project-mismatch',
        `Registry project ${registry.projectSlug} does not match requested project ${requestedProject}`,
      );
    }
    emit({
      valid: true,
      schemaVersion: registry.schemaVersion,
      projectSlug: registry.projectSlug,
      entries: registry.entries.length,
      registryPath,
    });
    return;
  }

  throw new Error(command ? `Unknown subcommand: ${command}\n${usage()}` : usage());
};

const isMain = process.argv[1]
  ? realpathSync.native(resolve(process.argv[1])) === fileURLToPath(import.meta.url)
  : false;
if (isMain) {
  try {
    await runRiskHelper(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${JSON.stringify(riskHelperDiagnostic(error))}\n`);
    process.exitCode = 2;
  }
}
