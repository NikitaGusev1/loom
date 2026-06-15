// Verification runner — spawns the resolved commands and shapes results.
//
// Safety rules (spec AC #10): a missing tool (spawn ENOENT) or a
// node_modules-less cwd (the worktree case) is SKIPPED, never failed — we never
// block a merge on tooling we couldn't run. Only a real non-zero exit (or a
// timeout) is a `fail`.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DAGTask } from '../types.js';
import type { Logger } from '../logger.js';
import { NODE_HEAP_ENV, WEIGHT_VERIFICATION_TIMEOUT_MS } from '../consts.js';
import type { ResolvedCommands, VerifyCommand, VerifyKind } from './detect.js';

const OUTPUT_CAP = 4_000; // chars of combined stdout+stderr kept for the fix re-invoke

export interface VerifyResult {
  kind: VerifyKind;
  status: 'pass' | 'fail' | 'skipped';
  /** Combined stdout+stderr (tail-truncated) on fail; skip reason on skip. */
  output: string;
}

export interface VerificationOutcome {
  /** True iff no check ended in `fail` (skipped checks do not break ok). */
  ok: boolean;
  results: VerifyResult[];
}

interface RunVerificationArgs {
  commands: ResolvedCommands;
  changedFiles: string[];
  cwd: string;
  weight: DAGTask['weight'];
  signal?: AbortSignal;
  log?: Logger;
}

const tail = (s: string): string => (s.length > OUTPUT_CAP ? `…${s.slice(s.length - OUTPUT_CAP)}` : s);

// Extensions a JS/TS lint/test runner can take as a file target. When scoping to
// changed files we drop everything else (README.md, package.json, lockfiles,
// images): passing those to eslint as explicit targets errors ("No files matching")
// and false-fails the gate on a task whose code was fine.
const SCOPABLE_FILE = /\.(?:[cm]?[jt]sx?|vue|svelte)$/i;

// Build the final execFile argv for a resolved command + changed files.
const buildArgs = (cmd: VerifyCommand, changedFiles: string[]): string[] => {
  const extra = [...cmd.baseExtra];
  if (cmd.scopeFiles) {
    const scoped = changedFiles.filter((f) => SCOPABLE_FILE.test(f));
    if (scoped.length > 0) extra.push(...cmd.fileFlag, ...scoped);
  }
  const forwarded = extra.length > 0 && cmd.needsSeparator ? ['--', ...extra] : extra;
  return [...cmd.argv.slice(1), ...forwarded];
};

interface SpawnOutcome {
  status: 'pass' | 'fail' | 'skipped';
  output: string;
}

const runOne = (
  cmd: VerifyCommand,
  changedFiles: string[],
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<SpawnOutcome> =>
  new Promise((resolve) => {
    // A node_modules-requiring command in a cwd without node_modules (fresh
    // worktree) would false-fail — skip it. Tier-2 on merged main has deps.
    if (cmd.requiresNodeModules && !existsSync(join(cwd, 'node_modules'))) {
      resolve({ status: 'skipped', output: 'node_modules absent in cwd — skipped (will run post-merge)' });
      return;
    }

    const args = buildArgs(cmd, changedFiles);
    // Preserve the target repo's NODE_OPTIONS (e.g. jest ESM's --experimental-vm-modules)
    // rather than clobbering it — our heap cap goes first so a repo that sets its own
    // --max-old-space-size still wins (Node applies NODE_OPTIONS left-to-right).
    const nodeOptions = [NODE_HEAP_ENV.NODE_OPTIONS, process.env.NODE_OPTIONS].filter(Boolean).join(' ');
    execFile(
      cmd.argv[0],
      args,
      {
        cwd,
        timeout: timeoutMs,
        env: { ...process.env, NODE_OPTIONS: nodeOptions },
        maxBuffer: 16 * 1024 * 1024,
        ...(signal && { signal }),
      },
      (err, stdout, stderr) => {
        const combined = tail(`${stdout ?? ''}${stderr ?? ''}`);
        if (!err) {
          resolve({ status: 'pass', output: '' });
          return;
        }
        const code = (err as NodeJS.ErrnoException).code;
        // Spawn failure (binary not found / not executable) → skip, never fail.
        if (code === 'ENOENT' || code === 'EACCES') {
          resolve({ status: 'skipped', output: `tool not found (${code}) — skipped` });
          return;
        }
        // AbortSignal cancellation (SIGINT teardown) → skip, not a verification failure.
        // The signal is the top-level abort, so this only fires when the run is being
        // torn down; emitting a permanent task.verification-failed here would be wrong.
        if (code === 'ABORT_ERR') {
          resolve({ status: 'skipped', output: 'aborted — skipped' });
          return;
        }
        const killed = (err as { killed?: boolean }).killed;
        let reason: string;
        if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') reason = `output exceeded buffer limit (16MB)\n${combined}`;
        else if (killed) reason = `timed out after ${timeoutMs}ms\n${combined}`;
        else reason = combined;
        resolve({ status: 'fail', output: reason });
      },
    );
  });

/**
 * Run every resolved check against the changed files in `cwd`. Order is
 * typecheck → lint → test (cheapest signal first); all run regardless of earlier
 * outcomes so a single pass surfaces every failure for the fix re-invoke.
 */
export const runVerification = async ({
  commands,
  changedFiles,
  cwd,
  weight,
  signal,
  log,
}: RunVerificationArgs): Promise<VerificationOutcome> => {
  const timeoutMs = WEIGHT_VERIFICATION_TIMEOUT_MS[weight];
  const results: VerifyResult[] = [];

  for (const kind of ['typecheck', 'lint', 'test'] as const) {
    const cmd = commands[kind];
    if (!cmd) {
      log?.warn(`Verification: no ${kind} command resolved — skipped.`);
      results.push({ kind, status: 'skipped', output: 'no command resolved' });
      continue;
    }
    const { status, output } = await runOne(cmd, changedFiles, cwd, timeoutMs, signal);
    if (status === 'skipped') log?.warn(`Verification: ${kind} skipped — ${output}`);
    if (status === 'fail') log?.error(`Verification: ${kind} FAILED`);
    results.push({ kind, status, output });
  }

  return { ok: results.every((r) => r.status !== 'fail'), results };
};

/** Render failing-check output for feeding back into a fix re-invoke prompt. */
export const formatFailures = (outcome: VerificationOutcome): string =>
  outcome.results
    .filter((r) => r.status === 'fail')
    .map((r) => `### ${r.kind} failed\n\n\`\`\`\n${r.output}\n\`\`\``)
    .join('\n\n');

// The first failing check's kind (for a failure event's verificationKind).
// Only ever called on a failing outcome (every caller guards on !ok), so a
// fail is always present; the `?? 'test'` is a defensive fallback that is
// never reached on the live path.
export const firstFailedKind = (results: VerifyResult[]): VerifyKind =>
  results.find((r) => r.status === 'fail')?.kind ?? 'test';
