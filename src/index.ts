#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ZodError } from 'zod';
import { validateDAG } from './validation.js';
import { executeDAG } from './executor.js';
import { executeBacklog } from './backlog-executor.js';
import { createLogger } from './logger.js';
import { exec, toErrorMessage } from './exec.js';
import { diffViewFromLog, renderDiffHtml } from './diff-view.js';
import { WEIGHT_MAX_TURNS } from './types.js';
import type { ExecutorConfig, DecompositionDAG, ExecutionState } from './types.js';
import { getEventLogPath, appendEvent } from './events/log.js';
import { DAG_EVENT_SCHEMA_VERSION } from './events/types.js';
import { DEFAULT_SLOT_DIR } from './semaphore.js';
import { MAX_GLOBAL_SLOTS } from './consts.js';
import { scanSlots, renderSlotsStatus } from './slots-status.js';
import { decompositionStatsFromFile } from './decomposition-stats.js';
import { metricsFromFiles, renderMetricsHuman } from './metrics.js';
import { checkSelfHostStaleness } from './self-host-guard.js';
import { analyzeDAGReadiness, formatDAGReadinessReport } from './dag-readiness.js';
import { archiveRun } from './corpus.js';

const log = createLogger();

const MODEL_MAP: Record<string, string> = {
  opus: 'claude-opus-4-8',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5-20251001',
};

const CODEX_DEFAULT_MODEL = 'account-default';
const CODEX_MODEL_MAP: Record<string, string> = {
  codex: CODEX_DEFAULT_MODEL,
  default: CODEX_DEFAULT_MODEL,
  gpt5: 'gpt-5',
  mini: 'gpt-5-mini',
};

const args = process.argv.slice(2);
const positionals = args.filter((a) => !a.startsWith('--'));
const dagPath = positionals[0];
const resume = args.includes('--resume');
const dryRun = args.includes('--dry-run');
const backlog = args.includes('--backlog');
const slotsFlag = args.includes('--slots');
const statsFlag = args.includes('--decomposition-stats');
const metricsFlag = args.includes('--metrics');
const diffViewFlag = args.includes('--diff-view');
const noOpen = args.includes('--no-open');
const humanFlag = args.includes('--human');
const readinessFlag = args.includes('--dag-readiness');
const skipDagReadiness = args.includes('--skip-dag-readiness');
const allowStaleSelfHost = args.includes('--allow-stale-self-host');
const getArgValue = (name: string): string | undefined => args.find((a) => a.startsWith(`${name}=`))?.split('=')[1];
const providerArg = getArgValue('--provider');

const diffHtmlPath = (path: string): string =>
  path.endsWith('.json') ? path.replace(/\.json$/, '.diff.html') : `${path}.diff.html`;

const openInBrowser = async (file: string): Promise<void> => {
  const openers: Array<{ cmd: string; args: string[] }> = [
    { cmd: 'open', args: [file] },
    { cmd: 'xdg-open', args: [file] },
    { cmd: 'cmd', args: ['/c', 'start', '', file] },
  ];
  for (const opener of openers) {
    try {
      await exec(opener.cmd, opener.args);
      return;
    } catch {
      // Try the next platform opener.
    }
  }
  log.info(`Could not launch a browser automatically. Open it manually: ${file}`);
};

const parseCsvArg = (value: string | undefined): string[] =>
  value
    ? value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

const modelArg = getArgValue('--model');
const rerunCsv = getArgValue('--rerun');
const rerunTaskIds = rerunCsv ? parseCsvArg(rerunCsv) : undefined;
const forceWorktreeResetTaskIds = parseCsvArg(getArgValue('--force-worktree-reset'));

// Verification command overrides + disable. Overrides win over auto-detection;
// --no-verify turns both tiers off entirely.
const testCmd = getArgValue('--test-cmd');
const lintCmd = getArgValue('--lint-cmd');
const typecheckCmd = getArgValue('--typecheck-cmd');
const noVerify = args.includes('--no-verify');
const memoryPath = getArgValue('--memory');
const noMemory = args.includes('--no-memory');
const verifyCommands =
  testCmd || lintCmd || typecheckCmd
    ? {
        ...(testCmd && { test: testCmd }),
        ...(lintCmd && { lint: lintCmd }),
        ...(typecheckCmd && { typecheck: typecheckCmd }),
      }
    : undefined;

