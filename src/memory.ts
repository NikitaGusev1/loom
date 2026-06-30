import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

export const DEFAULT_PROJECT_MEMORY_PATH = '.dag-executor/memory.md';
export const PROJECT_MEMORY_MAX_CHARS = 6000;

export interface ProjectMemory {
  path: string;
  content: string;
  truncated: boolean;
}

interface LoadProjectMemoryOptions {
  cwd: string;
  path?: string;
  disabled?: boolean;
  maxChars?: number;
}

const resolveMemoryPath = (cwd: string, path: string): string => (isAbsolute(path) ? path : resolve(cwd, path));

const truncateAtLineBoundary = (content: string, maxChars: number): { content: string; truncated: boolean } => {
  if (content.length <= maxChars) return { content, truncated: false };

  const cut = content.slice(0, maxChars);
  const lastNewline = cut.lastIndexOf('\n');
  const bounded = lastNewline > maxChars * 0.75 ? cut.slice(0, lastNewline) : cut;
  return { content: bounded.trimEnd(), truncated: true };
};

export const loadProjectMemory = ({
  cwd,
  path,
  disabled = false,
  maxChars = PROJECT_MEMORY_MAX_CHARS,
}: LoadProjectMemoryOptions): ProjectMemory | null => {
  if (disabled) return null;

  const requestedPath = path ?? DEFAULT_PROJECT_MEMORY_PATH;
  const resolvedPath = resolveMemoryPath(cwd, requestedPath);

  if (!existsSync(resolvedPath)) {
    if (path) throw new Error(`Project memory file not found: ${resolvedPath}`);
    return null;
  }

  const raw = readFileSync(resolvedPath, 'utf-8').trim();
  if (!raw) return null;

  const truncated = truncateAtLineBoundary(raw, maxChars);
  return {
    path: requestedPath,
    content: truncated.content,
    truncated: truncated.truncated,
  };
};

export const describeProjectMemory = (memory: ProjectMemory | null, disabled = false): string | null => {
  if (memory) return `Project memory: loaded ${memory.path}${memory.truncated ? ' (truncated)' : ''}.`;
  if (disabled) return 'Project memory: disabled (--no-memory).';
  return null;
};
