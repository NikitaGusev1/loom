import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { MAX_GLOBAL_SLOTS } from '../consts.js';
import { DEFAULT_SLOT_DIR } from '../semaphore.js';
import { scanSlots } from '../slots-status.js';
import { UI_HTML } from './assets.js';
import { discoverDags } from './discovery.js';
import { archiveInboxItem, createInboxItem, readInbox, updateInboxItemStatus } from './inbox.js';
import { loadDagDetail, loadTaskDetail } from './projection.js';
import type { UiError, UiInboxStatus } from './types.js';
import { IntakeService } from './intake/service.js';
import { loadRunDetail, listRuns } from './intake/projection.js';
import { StaleProposalError } from './intake/persistence.js';
import { intakePolicySchema } from './intake/types.js';
import { ZodError } from 'zod';

export interface UiServerOptions {
  projectPath: string;
  slotDir?: string;
  maxSlots?: number;
  intakeService?: Pick<IntakeService, 'enqueueTriage' | 'updatePolicy' | 'clarify' | 'approve' | 'cancel' | 'stop'> &
    Partial<Pick<IntakeService, 'start' | 'reconcile'>>;
}

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
const TEXT_CONTENT_TYPE = 'text/plain; charset=utf-8';
const MAX_JSON_BODY_BYTES = 64 * 1024;
const MAX_TODO_BODY_LENGTH = 10_000;

const toMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const json = (res: ServerResponse, statusCode: number, value: unknown): void => {
  res.writeHead(statusCode, {
    'content-type': JSON_CONTENT_TYPE,
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(value));
};

const text = (res: ServerResponse, statusCode: number, value: string, contentType = TEXT_CONTENT_TYPE): void => {
  res.writeHead(statusCode, {
    'content-type': contentType,
    'cache-control': 'no-store',
  });
  res.end(value);
};

const apiError = (
  message: string,
  projectPath: string,
  statusCode = 400,
): { statusCode: number; body: { error: UiError } } => ({
  statusCode,
  body: { error: { scope: 'project', path: projectPath, message } },
});

const parseJsonBody = async (req: IncomingMessage, projectPath: string): Promise<unknown> => {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw) > MAX_JSON_BODY_BYTES) throw apiError('JSON body is too large', projectPath, 413);
  }
  if (!raw.trim()) throw apiError('JSON body is required', projectPath);

  try {
    return JSON.parse(raw);
  } catch (err) {
    throw apiError(`Malformed JSON body: ${toMessage(err)}`, projectPath);
  }
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const requireString = (value: string | null, name: string, projectPath: string): string => {
  if (!value) throw apiError(`${name} is required`, projectPath);
  return value;
};

const decodePathSegment = (segment: string, projectPath: string): string => {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw apiError('Malformed path parameter', projectPath);
  }
};

const isInboxStatus = (value: unknown): value is UiInboxStatus =>
  value === 'open' || value === 'converted' || value === 'archived';

const isApiError = (err: unknown): err is { statusCode: number; body: { error: UiError } } =>
  isObject(err) && typeof err.statusCode === 'number' && isObject(err.body) && isObject(err.body.error);

