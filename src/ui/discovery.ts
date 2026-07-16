import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { validateDAG } from '../validation.js';
import { getEventLogPath } from '../events/log.js';
import { getStatePath } from '../state.js';
import type { UiDagListItem, UiDagStatus, UiError } from './types.js';

export interface DiscoverDagsResult {
  projectPath: string;
  dags: UiDagListItem[];
  errors: UiError[];
}

export const UI_IGNORED_DIRS = new Set([
  '.git',
  '.worktrees',
  'node_modules',
  'build',
  '.dag-executor',
  '.loom-supervisor',
  '.superpowers',
]);

const IGNORED_FILENAMES = new Set(['package.json', 'package-lock.json', 'tsconfig.json']);
const MAX_DISCOVERY_FILES = 5_000;
const MAX_DISCOVERY_DEPTH = 32;
const MAX_JSON_BYTES = 2 * 1024 * 1024;

const toMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const isCandidateDagPath = (path: string): boolean =>
  path.endsWith('.json') &&
  !path.endsWith('.state.json') &&
  !path.endsWith('.supervisor.json') &&
  !IGNORED_FILENAMES.has(basename(path));

const walkJson = (dir: string, out: string[], depth = 0): boolean => {
  if (depth > MAX_DISCOVERY_DEPTH || out.length >= MAX_DISCOVERY_FILES) return true;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (out.length >= MAX_DISCOVERY_FILES) return true;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!UI_IGNORED_DIRS.has(entry.name) && walkJson(path, out, depth + 1)) return true;
      continue;
    }
    if (entry.isFile() && isCandidateDagPath(path)) out.push(path);
  }
  return false;
};

const isoMtime = (path: string): string | null => {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return null;
  }
};

const maxIso = (values: Array<string | null>): string | null => {
  const times = values.filter((value): value is string => value !== null).sort();
  return times[times.length - 1] ?? null;
};

const stateCounts = (
  statePath: string,
): { status: UiDagStatus; completedTasks: number; failedTasks: number; runningTasks: number } | null => {
  if (!existsSync(statePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf-8')) as {
      status?: string;
      tasks?: Record<string, { status?: string }>;
    };
    const tasks = Object.values(parsed.tasks ?? {});
    return {
      status:
        parsed.status === 'running' ||
        parsed.status === 'paused' ||
        parsed.status === 'completed' ||
        parsed.status === 'failed'
          ? parsed.status
          : 'not-started',
      completedTasks: tasks.filter((task) => task.status === 'completed').length,
      failedTasks: tasks.filter((task) => task.status === 'failed').length,
      runningTasks: tasks.filter((task) => task.status === 'in-progress').length,
    };
  } catch {
    return null;
  }
};

export const discoverDags = (projectPath: string): DiscoverDagsResult => {
  const errors: UiError[] = [];
  const candidates: string[] = [];

  try {
    if (walkJson(projectPath, candidates)) {
      errors.push({
        scope: 'project',
        path: projectPath,
        message: 'DAG discovery limit reached; results may be incomplete',
      });
    }
  } catch (err) {
    return {
      projectPath,
      dags: [],
      errors: [{ scope: 'project', path: projectPath, message: toMessage(err) }],
    };
  }

  const dags: UiDagListItem[] = [];
  for (const path of candidates.sort()) {
    const eventLogPath = getEventLogPath(path);
    const statePath = getStatePath(path);
    const base = {
      path,
      relativePath: relative(projectPath, path).split(sep).join('/'),
      eventLogPath,
      statePath,
      updatedAt: maxIso([isoMtime(path), isoMtime(eventLogPath), isoMtime(statePath)]),
    };

    let parsed: unknown;
    try {
      if (statSync(path).size > MAX_JSON_BYTES) continue;
      parsed = JSON.parse(readFileSync(path, 'utf-8'));
    } catch {
      continue;
    }

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed) ||
      !('meta' in parsed) ||
      !('tasks' in parsed) ||
      !('executionLayers' in parsed)
    ) {
      continue;
    }

    try {
      const dag = validateDAG(parsed);
      const counts = stateCounts(statePath);
      dags.push({
        ...base,
        id: dag.meta.id,
        title: dag.meta.source.title,
        status: counts?.status ?? 'not-started',
        totalTasks: dag.tasks.length,
        completedTasks: counts?.completedTasks ?? 0,
        failedTasks: counts?.failedTasks ?? 0,
        runningTasks: counts?.runningTasks ?? 0,
        errors: [],
      });
    } catch {
      // Rejected JSON encountered during broad discovery is unrelated project data.
    }
  }

  return { projectPath, dags, errors };
};
