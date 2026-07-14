import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { discoverDags, UI_IGNORED_DIRS } from '../discovery.js';
import { readInbox } from '../inbox.js';

const MAX_FILES = 500;
const MAX_GUIDANCE_BYTES = 24_000;
const GUIDANCE_FILES = ['AGENTS.md', 'CLAUDE.md', 'README.md'];
const SECRET_NAMES = /(^|[._-])(secret|credentials?|tokens?|api[-_]?keys?)([._-]|$)|^\.env/i;

export interface IntakeProjectContext {
  projectPath: string;
  projectName: string;
  guidance: Array<{ path: string; content: string }>;
  files: string[];
  openTodos: Array<{ id: string; body: string; intakeStatus?: string }>;
  dags: Array<{ path: string; title: string; status: string; runningTasks: number }>;
  git: { isRepository: boolean; clean: boolean; branch: string | null };
  activeSequentialFiles: string[];
}

const walk = (root: string, dir: string, out: string[]): void => {
  if (out.length >= MAX_FILES) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (out.length >= MAX_FILES) return;
    if (entry.isDirectory() && UI_IGNORED_DIRS.has(entry.name)) continue;
    if (SECRET_NAMES.test(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(root, path, out);
    else if (entry.isFile()) out.push(relative(root, path).split(sep).join('/'));
  }
};

const gitContext = (projectPath: string): IntakeProjectContext['git'] => {
  try {
    const branch = execFileSync('git', ['branch', '--show-current'], {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const projectChanges = status.split('\n').filter((line) => line && !line.slice(3).startsWith('.dag-executor/'));
    return { isRepository: true, clean: projectChanges.length === 0, branch: branch || null };
  } catch {
    return { isRepository: false, clean: false, branch: null };
  }
};

export const collectIntakeContext = (
  projectPath: string,
  activeSequentialFiles: string[] = [],
): IntakeProjectContext => {
  const files: string[] = [];
  walk(projectPath, projectPath, files);
  let remainingGuidance = MAX_GUIDANCE_BYTES;
  const guidance = GUIDANCE_FILES.flatMap((name) => {
    const path = join(projectPath, name);
    if (!existsSync(path) || remainingGuidance <= 0) return [];
    const content = readFileSync(path, 'utf-8').slice(0, remainingGuidance);
    remainingGuidance -= Buffer.byteLength(content);
    return [{ path: name, content }];
  });
  const inbox = readInbox(projectPath);
  const dags = discoverDags(projectPath).dags.filter((dag) => dag.status !== 'invalid');
  return {
    projectPath,
    projectName: basename(projectPath),
    guidance,
    files,
    openTodos: inbox.items
      .filter((item) => item.status !== 'archived')
      .map((item) => ({ id: item.id, body: item.body, ...(item.intakeStatus && { intakeStatus: item.intakeStatus }) })),
    dags: dags.map((dag) => ({
      path: dag.relativePath,
      title: dag.title,
      status: dag.status,
      runningTasks: dag.runningTasks,
    })),
    git: gitContext(projectPath),
    activeSequentialFiles,
  };
};