// --slots: standalone snapshot of the machine-wide slot dir. No DAG arg, so it
// MUST run before the !dagPath guard.
if (slotsFlag) {
  console.log(renderSlotsStatus(scanSlots(DEFAULT_SLOT_DIR, MAX_GLOBAL_SLOTS)));
  process.exit(0);
}

// --decomposition-stats <path>: standalone, schema-aware derivation of the three
// mode-selection inputs. Emits inputs only (never a verdict) so the headless
// mechanical phase computes instead of eyeballing the JSON. Runs before the
// !dagPath guard (the path is its own positional arg). Failure → exit 1, no
// stdout JSON (errors go to stderr).
if (statsFlag) {
  if (!dagPath) {
    log.error('Usage: dag-executor --decomposition-stats <decomposition.json>');
    process.exit(1);
  }
  try {
    console.log(JSON.stringify(decompositionStatsFromFile(resolve(dagPath))));
    process.exit(0);
  } catch (err) {
    log.error(`Failed to read decomposition stats: ${toErrorMessage(err)}`);
    process.exit(1);
  }
}

if (metricsFlag) {
  const logPaths = positionals;
  if (logPaths.length === 0) {
    log.error('Usage: dag-executor --metrics <run.events.jsonl> [more.events.jsonl ...] [--human]');
    process.exit(1);
  }
  try {
    const report = metricsFromFiles(logPaths.map((p) => resolve(p)));
    console.log(humanFlag ? renderMetricsHuman(report) : JSON.stringify(report));
    process.exit(0);
  } catch (err) {
    log.error(`Failed to compute metrics: ${toErrorMessage(err)}`);
    process.exit(1);
  }
}

if (diffViewFlag) {
  if (!dagPath) {
    log.error('Usage: dag-executor --diff-view <decomposition.json> [--no-open]');
    process.exit(1);
  }
  try {
    const resolvedDag = resolve(dagPath);
    const model = await diffViewFromLog(resolvedDag);
    const outPath = diffHtmlPath(resolvedDag);
    writeFileSync(outPath, renderDiffHtml(model), 'utf-8');
    log.success(`Diff view written: ${outPath}`);
    if (noOpen) log.info(`Open it in a browser: ${outPath}`);
    else await openInBrowser(outPath);
    process.exit(0);
  } catch (err) {
    log.error(`Failed to build diff view: ${toErrorMessage(err)}`);
    process.exit(1);
  }
}

// --dag-readiness <path>: standalone, deterministic quality gate for generated
// decompositions. It catches prompt-enforced "/decompose" rules before an
// executor run can spend agent time on over-broad or under-specified tasks.
if (readinessFlag) {
  if (!dagPath) {
    log.error('Usage: dag-executor --dag-readiness <decomposition.json>');
    process.exit(1);
  }
  try {
    const checkedDag = validateDAG(JSON.parse(readFileSync(resolve(dagPath), 'utf-8')));
    const readiness = analyzeDAGReadiness(checkedDag, { cwd: process.cwd() });
    const report = formatDAGReadinessReport(readiness);
    if (readiness.ok) {
      log.success(report);
      process.exit(0);
    }
    log.error(report);
    process.exit(1);
  } catch (err) {
    log.error(`Failed to check DAG readiness: ${toErrorMessage(err)}`);
    process.exit(1);
  }
}

if (!dagPath) {
  log.error(
    [
      'Usage: dag-executor <decomposition.json>',
      '  [--resume] [--dry-run] [--backlog] [--slots] [--decomposition-stats] [--dag-readiness]',
      '  [--metrics <log...> [--human]] [--diff-view <dag> [--no-open]]',
      '  [--provider=codex|claude] [--model=codex|default|gpt5|mini|opus|sonnet|haiku|<model>]',
      '  [--rerun=id1,id2]',
      '  [--force-worktree-reset=id1,id2] [--allow-stale-self-host]',
      '  [--test-cmd=<cmd>] [--lint-cmd=<cmd>] [--typecheck-cmd=<cmd>] [--no-verify]',
      '  [--memory=<path>] [--no-memory] [--skip-dag-readiness]',
    ].join('\n'),
  );
  process.exit(1);
}

