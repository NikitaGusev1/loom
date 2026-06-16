#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_MAX_WALLCLOCK_SEC = 24 * 60 * 60;
const DEFAULT_MAX_ATTEMPTS = 100;
const DEFAULT_CRASH_DELAY_SEC = 60;
const DEFAULT_CRASH_DELAY_MAX_SEC = 15 * 60;
const DEFAULT_QUOTA_DELAY_SEC = 30 * 60;

function usage() {
  console.error(`Usage:
  loom-supervisor <dag.json> [dag-executor flags...]
  loom-supervisor --detach <dag.json> [dag-executor flags...]
  loom-supervisor --stop <dag.json>
  loom-day-run <dag.json> [dag-executor flags...]

Runs dag-executor in backlog mode and supervises the run.

Day-run behavior:
  - loom-day-run is shorthand for loom-supervisor --detach
  - --detach starts the supervisor in the background
  - --force-detach ignores a stale-looking active checkpoint
  - --foreground disables loom-day-run's implicit --detach
  - --stop sends SIGTERM to the PID in the checkpoint
  - on macOS, detached runs use caffeinate when available

Default behavior:
  - exit 0 from dag-executor: mark completed and exit 0
  - exit 2 with quota/usage pause: wait, then resume
  - exit 2 with ordinary pause: mark paused and exit 2
  - other non-zero exit: wait, then restart with --resume

Environment:
  DAG_EXECUTOR_BIN                  default: dag-executor
  LOOM_SUPERVISOR_CHECKPOINT        default: <dag>.supervisor.json
  LOOM_SUPERVISOR_LOG_DIR           default: <dag-dir>/.loom-supervisor/logs
  LOOM_SUPERVISOR_DETACH_LOG        default: <dag-dir>/.loom-supervisor/supervisor.log
  LOOM_SUPERVISOR_MAX_WALLCLOCK_SEC default: 86400
  LOOM_SUPERVISOR_MAX_ATTEMPTS      default: 100
  LOOM_SUPERVISOR_CRASH_DELAY_SEC   default: 60
  LOOM_SUPERVISOR_CRASH_DELAY_MAX_SEC default: 900
  LOOM_SUPERVISOR_QUOTA_DELAY_SEC   default: 1800`);
}

function envInt(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms, signalState) {
  return new Promise((resolve) => {
    if (ms <= 0 || signalState.stopping) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signalState.cancelSleep = () => {
      clearTimeout(timer);
      resolve();
    };
  }).finally(() => {
    signalState.cancelSleep = undefined;
  });
}

function statePathFor(dagPath) {
  return dagPath.replace(/\.json$/, '.state.json');
}