export const createUiServer = (options: UiServerOptions): Server => {
  const projectPath = resolve(options.projectPath);
  const slotDir = options.slotDir ?? DEFAULT_SLOT_DIR;
  const maxSlots = options.maxSlots ?? MAX_GLOBAL_SLOTS;
  const intake = options.intakeService ?? new IntakeService(projectPath);
  try {
    intake.start?.();
  } catch {
    // Malformed intake state remains visible through the API instead of preventing server startup.
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const method = req.method ?? 'GET';
      const path = url.pathname;

      if (method === 'GET' && (path === '/' || path === '/index.html')) {
        text(res, 200, UI_HTML, 'text/html; charset=utf-8');
        return;
      }

      if (method === 'GET' && path === '/api/project') {
        const discovered = discoverDags(projectPath);
        json(res, 200, {
          projectPath,
          dagCount: discovered.dags.length,
          slots: scanSlots(slotDir, maxSlots),
          errors: discovered.errors,
        });
        return;
      }

      if (method === 'GET' && path === '/api/dags') {
        json(res, 200, discoverDags(projectPath));
        return;
      }

      if (method === 'GET' && path === '/api/dags/detail') {
        const dagPath = requireString(url.searchParams.get('path'), 'path', projectPath);
        json(res, 200, loadDagDetail(projectPath, dagPath));
        return;
      }

      if (method === 'GET' && path === '/api/tasks/detail') {
        const dagPath = requireString(url.searchParams.get('dagPath'), 'dagPath', projectPath);
        const taskId = requireString(url.searchParams.get('taskId'), 'taskId', projectPath);
        json(res, 200, loadTaskDetail(projectPath, dagPath, taskId));
        return;
      }

      if (method === 'GET' && path === '/api/inbox') {
        intake.reconcile?.();
        json(res, 200, readInbox(projectPath));
        return;
      }

      if (method === 'POST' && path === '/api/inbox') {
        const body = await parseJsonBody(req, projectPath);
        if (!isObject(body) || typeof body.body !== 'string') {
          throw apiError('body must be a string', projectPath);
        }
        if (body.body.length > MAX_TODO_BODY_LENGTH) throw apiError('body is too long', projectPath, 413);
        const item = createInboxItem(projectPath, body.body);
        intake.enqueueTriage(item.id);
        json(res, 201, { item });
        return;
      }

      if (method === 'GET' && path === '/api/intake/status') {
        const file = readInbox(projectPath);
        json(res, 200, { policy: file.policy, jobs: file.jobs });
        return;
      }

      if (method === 'PATCH' && path === '/api/intake/policy') {
        const body = intakePolicySchema.parse(await parseJsonBody(req, projectPath));
        json(res, 200, { policy: intake.updatePolicy(body) });
        return;
      }

      if (method === 'GET' && path === '/api/intake/runs') {
        json(res, 200, { runs: listRuns(projectPath) });
        return;
      }

      const runMatch = path.match(/^\/api\/intake\/runs\/([^/]+)$/);
      if (method === 'GET' && runMatch) {
        json(res, 200, loadRunDetail(projectPath, decodePathSegment(runMatch[1], projectPath)));
        return;
      }

      const triageMatch = path.match(/^\/api\/inbox\/([^/]+)\/triage$/);
      if (method === 'POST' && triageMatch) {
        const id = decodePathSegment(triageMatch[1], projectPath);
        intake.enqueueTriage(id);
        json(res, 202, { accepted: true });
        return;
      }

      const clarifyMatch = path.match(/^\/api\/inbox\/([^/]+)\/clarify$/);
      if (method === 'POST' && clarifyMatch) {
        const body = await parseJsonBody(req, projectPath);
        if (!isObject(body) || typeof body.answer !== 'string' || !Number.isInteger(body.proposalRevision)) {
          throw apiError('answer and proposalRevision are required', projectPath);
        }
        intake.clarify(decodePathSegment(clarifyMatch[1], projectPath), body.proposalRevision as number, body.answer);
        json(res, 202, { accepted: true });
        return;
      }

      const approveMatch = path.match(/^\/api\/inbox\/([^/]+)\/approve$/);
      if (method === 'POST' && approveMatch) {
        const body = await parseJsonBody(req, projectPath);
        if (!isObject(body) || !Number.isInteger(body.proposalRevision)) {
          throw apiError('proposalRevision is required', projectPath);
        }
        await intake.approve(decodePathSegment(approveMatch[1], projectPath), body.proposalRevision as number);
        json(res, 202, { accepted: true });
        return;
      }

      const cancelMatch = path.match(/^\/api\/inbox\/([^/]+)\/cancel$/);
      if (method === 'POST' && cancelMatch) {
        await intake.cancel(decodePathSegment(cancelMatch[1], projectPath));
        json(res, 200, { cancelled: true });
        return;
      }

      const archiveMatch = path.match(/^\/api\/inbox\/([^/]+)\/archive$/);
      if (method === 'POST' && archiveMatch) {
        const id = decodePathSegment(archiveMatch[1], projectPath);
        json(res, 200, { item: archiveInboxItem(projectPath, id) });
        return;
      }

      const inboxItemMatch = path.match(/^\/api\/inbox\/([^/]+)$/);
      if (method === 'PATCH' && inboxItemMatch) {
        const body = await parseJsonBody(req, projectPath);
        if (!isObject(body) || !isInboxStatus(body.status)) {
          throw apiError('status must be open, converted, or archived', projectPath);
        }
        const linkedDagPath =
          typeof body.linkedDagPath === 'string' || body.linkedDagPath === null ? body.linkedDagPath : undefined;
        const linkedTaskId =
          typeof body.linkedTaskId === 'string' || body.linkedTaskId === null ? body.linkedTaskId : undefined;
        const id = decodePathSegment(inboxItemMatch[1], projectPath);
        json(res, 200, {
          item: updateInboxItemStatus(projectPath, id, body.status, { linkedDagPath, linkedTaskId }),
        });
        return;
      }

      text(res, 404, 'Not found');
    } catch (err) {
      if (err instanceof StaleProposalError) {
        json(res, 409, { error: { scope: 'intake', path: projectPath, message: toMessage(err) } });
        return;
      }
      if (err instanceof ZodError) {
        json(res, 400, { error: { scope: 'intake', path: projectPath, message: err.message } });
        return;
      }
      if (isApiError(err)) {
        json(res, err.statusCode, err.body);
        return;
      }
      json(res, 500, { error: { scope: 'project', path: projectPath, message: toMessage(err) } });
    }
  });
  server.on('close', () => intake.stop());
  return server;
};
