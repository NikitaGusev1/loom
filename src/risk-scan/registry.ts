import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import type {
  RiskCandidateEntry,
  RiskCandidateSet,
  RiskRegistry,
  RiskRegistryEntry,
  RiskRegistryMergeSummary,
  RiskRegistryPersistenceDiagnostic,
} from './types.js';

export const riskLensSchema = z.enum(['integration', 'reliability', 'trust-boundaries', 'maintainability']);
export const riskKindSchema = z.enum(['bug', 'risk', 'improvement']);
export const riskSeveritySchema = z.enum(['critical', 'high', 'medium', 'low']);
export const riskConfidenceSchema = z.enum(['high', 'medium', 'low']);
export const riskStatusSchema = z.enum(['open', 'accepted', 'fixed', 'dismissed', 'deferred']);
const nonWhitespaceStringSchema = z.string().refine((value) => value.trim().length > 0, {
  message: 'Must contain at least one non-whitespace character',
});
export const riskEvidenceSchema = z.array(nonWhitespaceStringSchema).min(1);
export const riskAffectedPathsSchema = z.array(nonWhitespaceStringSchema).min(1);

export const riskRegistryEntrySchema = z
  .object({
    id: z.string().min(1),
    fingerprint: z.string().min(1),
    lens: riskLensSchema,
    kind: riskKindSchema,
    severity: riskSeveritySchema,
    confidence: riskConfidenceSchema,
    status: riskStatusSchema,
    title: z.string().min(1),
    evidence: riskEvidenceSchema,
    affectedPaths: riskAffectedPathsSchema,
    seedRelationship: z.string().min(1),
    failureScenario: z.string().min(1),
    suggestedAction: z.string().min(1),
    rootCause: z.string().min(1).optional(),
    firstSeenAt: z.iso.datetime(),
    lastSeenAt: z.iso.datetime(),
    sourceReports: z.array(z.string().min(1)),
  })
  .strict();

export const riskRegistrySchema = z
  .object({
    schemaVersion: z.literal(1),
    projectSlug: z.string().min(1),
    updatedAt: z.iso.datetime(),
    entries: z.array(riskRegistryEntrySchema),
  })
  .strict();

export const riskCandidateEntrySchema = z
  .object({
    lens: riskLensSchema,
    kind: riskKindSchema,
    severity: riskSeveritySchema,
    confidence: riskConfidenceSchema,
    status: z.enum(['open', 'deferred']).optional(),
    title: z.string().min(1),
    evidence: riskEvidenceSchema,
    affectedPaths: riskAffectedPathsSchema,
    seedRelationship: z.string().min(1),
    failureScenario: z.string().min(1),
    suggestedAction: z.string().min(1),
    primaryAnchor: z.string().min(1).optional(),
    rootCause: z.string().min(1).optional(),
  })
  .strict();

export const riskCandidateSetSchema = z
  .object({
    schemaVersion: z.literal(1),
    projectSlug: z.string().min(1),
    entries: z.array(riskCandidateEntrySchema),
  })
  .strict();

const normalize = (value: string): string =>
  value.normalize('NFKC').trim().toLowerCase().replaceAll('\\', '/').replace(/\s+/gu, ' ');

const primaryLocation = (entry: RiskCandidateEntry | RiskRegistryEntry): { path: string; anchor: string } => {
  const evidence = entry.evidence[0] ?? '';
  const match = /^(.*?)(?::([^:]+))?$/u.exec(evidence);
  const path = entry.affectedPaths[0] ?? match?.[1] ?? '';
  const explicitAnchor = 'primaryAnchor' in entry ? entry.primaryAnchor : undefined;
  return { path: normalize(path), anchor: normalize(explicitAnchor ?? match?.[2] ?? '') };
};

const canonicalIdentity = (entry: RiskCandidateEntry | RiskRegistryEntry, summary: string): string => {
  const location = primaryLocation(entry);
  return JSON.stringify([
    normalize(entry.lens),
    normalize(entry.kind),
    location.path,
    location.anchor,
    normalize(summary),
  ]);
};