const resolveProvider = (arg: string | undefined): ExecutorConfig['provider'] => {
  if (!arg) return 'codex';
  if (arg === 'codex' || arg === 'claude') return arg;
  throw new Error(`Invalid --provider=${arg}. Expected codex or claude.`);
};

let provider: ExecutorConfig['provider'];
try {
  provider = resolveProvider(providerArg);
} catch (err) {
  log.error(toErrorMessage(err));
  process.exit(1);
}

const resolveModels = (
  arg: string | undefined,
  selectedProvider: ExecutorConfig['provider'],
): { defaultModel: string; heavyModel: string } => {
  if (!arg) {
    return selectedProvider === 'codex'
      ? { defaultModel: CODEX_DEFAULT_MODEL, heavyModel: CODEX_DEFAULT_MODEL }
      : { defaultModel: 'claude-sonnet-4-6', heavyModel: 'claude-opus-4-8' };
  }
  const map = selectedProvider === 'codex' ? CODEX_MODEL_MAP : MODEL_MAP;
  const resolved = map[arg] ?? arg;
  return { defaultModel: resolved, heavyModel: resolved };
};

const { defaultModel, heavyModel } = resolveModels(modelArg, provider);

const config: ExecutorConfig = {
  provider,
  executionMode: backlog ? 'backlog' : 'layered',
  defaultModel,
  heavyModel,
  maxTurns: 80,
  permissionMode: 'bypassPermissions',
  dagPath: resolve(dagPath),
  dryRun,
  forceWorktreeResetTaskIds,
  ...(memoryPath && { projectMemoryPath: memoryPath }),
  ...(noMemory && { disableMemory: true }),
  ...(verifyCommands && { verifyCommands }),
  ...(noVerify && { disableVerification: true }),
};

let raw: unknown;
try {
  raw = JSON.parse(readFileSync(config.dagPath, 'utf-8'));
} catch (err) {
  log.error(`Failed to read DAG file: ${config.dagPath}`);
  log.error(toErrorMessage(err));
  process.exit(1);
}

let dag: DecompositionDAG;
try {
  dag = validateDAG(raw);
} catch (err) {
  if (err instanceof ZodError) {
    log.error('DAG validation failed:');
    for (const issue of err.issues) {
      log.error(`  ${issue.path.join('.')}: ${issue.message}`);
    }
  } else {
    log.error(toErrorMessage(err));
  }
  process.exit(1);
}

log.info(`DAG: ${dag.meta.id}`);
log.info(`Tasks: ${dag.tasks.length} across ${dag.executionLayers.length} layers`);

if (!skipDagReadiness) {
  const readiness = analyzeDAGReadiness(dag, { cwd: process.cwd() });
  if (!readiness.ok) {
    log.error(formatDAGReadinessReport(readiness));
    log.error('Fix the decomposition or pass --skip-dag-readiness to bypass this gate.');
    process.exit(1);
  }
  log.success('DAG readiness passed.');
}

