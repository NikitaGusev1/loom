// Verification command resolution — pure, no spawning.
//
// Resolves the target repo's own test / lint / typecheck commands from its
// package manager + package.json scripts. The cardinal rule (spec AC #8, #10):
// NEVER default to yarn, and NEVER fabricate a command. A check we cannot
// resolve is `undefined` (= absent) and the runner skips it rather than
// false-failing. CLI/config overrides always win.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type VerifyKind = 'test' | 'lint' | 'typecheck';

/**
 * A resolved verification command, shaped for execFile in run.ts.
 *
 * Final spawn argv = `argv[0]` + `argv[1..]` + (separator?) + baseExtra +
 * (scopeFiles && files.length ? fileFlag + files : []).
 */
export interface VerifyCommand {
  /** Program + fixed leading args, e.g. ['npm','run','test'] or ['/abs/.bin/tsc','--noEmit']. */
  argv: string[];
  /** Always appended (run-once / CI flags), e.g. jest ['--ci','--passWithNoTests'], vitest ['run']. */
  baseExtra: string[];
  /** Runner flag preceding the file list; only used when scopeFiles && files present. */
  fileFlag: string[];
  /** Whether changed files are appended to scope the check. typecheck = false (whole program). */
  scopeFiles: boolean;
  /** Insert a `--` package-manager argument separator before baseExtra/fileFlag/files. npm/pnpm/bun: true; yarn + direct-bin + raw override: false. */
  needsSeparator: boolean;
  /** Whether the command needs an installed toolchain (node_modules). pm/script/tsc-bin: true; raw override: false. The runner skips (never fails) a node_modules-requiring command in a cwd that has none — the worktree case. */
  requiresNodeModules: boolean;
}

export type ResolvedCommands = Partial<Record<VerifyKind, VerifyCommand>>;

export interface VerifyOverrides {
  test?: string;
  lint?: string;
  typecheck?: string;
}

type PackageManager = 'yarn' | 'pnpm' | 'npm' | 'bun';

// Script-name aliases per kind, in preference order.
const SCRIPT_ALIASES: Record<VerifyKind, string[]> = {
  test: ['test'],
  lint: ['lint'],
  typecheck: ['typecheck', 'type-check', 'lint:types', 'lintTypes', 'tsc'],
};

