import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { getInboxPath, readInbox, writeInboxFile } from '../inbox.js';
import {
  intakePolicySchema,
  sequentialCheckpointSchema,
  type UiInboxFileV2,
  type UiIntakeJob,
  type UiIntakePolicy,
  type UiSequentialCheckpoint,
} from './types.js';
import type { UiInboxItem } from '../types.js';
import { isPidAlive } from '../../pid.js';

const MAX_LOG_BYTES = 64 * 1024;
const MAX_LOG_LINES = 200;

export class StaleProposalError extends Error {}

export const getIntakeDir = (projectPath: string): string => join(projectPath, '.dag-executor', 'intake');
export const getPlansDir = (projectPath: string): string => join(getIntakeDir(projectPath), 'plans');
export const getRunsDir = (projectPath: string): string => join(getIntakeDir(projectPath), 'runs');
export const getPlanPath = (projectPath: string, itemId: string): string =>
  join(getPlansDir(projectPath), `${itemId}.plan.md`);
export const getRunPath = (projectPath: string, runId: string): string =>
  join(getRunsDir(projectPath), `${runId}.json`);
export const getRunLogPath = (projectPath: string, runId: string): string =>
  join(getRunsDir(projectPath), `${runId}.log`);

export const acquireIntakeJobLease = (projectPath: string, jobId: string): (() => void) | null => {
  const path = join(getIntakeDir(projectPath), 'jobs', `${jobId}.lock`);
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    try {
      const current = JSON.parse(readFileSync(path, 'utf-8')) as { pid?: number };
      if (typeof current.pid === 'number' && isPidAlive(current.pid)) return null;
      unlinkSync(path);
    } catch {
      return null;
    }
  }
  try {
    const fd = openSync(path, 'wx');
    writeFileSync(fd, JSON.stringify({ pid: process.pid }));
    closeSync(fd);
    return () => {
      try {
        unlinkSync(path);
      } catch {
        // Already released or reclaimed.
      }
    };
  } catch {
    return null;
  }
};

const assertWithinProject = (projectPath: string, path: string): void => {
  const root = resolve(projectPath) + '/';
  if (!resolve(path).startsWith(root)) throw new Error('Intake artifact path escapes project');
};

export const atomicWriteText = (path: string, value: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, value, 'utf-8');
  renameSync(tmp, path);
};

export const updateInboxFile = (projectPath: string, update: (file: UiInboxFileV2) => UiInboxFileV2): UiInboxFileV2 => {
  const next = update(readInbox(projectPath));
  writeInboxFile(getInboxPath(projectPath), next);
  return next;
};

export const updateInboxItem = (
  projectPath: string,
  itemId: string,
  update: (item: UiInboxItem) => UiInboxItem,
  expectedRevision?: number,
): UiInboxItem => {
  let result: UiInboxItem | undefined;
  updateInboxFile(projectPath, (file) => ({
    ...file,
    items: file.items.map((item) => {
      if (item.id !== itemId) return item;
      if (expectedRevision !== undefined && item.triage?.proposalRevision !== expectedRevision) {
        throw new StaleProposalError(`Inbox item "${itemId}" proposal changed`);
      }
      result = update(item);
      return result;
    }),
  }));
  if (!result) throw new Error(`Inbox item "${itemId}" not found`);
  return result;
};

export const setIntakePolicy = (projectPath: string, policy: UiIntakePolicy): UiIntakePolicy => {
  const validated = intakePolicySchema.parse(policy);
  updateInboxFile(projectPath, (file) => ({ ...file, policy: validated }));
  return validated;
};

export const addIntakeJob = (projectPath: string, job: UiIntakeJob): UiIntakeJob => {
  let result = job;
  updateInboxFile(projectPath, (file) => {
    const existing = file.jobs.find((candidate) => candidate.idempotencyKey === job.idempotencyKey);
    if (existing) {
      result = existing;
      return file;
    }
    return { ...file, jobs: [...file.jobs, job] };
  });
  return result;
};

export const updateIntakeJob = (
  projectPath: string,
  jobId: string,
  update: (job: UiIntakeJob) => UiIntakeJob,
): UiIntakeJob => {
  let result: UiIntakeJob | undefined;
  updateInboxFile(projectPath, (file) => ({
    ...file,
    jobs: file.jobs.map((job) => {
      if (job.id !== jobId) return job;
      result = update(job);
      return result;
    }),
  }));
  if (!result) throw new Error(`Intake job "${jobId}" not found`);
  return result;
};

export const writePlan = (projectPath: string, itemId: string, markdown: string): string => {
  const path = getPlanPath(projectPath, itemId);
  assertWithinProject(projectPath, path);
  atomicWriteText(path, markdown);
  return path;
};

export const writeCheckpoint = (projectPath: string, checkpoint: UiSequentialCheckpoint): void => {
  const validated = sequentialCheckpointSchema.parse(checkpoint);
  const path = getRunPath(projectPath, checkpoint.id);
  assertWithinProject(projectPath, path);
  atomicWriteText(path, JSON.stringify(validated, null, 2) + '\n');
};

export const readCheckpoint = (projectPath: string, runId: string): UiSequentialCheckpoint =>
  sequentialCheckpointSchema.parse(JSON.parse(readFileSync(getRunPath(projectPath, runId), 'utf-8')));

export const listCheckpoints = (projectPath: string): UiSequentialCheckpoint[] => {
  const dir = getRunsDir(projectPath);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .flatMap((name) => {
      try {
        return [sequentialCheckpointSchema.parse(JSON.parse(readFileSync(join(dir, name), 'utf-8')))];
      } catch {
        return [];
      }
    });
};

export const appendRunLog = (projectPath: string, runId: string, line: string): void => {
  const path = getRunLogPath(projectPath, runId);
  assertWithinProject(projectPath, path);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, line.replace(/[\r\n]+/g, ' ') + '\n', 'utf-8');
};

export const readRunLogTail = (projectPath: string, runId: string): string[] => {
  const path = getRunLogPath(projectPath, runId);
  if (!existsSync(path)) return [];
  const size = statSync(path).size;
  const raw = readFileSync(path);
  return raw
    .subarray(Math.max(0, size - MAX_LOG_BYTES))
    .toString('utf-8')
    .split('\n')
    .filter(Boolean)
    .slice(-MAX_LOG_LINES);
};