if (dryRun) {
  log.info('--- Dry Run ---');
  const taskMap = new Map(dag.tasks.map((t) => [t.id, t]));

  // Per-model cost per 1M tokens (input / output) — approximate
  const MODEL_COSTS: Record<string, { input: number; output: number }> = {
    'claude-opus-4-8': { input: 15, output: 75 },
    'claude-sonnet-4-6': { input: 3, output: 15 },
    'claude-haiku-4-5-20251001': { input: 0.8, output: 4 },
  };

  // Rough token estimates per turn (from observed runs)
  const AVG_INPUT_PER_TURN = 8000;
  const AVG_OUTPUT_PER_TURN = 2000;
  // Typical turn usage is ~40% of max turns
  const TURN_UTILIZATION = 0.4;

  let totalEstMin = 0;
  let totalEstMax = 0;

  for (const layer of dag.executionLayers) {
    log.info(`Layer ${layer.layer}: ${layer.description}`);
    for (const taskId of layer.taskIds) {
      const task = taskMap.get(taskId);
      if (!task) continue;

      const maxTurns = WEIGHT_MAX_TURNS[task.weight] ?? config.maxTurns;
      const taskModel = task.weight === 'heavy' ? heavyModel : defaultModel;
      const costs = MODEL_COSTS[taskModel] ?? MODEL_COSTS['claude-opus-4-8'];
      const estTurns = maxTurns * TURN_UTILIZATION;

      const perPassCost = (input: number, output: number) => (input * costs.input + output * costs.output) / 1_000_000;

      const estInputTokens = estTurns * AVG_INPUT_PER_TURN;
      const estOutputTokens = estTurns * AVG_OUTPUT_PER_TURN;
      const estCost = perPassCost(estInputTokens, estOutputTokens);
      const maxInputTokens = maxTurns * AVG_INPUT_PER_TURN;
      const maxOutputTokens = maxTurns * AVG_OUTPUT_PER_TURN;
      const maxCost = perPassCost(maxInputTokens, maxOutputTokens);

      totalEstMin += estCost;
      totalEstMax += maxCost;

      log.info(`  ${taskId}: ${task.name} [${task.weight}] (${taskModel})`);
      log.info(`    pass: Implement`);
      log.info(`    deps: ${task.dependencies.length > 0 ? task.dependencies.join(', ') : 'none'}`);
      log.info(`    files: ${task.context.files.join(', ')}`);
      log.info(`    est: ~${estTurns.toFixed(0)} turns, $${estCost.toFixed(2)} typical / $${maxCost.toFixed(2)} max`);
    }
  }

  log.info('');
  log.info(`Provider: ${provider}`);
  log.info(`Mode: ${backlog ? 'backlog' : 'layered'}`);
  log.info(`Models: default=${defaultModel}, heavy=${heavyModel}`);
  log.info(`Cost estimate: $${totalEstMin.toFixed(2)} typical — $${totalEstMax.toFixed(2)} max`);
  log.info('(Based on avg 8K input + 2K output per turn, 40% turn utilization)');
  process.exit(0);
}

// Self-host staleness guard: refuse to run a stale linked binary against its own
// repo (the running build/ would be the pre-change code — silent work-drop).
const staleness = await checkSelfHostStaleness(process.cwd(), import.meta.url);
if (staleness.stale) {
  if (allowStaleSelfHost) {
    log.warn(`Self-host staleness (${staleness.reason}) — proceeding due to --allow-stale-self-host.`);
  } else {
    log.error(`Self-host staleness guard tripped: ${staleness.reason}.`);
    log.error('The running dag-executor binary is stale relative to its own source.');
    log.error('Run `npm run build`, then re-run — or pass --allow-stale-self-host to override.');
    process.exit(1);
  }
}

// Cooperative SIGINT handler via AbortController
const abortController = new AbortController();
process.on('SIGINT', () => {
  if (abortController.signal.aborted) {
    appendEvent(getEventLogPath(config.dagPath), {
      kind: 'dag.aborted',
      schemaVersion: DAG_EVENT_SCHEMA_VERSION,
      ts: new Date().toISOString(),
      dagPath: config.dagPath,
      dagId: dag.meta.id,
      reason: 'SIGINT (force)',
      signal: 'SIGINT',
    });
    process.exit(1);
  }
  abortController.abort();
  log.warn('Interrupted. Waiting for current layer to finish...');
  log.warn('Press Ctrl+C again to force exit.');
});

let finalState: ExecutionState;
try {
  finalState = backlog
    ? await executeBacklog({ dag, config, signal: abortController.signal, resume, rerunTaskIds })
    : await executeDAG({ dag, config, signal: abortController.signal, resume, rerunTaskIds });
} catch (err) {
  log.error(`Unexpected error: ${toErrorMessage(err)}`);
  process.exit(1);
}

try {
  const archive = archiveRun(config.dagPath, {
    disabled: process.env.DAG_EXECUTOR_NO_CORPUS === '1',
    ...(process.env.DAG_EXECUTOR_CORPUS_DIR && { corpusDir: process.env.DAG_EXECUTOR_CORPUS_DIR }),
  });
  if (archive.archived) log.info(`Run banked to corpus: ${archive.destLog}`);
} catch (err) {
  log.warn(`Corpus archive skipped: ${toErrorMessage(err)}`);
}

if (finalState.status === 'completed') {
  log.success('DAG execution completed successfully');
  process.exit(0);
} else if (finalState.status === 'paused') {
  log.warn('DAG execution paused. Resume with --resume');
  process.exit(2);
} else {
  log.error(`DAG execution ended with status: ${finalState.status}`);
  process.exit(1);
}