const detectPackageManager = (cwd: string, pkg: Record<string, unknown> | undefined): PackageManager => {
  const declared = typeof pkg?.packageManager === 'string' ? pkg.packageManager : '';
  if (declared.startsWith('yarn')) return 'yarn';
  if (declared.startsWith('pnpm')) return 'pnpm';
  if (declared.startsWith('bun')) return 'bun';
  if (declared.startsWith('npm')) return 'npm';
  if (existsSync(join(cwd, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(cwd, 'bun.lockb'))) return 'bun';
  // package-lock.json OR no lockfile at all → npm (the safe, non-yarn default).
  return 'npm';
};

// `<pm> run <script>` invocation. `needsSeparator` captures whether forwarded
// args require a `--` separator (npm/pnpm/bun do; yarn forwards directly).
const pmRun = (pm: PackageManager, script: string): { argv: string[]; needsSeparator: boolean } => {
  switch (pm) {
    case 'yarn':
      return { argv: ['yarn', script], needsSeparator: false };
    case 'pnpm':
      return { argv: ['pnpm', 'run', script], needsSeparator: true };
    case 'bun':
      return { argv: ['bun', 'run', script], needsSeparator: true };
    case 'npm':
      return { argv: ['npm', 'run', script], needsSeparator: true };
  }
};

// Recognize the underlying runner from a script's command string so we can scope
// to changed files + force a single non-watch run. Unknown runner → run whole.
const scopingFor = (
  kind: VerifyKind,
  scriptBody: string,
): Pick<VerifyCommand, 'baseExtra' | 'fileFlag' | 'scopeFiles'> => {
  const body = scriptBody.toLowerCase();
  if (kind === 'test') {
    if (/\bjest\b/.test(body))
      return { baseExtra: ['--ci', '--passWithNoTests'], fileFlag: ['--findRelatedTests'], scopeFiles: true };
    // vitest: force a single non-watch run, but DON'T scope. vitest's related-tests
    // is a leading subcommand (`vitest related <files> --run`), not a trailing flag —
    // appending it after `run` makes it a name filter and a no-match exits 0 (false
    // pass). Whole-suite is the safe choice until the subcommand form is wired up.
    if (/\bvitest\b/.test(body)) return { baseExtra: ['run'], fileFlag: [], scopeFiles: false };
    return { baseExtra: [], fileFlag: [], scopeFiles: false };
  }
  if (kind === 'lint') {
    if (/\beslint\b/.test(body)) return { baseExtra: [], fileFlag: [], scopeFiles: true };
    return { baseExtra: [], fileFlag: [], scopeFiles: false };
  }
  // typecheck: always whole-program (tsc has no meaningful per-file mode here).
  return { baseExtra: [], fileFlag: [], scopeFiles: false };
};

// Whitespace-split a raw override string into argv. No shell quoting — overrides
// are expected to be simple ("npm test", "pnpm lint"). Documented in README.
const splitOverride = (raw: string): string[] => raw.trim().split(/\s+/).filter(Boolean);

const findScript = (kind: VerifyKind, scripts: Record<string, string>): { name: string; body: string } | undefined => {
  for (const name of SCRIPT_ALIASES[kind]) {
    if (typeof scripts[name] === 'string') return { name, body: scripts[name] };
  }
  return undefined;
};

/**
 * Resolve the verification commands for a repo rooted at `cwd`.
 *
 * @param cwd       Repo root (where package.json + lockfile live).
 * @param overrides CLI/config overrides — always win over detection.
 * @param disable   `--no-verify` — returns {} (all checks skipped).
 */
export const resolveVerifyCommands = (
  cwd: string,
  overrides: VerifyOverrides = {},
  disable = false,
): ResolvedCommands => {
  if (disable) return {};

  let pkg: Record<string, unknown> | undefined;
  try {
    pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf-8'));
  } catch {
    pkg = undefined;
  }
  const scripts: Record<string, string> =
    pkg && typeof pkg.scripts === 'object' && pkg.scripts ? (pkg.scripts as Record<string, string>) : {};
  const pm = detectPackageManager(cwd, pkg);

  const out: ResolvedCommands = {};

  for (const kind of ['test', 'lint', 'typecheck'] as const) {
    const override = overrides[kind];
    if (override) {
      // Raw override: run exactly as given, no scoping, no separator. The
      // override owns its own flags + file handling.
      out[kind] = {
        argv: splitOverride(override),
        baseExtra: [],
        fileFlag: [],
        scopeFiles: false,
        needsSeparator: false,
        requiresNodeModules: false,
      };
      continue;
    }

    const script = findScript(kind, scripts);
    if (script) {
      const { argv, needsSeparator } = pmRun(pm, script.name);
      out[kind] = {
        argv,
        needsSeparator,
        requiresNodeModules: true,
        ...scopingFor(kind, script.body),
      };
      continue;
    }

    // typecheck fallback: a local tsc binary + a tsconfig, no script needed.
    if (kind === 'typecheck' && existsSync(join(cwd, 'tsconfig.json'))) {
      const tscBin = join(cwd, 'node_modules', '.bin', 'tsc');
      if (existsSync(tscBin)) {
        out.typecheck = {
          argv: [tscBin, '--noEmit'],
          baseExtra: [],
          fileFlag: [],
          scopeFiles: false,
          needsSeparator: false,
          requiresNodeModules: true,
        };
      }
    }
    // Otherwise: leave undefined (absent → skipped, never faked).
  }

  return out;
};
