import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import type { UiInboxItem, UiInboxStatus } from './types.js';
import {
  DEFAULT_INTAKE_POLICY,
  approvalSchema,
  clarificationMessageSchema,
  executionModeSchema,
  intakeJobSchema,
  intakePolicySchema,
  intakeStatusSchema,
  triageResultSchema,
  type UiInboxFileV2,
} from './intake/types.js';
import { assertContainedArtifactPath } from './path-safety.js';

export class InboxParseError extends Error {
  path: string;

  constructor(path: string, cause: unknown) {
    super(`Failed to parse inbox JSON at ${path}: ${String(cause)}`);
    this.name = 'InboxParseError';
    this.path = path;
    this.cause = cause;
  }
}

interface ClockOptions {
  now?: () => string;
}

interface CreateInboxOptions extends ClockOptions {
  id?: () => string;
}

interface UpdateInboxOptions extends ClockOptions {
  linkedDagPath?: string | null;
  linkedTaskId?: string | null;
}

export const getInboxPath = (projectPath: string): string => join(projectPath, '.dag-executor', 'ui-inbox.json');

const nowIso = (options?: ClockOptions): string => options?.now?.() ?? new Date().toISOString();

const nextId = (options?: CreateInboxOptions): string => options?.id?.() ?? `ui-todo-${randomUUID()}`;

const isStringOrNull = (value: unknown): value is string | null => typeof value === 'string' || value === null;

const assertInboxItem = (item: unknown): UiInboxItem => {
  if (!item || typeof item !== 'object') throw new Error('expected inbox item object');
  const candidate = item as Partial<UiInboxItem>;
  if (typeof candidate.id !== 'string') throw new Error('expected item.id string');
  if (typeof candidate.createdAt !== 'string') throw new Error('expected item.createdAt string');
  if (typeof candidate.updatedAt !== 'string') throw new Error('expected item.updatedAt string');
  if (typeof candidate.body !== 'string') throw new Error('expected item.body string');
  if (candidate.status !== 'open' && candidate.status !== 'converted' && candidate.status !== 'archived') {
    throw new Error('expected item.status open, converted, or archived');
  }
  if (candidate.source !== 'ui') throw new Error('expected item.source ui');
  if (!isStringOrNull(candidate.linkedDagPath)) throw new Error('expected item.linkedDagPath string or null');
  if (!isStringOrNull(candidate.linkedTaskId)) throw new Error('expected item.linkedTaskId string or null');
  if (candidate.intakeStatus !== undefined) intakeStatusSchema.parse(candidate.intakeStatus);
  if (candidate.triage !== undefined && candidate.triage !== null) triageResultSchema.parse(candidate.triage);
  if (candidate.approval !== undefined && candidate.approval !== null) approvalSchema.parse(candidate.approval);
  if (candidate.clarificationMessages !== undefined) {
    if (!Array.isArray(candidate.clarificationMessages)) throw new Error('expected item.clarificationMessages array');
    candidate.clarificationMessages.forEach((message) => clarificationMessageSchema.parse(message));
  }
  if (
    candidate.clarificationRounds !== undefined &&
    (!Number.isInteger(candidate.clarificationRounds) || candidate.clarificationRounds < 0)
  ) {
    throw new Error('expected item.clarificationRounds non-negative integer');
  }
  if (candidate.executionMode !== undefined && candidate.executionMode !== null) {
    executionModeSchema.parse(candidate.executionMode);
  }
  for (const [name, value] of Object.entries({
    linkedPlanPath: candidate.linkedPlanPath,
    linkedRunId: candidate.linkedRunId,
    lastError: candidate.lastError,
    executionStartedAt: candidate.executionStartedAt,
    executionCompletedAt: candidate.executionCompletedAt,
  })) {
    if (value !== undefined && !isStringOrNull(value)) throw new Error(`expected item.${name} string or null`);
  }
  return candidate as UiInboxItem;
};

const assertInboxFile = (value: unknown): UiInboxFileV2 => {
  if (!value || typeof value !== 'object') throw new Error('expected object');
  const file = value as { schemaVersion?: unknown; items?: unknown; jobs?: unknown; policy?: unknown };
  if (file.schemaVersion !== 1 && file.schemaVersion !== 2) throw new Error('expected schemaVersion 1 or 2');
  if (!Array.isArray(file.items)) throw new Error('expected items array');
  const items = file.items.map(assertInboxItem);
  if (file.schemaVersion === 1) {
    return { schemaVersion: 2, items, jobs: [], policy: DEFAULT_INTAKE_POLICY };
  }
  if (!Array.isArray(file.jobs)) throw new Error('expected jobs array');
  return {
    schemaVersion: 2,
    items,
    jobs: file.jobs.map((job) => intakeJobSchema.parse(job)),
    policy: intakePolicySchema.parse(file.policy),
  };
};

export const writeInboxFile = (path: string, file: UiInboxFileV2): void => {
  assertContainedArtifactPath(resolve(dirname(path), '..'), path);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n', 'utf-8');
  renameSync(tmp, path);
};

export const readInbox = (projectPath: string): UiInboxFileV2 => {
  const path = getInboxPath(projectPath);
  assertContainedArtifactPath(projectPath, path);
  if (!existsSync(path)) return { schemaVersion: 2, items: [], jobs: [], policy: DEFAULT_INTAKE_POLICY };
  try {
    return assertInboxFile(JSON.parse(readFileSync(path, 'utf-8')));
  } catch (cause) {
    throw new InboxParseError(path, cause);
  }
};

export const createInboxItem = (projectPath: string, body: string, options?: CreateInboxOptions): UiInboxItem => {
  const trimmed = body.trim();
  if (!trimmed) throw new Error('Inbox item body is required');

  const file = readInbox(projectPath);
  const ts = nowIso(options);
  const item: UiInboxItem = {
    id: nextId(options),
    createdAt: ts,
    updatedAt: ts,
    body: trimmed,
    status: 'open',
    source: 'ui',
    linkedDagPath: null,
    linkedTaskId: null,
  };
  writeInboxFile(getInboxPath(projectPath), { ...file, items: [...file.items, item] });
  return item;
};

export const updateInboxItemStatus = (
  projectPath: string,
  id: string,
  status: UiInboxStatus,
  options?: UpdateInboxOptions,
): UiInboxItem => {
  const file = readInbox(projectPath);
  const existing = file.items.find((item) => item.id === id);
  if (!existing) throw new Error(`Inbox item "${id}" not found`);

  const updated: UiInboxItem = {
    ...existing,
    status,
    updatedAt: nowIso(options),
    linkedDagPath: options?.linkedDagPath !== undefined ? options.linkedDagPath : existing.linkedDagPath,
    linkedTaskId: options?.linkedTaskId !== undefined ? options.linkedTaskId : existing.linkedTaskId,
  };
  writeInboxFile(getInboxPath(projectPath), {
    ...file,
    items: file.items.map((item) => (item.id === id ? updated : item)),
  });
  return updated;
};

export const archiveInboxItem = (projectPath: string, id: string, options?: ClockOptions): UiInboxItem =>
  updateInboxItemStatus(projectPath, id, 'archived', options);
