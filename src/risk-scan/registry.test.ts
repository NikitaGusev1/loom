import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  fingerprintRisk,
  mergeRiskRegistry,
  parseRiskCandidateSet,
  parseRiskRegistry,
  RiskRegistryPersistenceError,
} from './registry.js';
import type { RiskCandidateEntry, RiskCandidateSet, RiskRegistry } from './types.js';

const directories: string[] = [];
const projectSlug = 'example-project';
const now = '2026-07-14T12:00:00.000Z';

const candidate = (overrides: Partial<RiskCandidateEntry> = {}): RiskCandidateEntry => ({
  lens: 'integration',
  kind: 'bug',
  severity: 'high',
  confidence: 'high',
  title: 'Consumer ignores required state',
  evidence: ['src/consumer.ts:42'],
  affectedPaths: ['src/consumer.ts'],
  seedRelationship: 'direct caller of the seed API',
  failureScenario: 'The consumer proceeds without required state.',
  suggestedAction: 'Validate the state before proceeding.',
  ...overrides,
});

const candidates = (...entries: RiskCandidateEntry[]): RiskCandidateSet => ({
  schemaVersion: 1,
  projectSlug,
  entries,
});

const emptyRegistry = (): RiskRegistry => ({
  schemaVersion: 1,
  projectSlug,
  updatedAt: '2026-07-11T00:00:00.000Z',
  entries: [],
});

const fixture = (): { directory: string; registryPath: string } => {
  const directory = mkdtempSync(join(tmpdir(), 'risk-registry-'));
  directories.push(directory);
  const registryPath = join(directory, 'registry.json');
  writeFileSync(registryPath, `${JSON.stringify(emptyRegistry(), null, 2)}\n`);
  return { directory, registryPath };
};

