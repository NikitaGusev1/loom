import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { basename, resolve } from 'node:path';
import { ZodError } from 'zod';
import { MAX_GLOBAL_SLOTS } from '../consts.js';
import { DEFAULT_SLOT_DIR } from '../semaphore.js';
import { scanSlots } from '../slots-status.js';
import { UI_HTML } from './assets.js';
import {
  archiveDag,
  classifyDags,
  DagArchiveConflictError,
  dagsForView,
  readDagArchive,
  restoreDag,
} from './dag-archive.js';
import { discoverDags } from './discovery.js';
import { readGitStatus } from './git-status.js';
import { archiveInboxItem, createInboxItem, readInbox, updateInboxItemStatus } from './inbox.js';
import { StaleProposalError } from './intake/persistence.js';
import { loadRunDetail, listRuns } from './intake/projection.js';
import { IntakeService } from './intake/service.js';
import { intakePolicySchema } from './intake/types.js';
import { loadDagDetail, loadTaskDetail } from './projection.js';
import { getProject, listProjects, resolveArtifactsRoot } from './projects.js';
import type { UiDagListItem, UiDagView, UiError, UiInboxStatus, UiProject, UiProjectSummary } from './types.js';

type IntakePort = Pick<IntakeService, 'enqueueTriage' | 'updatePolicy' | 'clarify' | 'approve' | 'cancel' | 'stop'> &
  Partial<Pick<IntakeService, 'start' | 'reconcile'>>;

export interface UiServerOptions {
  projectPath?: string;
  initialProject?: UiProject;
  artifactsRoot?: string;
  slotDir?: string;
  maxSlots?: number;
  maxIntakeServices?: number;
  intakeService?: IntakePort;
  intakeServiceFactory?: (projectPath: string) => IntakePort;
  isIntakeActive?: (projectPath: string) => boolean;
}

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
const TEXT_CONTENT_TYPE = 'text/plain; charset=utf-8';
const MAX_JSON_BODY_BYTES = 64 * 1024;
const MAX_TODO_BODY_LENGTH = 10_000;
const DEFAULT_MAX_INTAKE_SERVICES = 16;
const DISCOVERY_CACHE_MS = 2_000;

const toMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const json = (res: ServerResponse, statusCode: number, value: unknown): void => {
  res.writeHead(statusCode, { 'content-type': JSON_CONTENT_TYPE, 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
};

const text = (res: ServerResponse, statusCode: number, value: string, contentType = TEXT_CONTENT_TYPE): void => {
  res.writeHead(statusCode, { 'content-type': contentType, 'cache-control': 'no-store' });
  res.end(value);
};

const apiError = (
  message: string,
  projectPath?: string,
  statusCode = 400,
): { statusCode: number; body: { error: UiError } } => ({
  statusCode,
  body: { error: { scope: 'project', ...(projectPath && { path: projectPath }), message } },
});

const parseJsonBody = async (req: IncomingMessage, projectPath?: string): Promise<unknown> => {
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

const decodeSegment = (segment: string, projectPath?: string): string => {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw apiError('Malformed path parameter', projectPath);
  }
};

const isInboxStatus = (value: unknown): value is UiInboxStatus =>
  value === 'open' || value === 'converted' || value === 'archived';
const isDagView = (value: string | null): value is UiDagView =>
  value === 'active' || value === 'history' || value === 'archived';
const isApiError = (err: unknown): err is { statusCode: number; body: { error: UiError } } =>
  isObject(err) && typeof err.statusCode === 'number' && isObject(err.body) && isObject(err.body.error);

const ephemeralProject = (projectPath: string): UiProject => {
  const path = resolve(projectPath);
  const slug = basename(path);
  return {
    schemaVersion: 1,
    slug,
    displayName: slug,
    repoPath: path,
    registeredAt: '',
    updatedAt: '',
    source: 'manifest',
    available: true,
    errors: [],
  };
};

const latestActivity = (dags: UiDagListItem[]): string | null =>
  dags
    .map((dag) => dag.updatedAt)
    .filter((value): value is string => value !== null)
    .sort()
    .at(-1) ?? null;

const isLoopbackHost = (host: string | undefined): boolean => {
  if (!host) return false;
  const hostname = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0];
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
};

const isSameOrigin = (origin: string | undefined, host: string | undefined): boolean => {
  if (!origin) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
};

export const createUiServer = (options: UiServerOptions = {}): Server => {
  const artifactsRoot = resolveArtifactsRoot(options.artifactsRoot);
  const slotDir = options.slotDir ?? DEFAULT_SLOT_DIR;
  const maxSlots = options.maxSlots ?? MAX_GLOBAL_SLOTS;
  const maxIntakeServices = Math.max(1, options.maxIntakeServices ?? DEFAULT_MAX_INTAKE_SERVICES);
  const candidateInitial =
    options.initialProject ?? (options.projectPath ? ephemeralProject(options.projectPath) : null);
  const registeredInitial = candidateInitial ? getProject(artifactsRoot, candidateInitial.slug) : null;
  if (registeredInitial && candidateInitial && registeredInitial.repoPath !== candidateInitial.repoPath) {
    throw new Error(
      `Initial project slug "${candidateInitial.slug}" is registered to ${registeredInitial.repoPath}, not ${candidateInitial.repoPath}`,
    );
  }
  const initialProject = registeredInitial ?? candidateInitial;
  const services = new Map<string, IntakePort>();
  const discoveryCache = new Map<string, { expiresAt: number; result: ReturnType<typeof discoverDags> }>();
  const csrfToken = randomUUID();

  const discoverProject = (projectPath: string): ReturnType<typeof discoverDags> => {
    const cached = discoveryCache.get(projectPath);
    if (cached && cached.expiresAt > Date.now()) return cached.result;
    const result = discoverDags(projectPath);
    discoveryCache.set(projectPath, { expiresAt: Date.now() + DISCOVERY_CACHE_MS, result });
    return result;
  };

  const registryProjects = (): UiProject[] => {
    const projects = listProjects(artifactsRoot).projects;
    if (!initialProject || projects.some((project) => project.slug === initialProject.slug)) return projects;
    return [initialProject, ...projects];
  };

  const resolveProject = (slug: string): UiProject => {
    // Prefer the registry on every request.  In particular, do not let the
    // single-project compatibility option shadow a registered project whose
    // path or availability has since changed.  The fallback keeps legacy
    // --project sessions working before a project has been registered.
    const project = getProject(artifactsRoot, slug) ?? (initialProject?.slug === slug ? initialProject : null);
    if (!project) throw apiError(`Unknown project "${slug}"`, undefined, 404);
    if (!project.available) throw apiError('Project repository is unavailable', project.repoPath, 404);
    return project;
  };

  const isActive =
    options.isIntakeActive ??
    ((projectPath: string): boolean => {
      try {
        const inbox = readInbox(projectPath);
        if (inbox.jobs.some((job) => job.status === 'queued' || job.status === 'claimed')) return true;
        if (
          inbox.items.some(
            (item) =>
              item.intakeStatus === 'triaging' || item.intakeStatus === 'queued' || item.intakeStatus === 'running',
          )
        ) {
          return true;
        }
        return listRuns(projectPath).some(
          (run) => run.mode === 'sequential' && (run.status === 'queued' || run.status === 'running'),
        );
      } catch {
        return true;
      }
    });

  const intakeFor = (project: UiProject): IntakePort => {
    const serviceKey = project.repoPath;
    const existing = services.get(serviceKey);
    if (existing) {
      services.delete(serviceKey);
      services.set(serviceKey, existing);
      return existing;
    }
    if (services.size >= maxIntakeServices) {
      const idle = [...services.entries()].find(([projectPath]) => !isActive(projectPath));
      if (!idle) throw apiError('All project intake services are busy; try again later', project.repoPath, 503);
      idle[1].stop();
      services.delete(idle[0]);
    }
    const service =
      options.intakeService && initialProject?.slug === project.slug
        ? options.intakeService
        : (options.intakeServiceFactory?.(project.repoPath) ?? new IntakeService(project.repoPath));
    try {
      service.start?.();
    } catch (error) {
      try {
        service.stop();
      } catch {
        // Preserve the startup failure as the actionable error.
      }
      throw apiError(`Failed to start project intake: ${toMessage(error)}`, project.repoPath, 500);
    }
    services.set(serviceKey, service);
    return service;
  };

  const projectionFor = (project: UiProject) => {
    const discovered = discoverProject(project.repoPath);
    try {
      const classified = classifyDags(discovered.dags, readDagArchive(artifactsRoot, project.slug));
      return { discovered, classified, errors: [...project.errors, ...discovered.errors, ...classified.errors] };
    } catch (error) {
      const classified = classifyDags(discovered.dags, { schemaVersion: 1, items: [] });
      return {
        discovered,
        classified,
        errors: [
          ...project.errors,
          ...discovered.errors,
          { scope: 'dag' as const, message: `Failed to read DAG archive: ${toMessage(error)}` },
        ],
      };
    }
  };

  const summaryFor = (project: UiProject, slots = scanSlots(slotDir, maxSlots)): UiProjectSummary => {
    const { discovered, classified, errors } = projectionFor(project);
    let openInboxCount = 0;
    let runs: ReturnType<typeof listRuns> = [];
    try {
      openInboxCount = readInbox(project.repoPath).items.filter((item) => item.status !== 'archived').length;
      runs = listRuns(project.repoPath, discovered.dags);
    } catch (error) {
      errors.push({ scope: 'inbox', path: project.repoPath, message: toMessage(error) });
    }
    const recentRun = runs[0] ?? null;
    const recentActivityAt =
      [latestActivity(discovered.dags), recentRun?.updatedAt || null]
        .filter((value): value is string => value !== null && value !== '')
        .sort()
        .at(-1) ?? null;
    return {
      slug: project.slug,
      displayName: project.displayName,
      projectPath: project.repoPath,
      dagCount: discovered.dags.length,
      dagCounts: {
        active: classified.active.length,
        history: classified.history.length,
        archived: classified.archived.length,
        attention: classified.active.filter((dag) => dag.status === 'paused' || dag.status === 'failed').length,
      },
      openInboxCount,
      recentActivityAt,
      recentRun: recentRun ? { mode: recentRun.mode, status: recentRun.status, updatedAt: recentRun.updatedAt } : null,
      git: readGitStatus(project.repoPath),
      slots,
      errors,
    };
  };

  const resolveDag = (project: UiProject, relativePath: string): UiDagListItem => {
    if (!relativePath || relativePath.startsWith('/') || relativePath.split('/').includes('..')) {
      throw apiError('DAG path must be a repository-relative discovered path', project.repoPath);
    }
    const dag = discoverProject(project.repoPath).dags.find((item) => item.relativePath === relativePath);
    if (!dag) throw apiError(`DAG "${relativePath}" was not found`, project.repoPath, 404);
    return dag;
  };

  const handleProjectRoute = async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    project: UiProject,
    tail: string,
  ): Promise<boolean> => {
    const method = req.method ?? 'GET';
    if (method === 'GET' && tail === '') {
      json(res, 200, summaryFor(project));
      return true;
    }
    if (method === 'GET' && tail === '/dags') {
      const view = url.searchParams.get('view') ?? 'active';
      if (!isDagView(view)) throw apiError('view must be active, history, or archived', project.repoPath);
      const { classified, errors } = projectionFor(project);
      json(res, 200, { projectPath: project.repoPath, view, dags: dagsForView(classified, view), errors });
      return true;
    }
    if (method === 'GET' && tail === '/dags/detail') {
      const dag = resolveDag(project, url.searchParams.get('path') ?? '');
      json(res, 200, loadDagDetail(project.repoPath, dag.path));
      return true;
    }
    if (method === 'GET' && tail === '/tasks/detail') {
      const dag = resolveDag(project, url.searchParams.get('dagPath') ?? '');
      const taskId = url.searchParams.get('taskId');
      if (!taskId) throw apiError('taskId is required', project.repoPath);
      json(res, 200, loadTaskDetail(project.repoPath, dag.path, taskId));
      return true;
    }
    if (method === 'POST' && (tail === '/dags/archive' || tail === '/dags/restore')) {
      const body = await parseJsonBody(req, project.repoPath);
      if (!isObject(body) || typeof body.path !== 'string') throw apiError('path must be a string', project.repoPath);
      const dag = resolveDag(project, body.path);
      const archive =
        tail === '/dags/archive'
          ? await archiveDag(artifactsRoot, project.slug, dag)
          : await restoreDag(artifactsRoot, project.slug, dag.relativePath);
      json(res, 200, { archive });
      return true;
    }
    if (method === 'GET' && tail === '/inbox') {
      json(res, 200, readInbox(project.repoPath));
      return true;
    }
    if (method === 'POST' && tail === '/intake/reconcile') {
      intakeFor(project).reconcile?.();
      json(res, 200, { ok: true });
      return true;
    }
    if (method === 'POST' && tail === '/inbox') {
      const body = await parseJsonBody(req, project.repoPath);
      if (!isObject(body) || typeof body.body !== 'string') throw apiError('body must be a string', project.repoPath);
      if (body.body.length > MAX_TODO_BODY_LENGTH) throw apiError('body is too long', project.repoPath, 413);
      const intake = intakeFor(project);
      const item = createInboxItem(project.repoPath, body.body);
      try {
        intake.enqueueTriage(item.id);
      } catch (error) {
        archiveInboxItem(project.repoPath, item.id);
        throw error;
      }
      json(res, 201, { item });
      return true;
    }
    if (method === 'GET' && tail === '/intake/status') {
      const file = readInbox(project.repoPath);
      json(res, 200, { policy: file.policy, jobs: file.jobs });
      return true;
    }
    if (method === 'PATCH' && tail === '/intake/policy') {
      const body = intakePolicySchema.parse(await parseJsonBody(req, project.repoPath));
      json(res, 200, { policy: intakeFor(project).updatePolicy(body) });
      return true;
    }
    if (method === 'GET' && tail === '/intake/runs') {
      json(res, 200, { runs: listRuns(project.repoPath) });
      return true;
    }
    const runMatch = tail.match(/^\/intake\/runs\/([^/]+)$/);
    if (method === 'GET' && runMatch) {
      json(res, 200, loadRunDetail(project.repoPath, decodeSegment(runMatch[1], project.repoPath)));
      return true;
    }
    const actionMatch = tail.match(/^\/inbox\/([^/]+)\/(triage|clarify|approve|cancel|archive)$/);
    if (actionMatch) {
      const id = decodeSegment(actionMatch[1], project.repoPath);
      const action = actionMatch[2];
      if (method === 'POST' && action === 'archive') {
        json(res, 200, { item: archiveInboxItem(project.repoPath, id) });
        return true;
      }
      if (method !== 'POST') return false;
      const intake = intakeFor(project);
      if (action === 'triage') intake.enqueueTriage(id);
      else if (action === 'clarify') {
        const body = await parseJsonBody(req, project.repoPath);
        if (!isObject(body) || typeof body.answer !== 'string' || !Number.isInteger(body.proposalRevision)) {
          throw apiError('answer and proposalRevision are required', project.repoPath);
        }
        intake.clarify(id, body.proposalRevision as number, body.answer);
      } else if (action === 'approve') {
        const body = await parseJsonBody(req, project.repoPath);
        if (!isObject(body) || !Number.isInteger(body.proposalRevision)) {
          throw apiError('proposalRevision is required', project.repoPath);
        }
        await intake.approve(id, body.proposalRevision as number);
      } else if (action === 'cancel') await intake.cancel(id);
      else return false;
      json(res, action === 'cancel' ? 200 : 202, action === 'cancel' ? { cancelled: true } : { accepted: true });
      return true;
    }
    const inboxItemMatch = tail.match(/^\/inbox\/([^/]+)$/);
    if (method === 'PATCH' && inboxItemMatch) {
      const body = await parseJsonBody(req, project.repoPath);
      if (!isObject(body) || !isInboxStatus(body.status)) {
        throw apiError('status must be open, converted, or archived', project.repoPath);
      }
      const linkedDagPath =
        typeof body.linkedDagPath === 'string' || body.linkedDagPath === null ? body.linkedDagPath : undefined;
      const linkedTaskId =
        typeof body.linkedTaskId === 'string' || body.linkedTaskId === null ? body.linkedTaskId : undefined;
      const id = decodeSegment(inboxItemMatch[1], project.repoPath);
      json(res, 200, {
        item: updateInboxItemStatus(project.repoPath, id, body.status, { linkedDagPath, linkedTaskId }),
      });
      return true;
    }
    return false;
  };

  const legacyTail = (path: string): string | null => {
    if (path === '/api/project') return '';
    if (path.startsWith('/api/')) return path.slice(4);
    return null;
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const method = req.method ?? 'GET';
      if (!isLoopbackHost(req.headers.host)) throw apiError('Invalid Host header', undefined, 403);
      if (!isSameOrigin(req.headers.origin, req.headers.host)) {
        throw apiError('Cross-origin requests are not allowed', undefined, 403);
      }
      if (method !== 'GET' && method !== 'HEAD' && req.headers['x-loom-csrf'] !== csrfToken) {
        throw apiError('Invalid CSRF token', undefined, 403);
      }
      if (method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        text(res, 200, UI_HTML, 'text/html; charset=utf-8');
        return;
      }
      if (method === 'GET' && url.pathname === '/api/session') {
        json(res, 200, { csrfToken });
        return;
      }
      if (method === 'GET' && url.pathname === '/api/projects') {
        const registry = listProjects(artifactsRoot);
        const slots = scanSlots(slotDir, maxSlots);
        const projects = registryProjects().map((project) =>
          project.available
            ? summaryFor(project, slots)
            : {
                slug: project.slug,
                displayName: project.displayName,
                projectPath: project.repoPath,
                unavailable: true,
                errors: project.errors,
              },
        );
        json(res, 200, { projects, errors: registry.errors, initialProjectSlug: initialProject?.slug ?? null });
        return;
      }
      const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
      if (projectMatch) {
        const project = resolveProject(decodeSegment(projectMatch[1]));
        if (await handleProjectRoute(req, res, url, project, projectMatch[2] ?? '')) return;
      } else if (initialProject) {
        const tail = legacyTail(url.pathname);
        if (tail !== null && (await handleProjectRoute(req, res, url, initialProject, tail))) return;
      }
      text(res, 404, 'Not found');
    } catch (err) {
      if (err instanceof StaleProposalError) {
        json(res, 409, { error: { scope: 'intake', message: toMessage(err) } });
      } else if (err instanceof DagArchiveConflictError) {
        json(res, 409, { error: { scope: 'dag', message: err.message } });
      } else if (err instanceof ZodError) {
        json(res, 400, { error: { scope: 'project', message: err.message } });
      } else if (isApiError(err)) {
        json(res, err.statusCode, err.body);
      } else {
        json(res, 500, { error: { scope: 'project', message: toMessage(err) } });
      }
    }
  });
  server.on('close', () => {
    for (const service of services.values()) service.stop();
    services.clear();
  });
  return server;
};