const identityAliases = (entry: RiskCandidateEntry | RiskRegistryEntry): string[] => {
  const explicitRoot = 'rootCause' in entry ? entry.rootCause : undefined;
  return [
    ...new Set(
      [explicitRoot, entry.title, entry.failureScenario]
        .filter((value): value is string => Boolean(value))
        .map((value) => canonicalIdentity(entry, value)),
    ),
  ];
};

export const fingerprintRisk = (entry: RiskCandidateEntry): string => {
  const canonical = canonicalIdentity(entry, entry.rootCause ?? entry.failureScenario ?? entry.title);
  return `rs1:${createHash('sha256').update(canonical).digest('hex')}`;
};

export const parseRiskRegistry = (value: unknown): RiskRegistry => riskRegistrySchema.parse(value);
export const parseRiskCandidateSet = (value: unknown): RiskCandidateSet => riskCandidateSetSchema.parse(value);

export class RiskRegistryPersistenceError extends Error {
  constructor(
    readonly code:
      | 'invalid-registry'
      | 'invalid-candidates'
      | 'project-mismatch'
      | 'lock-timeout'
      | 'stale-lock'
      | 'unsupported-shared-host'
      | 'write-failed'
      | 'durability-uncertain'
      | 'lock-release-failed',
    message: string,
    options?: ErrorOptions,
    readonly diagnostics: RiskRegistryPersistenceDiagnostic[] = [],
  ) {
    super(message, options);
    this.name = 'RiskRegistryPersistenceError';
  }
}

const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, 'utf8')) as unknown;

const emptyRegistry = (projectSlug: string, now: string): RiskRegistry => ({
  schemaVersion: 1,
  projectSlug,
  updatedAt: now,
  entries: [],
});

export const loadRiskRegistry = async (path: string): Promise<RiskRegistry> => {
  try {
    return parseRiskRegistry(await readJson(path));
  } catch (error) {
    throw new RiskRegistryPersistenceError('invalid-registry', `Invalid risk registry at ${path}`, { cause: error });
  }
};

export const loadRiskCandidateSet = async (path: string): Promise<RiskCandidateSet> => {
  try {
    return parseRiskCandidateSet(await readJson(path));
  } catch (error) {
    throw new RiskRegistryPersistenceError('invalid-candidates', `Invalid risk candidates at ${path}`, {
      cause: error,
    });
  }
};

const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

type LockTransition = 'release';

interface LockOptions {
  timeoutMs: number;
  staleMs: number;
  writeOwner?: (path: string, owner: LockOwner) => Promise<void>;
  beforeQuarantine?: (phase: LockTransition, path: string) => Promise<void>;
  beforePublish?: (path: string) => Promise<void>;
}

interface LockOwner {
  token: string;
  pid: number;
  hostname: string;
  createdAt: string;
}

interface LockObservation {
  dev: number;
  ino: number;
  mtimeMs: number;
  owner?: LockOwner;
}

const lockOwnerSchema = z
  .object({
    token: z.string().uuid(),
    pid: z.number().int().positive(),
    hostname: z.string().min(1),
    createdAt: z.iso.datetime(),
  })
  .strict();

const ownerPath = (path: string): string => join(path, 'owner.json');

const readLockOwner = async (path: string): Promise<LockOwner | undefined> => {
  try {
    return lockOwnerSchema.parse(JSON.parse(await readFile(ownerPath(path), 'utf8')) as unknown);
  } catch {
    return undefined;
  }
};

const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const sameInode = (left: LockObservation, right: LockObservation): boolean =>
  left.dev === right.dev && left.ino === right.ino;

