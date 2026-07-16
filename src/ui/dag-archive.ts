import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { UiDagListItem, UiDagView, UiError } from './types.js';
import { projectDirectory } from './projects.js';

const archiveSchema = z.object({
  schemaVersion: z.literal(1),
  items: z.array(
    z.object({
      relativePath: z.string().min(1),
      archivedAt: z.string().min(1),
    }),
  ),
});

export type DagArchiveFile = z.infer<typeof archiveSchema>;

export class DagArchiveConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DagArchiveConflictError';
  }
}

export interface ClassifiedDags {
  active: UiDagListItem[];
  history: UiDagListItem[];
  archived: UiDagListItem[];
  errors: UiError[];
}

const updateQueues = new Map<string, Promise<void>>();

export const getDagArchivePath = (artifactsRoot: string, slug: string): string =>
  join(projectDirectory(artifactsRoot, slug), 'runs', 'ui-dag-archive.json');

export const readDagArchive = (artifactsRoot: string, slug: string): DagArchiveFile => {
  const path = getDagArchivePath(artifactsRoot, slug);
  if (!existsSync(path)) return { schemaVersion: 1, items: [] };
  return archiveSchema.parse(JSON.parse(readFileSync(path, 'utf-8')));
};

const writeDagArchive = (path: string, value: DagArchiveFile): void => {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const sorted = {
    schemaVersion: 1 as const,
    items: [...value.items].sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
  };
  let renamed = false;
  try {
    writeFileSync(temporary, `${JSON.stringify(sorted, null, 2)}\n`, 'utf-8');
    renameSync(temporary, path);
    renamed = true;
  } finally {
    if (!renamed && existsSync(temporary)) unlinkSync(temporary);
  }
};

const serializeUpdate = async <T>(path: string, update: () => T): Promise<T> => {
  const previous = updateQueues.get(path) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  updateQueues.set(path, queued);
  await previous;
  try {
    return update();
  } finally {
    release();
    if (updateQueues.get(path) === queued) updateQueues.delete(path);
  }
};

export const archiveDag = async (
  artifactsRoot: string,
  slug: string,
  dag: UiDagListItem,
  now: () => string = () => new Date().toISOString(),
): Promise<DagArchiveFile> => {
  if (dag.status !== 'completed') {
    throw new DagArchiveConflictError(`Only completed DAGs can be archived; "${dag.relativePath}" is ${dag.status}`);
  }
  const path = getDagArchivePath(artifactsRoot, slug);
  return serializeUpdate(path, () => {
    const file = readDagArchive(artifactsRoot, slug);
    if (file.items.some((item) => item.relativePath === dag.relativePath)) return file;
    const next = {
      schemaVersion: 1 as const,
      items: [...file.items, { relativePath: dag.relativePath, archivedAt: now() }],
    };
    writeDagArchive(path, next);
    return readDagArchive(artifactsRoot, slug);
  });
};

export const restoreDag = async (
  artifactsRoot: string,
  slug: string,
  relativePath: string,
): Promise<DagArchiveFile> => {
  const path = getDagArchivePath(artifactsRoot, slug);
  return serializeUpdate(path, () => {
    const file = readDagArchive(artifactsRoot, slug);
    const items = file.items.filter((item) => item.relativePath !== relativePath);
    if (items.length === file.items.length) return file;
    writeDagArchive(path, { schemaVersion: 1, items });
    return readDagArchive(artifactsRoot, slug);
  });
};

export const classifyDags = (dags: UiDagListItem[], archive: DagArchiveFile): ClassifiedDags => {
  const archivedPaths = new Set(archive.items.map((item) => item.relativePath));
  const active: UiDagListItem[] = [];
  const history: UiDagListItem[] = [];
  const archived: UiDagListItem[] = [];
  for (const dag of dags) {
    if (dag.status !== 'completed') active.push(dag);
    else if (archivedPaths.has(dag.relativePath)) archived.push(dag);
    else history.push(dag);
  }
  const discovered = new Set(dags.map((dag) => dag.relativePath));
  const errors = archive.items.flatMap((item): UiError[] =>
    discovered.has(item.relativePath)
      ? []
      : [
          {
            scope: 'dag',
            path: item.relativePath,
            message: 'Archived DAG metadata refers to a DAG that is no longer discoverable',
          },
        ],
  );
  return { active, history, archived, errors };
};

export const dagsForView = (classified: ClassifiedDags, view: UiDagView): UiDagListItem[] => classified[view];