function readJson(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    return null;
  }
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function writeAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now().toString(36)}`,
  );
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendStatus(checkpointPath, patch) {
  const current = readJson(checkpointPath) || {};
  const next = { ...current, ...patch, lastUpdated: nowIso() };
  writeAtomic(checkpointPath, next);
  return next;
}

function latestPauseReason(dagPath) {
  const state = readJson(statePathFor(dagPath));
  if (!state || state.status !== 'paused') return '';
  return typeof state.reason === 'string' ? state.reason : '';
}

function isQuotaPause(reason) {
  return /\b(quota|usage\s+limit|token\s+limit|daily\s+limit|weekly\s+limit|monthly\s+limit|credits?\b)/i.test(
    reason || '',
  );
}

function formatSeconds(sec) {
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  return `${Math.round(min / 60)}h`;
}

function makeRunId() {
  return `loom-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, 'Z')}-${process.pid}`;
}

function parseArgs(argv) {
  const flags = {
    detach: false,
    forceDetach: false,
    foreground: false,
    stop: false,
    help: false,
  };
  const rest = [];

  for (const arg of argv) {
    if (arg === '--detach') flags.detach = true;
    else if (arg === '--force-detach') flags.forceDetach = true;
    else if (arg === '--foreground') flags.foreground = true;
    else if (arg === '--stop') flags.stop = true;
    else if (arg === '-h' || arg === '--help') flags.help = true;
    else rest.push(arg);
  }

  return { flags, dagArg: rest[0], userArgs: rest.slice(1) };
}

function resolvePaths(dagPath) {
  const logDir = path.resolve(
    process.env.LOOM_SUPERVISOR_LOG_DIR || path.join(path.dirname(dagPath), '.loom-supervisor', 'logs'),
  );
  return {
    checkpointPath: path.resolve(
      process.env.LOOM_SUPERVISOR_CHECKPOINT || dagPath.replace(/\.json$/, '.supervisor.json'),
    ),
    logDir,
    detachLogPath: path.resolve(
      process.env.LOOM_SUPERVISOR_DETACH_LOG || path.join(path.dirname(logDir), 'supervisor.log'),
    ),
  };
}

function activeSupervisorPid(checkpoint) {
  const supervisorPid = Number(checkpoint?.supervisorPid);
  if (Number.isInteger(supervisorPid) && supervisorPid > 0) return supervisorPid;
  const detachedPid = Number(checkpoint?.detachedPid);
  if (Number.isInteger(detachedPid) && detachedPid > 0) return detachedPid;
  return undefined;
}

function checkpointLooksActive(checkpoint) {
  if (!checkpoint || typeof checkpoint !== 'object') return false;
  if (!['running', 'waiting', 'starting', 'stopping'].includes(checkpoint.status)) return false;
  const pid = activeSupervisorPid(checkpoint);
  return pid !== undefined && isPidAlive(pid);
}

function caffeinateCommand() {
  if (process.platform !== 'darwin') return null;
  const command = '/usr/bin/caffeinate';
  return fs.existsSync(command) ? command : null;
}

function stopSupervisor({ dagPath, checkpointPath }) {
  const checkpoint = readJson(checkpointPath);
  if (!checkpoint) {
    console.error(`[loom-supervisor] checkpoint not found: ${checkpointPath}`);
    return 1;
  }

  const pid = activeSupervisorPid(checkpoint);
  if (!pid || !isPidAlive(pid)) {
    appendStatus(checkpointPath, {
      status: 'stopped',
      reason: 'supervisor PID is not running',
      nextAction: `resume with loom-supervisor ${dagPath}`,
    });
    console.error(`[loom-supervisor] no running supervisor PID in ${checkpointPath}`);
    return 3;
  }

  appendStatus(checkpointPath, {
    status: 'stopping',
    reason: `stop requested for pid ${pid}`,
  });
  process.kill(pid, 'SIGTERM');
  console.error(`[loom-supervisor] sent SIGTERM to pid ${pid}`);
  return 0;
}

function detachSupervisor({ dagPath, userArgs, checkpointPath, logDir, detachLogPath, forceDetach }) {
  const existing = readJson(checkpointPath);
  if (!forceDetach && checkpointLooksActive(existing)) {
    const pid = activeSupervisorPid(existing);
    console.error(`[loom-supervisor] supervisor already running for this DAG (pid ${pid})`);
    console.error(`[loom-supervisor] checkpoint=${checkpointPath}`);
    console.error('[loom-supervisor] use --force-detach only after verifying the old run is stale');
    return 4;
  }

  fs.mkdirSync(path.dirname(detachLogPath), { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });

  const nodeArgs = [__filename, dagPath, ...userArgs];
  const caffeinate = caffeinateCommand();
  const command = caffeinate || process.execPath;
  const args = caffeinate ? ['-dimsu', process.execPath, ...nodeArgs] : nodeArgs;
  const fd = fs.openSync(detachLogPath, 'a');

  let child;
  try {
    child = spawn(command, args, {
      detached: true,
      stdio: ['ignore', fd, fd],
      env: process.env,
    });
  } finally {
    fs.closeSync(fd);
  }

  child.unref();
  appendStatus(checkpointPath, {
    runId: existing?.runId || makeRunId(),
    dagPath,
    status: 'starting',
    detached: true,
    detachedPid: child.pid,
    supervisorPid: child.pid,
    detachCommand: caffeinate ? `${caffeinate} -dimsu node` : process.execPath,
    detachLogPath,
    logDir,
    nextAction: `stop with loom-supervisor --stop ${dagPath}`,
  });

  console.error(`[loom-supervisor] detached pid=${child.pid}`);
  console.error(`[loom-supervisor] checkpoint=${checkpointPath}`);
  console.error(`[loom-supervisor] supervisorLog=${detachLogPath}`);
  console.error(`[loom-supervisor] attemptLogs=${logDir}`);
  console.error(`[loom-supervisor] stop: loom-supervisor --stop ${dagPath}`);
  return 0;
}

async function runOnce({ dagPath, userArgs, attempt, logDir, resume, signalState }) {
  fs.mkdirSync(logDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, 'Z');
  const logPath = path.join(logDir, `loom-${timestamp}-attempt${attempt}.log`);
  const out = fs.createWriteStream(logPath, { flags: 'a' });

  const bin = process.env.DAG_EXECUTOR_BIN || 'dag-executor';
  const args = [dagPath, ...userArgs];
  if (!args.includes('--backlog')) args.push('--backlog');
  if (resume && !args.includes('--resume')) args.push('--resume');

  console.error(`[loom-supervisor] attempt=${attempt} ${bin} ${args.join(' ')}`);
  console.error(`[loom-supervisor] log=${logPath}`);

  return await new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    signalState.child = child;

    child.stdout.pipe(out);
    child.stderr.pipe(out);

    child.on('error', (err) => {
      out.write(`\n[loom-supervisor] failed to spawn ${bin}: ${err.message}\n`);
      out.end();
      signalState.child = undefined;
      resolve({ code: 127, signal: null, logPath });
    });

    child.on('exit', (code, signal) => {
      out.write(`\n[loom-supervisor] child exit code=${code ?? ''} signal=${signal ?? ''}\n`);
      out.end();
      signalState.child = undefined;
      resolve({ code: code ?? 1, signal, logPath });
    });
  });
}

async function main(argv) {
  const invokedAs = path.basename(process.argv[1] || '');
  const parsed = parseArgs(argv);
  const { flags, dagArg, userArgs } = parsed;
  if (flags.help) {
    usage();
    return 0;
  }
  if (!dagArg) {
    usage();
    return 1;
  }

  const dagPath = path.resolve(dagArg);
  if (!fs.existsSync(dagPath)) {
    console.error(`[loom-supervisor] DAG not found: ${dagPath}`);
    return 1;
  }

  const { checkpointPath, logDir, detachLogPath } = resolvePaths(dagPath);
  if (flags.stop) return stopSupervisor({ dagPath, checkpointPath });

  const defaultDetach = invokedAs === 'loom-day-run' && !flags.foreground;
  if (flags.detach || defaultDetach) {
    return detachSupervisor({
      dagPath,
      userArgs,
      checkpointPath,
      logDir,
      detachLogPath,
      forceDetach: flags.forceDetach,
    });
  }

  const maxWallclockSec = envInt('LOOM_SUPERVISOR_MAX_WALLCLOCK_SEC', DEFAULT_MAX_WALLCLOCK_SEC);
  const maxAttempts = envInt('LOOM_SUPERVISOR_MAX_ATTEMPTS', DEFAULT_MAX_ATTEMPTS);
  const crashDelaySec = envInt('LOOM_SUPERVISOR_CRASH_DELAY_SEC', DEFAULT_CRASH_DELAY_SEC);
  const crashDelayMaxSec = envInt('LOOM_SUPERVISOR_CRASH_DELAY_MAX_SEC', DEFAULT_CRASH_DELAY_MAX_SEC);
  const quotaDelaySec = envInt('LOOM_SUPERVISOR_QUOTA_DELAY_SEC', DEFAULT_QUOTA_DELAY_SEC);
  const startedAt = Date.now();
  const existing = readJson(checkpointPath);
  const runId = existing && existing.runId ? existing.runId : makeRunId();
  const signalState = { stopping: false, child: undefined, cancelSleep: undefined };

  const stop = (signal) => {
    signalState.stopping = true;
    appendStatus(checkpointPath, { status: 'stopping', signal });
    if (signalState.child) signalState.child.kill(signal);
    if (signalState.cancelSleep) signalState.cancelSleep();
  };

  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  appendStatus(checkpointPath, {
    runId,
    dagPath,
    status: 'running',
    startedAt: existing?.startedAt || nowIso(),
    supervisorPid: process.pid,
    attempts: existing?.attempts || 0,
    crashes: existing?.crashes || 0,
    pauses: existing?.pauses || 0,
    maxWallclockSec,
    maxAttempts,
  });

  let attempt = existing?.attempts || 0;
  let resume = fs.existsSync(dagPath.replace(/\.json$/, '.events.jsonl')) || userArgs.includes('--resume');

  while (!signalState.stopping) {
    const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
    if (elapsedSec >= maxWallclockSec) {
      appendStatus(checkpointPath, {
        status: 'stopped',
        reason: `max wall-clock ${maxWallclockSec}s exceeded`,
        nextAction: 'resume manually or increase LOOM_SUPERVISOR_MAX_WALLCLOCK_SEC',
      });
      return 3;
    }
    if (attempt >= maxAttempts) {
      appendStatus(checkpointPath, {
        status: 'stopped',
        reason: `max attempts ${maxAttempts} exceeded`,
        nextAction: 'inspect lastLogPath and resume manually',
      });
      return 3;
    }

    attempt += 1;
    appendStatus(checkpointPath, {
      status: 'running',
      attempts: attempt,
      lastStartedAt: nowIso(),
      nextAction: 'waiting for dag-executor',
    });

    const result = await runOnce({ dagPath, userArgs, attempt, logDir, resume, signalState });
    appendStatus(checkpointPath, {
      lastExitCode: result.code,
      lastSignal: result.signal,
      lastLogPath: result.logPath,
    });

    if (signalState.stopping) {
      appendStatus(checkpointPath, {
        status: 'aborted',
        reason: `supervisor received ${result.signal || 'stop signal'}`,
        nextAction: `resume with loom-supervisor ${dagPath}`,
      });
      return 130;
    }

    if (result.code === 0) {
      appendStatus(checkpointPath, {
        status: 'completed',
        completedAt: nowIso(),
        nextAction: 'none',
      });
      return 0;
    }

    resume = true;

    if (result.code === 2) {
      const reason = latestPauseReason(dagPath);
      const pauses = (readJson(checkpointPath)?.pauses || 0) + 1;
      if (!isQuotaPause(reason)) {
        appendStatus(checkpointPath, {
          status: 'paused',
          pauses,
          reason: reason || 'dag-executor paused',
          nextAction: `inspect ${statePathFor(dagPath)} and resume with loom-supervisor ${dagPath}`,
        });
        return 2;
      }

      const nextRunAt = new Date(Date.now() + quotaDelaySec * 1000).toISOString();
      appendStatus(checkpointPath, {
        status: 'waiting',
        pauses,
        reason,
        waitKind: 'quota',
        nextRunAt,
        nextAction: `retry quota pause after ${formatSeconds(quotaDelaySec)}`,
      });
      console.error(`[loom-supervisor] quota pause: retrying at ${nextRunAt}`);
      await sleep(quotaDelaySec * 1000, signalState);
      continue;
    }

    const crashes = (readJson(checkpointPath)?.crashes || 0) + 1;
    const delaySec = Math.min(crashDelayMaxSec, crashDelaySec * Math.max(1, crashes));
    const nextRunAt = new Date(Date.now() + delaySec * 1000).toISOString();
    appendStatus(checkpointPath, {
      status: 'waiting',
      crashes,
      reason: `dag-executor exited ${result.code}`,
      waitKind: 'crash-retry',
      nextRunAt,
      nextAction: `restart with --resume after ${formatSeconds(delaySec)}`,
    });
    console.error(`[loom-supervisor] child exited ${result.code}; retrying at ${nextRunAt}`);
    await sleep(delaySec * 1000, signalState);
  }

  appendStatus(checkpointPath, {
    status: 'aborted',
    reason: 'supervisor stopped',
    nextAction: `resume with loom-supervisor ${dagPath}`,
  });
  return 130;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`[loom-supervisor] fatal: ${err && err.stack ? err.stack : String(err)}`);
    process.exit(1);
  });
