import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { getEventLogPath } from './events/log.js';

// Machine-wide corpus of finished-run telemetry. Lives outside any repo so the
// corpus can accumulate across checkouts, cleans, and separate projects.
export const DEFAULT_CORPUS_DIR = join(homedir(), '.dag-executor', 'corpus');

export interface ArchiveResult {
  archived: boolean;
  reason?: string;
  destLog?: string;
}

export interface ArchiveOptions {
  corpusDir?: string;
  disabled?: boolean;
}

/**
 * Copy a finished run's event log and sibling DAG json into the corpus.
 *
 * Idempotent: re-archiving the same run overwrites the previous corpus copy with
 * the fuller log, which is useful after resume appends more events.
 */
export const archiveRun = (dagPath: string, opts: ArchiveOptions = {}): ArchiveResult => {
  if (opts.disabled) return { archived: false, reason: 'disabled' };

  const corpusDir = opts.corpusDir ?? DEFAULT_CORPUS_DIR;
  const resolvedDag = resolve(dagPath);
  const logPath = getEventLogPath(resolvedDag);

  if (!existsSync(logPath)) return { archived: false, reason: 'no event log' };

  if (resolve(dirname(resolvedDag)) === resolve(corpusDir)) {
    return { archived: false, reason: 'already in corpus' };
  }

  mkdirSync(corpusDir, { recursive: true });
  const base = basename(resolvedDag).replace(/\.json$/, '');
  const destLog = join(corpusDir, `${base}.events.jsonl`);
  const destDag = join(corpusDir, `${base}.json`);

  copyFileSync(logPath, destLog);
  if (existsSync(resolvedDag)) copyFileSync(resolvedDag, destDag);

  return { archived: true, destLog };
};