const writeLock = (
  lockPath: string,
  owner: { token: string; pid: number; hostname: string; createdAt: string },
): void => {
  mkdirSync(lockPath);
  writeFileSync(join(lockPath, 'owner.json'), JSON.stringify(owner));
};

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('risk registry', () => {
  it('rejects unknown and malformed persisted fields', () => {
    assert.throws(() => parseRiskRegistry({ ...emptyRegistry(), unexpected: true }));
    assert.throws(() => parseRiskRegistry({ ...emptyRegistry(), schemaVersion: 2 }));
    assert.throws(() =>
      parseRiskCandidateSet({
        ...candidates(candidate()),
        entries: [{ ...candidate(), fingerprint: 'integration:bug:forged' }],
      }),
    );
    assert.throws(() => parseRiskCandidateSet(candidates(candidate({ evidence: [] }))));
    assert.throws(() => parseRiskCandidateSet(candidates(candidate({ affectedPaths: [] }))));
    assert.throws(() => parseRiskCandidateSet(candidates(candidate({ evidence: ['  \t'] }))));
    assert.throws(() => parseRiskCandidateSet(candidates(candidate({ affectedPaths: ['\n'] }))));
    assert.throws(() =>
      parseRiskRegistry({
        ...emptyRegistry(),
        entries: [
          {
            id: 'RS-001',
            fingerprint: fingerprintRisk(candidate()),
            ...candidate({ evidence: [' '] }),
            status: 'open',
            firstSeenAt: now,
            lastSeenAt: now,
            sourceReports: [],
          },
        ],
      }),
    );
    assert.deepEqual(
      parseRiskCandidateSet(candidates(candidate({ evidence: ['  src/consumer.ts:42  '] }))).entries[0].evidence,
      ['  src/consumer.ts:42  '],
    );
  });

  it('generates stable fingerprints from canonical fields', () => {
    const first = fingerprintRisk(candidate());
    const second = fingerprintRisk(candidate({ title: 'A display-only title change' }));
    assert.equal(first, second);
    assert.match(first, /^rs1:[a-f0-9]{64}$/u);
  });

  it('creates stable IDs and deduplicates repeated scans while merging evidence and reports', async () => {
    const { registryPath } = fixture();
    await mergeRiskRegistry({
      registryPath,
      candidates: candidates(candidate()),
      report: 'first.md',
      projectSlug,
      now: new Date(now),
    });
    await mergeRiskRegistry({
      registryPath,
      candidates: candidates(candidate({ evidence: ['src/consumer.ts:42', 'src/caller.ts:9'] })),
      report: 'second.md',
      projectSlug,
      now: new Date('2026-07-15T12:00:00.000Z'),
    });
    const registry = parseRiskRegistry(JSON.parse(readFileSync(registryPath, 'utf8')) as unknown);
    assert.equal(registry.entries.length, 1);
    assert.equal(registry.entries[0].id, 'RS-001');
    assert.deepEqual(registry.entries[0].sourceReports, ['first.md', 'second.md']);
    assert.deepEqual(registry.entries[0].evidence, ['src/consumer.ts:42', 'src/caller.ts:9']);
  });

  it('matches generated fingerprints before aliases and keeps distinct root causes separate', async () => {
    const { registryPath } = fixture();
    const shared = {
      title: 'Shared display title',
      failureScenario: 'Shared failure wording.',
    };
    await mergeRiskRegistry({
      registryPath,
      candidates: candidates(
        candidate({ ...shared, rootCause: 'Caller omits the state token.' }),
        candidate({ ...shared, rootCause: 'State token expires before use.' }),
      ),
      report: 'first.md',
      projectSlug,
      now: new Date(now),
    });
    await mergeRiskRegistry({
      registryPath,
      candidates: candidates(
        candidate({
          title: 'Renamed finding',
          failureScenario: 'Reworded scenario.',
          rootCause: 'Caller omits the state token.',
        }),
      ),
      report: 'second.md',
      projectSlug,
    });

    const registry = parseRiskRegistry(JSON.parse(readFileSync(registryPath, 'utf8')) as unknown);
    assert.equal(registry.entries.length, 2);
    assert.equal(
      registry.entries.find((entry) => entry.rootCause === 'Caller omits the state token.')?.title,
      'Renamed finding',
    );
    assert.deepEqual(registry.entries.map((entry) => entry.rootCause).sort(), [
      'Caller omits the state token.',
      'State token expires before use.',
    ]);
  });

  it('does not mutate registry bytes for empty evidence or affected paths', async () => {
    const { registryPath } = fixture();
    const before = readFileSync(registryPath, 'utf8');
    for (const invalid of [
      candidate({ evidence: [] }),
      candidate({ affectedPaths: [] }),
      candidate({ evidence: ['   '] }),
      candidate({ affectedPaths: ['\t'] }),
    ]) {
      await assert.rejects(
        mergeRiskRegistry({ registryPath, candidates: candidates(invalid), report: 'scan.md', projectSlug }),
        (error: unknown) => error instanceof RiskRegistryPersistenceError && error.code === 'invalid-candidates',
      );
      assert.equal(readFileSync(registryPath, 'utf8'), before);
    }
  });

  it('preserves surrounding whitespace in accepted evidence and affected paths', async () => {
    const { registryPath } = fixture();
    await mergeRiskRegistry({
      registryPath,
      candidates: candidates(
        candidate({
          evidence: ['  src/consumer.ts:42  '],
          affectedPaths: ['  src/consumer.ts  '],
        }),
      ),
      report: 'scan.md',
      projectSlug,
    });
    const registry = parseRiskRegistry(JSON.parse(readFileSync(registryPath, 'utf8')) as unknown);
    assert.deepEqual(registry.entries[0].evidence, ['  src/consumer.ts:42  ']);
    assert.deepEqual(registry.entries[0].affectedPaths, ['  src/consumer.ts  ']);
  });

  it('preserves terminal human status when refreshing a finding', async () => {
    const { registryPath } = fixture();
    const initial = emptyRegistry();
    initial.entries.push({
      id: 'RS-007',
      fingerprint: fingerprintRisk(candidate()),
      ...candidate(),
      status: 'accepted',
      firstSeenAt: now,
      lastSeenAt: now,
      sourceReports: ['old.md'],
    });
    writeFileSync(registryPath, JSON.stringify(initial));
    await mergeRiskRegistry({
      registryPath,
      candidates: candidates(candidate({ status: 'open' })),
      report: 'new.md',
      projectSlug,
    });
    const registry = parseRiskRegistry(JSON.parse(readFileSync(registryPath, 'utf8')) as unknown);
    assert.equal(registry.entries[0].status, 'accepted');
    assert.equal(registry.entries[0].fingerprint, initial.entries[0].fingerprint);
  });

  it('preserves every terminal human status when refreshing exact matches', async () => {
    for (const status of ['accepted', 'fixed', 'dismissed'] as const) {
      const { registryPath } = fixture();
      const initial = emptyRegistry();
      initial.entries.push({
        id: 'RS-001',
        fingerprint: fingerprintRisk(candidate()),
        ...candidate(),
        status,
        firstSeenAt: now,
        lastSeenAt: now,
        sourceReports: ['old.md'],
      });
      writeFileSync(registryPath, JSON.stringify(initial));
      await mergeRiskRegistry({
        registryPath,
        candidates: candidates(candidate({ status: 'open' })),
        report: 'new.md',
        projectSlug,
      });
      assert.equal(
        parseRiskRegistry(JSON.parse(readFileSync(registryPath, 'utf8')) as unknown).entries[0].status,
        status,
      );
    }
  });

  it('preserves every terminal human status when refreshing legacy matches', async () => {
    for (const status of ['accepted', 'fixed', 'dismissed'] as const) {
      const { registryPath } = fixture();
      const initial = emptyRegistry();
      initial.entries.push({
        id: 'RS-001',
        fingerprint: `legacy:${status}`,
        ...candidate(),
        status,
        firstSeenAt: now,
        lastSeenAt: now,
        sourceReports: ['old.md'],
      });
      writeFileSync(registryPath, JSON.stringify(initial));
      await mergeRiskRegistry({
        registryPath,
        candidates: candidates(candidate({ status: 'open' })),
        report: 'new.md',
        projectSlug,
      });
      const registry = parseRiskRegistry(JSON.parse(readFileSync(registryPath, 'utf8')) as unknown);
      assert.equal(registry.entries[0].status, status);
      assert.equal(registry.entries[0].fingerprint, `legacy:${status}`);
    }
  });

  it('prefers an exact fingerprint match over a matching legacy alias', async () => {
    const { registryPath } = fixture();
    const initial = emptyRegistry();
    initial.entries.push(
      {
        id: 'RS-001',
        fingerprint: fingerprintRisk(candidate()),
        ...candidate(),
        status: 'open',
        firstSeenAt: now,
        lastSeenAt: now,
        sourceReports: ['exact.md'],
      },
      {
        id: 'RS-002',
        fingerprint: 'legacy:matching-alias',
        ...candidate(),
        status: 'accepted',
        firstSeenAt: now,
        lastSeenAt: now,
        sourceReports: ['legacy.md'],
      },
    );
    writeFileSync(registryPath, JSON.stringify(initial));

    await mergeRiskRegistry({
      registryPath,
      candidates: candidates(candidate({ title: 'Updated exact finding' })),
      report: 'new.md',
      projectSlug,
    });

    const registry = parseRiskRegistry(JSON.parse(readFileSync(registryPath, 'utf8')) as unknown);
    assert.equal(registry.entries[0].title, 'Updated exact finding');
    assert.deepEqual(registry.entries[0].sourceReports, ['exact.md', 'new.md']);
    assert.equal(registry.entries[1].title, candidate().title);
    assert.deepEqual(registry.entries[1].sourceReports, ['legacy.md']);
  });

  it('refreshes a semantic legacy match without replacing its colon-delimited fingerprint', async () => {
    const { registryPath } = fixture();
    const initial = emptyRegistry();
    initial.entries.push({
      id: 'RS-010',
      fingerprint: 'integration:bug:consumer:missing-state',
      ...candidate(),
      status: 'open',
      firstSeenAt: now,
      lastSeenAt: now,
      sourceReports: ['legacy.md'],
    });
    writeFileSync(registryPath, JSON.stringify(initial));
    const summary = await mergeRiskRegistry({
      registryPath,
      candidates: candidates(candidate({ rootCause: 'Required state is not propagated.' })),
      report: 'current.md',
      projectSlug,
    });
    const registry = parseRiskRegistry(JSON.parse(readFileSync(registryPath, 'utf8')) as unknown);
    assert.deepEqual({ added: summary.added, refreshed: summary.refreshed }, { added: 0, refreshed: 1 });
    assert.equal(registry.entries.length, 1);
    assert.equal(registry.entries[0].fingerprint, 'integration:bug:consumer:missing-state');
    assert.equal(registry.entries[0].rootCause, 'Required state is not propagated.');
  });

  it('creates a canonical entry when legacy alias matching is ambiguous', async () => {
    const { registryPath } = fixture();
    const initial = emptyRegistry();
    for (const [id, fingerprint] of [
      ['RS-001', 'legacy:first'],
      ['RS-002', 'legacy:second'],
    ]) {
      initial.entries.push({
        id,
        fingerprint,
        ...candidate(),
        status: 'open',
        firstSeenAt: now,
        lastSeenAt: now,
        sourceReports: ['legacy.md'],
      });
    }
    writeFileSync(registryPath, JSON.stringify(initial));

    const summary = await mergeRiskRegistry({
      registryPath,
      candidates: candidates(candidate()),
      report: 'current.md',
      projectSlug,
    });
    const registry = parseRiskRegistry(JSON.parse(readFileSync(registryPath, 'utf8')) as unknown);
    assert.deepEqual({ added: summary.added, refreshed: summary.refreshed }, { added: 1, refreshed: 0 });
    assert.equal(registry.entries.length, 3);
    assert.match(registry.entries[2].fingerprint, /^rs1:/u);
  });

  it('rejects project mismatches and leaves malformed registries byte-for-byte intact', async () => {
    const { registryPath } = fixture();
    await assert.rejects(
      mergeRiskRegistry({
        registryPath,
        candidates: { ...candidates(candidate()), projectSlug: 'other' },
        report: 'scan.md',
        projectSlug,
      }),
      (error: unknown) => error instanceof RiskRegistryPersistenceError && error.code === 'project-mismatch',
    );
    const malformed = '{ definitely not json\n';
    writeFileSync(registryPath, malformed);
    await assert.rejects(
      mergeRiskRegistry({ registryPath, candidates: candidates(candidate()), report: 'scan.md', projectSlug }),
      (error: unknown) => error instanceof RiskRegistryPersistenceError && error.code === 'invalid-registry',
    );
    assert.equal(readFileSync(registryPath, 'utf8'), malformed);
  });

  it('cleans temporary files and preserves the prior bytes when atomic replacement fails', async () => {
    const { directory, registryPath } = fixture();
    const before = readFileSync(registryPath, 'utf8');
    await assert.rejects(
      mergeRiskRegistry({
        registryPath,
        candidates: candidates(candidate()),
        report: 'scan.md',
        projectSlug,
        beforeRename: async () => {
          throw new Error('injected failure');
        },
      }),
    );
    assert.equal(readFileSync(registryPath, 'utf8'), before);
    assert.deepEqual(readdirSync(directory).sort(), ['registry.json']);
  });

  it('reports durability uncertainty when parent-directory sync fails after rename', async () => {
    const { registryPath } = fixture();
    await assert.rejects(
      mergeRiskRegistry({
        registryPath,
        candidates: candidates(candidate()),
        report: 'scan.md',
        projectSlug,
        syncRegistryDirectory: async () => {
          throw new Error('injected directory sync failure');
        },
      }),
      (error: unknown) => error instanceof RiskRegistryPersistenceError && error.code === 'durability-uncertain',
    );
    assert.equal(parseRiskRegistry(JSON.parse(readFileSync(registryPath, 'utf8')) as unknown).entries.length, 1);
  });

  it('reports release failure instead of returning success', async () => {
    const { registryPath } = fixture();
    await assert.rejects(
      mergeRiskRegistry({
        registryPath,
        candidates: candidates(candidate()),
        report: 'scan.md',
        projectSlug,
        beforeLockQuarantine: async () => {
          throw new Error('injected release failure');
        },
      }),
      (error: unknown) =>
        error instanceof RiskRegistryPersistenceError &&
        error.code === 'lock-release-failed' &&
        error.diagnostics[0]?.code === 'lock-release-failed',
    );
  });

  it('reports release failure when owned lock metadata becomes malformed', async () => {
    const { registryPath } = fixture();
    await assert.rejects(
      mergeRiskRegistry({
        registryPath,
        candidates: candidates(candidate()),
        report: 'scan.md',
        projectSlug,
        beforeRename: async () => {
          writeFileSync(join(`${registryPath}.lock`, 'owner.json'), '{malformed');
        },
      }),
      (error: unknown) =>
        error instanceof RiskRegistryPersistenceError &&
        error.code === 'lock-release-failed' &&
        error.diagnostics[0]?.code === 'lock-release-failed',
    );
  });

  it('reports release failure when owned lock metadata disappears but the lock remains', async () => {
    const { registryPath } = fixture();
    await assert.rejects(
      mergeRiskRegistry({
        registryPath,
        candidates: candidates(candidate()),
        report: 'scan.md',
        projectSlug,
        beforeRename: async () => {
          rmSync(join(`${registryPath}.lock`, 'owner.json'));
        },
      }),
      (error: unknown) => error instanceof RiskRegistryPersistenceError && error.code === 'lock-release-failed',
    );
  });

  it('preserves the primary operation error and attaches a release diagnostic', async () => {
    const { registryPath } = fixture();
    await assert.rejects(
      mergeRiskRegistry({
        registryPath,
        candidates: candidates(candidate()),
        report: 'scan.md',
        projectSlug,
        beforeRename: async () => {
          throw new Error('injected operation failure');
        },
        beforeLockQuarantine: async () => {
          throw new Error('injected release failure');
        },
      }),
      (error: unknown) =>
        error instanceof RiskRegistryPersistenceError &&
        error.code === 'write-failed' &&
        error.diagnostics[0]?.code === 'lock-release-failed',
    );
  });

  it('serializes two concurrent disjoint updates without losing either finding', async () => {
    const { registryPath } = fixture();
    await Promise.all([
      mergeRiskRegistry({ registryPath, candidates: candidates(candidate()), report: 'one.md', projectSlug }),
      mergeRiskRegistry({
        registryPath,
        candidates: candidates(
          candidate({
            title: 'Cleanup is not idempotent',
            evidence: ['src/cleanup.ts:12'],
            affectedPaths: ['src/cleanup.ts'],
          }),
        ),
        report: 'two.md',
        projectSlug,
      }),
    ]);
    const registry = parseRiskRegistry(JSON.parse(readFileSync(registryPath, 'utf8')) as unknown);
    assert.equal(registry.entries.length, 2);
    assert.deepEqual(registry.entries.map((entry) => entry.id).sort(), ['RS-001', 'RS-002']);
  });

  it('creates a new schema-v1 registry on first merge', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'risk-registry-new-'));
    directories.push(directory);
    const registryPath = join(directory, 'registry.json');
    await mergeRiskRegistry({ registryPath, candidates: candidates(candidate()), report: 'first.md', projectSlug });
    assert.equal(parseRiskRegistry(JSON.parse(readFileSync(registryPath, 'utf8')) as unknown).entries.length, 1);
  });

  it('does not reclaim a stale-looking lock owned by a live local process', async () => {
    const { registryPath } = fixture();
    const lockPath = `${registryPath}.lock`;
    const owner = {
      token: '11111111-1111-4111-8111-111111111111',
      pid: process.pid,
      hostname: hostname(),
      createdAt: '2020-01-01T00:00:00.000Z',
    };
    writeLock(lockPath, owner);
    utimesSync(lockPath, new Date(0), new Date(0));

    await assert.rejects(
      mergeRiskRegistry({
        registryPath,
        candidates: candidates(candidate()),
        report: 'scan.md',
        projectSlug,
        lockTimeoutMs: 30,
        staleLockMs: 1,
      }),
      (error: unknown) => error instanceof RiskRegistryPersistenceError && error.code === 'lock-timeout',
    );
    assert.deepEqual(JSON.parse(readFileSync(join(lockPath, 'owner.json'), 'utf8')) as unknown, owner);
  });

  it('fails clearly without mutating a stale lock whose local owner is dead', async () => {
    const { registryPath } = fixture();
    const lockPath = `${registryPath}.lock`;
    writeLock(lockPath, {
      token: '22222222-2222-4222-8222-222222222222',
      pid: 2_147_483_647,
      hostname: hostname(),
      createdAt: '2020-01-01T00:00:00.000Z',
    });
    utimesSync(lockPath, new Date(0), new Date(0));

    const before = readFileSync(join(lockPath, 'owner.json'), 'utf8');
    await assert.rejects(
      mergeRiskRegistry({
        registryPath,
        candidates: candidates(candidate()),
        report: 'scan.md',
        projectSlug,
        staleLockMs: 1,
      }),
      (error: unknown) => error instanceof RiskRegistryPersistenceError && error.code === 'stale-lock',
    );
    assert.equal(readFileSync(join(lockPath, 'owner.json'), 'utf8'), before);
  });

  it('times out behind a fresh lock even when its recorded process is dead', async () => {
    const { registryPath } = fixture();
    writeLock(`${registryPath}.lock`, {
      token: '33333333-3333-4333-8333-333333333333',
      pid: 2_147_483_647,
      hostname: hostname(),
      createdAt: new Date().toISOString(),
    });

    await assert.rejects(
      mergeRiskRegistry({
        registryPath,
        candidates: candidates(candidate()),
        report: 'scan.md',
        projectSlug,
        lockTimeoutMs: 30,
        staleLockMs: 60_000,
      }),
      (error: unknown) => error instanceof RiskRegistryPersistenceError && error.code === 'lock-timeout',
    );
  });

  it('does not remove a successor lock when releasing its own lease', async () => {
    const { registryPath } = fixture();
    const successor = {
      token: '44444444-4444-4444-8444-444444444444',
      pid: process.pid,
      hostname: hostname(),
      createdAt: new Date().toISOString(),
    };

    await mergeRiskRegistry({
      registryPath,
      candidates: candidates(candidate()),
      report: 'scan.md',
      projectSlug,
      beforeRename: async () => {
        rmSync(`${registryPath}.lock`, { recursive: true, force: true });
        writeLock(`${registryPath}.lock`, successor);
      },
    });

    assert.deepEqual(
      JSON.parse(readFileSync(join(`${registryPath}.lock`, 'owner.json'), 'utf8')) as unknown,
      successor,
    );
  });

  it('fails clearly without mutating an aged malformed lock directory', async () => {
    const { registryPath } = fixture();
    const lockPath = `${registryPath}.lock`;
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, 'owner.json'), '{malformed');
    utimesSync(lockPath, new Date(0), new Date(0));

    await assert.rejects(
      mergeRiskRegistry({
        registryPath,
        candidates: candidates(candidate()),
        report: 'scan.md',
        projectSlug,
        staleLockMs: 1,
      }),
      (error: unknown) => error instanceof RiskRegistryPersistenceError && error.code === 'stale-lock',
    );
    assert.equal(readFileSync(join(lockPath, 'owner.json'), 'utf8'), '{malformed');
  });

  it('cleans the lock directory when owner persistence fails during acquisition', async () => {
    const { directory, registryPath } = fixture();

    await assert.rejects(
      mergeRiskRegistry({
        registryPath,
        candidates: candidates(candidate()),
        report: 'scan.md',
        projectSlug,
        writeLockOwner: async () => {
          throw new Error('injected owner write failure');
        },
      }),
      (error: unknown) => error instanceof RiskRegistryPersistenceError && error.code === 'write-failed',
    );

    assert.deepEqual(readdirSync(directory).sort(), ['registry.json']);
  });

  it('publishes only a fully initialized lock directory', async () => {
    const { registryPath } = fixture();
    const lockPath = `${registryPath}.lock`;
    let inspected = false;

    await mergeRiskRegistry({
      registryPath,
      candidates: candidates(candidate()),
      report: 'scan.md',
      projectSlug,
      beforeLockPublish: async (stagingPath) => {
        inspected = true;
        assert.throws(() => readFileSync(join(lockPath, 'owner.json'), 'utf8'));
        assert.doesNotThrow(() => JSON.parse(readFileSync(join(stagingPath, 'owner.json'), 'utf8')));
      },
    });

    assert.equal(inspected, true);
  });

  it('restores a replacement inode encountered at the release quarantine barrier', async () => {
    const { registryPath } = fixture();
    const replacement = {
      token: '77777777-7777-4777-8777-777777777777',
      pid: process.pid,
      hostname: hostname(),
      createdAt: new Date().toISOString(),
    };
    let replaced = false;

    await mergeRiskRegistry({
      registryPath,
      candidates: candidates(candidate()),
      report: 'scan.md',
      projectSlug,
      beforeLockQuarantine: async (phase, path) => {
        if (phase === 'release' && !replaced) {
          replaced = true;
          rmSync(path, { recursive: true, force: true });
          writeLock(path, replacement);
        }
      },
    });

    assert.deepEqual(
      JSON.parse(readFileSync(join(`${registryPath}.lock`, 'owner.json'), 'utf8')) as unknown,
      replacement,
    );
  });

  it('fails clearly for an aged lock owned by another host', async () => {
    const { registryPath } = fixture();
    const lockPath = `${registryPath}.lock`;
    writeLock(lockPath, {
      token: '88888888-8888-4888-8888-888888888888',
      pid: 123,
      hostname: 'other-host.example',
      createdAt: '2020-01-01T00:00:00.000Z',
    });
    utimesSync(lockPath, new Date(0), new Date(0));

    await assert.rejects(
      mergeRiskRegistry({
        registryPath,
        candidates: candidates(candidate()),
        report: 'scan.md',
        projectSlug,
        staleLockMs: 1,
      }),
      (error: unknown) => error instanceof RiskRegistryPersistenceError && error.code === 'unsupported-shared-host',
    );
  });
});
