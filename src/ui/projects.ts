import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import type { UiError, UiProject } from './types.js';

export const DEFAULT_LOOM_ARTIFACTS_DIR = '/Users/nikita/Desktop/repos/dag-executor-artifacts';

const PROJECT_DIRS = ['specs', 'plans', 'decompositions', 'reviews', 'runs', 'risk-register'] as const;
const TARGET_REPO_PATTERN = /^Target repo:\s*`([^`]+)`\s*$/m;

const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  slug: z.string().min(1),
  displayName: z.string().min(1),
  repoPath: z.string().min(1),
  registeredAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

type ProjectManifest = z.infer<typeof manifestSchema>;

export interface ProjectRegistryResult {
  projects: UiProject[];
  errors: UiError[];
}

export interface RegisterProjectOptions {
  displayName?: string;
  now?: () => string;
}

const toMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const canonicalPath = (path: string): string => (existsSync(path) ? realpathSync(path) : resolve(path));

export const resolveArtifactsRoot = (value = process.env.LOOM_ARTIFACTS_DIR): string =>
  resolve(value || DEFAULT_LOOM_ARTIFACTS_DIR);

export const projectDirectory = (artifactsRoot: string, slug: string): string =>
  join(resolve(artifactsRoot), 'projects', slug);

const manifestPath = (artifactsRoot: string, slug: string): string =>
  join(projectDirectory(artifactsRoot, slug), 'project.json');

const atomicWriteJson = (path: string, value: unknown): void => {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let renamed = false;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
    renameSync(temporary, path);
    renamed = true;
  } finally {
    if (!renamed && existsSync(temporary)) unlinkSync(temporary);
  }
};

const toUiProject = (manifest: ProjectManifest, source: UiProject['source']): UiProject => {
  let repoPath = resolve(manifest.repoPath);
  let accessError: string | null = null;
  try {
    if (existsSync(repoPath)) repoPath = realpathSync(repoPath);
  } catch (error) {
    accessError = toMessage(error);
  }
  const available = !accessError && existsSync(repoPath);
  return {
    ...manifest,
    repoPath,
    source,
    available,
    errors: available
      ? []
      : [
          {
            scope: 'project',
            path: repoPath,
            message: accessError
              ? `Registered project repository cannot be accessed: ${accessError}`
              : 'Registered project repository is unavailable',
          },
        ],
  };
};

const legacyProject = (artifactsRoot: string, slug: string): UiProject | null => {
  const readmePath = join(projectDirectory(artifactsRoot, slug), 'README.md');
  if (!existsSync(readmePath)) return null;
  const target = readFileSync(readmePath, 'utf-8').match(TARGET_REPO_PATTERN)?.[1];
  if (!target) return null;
  const timestamp = '1970-01-01T00:00:00.000Z';
  return toUiProject(
    {
      schemaVersion: 1,
      slug,
      displayName: slug,
      repoPath: target,
      registeredAt: timestamp,
      updatedAt: timestamp,
    },
    'legacy-readme',
  );
};

export const listProjects = (artifactsRoot = resolveArtifactsRoot()): ProjectRegistryResult => {
  const root = join(resolve(artifactsRoot), 'projects');
  if (!existsSync(root)) return { projects: [], errors: [] };

  const projects: UiProject[] = [];
  const errors: UiError[] = [];
  const paths = new Map<string, string>();

  for (const entry of readdirSync(root, { withFileTypes: true }).filter((item) => item.isDirectory())) {
    const path = manifestPath(artifactsRoot, entry.name);
    let project: UiProject | null = null;
    if (existsSync(path)) {
      try {
        const manifest = manifestSchema.parse(JSON.parse(readFileSync(path, 'utf-8')));
        if (manifest.slug !== entry.name) throw new Error(`Manifest slug must match directory name "${entry.name}"`);
        project = toUiProject(manifest, 'manifest');
      } catch (error) {
        errors.push({ scope: 'project', path, message: `Invalid project manifest: ${toMessage(error)}` });
      }
    } else {
      try {
        project = legacyProject(artifactsRoot, entry.name);
      } catch (error) {
        errors.push({ scope: 'project', path, message: `Failed to read legacy project: ${toMessage(error)}` });
      }
    }
    if (!project) continue;
    const previousSlug = paths.get(project.repoPath);
    if (previousSlug) {
      errors.push({
        scope: 'project',
        path: project.repoPath,
        message: `Project path is already registered as "${previousSlug}"`,
      });
      continue;
    }
    paths.set(project.repoPath, project.slug);
    projects.push(project);
  }

  projects.sort((a, b) => a.displayName.localeCompare(b.displayName) || a.slug.localeCompare(b.slug));
  return { projects, errors };
};

export const getProject = (artifactsRoot: string, slug: string): UiProject | null =>
  listProjects(artifactsRoot).projects.find((project) => project.slug === slug) ?? null;

export const registerProject = (
  artifactsRoot: string,
  repoPath: string,
  options: RegisterProjectOptions = {},
): UiProject => {
  const canonicalRepoPath = canonicalPath(repoPath);
  if (!existsSync(canonicalRepoPath)) throw new Error(`Project repository does not exist: ${canonicalRepoPath}`);
  const slug = basename(canonicalRepoPath);
  const existingProjects = listProjects(artifactsRoot).projects;
  const samePath = existingProjects.find((project) => project.repoPath === canonicalRepoPath);
  if (samePath && samePath.slug !== slug) throw new Error(`Project path is already registered as "${samePath.slug}"`);
  const sameSlug = existingProjects.find((project) => project.slug === slug);
  if (sameSlug && sameSlug.repoPath !== canonicalRepoPath) {
    throw new Error(`Project slug "${slug}" is already registered to ${sameSlug.repoPath}`);
  }

  const now = options.now?.() ?? new Date().toISOString();
  const currentPath = manifestPath(artifactsRoot, slug);
  let current: ProjectManifest | null = null;
  if (existsSync(currentPath)) current = manifestSchema.parse(JSON.parse(readFileSync(currentPath, 'utf-8')));
  const manifest = manifestSchema.parse({
    schemaVersion: 1,
    slug,
    displayName: options.displayName ?? current?.displayName ?? sameSlug?.displayName ?? slug,
    repoPath: canonicalRepoPath,
    registeredAt: current?.registeredAt ?? (sameSlug?.source === 'manifest' ? sameSlug.registeredAt : now),
    updatedAt: now,
  });

  const directory = projectDirectory(artifactsRoot, slug);
  mkdirSync(directory, { recursive: true });
  for (const child of PROJECT_DIRS) mkdirSync(join(directory, child), { recursive: true });
  atomicWriteJson(currentPath, manifest);
  return toUiProject(manifest, 'manifest');
};