const observeLock = async (path: string): Promise<LockObservation | undefined> => {
  try {
    const before = await stat(path);
    const owner = await readLockOwner(path);
    const after = await stat(path);
    if (before.dev !== after.dev || before.ino !== after.ino) return undefined;
    return { dev: after.dev, ino: after.ino, mtimeMs: after.mtimeMs, owner };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
};

const observeLockStrict = async (path: string): Promise<LockObservation | undefined> => {
  let before;
  try {
    before = await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }

  let owner: LockOwner;
  try {
    owner = lockOwnerSchema.parse(JSON.parse(await readFile(ownerPath(path), 'utf8')) as unknown);
  } catch (error) {
    try {
      await stat(path);
    } catch (statError) {
      if ((statError as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw statError;
    }
    throw error;
  }

  try {
    const after = await stat(path);
    if (before.dev !== after.dev || before.ino !== after.ino) return undefined;
    return { dev: after.dev, ino: after.ino, mtimeMs: after.mtimeMs, owner };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
};

const writeLockOwner = async (path: string, owner: LockOwner): Promise<void> => {
  const handle = await open(ownerPath(path), 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(owner));
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const syncDirectory = async (path: string): Promise<void> => {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const moveToQuarantine = async (path: string, quarantinePath: string): Promise<boolean> => {
  try {
    await rename(path, quarantinePath);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EEXIST' || code === 'ENOTEMPTY') return false;
    throw error;
  }
};

const removeExactDirectory = async (path: string, observed: LockObservation): Promise<void> => {
  const current = await observeLock(path);
  if (!current || !sameInode(current, observed)) return;
  const quarantinePath = `${path}.cleanup-${randomUUID()}`;
  if (!(await moveToQuarantine(path, quarantinePath))) return;
  const moved = await observeLock(quarantinePath);
  if (!moved || !sameInode(moved, observed)) return;
  await rm(quarantinePath, { recursive: true, force: true });
};

const releaseOwnedLock = async (
  path: string,
  token: string,
  beforeQuarantine?: LockOptions['beforeQuarantine'],
): Promise<void> => {
  const observed = await observeLockStrict(path);
  if (observed?.owner?.token !== token) return;
  await beforeQuarantine?.('release', path);
  const current = await observeLockStrict(path);
  if (!current || !sameInode(current, observed) || current.owner?.token !== token) return;
  const quarantinePath = `${path}.release-${token}-${randomUUID()}`;
  try {
    await rename(path, quarantinePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const moved = await observeLockStrict(quarantinePath);
  if (!moved || !sameInode(moved, observed) || moved.owner?.token !== token) {
    throw new Error(`Could not verify quarantined registry lock ownership at ${quarantinePath}`);
  }
  await rm(quarantinePath, { recursive: true, force: true });
};

const acquireLock = async (path: string, options: LockOptions): Promise<() => Promise<void>> => {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= options.timeoutMs) {
    const owner: LockOwner = {
      token: randomUUID(),
      pid: process.pid,
      hostname: hostname(),
      createdAt: new Date().toISOString(),
    };
    const stagingPath = `${path}.pending-${owner.token}`;
    await mkdir(stagingPath, { mode: 0o700 });
    const staged = await observeLock(stagingPath);
    try {
      await (options.writeOwner ?? writeLockOwner)(stagingPath, owner);
      await syncDirectory(stagingPath);
      await options.beforePublish?.(stagingPath);
    } catch (error) {
      if (staged) await removeExactDirectory(stagingPath, staged);
      throw error;
    }
    try {
      await rename(stagingPath, path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error;
      if (staged) await removeExactDirectory(stagingPath, staged);
      const observed = await observeLock(path);
      if (!observed) continue;
      if (Date.now() - observed.mtimeMs > options.staleMs) {
        if (observed.owner?.hostname && observed.owner.hostname !== hostname()) {
          throw new RiskRegistryPersistenceError(
            'unsupported-shared-host',
            `Cannot determine whether registry lock owner ${observed.owner.hostname}:${observed.owner.pid} is alive`,
          );
        }
        if (!observed.owner || !isPidAlive(observed.owner.pid)) {
          throw new RiskRegistryPersistenceError('stale-lock', `Registry lock requires manual removal: ${path}`);
        }
      }
      await delay(20);
      continue;
    }
    return async () => releaseOwnedLock(path, owner.token, options.beforeQuarantine);
  }
  throw new RiskRegistryPersistenceError('lock-timeout', `Timed out waiting for registry lock: ${path}`);
};

const nextId = (entries: RiskRegistryEntry[]): string => {
  const max = entries.reduce((current, entry) => {
    const match = /^RS-(\d+)$/u.exec(entry.id);
    return Math.max(current, match ? Number(match[1]) : 0);
  }, 0);
  return `RS-${String(max + 1).padStart(3, '0')}`;
};

const unique = (values: string[]): string[] => [...new Set(values)];
const terminalStatuses = new Set(['accepted', 'fixed', 'dismissed']);

const mergeIntoRegistry = (
  registry: RiskRegistry,
  candidates: RiskCandidateEntry[],
  report: string,
  now: string,
): { registry: RiskRegistry; added: number; refreshed: number } => {
  let added = 0;
  let refreshed = 0;
  const entries = registry.entries.map((entry) => ({
    ...entry,
    evidence: [...entry.evidence],
    sourceReports: [...entry.sourceReports],
  }));

  for (const candidate of candidates) {
    const generatedFingerprint = fingerprintRisk(candidate);
    const exactIndex = entries.findIndex((entry) => entry.fingerprint === generatedFingerprint);
    const aliases = new Set(identityAliases(candidate));
    const legacyMatches = entries
      .map((entry, index) => ({ entry, index }))
      .filter(
        ({ entry }) =>
          !entry.fingerprint.startsWith('rs1:') && identityAliases(entry).some((alias) => aliases.has(alias)),
      );
    const index = exactIndex >= 0 ? exactIndex : legacyMatches.length === 1 ? legacyMatches[0].index : -1;
    if (index >= 0) {
      const existing = entries[index];
      entries[index] = {
        ...existing,
        severity: candidate.severity,
        confidence: candidate.confidence,
        title: candidate.title,
        evidence: unique([...existing.evidence, ...candidate.evidence]),
        affectedPaths: unique([...existing.affectedPaths, ...candidate.affectedPaths]),
        seedRelationship: candidate.seedRelationship,
        failureScenario: candidate.failureScenario,
        suggestedAction: candidate.suggestedAction,
        rootCause: candidate.rootCause ?? existing.rootCause,
        status: terminalStatuses.has(existing.status) ? existing.status : (candidate.status ?? existing.status),
        lastSeenAt: now,
        sourceReports: unique([...existing.sourceReports, report]),
      };
      refreshed += 1;
      continue;
    }

    entries.push({
      id: nextId(entries),
      fingerprint: generatedFingerprint,
      lens: candidate.lens,
      kind: candidate.kind,
      severity: candidate.severity,
      confidence: candidate.confidence,
      status: candidate.status ?? 'open',
      title: candidate.title,
      evidence: unique(candidate.evidence),
      affectedPaths: unique(candidate.affectedPaths),
      seedRelationship: candidate.seedRelationship,
      failureScenario: candidate.failureScenario,
      suggestedAction: candidate.suggestedAction,
      ...(candidate.rootCause ? { rootCause: candidate.rootCause } : {}),
      firstSeenAt: now,
      lastSeenAt: now,
      sourceReports: [report],
    });
    added += 1;
  }

  return { registry: { ...registry, updatedAt: now, entries }, added, refreshed };
};

export interface MergeRiskRegistryOptions {
  registryPath: string;
  candidates: RiskCandidateSet;
  report: string;
  projectSlug: string;
  now?: Date;
  lockTimeoutMs?: number;
  staleLockMs?: number;
  beforeRename?: (temporaryPath: string) => Promise<void>;
  syncRegistryDirectory?: (path: string) => Promise<void>;
  writeLockOwner?: (
    path: string,
    owner: { token: string; pid: number; hostname: string; createdAt: string },
  ) => Promise<void>;
  beforeLockQuarantine?: (phase: LockTransition, path: string) => Promise<void>;
  beforeLockPublish?: (path: string) => Promise<void>;
}

export const mergeRiskRegistry = async (options: MergeRiskRegistryOptions): Promise<RiskRegistryMergeSummary> => {
  const { registryPath, report, projectSlug } = options;
  let candidates: RiskCandidateSet;
  try {
    candidates = riskCandidateSetSchema.parse(options.candidates);
  } catch (error) {
    throw new RiskRegistryPersistenceError('invalid-candidates', 'Invalid risk candidate set', { cause: error });
  }
  if (candidates.projectSlug !== projectSlug) {
    throw new RiskRegistryPersistenceError(
      'project-mismatch',
      `Candidate project ${candidates.projectSlug} does not match requested project ${projectSlug}`,
    );
  }

  const lockPath = `${registryPath}.lock`;
  let release: (() => Promise<void>) | undefined;
  let temporaryPath: string | undefined;
  let summary: RiskRegistryMergeSummary | undefined;
  let operationError: RiskRegistryPersistenceError | undefined;
  try {
    release = await acquireLock(lockPath, {
      timeoutMs: options.lockTimeoutMs ?? 5_000,
      staleMs: options.staleLockMs ?? 60_000,
      writeOwner: options.writeLockOwner,
      beforeQuarantine: options.beforeLockQuarantine,
      beforePublish: options.beforeLockPublish,
    });
    let registry: RiskRegistry;
    try {
      registry = await loadRiskRegistry(registryPath);
    } catch (error) {
      const cause = error instanceof RiskRegistryPersistenceError ? error.cause : undefined;
      if ((cause as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') throw error;
      registry = emptyRegistry(projectSlug, (options.now ?? new Date()).toISOString());
    }
    if (registry.projectSlug !== projectSlug) {
      throw new RiskRegistryPersistenceError(
        'project-mismatch',
        `Registry project ${registry.projectSlug} does not match requested project ${projectSlug}`,
      );
    }

    const now = (options.now ?? new Date()).toISOString();
    const result = mergeIntoRegistry(registry, candidates.entries, basename(report), now);
    const validated = riskRegistrySchema.parse(result.registry);
    const directory = dirname(registryPath);
    temporaryPath = join(directory, `.${basename(registryPath)}.${process.pid}.${randomUUID()}.tmp`);
    const handle = await open(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    parseRiskRegistry(await readJson(temporaryPath));
    await options.beforeRename?.(temporaryPath);
    await rename(temporaryPath, registryPath);
    temporaryPath = undefined;
    try {
      await (options.syncRegistryDirectory ?? syncDirectory)(directory);
    } catch (error) {
      throw new RiskRegistryPersistenceError(
        'durability-uncertain',
        `Updated risk registry at ${registryPath}, but could not confirm directory durability`,
        { cause: error },
      );
    }
    summary = {
      registryPath,
      projectSlug,
      added: result.added,
      refreshed: result.refreshed,
      total: validated.entries.length,
      report: basename(report),
    };
  } catch (error) {
    operationError =
      error instanceof RiskRegistryPersistenceError
        ? error
        : new RiskRegistryPersistenceError('write-failed', `Failed to update risk registry at ${registryPath}`, {
            cause: error,
          });
  }

  try {
    if (temporaryPath) await rm(temporaryPath, { force: true }).catch(() => undefined);
    if (release) await release();
  } catch (error) {
    const diagnostic: RiskRegistryPersistenceDiagnostic = {
      code: 'lock-release-failed',
      message: `Failed to release risk registry lock at ${lockPath}: ${error instanceof Error ? error.message : String(error)}`,
    };
    if (operationError) operationError.diagnostics.push(diagnostic);
    else {
      operationError = new RiskRegistryPersistenceError(diagnostic.code, diagnostic.message, { cause: error }, [
        diagnostic,
      ]);
    }
  }

  if (operationError) throw operationError;
  if (!summary)
    throw new RiskRegistryPersistenceError('write-failed', `Failed to update risk registry at ${registryPath}`);
  return summary;
};
