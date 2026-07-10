import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveRun } from './corpus.js';

describe('archiveRun', () => {
  let work: string;
  let corpus: string;

  const dagPath = (): string => join(work, 'decomposition-2026-07-02-demo.json');
  const logPath = (): string => join(work, 'decomposition-2026-07-02-demo.events.jsonl');
  const bankedLog = (): string => join(corpus, 'decomposition-2026-07-02-demo.events.jsonl');
  const bankedDag = (): string => join(corpus, 'decomposition-2026-07-02-demo.json');

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'corpus-src-'));
    corpus = mkdtempSync(join(tmpdir(), 'corpus-dest-'));
    writeFileSync(dagPath(), '{"meta":{"id":"demo"}}');
    writeFileSync(logPath(), '{"kind":"dag.started"}\n{"kind":"dag.completed"}\n');
  });

  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
    rmSync(corpus, { recursive: true, force: true });
  });

  it('copies both the event log and the sibling DAG into the corpus', () => {
    const result = archiveRun(dagPath(), { corpusDir: corpus });

    assert.equal(result.archived, true);
    assert.equal(result.destLog, bankedLog());
    assert.ok(existsSync(bankedLog()), 'event log banked');
    assert.ok(existsSync(bankedDag()), 'DAG json banked');
    assert.equal(readFileSync(bankedLog(), 'utf-8'), readFileSync(logPath(), 'utf-8'));
  });

  it('skips when there is no event log', () => {
    rmSync(logPath());

    const result = archiveRun(dagPath(), { corpusDir: corpus });

    assert.equal(result.archived, false);
    assert.equal(result.reason, 'no event log');
    assert.ok(!existsSync(bankedDag()), 'DAG not banked without a log');
  });

  it('skips when disabled', () => {
    const result = archiveRun(dagPath(), { corpusDir: corpus, disabled: true });

    assert.equal(result.archived, false);
    assert.equal(result.reason, 'disabled');
    assert.ok(!existsSync(bankedLog()));
  });

  it('does not self-copy a run already living in the corpus dir', () => {
    const inCorpusDag = join(corpus, 'decomposition-2026-07-02-demo.json');
    writeFileSync(inCorpusDag, '{"meta":{"id":"demo"}}');
    writeFileSync(join(corpus, 'decomposition-2026-07-02-demo.events.jsonl'), '{"kind":"dag.started"}\n');

    const result = archiveRun(inCorpusDag, { corpusDir: corpus });

    assert.equal(result.archived, false);
    assert.equal(result.reason, 'already in corpus');
  });

  it('re-archives with the fuller log on a resume', () => {
    archiveRun(dagPath(), { corpusDir: corpus });
    writeFileSync(logPath(), '{"kind":"dag.started"}\n{"kind":"task.completed"}\n{"kind":"dag.completed"}\n');

    const result = archiveRun(dagPath(), { corpusDir: corpus });

    assert.equal(result.archived, true);
    assert.equal(readFileSync(bankedLog(), 'utf-8'), readFileSync(logPath(), 'utf-8'));
  });

  it('archives the log even when the DAG json is absent', () => {
    rmSync(dagPath());

    const result = archiveRun(dagPath(), { corpusDir: corpus });

    assert.equal(result.archived, true);
    assert.ok(existsSync(bankedLog()), 'log banked');
    assert.ok(!existsSync(bankedDag()), 'no DAG to bank');
  });

  it('creates the corpus dir if it does not exist yet', () => {
    const fresh = join(corpus, 'nested', 'created', 'on', 'demand');

    const result = archiveRun(dagPath(), { corpusDir: fresh });

    assert.equal(result.archived, true);
    assert.ok(existsSync(join(fresh, 'decomposition-2026-07-02-demo.events.jsonl')));
  });
});
