#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_MAX_WALLCLOCK_SEC = 24 * 60 * 60;
const DEFAULT_MAX_ATTEMPTS = 100;
const DEFAULT_CRASH_DELAY_SEC = 60;
const DEFAULT_CRASH_DELAY_MAX_SEC = 15 * 60;
const DEFAULT_QUOTA_DELAY_SEC = 30 * 60;
const ACTIVE_CHECKPOINT_STATUSES = new Set(['running', 'waiting', 'starting', 'stopping']);
const QUEUE_INCOMPLETE_STATUSES = new Set(['queued', 'running', 'paused', 'stopped', 'failed']);
const TASK_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const ESTIMATED_SCOPES = new Set(['single-component', 'multi-file', 'cross-module']);
const TASK_WEIGHTS = new Set(['trivial', 'standard', 'heavy']);
const EMPTY_PAUSE = { reason: '', blockedTasks: [], quota: undefined };

function usage() {
  console.error(`Usage:
  loom-supervisor <dag.json> [dag-executor flags...]
  loom-supervisor --detach <dag.json> [dag-executor flags...]
  loom-supervisor --status <dag.json>
  loom-supervisor --stop <dag.json>
  loom-supervisor --queue-add <dag.json> [--priority=N] [dag-executor flags...]
  loom-supervisor --queue-run
  loom-supervisor --queue-status
  loom-supervisor --queue-pause <item-id>
  loom-supervisor --queue-resume <item-id>
  loom-supervisor --queue-cancel <item-id>
  loom-supervisor --queue-priority <item-id> <priority>
  loom-day-run <dag.json> [dag-executor flags...]
  loom-status <dag.json>

Runs dag-executor in backlog mode and supervises the run.

Day-run behavior:
  - loom-day-run is shorthand for loom-supervisor --detach
  - --detach starts the supervisor in the background
  - --force-detach ignores a stale-looking active checkpoint
  - --foreground disables loom-day-run's implicit --detach
  - --allow-dirty-repo permits starting when git status is dirty
  - --status prints checkpoint + DAG task status
  - --stop sends SIGTERM to the PID in the checkpoint
  - --queue=<path> selects a persistent multi-DAG queue file
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
  LOOM_SUPERVISOR_QUEUE             default: .loom-supervisor/queue.json
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

function eventLogPathFor(dagPath) {
  return dagPath.replace(/\.json$/, '.events.jsonl');
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

function readJsonLines(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return raw
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function isPidAlive(pid) {
  if (!isPositiveInteger(pid)) return false;
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

function quotaMetadata(value) {
  return value && typeof value === 'object' ? value : undefined;
}

function latestPause(dagPath) {
  const events = readJsonLines(eventLogPathFor(dagPath));
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event && event.kind === 'dag.paused' && typeof event.reason === 'string') {
      return {
        reason: event.reason,
        blockedTasks: Array.isArray(event.blockedTasks) ? event.blockedTasks : [],
        quota: quotaMetadata(event.quota),
      };
    }
  }

  const state = readJson(statePathFor(dagPath));
  if (!state || state.status !== 'paused') return EMPTY_PAUSE;
  return {
    reason: typeof state.reason === 'string' ? state.reason : '',
    blockedTasks: Array.isArray(state.blockedTasks) ? state.blockedTasks : [],
    quota: quotaMetadata(state.quota),
  };
}

function formatBlockedTasks(blockedTasks) {
  if (!Array.isArray(blockedTasks) || blockedTasks.length === 0) return '';
  return blockedTasks
    .map((task) => {
      const id = typeof task?.taskId === 'string' ? task.taskId : 'unknown';
      const kind = typeof task?.kind === 'string' ? task.kind : 'blocked';
      let blockedBy = '';
      if (Array.isArray(task?.blockedBy) && task.blockedBy.length > 0) {
        blockedBy = `<-${task.blockedBy.join(',')}`;
      }
      return `${id}:${kind}${blockedBy}`;
    })
    .join(' ');
}

function isQuotaPause(pause) {
  if (quotaMetadata(pause?.quota)) return true;
  const reason = typeof pause === 'string' ? pause : pause?.reason;
  return /\b(quota|usage\s+limit|account\s+limit|token\s+limit|daily\s+limit|weekly\s+limit|monthly\s+limit|credits?\b)/i.test(
    reason || '',
  );
}

function quotaDelayMs(quota, fallbackDelaySec) {
  const metadata = quotaMetadata(quota);
  if (metadata) {
    if (typeof metadata.resetAt === 'string') {
      const resetMs = Date.parse(metadata.resetAt);
      const delayMs = resetMs - Date.now();
      if (Number.isFinite(delayMs) && delayMs > 0) return delayMs;
    }
    if (Number.isFinite(metadata.retryAfterMs) && metadata.retryAfterMs >= 0) {
      return metadata.retryAfterMs;
    }
  }
  return fallbackDelaySec * 1000;
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

function requireValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseArgs(argv) {
  const flags = {
    detach: false,
    forceDetach: false,
    foreground: false,
    allowDirtyRepo: false,
    status: false,
    stop: false,
    queueAdd: false,
    queueRun: false,
    queueStatus: false,
    queuePause: false,
    queueResume: false,
    queueCancel: false,
    queuePriority: false,
    queuePath: undefined,
    priority: 0,
    help: false,
  };
  const rest = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--detach') flags.detach = true;
    else if (arg === '--force-detach') flags.forceDetach = true;
    else if (arg === '--foreground') flags.foreground = true;
    else if (arg === '--allow-dirty-repo') flags.allowDirtyRepo = true;
    else if (arg === '--status') flags.status = true;
    else if (arg === '--stop') flags.stop = true;
    else if (arg === '--queue-add') flags.queueAdd = true;
    else if (arg.startsWith('--queue-add=')) {
      flags.queueAdd = true;
      rest.push(arg.slice('--queue-add='.length));
    } else if (arg === '--queue-run') flags.queueRun = true;
    else if (arg === '--queue-status') flags.queueStatus = true;
    else if (arg === '--queue-pause') {
      flags.queuePause = true;
      rest.push(requireValue(argv, i, arg));
      i += 1;
    } else if (arg === '--queue-resume') {
      flags.queueResume = true;
      rest.push(requireValue(argv, i, arg));
      i += 1;
    } else if (arg === '--queue-cancel') {
      flags.queueCancel = true;
      rest.push(requireValue(argv, i, arg));
      i += 1;
    } else if (arg === '--queue-priority') {
      flags.queuePriority = true;
      rest.push(requireValue(argv, i, arg));
      rest.push(requireValue(argv, i + 1, arg));
      i += 2;
    } else if (arg === '--queue') {
      flags.queuePath = requireValue(argv, i, arg);
      i += 1;
    } else if (arg.startsWith('--queue=')) flags.queuePath = arg.slice('--queue='.length);
    else if (arg === '--priority') {
      flags.priority = Number(requireValue(argv, i, arg));
      i += 1;
    } else if (arg.startsWith('--priority=')) flags.priority = Number(arg.slice('--priority='.length));
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

function resolveQueuePath(queuePath) {
  return path.resolve(queuePath || process.env.LOOM_SUPERVISOR_QUEUE || path.join('.loom-supervisor', 'queue.json'));
}

function queueLockPath(queuePath) {
  return `${queuePath}.lock`;
}

function readQueue(queuePath) {
  const queue = readJson(queuePath);
  if (queue && isRecord(queue) && Array.isArray(queue.items)) return queue;
  return {
    schemaVersion: 1,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    items: [],
  };
}

function writeQueue(queuePath, queue) {
  writeAtomic(queuePath, { ...queue, schemaVersion: 1, updatedAt: nowIso() });
}

function queueItemId(dagPath) {
  const base = path.basename(dagPath, path.extname(dagPath)).replace(/[^a-zA-Z0-9_-]+/g, '-');
  return `${base || 'dag'}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function withQueueLock(queuePath, fn) {
  fs.mkdirSync(path.dirname(queuePath), { recursive: true });
  const lockPath = queueLockPath(queuePath);
  let fd;

  try {
    fd = fs.openSync(lockPath, 'wx');
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      const lock = readJson(lockPath);
      const pid = Number(lock?.pid);
      if (!isPositiveInteger(pid) || !isPidAlive(pid)) {
        fs.rmSync(lockPath, { force: true });
        fd = fs.openSync(lockPath, 'wx');
      } else {
        throw new Error(`queue is locked by running pid ${pid}: ${lockPath}`);
      }
    } else {
      throw err;
    }
  }

  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: nowIso() }) + '\n', 'utf8');
    const queue = readQueue(queuePath);
    const result = fn(queue);
    if (result !== false) writeQueue(queuePath, queue);
    return result;
  } finally {
    fs.closeSync(fd);
    fs.rmSync(lockPath, { force: true });
  }
}

function findQueueItem(queue, itemId) {
  return queue.items.find((item) => item && item.id === itemId);
}

function normalizeQueueRunningItems(queue) {
  let changed = false;
  for (const item of queue.items) {
    if (item?.status !== 'running') continue;
    if (queueItemHasLiveOwner(item)) continue;
    item.status = 'queued';
    item.reason = 'requeued after stale worker';
    item.workerPid = undefined;
    item.supervisorPid = undefined;
    item.updatedAt = nowIso();
    changed = true;
  }
  return changed;
}

function queueItemHasLiveOwner(item) {
  const workerPid = Number(item?.workerPid);
  const supervisorPid = Number(item?.supervisorPid);
  return (
    (isPositiveInteger(workerPid) && isPidAlive(workerPid)) ||
    (isPositiveInteger(supervisorPid) && isPidAlive(supervisorPid))
  );
}

function queueRunnableItems(queue) {
  normalizeQueueRunningItems(queue);
  return queue.items
    .filter((item) => item && item.status === 'queued')
    .sort((a, b) => {
      const priorityDelta = Number(b.priority || 0) - Number(a.priority || 0);
      if (priorityDelta !== 0) return priorityDelta;
      return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
    });
}

function validatePriority(priority) {
  if (!Number.isFinite(priority)) throw new Error('priority must be a number');
  return priority;
}

function addQueueItem({ queuePath, dagArg, userArgs, priority, allowDirtyRepo }) {
  if (!dagArg) {
    console.error('[loom-supervisor] --queue-add requires a DAG path');
    return 1;
  }

  const dagPath = path.resolve(dagArg);
  if (!fs.existsSync(dagPath)) {
    console.error(`[loom-supervisor] DAG not found: ${dagPath}`);
    return 1;
  }

  const errors = [];
  checkDagFile(dagPath, errors);
  if (errors.length > 0) {
    for (const error of errors) console.error(`[loom-supervisor] queue add failed: ${error}`);
    return 1;
  }

  const item = {
    id: queueItemId(dagPath),
    dagPath,
    args: userArgs,
    allowDirtyRepo,
    priority: validatePriority(priority),
    status: 'queued',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    attempts: 0,
  };

  withQueueLock(queuePath, (queue) => {
    queue.items.push(item);
  });

  console.log(`queued: ${item.id}`);
  console.log(`dagPath: ${item.dagPath}`);
  console.log(`priority: ${item.priority}`);
  console.log(`queue: ${queuePath}`);
  return 0;
}

function printQueueItem(item) {
  const fields = [
    `id=${item.id}`,
    `status=${item.status}`,
    `priority=${item.priority || 0}`,
    `dag=${item.dagPath}`,
  ];
  if (item.workerPid) fields.push(`workerPid=${item.workerPid}`);
  if (item.supervisorPid) fields.push(`supervisorPid=${item.supervisorPid}`);
  if (item.lastExitCode !== undefined) fields.push(`lastExitCode=${item.lastExitCode}`);
  if (item.reason) fields.push(`reason=${item.reason}`);
  console.log(fields.join(' '));
}

function showQueueStatus(queuePath) {
  const queue = withQueueLock(queuePath, (current) => {
    normalizeQueueRunningItems(current);
    return { ...current, items: [...current.items] };
  });
  console.log(`queue: ${queuePath}`);
  console.log(`items: ${queue.items.length}`);
  for (const item of queue.items) printQueueItem(item);
  const blocked = queue.items.some((item) => item && ['paused', 'stopped', 'failed'].includes(item.status));
  return blocked ? 2 : 0;
}

function updateQueueItemStatus({ queuePath, itemId, nextStatus }) {
  let updated;
  withQueueLock(queuePath, (queue) => {
    normalizeQueueRunningItems(queue);
    const item = findQueueItem(queue, itemId);
    if (!item) throw new Error(`queue item not found: ${itemId}`);
    if (nextStatus === 'queued' && item.status === 'canceled') {
      throw new Error(`cannot resume canceled queue item: ${itemId}`);
    }
    const oldStatus = item.status;
    item.status = nextStatus;
    item.updatedAt = nowIso();
    if (nextStatus === 'queued') {
      item.workerPid = undefined;
      item.supervisorPid = undefined;
      item.reason = undefined;
      item.finishedAt = undefined;
    }
    if (nextStatus === 'paused') item.reason = oldStatus === 'running' ? 'pause requested' : 'paused by user';
    if (nextStatus === 'canceled') item.reason = oldStatus === 'running' ? 'cancel requested' : 'canceled by user';
    updated = { ...item, oldStatus };
  });

  if ((nextStatus === 'paused' || nextStatus === 'canceled') && updated.oldStatus === 'running') {
    const supervisorPid = Number(updated.supervisorPid);
    const workerPid = Number(updated.workerPid);
    const pid = isPositiveInteger(supervisorPid) ? supervisorPid : workerPid;
    if (isPositiveInteger(pid) && isPidAlive(pid)) process.kill(pid, 'SIGTERM');
  }

  console.log(`${updated.id}: ${updated.oldStatus} -> ${updated.status}`);
  return 0;
}

function updateQueueItemPriority({ queuePath, itemId, priority }) {
  let updated;
  withQueueLock(queuePath, (queue) => {
    normalizeQueueRunningItems(queue);
    const item = findQueueItem(queue, itemId);
    if (!item) throw new Error(`queue item not found: ${itemId}`);
    item.priority = validatePriority(priority);
    item.updatedAt = nowIso();
    updated = { ...item };
  });
  console.log(`${updated.id}: priority=${updated.priority}`);
  return 0;
}

function claimNextQueueItem(queuePath) {
  return withQueueLock(queuePath, (queue) => {
    const item = queueRunnableItems(queue)[0];
    if (!item) return null;
    item.status = 'running';
    item.workerPid = process.pid;
    item.startedAt = nowIso();
    item.updatedAt = nowIso();
    item.attempts = Number(item.attempts || 0) + 1;
    item.reason = undefined;
    return { ...item, args: [...(item.args || [])] };
  });
}

function finishQueueItem(queuePath, itemId, patch) {
  withQueueLock(queuePath, (queue) => {
    const item = findQueueItem(queue, itemId);
    if (!item) return;
    if (item.status === 'paused' || item.status === 'canceled') {
      item.workerPid = undefined;
      item.supervisorPid = undefined;
      item.finishedAt = nowIso();
      item.updatedAt = nowIso();
      return;
    }
    Object.assign(item, patch, {
      workerPid: undefined,
      supervisorPid: undefined,
      finishedAt: nowIso(),
      updatedAt: nowIso(),
    });
  });
}

function markQueueItemSupervisor({ queuePath, itemId, supervisorPid }) {
  withQueueLock(queuePath, (queue) => {
    const item = findQueueItem(queue, itemId);
    if (!item || item.status !== 'running') return;
    item.supervisorPid = supervisorPid;
    item.updatedAt = nowIso();
  });
}

function queueCompletionPatch(item, result) {
  const checkpointPath = resolvePaths(item.dagPath).checkpointPath;
  if (result.code === 0) {
    return {
      status: 'completed',
      lastExitCode: 0,
      checkpointPath,
      reason: undefined,
    };
  }
  if (result.code === 2) {
    return {
      status: 'paused',
      lastExitCode: 2,
      checkpointPath,
      reason: latestPause(item.dagPath).reason || 'dag paused',
    };
  }
  if (result.code === 3) {
    return {
      status: 'stopped',
      lastExitCode: 3,
      checkpointPath,
      reason: readJson(checkpointPath)?.reason || 'supervisor stopped',
    };
  }
  return {
    status: 'failed',
    lastExitCode: result.code,
    checkpointPath,
    reason: result.reason || `supervisor exited ${result.code}`,
  };
}

function incompleteQueueItems(queuePath) {
  return withQueueLock(queuePath, (queue) => {
    normalizeQueueRunningItems(queue);
    return queue.items.filter((item) => item && QUEUE_INCOMPLETE_STATUSES.has(item.status)).length;
  });
}

function queueChildEnv() {
  const env = { ...process.env };
  delete env.LOOM_SUPERVISOR_CHECKPOINT;
  delete env.LOOM_SUPERVISOR_LOG_DIR;
  delete env.LOOM_SUPERVISOR_DETACH_LOG;
  return env;
}

async function runQueueWorker({ queuePath }) {
  const signalState = { stopping: false, child: undefined };
  const stop = (signal) => {
    signalState.stopping = true;
    if (signalState.child) signalState.child.kill(signal);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  while (!signalState.stopping) {
    const item = claimNextQueueItem(queuePath);
    if (!item) break;

    const childArgs = [__filename];
    if (item.allowDirtyRepo) childArgs.push('--allow-dirty-repo');
    childArgs.push(item.dagPath, ...(item.args || []));
    console.error(`[loom-supervisor] queue item=${item.id} node ${childArgs.join(' ')}`);

    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, childArgs, { stdio: 'inherit', env: queueChildEnv() });
      signalState.child = child;
      if (isPositiveInteger(child.pid)) {
        markQueueItemSupervisor({ queuePath, itemId: item.id, supervisorPid: child.pid });
      }
      child.on('error', (err) => {
        signalState.child = undefined;
        resolve({ code: 127, reason: err.message });
      });
      child.on('exit', (code, signal) => {
        signalState.child = undefined;
        resolve({ code: code ?? 1, signal });
      });
    });

    if (signalState.stopping) {
      finishQueueItem(queuePath, item.id, {
        status: 'stopped',
        lastExitCode: result.code,
        lastSignal: result.signal,
        reason: `queue worker received ${result.signal || 'stop signal'}`,
      });
      return 130;
    }

    finishQueueItem(queuePath, item.id, queueCompletionPatch(item, result));
  }

  return incompleteQueueItems(queuePath) > 0 ? 2 : 0;
}

function detachQueueWorker({ queuePath, forceDetach }) {
  const active = withQueueLock(queuePath, (queue) => {
    normalizeQueueRunningItems(queue);
    return queue.items.find((item) => item && item.status === 'running' && queueItemHasLiveOwner(item));
  });
  if (active && !forceDetach) {
    const pid = active.supervisorPid || active.workerPid;
    console.error(`[loom-supervisor] queue worker already running item ${active.id} (pid ${pid})`);
    return 4;
  }

  fs.mkdirSync(path.dirname(queuePath), { recursive: true });
  const logPath = path.join(path.dirname(queuePath), 'queue-supervisor.log');
  const fd = fs.openSync(logPath, 'a');
  let child;
  try {
    child = spawn(process.execPath, [__filename, '--queue-run', '--queue', queuePath], {
      detached: true,
      stdio: ['ignore', fd, fd],
      env: process.env,
    });
  } finally {
    fs.closeSync(fd);
  }
  child.unref();
  console.error(`[loom-supervisor] detached queue pid=${child.pid}`);
  console.error(`[loom-supervisor] queue=${queuePath}`);
  console.error(`[loom-supervisor] queueLog=${logPath}`);
  return 0;
}

function activeSupervisorPid(checkpoint) {
  const supervisorPid = Number(checkpoint?.supervisorPid);
  if (isPositiveInteger(supervisorPid)) return supervisorPid;
  const detachedPid = Number(checkpoint?.detachedPid);
  if (isPositiveInteger(detachedPid)) return detachedPid;
  return undefined;
}

function checkpointLooksActive(checkpoint) {
  if (!checkpoint || typeof checkpoint !== 'object') return false;
  if (!ACTIVE_CHECKPOINT_STATUSES.has(checkpoint.status)) return false;
  const pid = activeSupervisorPid(checkpoint);
  return pid !== undefined && isPidAlive(pid);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isStringRecord(value) {
  return isRecord(value) && Object.values(value).every((item) => typeof item === 'string');
}

function requireString(value, pathName, errors, { nonEmpty = false } = {}) {
  if (typeof value !== 'string' || (nonEmpty && value.trim() === '')) {
    errors.push(`${pathName} must be a${nonEmpty ? ' non-empty' : ''} string`);
  }
}

function requireStringArray(value, pathName, errors) {
  if (!isStringArray(value)) errors.push(`${pathName} must be an array of strings`);
}

function validateMetaShape(meta, errors) {
  if (!isRecord(meta)) {
    errors.push('meta must be an object');
    return;
  }

  requireString(meta.id, 'meta.id', errors, { nonEmpty: true });
  requireString(meta.createdAt, 'meta.createdAt', errors);
  requireString(meta.gitCommit, 'meta.gitCommit', errors);
  requireString(meta.branch, 'meta.branch', errors);

  const source = meta.source;
  if (!isRecord(source)) {
    errors.push('meta.source must be an object');
  } else {
    if (!['jira', 'description'].includes(source.type)) errors.push('meta.source.type is invalid');
    if (source.jiraKey !== undefined) requireString(source.jiraKey, 'meta.source.jiraKey', errors);
    requireString(source.title, 'meta.source.title', errors, { nonEmpty: true });
    requireString(source.description, 'meta.source.description', errors);
    requireStringArray(source.figmaUrls, 'meta.source.figmaUrls', errors);
    requireStringArray(source.acceptanceCriteria, 'meta.source.acceptanceCriteria', errors);
  }

  const qualityReport = meta.qualityReport;
  if (!isRecord(qualityReport)) {
    errors.push('meta.qualityReport must be an object');
    return;
  }
  if (typeof qualityReport.iterations !== 'number') errors.push('meta.qualityReport.iterations must be a number');
  requireStringArray(qualityReport.checksRun, 'meta.qualityReport.checksRun', errors);
  if (typeof qualityReport.allPassed !== 'boolean') errors.push('meta.qualityReport.allPassed must be a boolean');
  if (qualityReport.details !== undefined) {
    if (!isRecord(qualityReport.details)) {
      errors.push('meta.qualityReport.details must be an object');
    } else {
      for (const [name, detail] of Object.entries(qualityReport.details)) {
        if (!isRecord(detail)) {
          errors.push(`meta.qualityReport.details.${name} must be an object`);
          continue;
        }
        if (typeof detail.passed !== 'boolean') {
          errors.push(`meta.qualityReport.details.${name}.passed must be a boolean`);
        }
        requireString(detail.notes, `meta.qualityReport.details.${name}.notes`, errors);
      }
    }
  }
}

function validateContractsShape(contracts, taskPath, errors) {
  if (!isRecord(contracts)) {
    errors.push(`${taskPath}.contracts must be an object`);
    return;
  }

  if (!isRecord(contracts.inputs)) {
    errors.push(`${taskPath}.contracts.inputs must be an object`);
  } else {
    for (const [name, input] of Object.entries(contracts.inputs)) {
      if (!isRecord(input)) {
        errors.push(`${taskPath}.contracts.inputs.${name} must be an object`);
        continue;
      }
      if (input.type !== undefined) requireString(input.type, `${taskPath}.contracts.inputs.${name}.type`, errors);
      requireString(input.source, `${taskPath}.contracts.inputs.${name}.source`, errors);
    }
  }

  if (!isRecord(contracts.outputs)) {
    errors.push(`${taskPath}.contracts.outputs must be an object`);
    return;
  }

  for (const [name, output] of Object.entries(contracts.outputs)) {
    const outputPath = `${taskPath}.contracts.outputs.${name}`;
    if (!isRecord(output)) {
      errors.push(`${outputPath} must be an object`);
      continue;
    }
    if (output.kind === 'file') {
      requireString(output.path, `${outputPath}.path`, errors, { nonEmpty: true });
      if (
        output.mediaType !== undefined &&
        !['json', 'markdown', 'yaml', 'text', 'typescript', 'shell', 'other'].includes(output.mediaType)
      ) {
        errors.push(`${outputPath}.mediaType is invalid`);
      }
      requireString(output.description, `${outputPath}.description`, errors);
    } else if (output.kind === 'export') {
      requireString(output.file, `${outputPath}.file`, errors, { nonEmpty: true });
      requireString(output.exportName, `${outputPath}.exportName`, errors, { nonEmpty: true });
      if (!['type', 'interface', 'const', 'function', 'class', 'component'].includes(output.exportKind)) {
        errors.push(`${outputPath}.exportKind is invalid`);
      }
      requireString(output.description, `${outputPath}.description`, errors);
    } else if (output.kind === 'behavioral') {
      requireString(output.description, `${outputPath}.description`, errors);
    } else {
      errors.push(`${outputPath}.kind is invalid`);
    }
  }
}

function validateContextShape(context, taskPath, errors) {
  if (!isRecord(context)) {
    errors.push(`${taskPath}.context must be an object`);
    return;
  }
  requireStringArray(context.files, `${taskPath}.context.files`, errors);
  if (context.layoutSpec !== undefined) requireString(context.layoutSpec, `${taskPath}.context.layoutSpec`, errors);
  if (context.conventions !== undefined) requireStringArray(context.conventions, `${taskPath}.context.conventions`, errors);
  if (context.figmaTokens !== undefined && !isStringRecord(context.figmaTokens)) {
    errors.push(`${taskPath}.context.figmaTokens must be an object of strings`);
  }

  if (context.figmaRef !== undefined) {
    if (!isRecord(context.figmaRef)) {
      errors.push(`${taskPath}.context.figmaRef must be an object`);
    } else {
      if (context.figmaRef.nodeId !== undefined) {
        requireString(context.figmaRef.nodeId, `${taskPath}.context.figmaRef.nodeId`, errors);
      }
      if (context.figmaRef.url !== undefined) requireString(context.figmaRef.url, `${taskPath}.context.figmaRef.url`, errors);
      if (context.figmaRef.hints !== undefined) {
        requireStringArray(context.figmaRef.hints, `${taskPath}.context.figmaRef.hints`, errors);
      }
    }
  }

  if (context.relatedPatterns !== undefined) {
    if (!Array.isArray(context.relatedPatterns)) {
      errors.push(`${taskPath}.context.relatedPatterns must be an array`);
    } else {
      for (const [i, pattern] of context.relatedPatterns.entries()) {
        if (!isRecord(pattern)) {
          errors.push(`${taskPath}.context.relatedPatterns.${i} must be an object`);
          continue;
        }
        requireString(pattern.file, `${taskPath}.context.relatedPatterns.${i}.file`, errors);
        requireString(pattern.relevance, `${taskPath}.context.relatedPatterns.${i}.relevance`, errors);
      }
    }
  }
}

function validateCompletionCriteriaShape(completionCriteria, taskPath, errors) {
  if (!isRecord(completionCriteria)) {
    errors.push(`${taskPath}.completionCriteria must be an object`);
    return;
  }
  requireStringArray(completionCriteria.automated, `${taskPath}.completionCriteria.automated`, errors);
  requireStringArray(completionCriteria.manual, `${taskPath}.completionCriteria.manual`, errors);
}

function validateDagShape(dag) {
  const errors = [];
  if (!isRecord(dag)) return ['DAG must be a JSON object'];

  validateMetaShape(dag.meta, errors);
  if (!Array.isArray(dag.tasks) || dag.tasks.length === 0) errors.push('tasks must be a non-empty array');
  if (!Array.isArray(dag.executionLayers) || dag.executionLayers.length === 0) {
    errors.push('executionLayers must be a non-empty array');
  }
  if (errors.length > 0) return errors;

  const taskIds = new Set();
  const layerByTask = new Map();
  const tasks = dag.tasks;
  const layers = dag.executionLayers;

  for (const [i, task] of tasks.entries()) {
    const taskPath = `tasks.${i}`;
    if (!isRecord(task)) {
      errors.push(`${taskPath} must be an object`);
      continue;
    }
    if (typeof task.id !== 'string' || !TASK_ID_PATTERN.test(task.id)) {
      errors.push(`${taskPath}.id must contain only alphanumeric, hyphen, or underscore characters`);
      continue;
    }
    if (taskIds.has(task.id)) errors.push(`duplicate task id "${task.id}"`);
    taskIds.add(task.id);
    requireString(task.name, `${taskPath}.name`, errors, { nonEmpty: true });
    requireString(task.description, `${taskPath}.description`, errors);
    requireStringArray(task.dependencies, `${taskPath}.dependencies`, errors);
    validateContractsShape(task.contracts, taskPath, errors);
    validateContextShape(task.context, taskPath, errors);
    validateCompletionCriteriaShape(task.completionCriteria, taskPath, errors);
    if (!ESTIMATED_SCOPES.has(task.estimatedScope)) {
      errors.push(`task "${task.id}" estimatedScope is invalid`);
    }
    if (!TASK_WEIGHTS.has(task.weight)) errors.push(`task "${task.id}" weight is invalid`);
  }

  for (const layer of layers) {
    if (!isRecord(layer) || !Number.isInteger(layer.layer) || layer.layer < 0 || !Array.isArray(layer.taskIds)) {
      errors.push('execution layer must include layer >= 0 and taskIds array');
      continue;
    }
    if (typeof layer.description !== 'string') errors.push(`execution layer ${layer.layer} description must be a string`);
    if (layer.taskIds.length === 0) errors.push(`execution layer ${layer.layer} taskIds must be non-empty`);
    for (const taskId of layer.taskIds) {
      if (typeof taskId !== 'string') {
        errors.push(`execution layer ${layer.layer} taskIds must contain only strings`);
        continue;
      }
      if (!taskIds.has(taskId)) {
        errors.push(`execution layer ${layer.layer} references unknown task "${taskId}"`);
        continue;
      }
      if (layerByTask.has(taskId)) {
        errors.push(`task "${taskId}" appears in multiple execution layers`);
        continue;
      }
      layerByTask.set(taskId, layer.layer);
    }
  }

  for (const task of tasks) {
    if (!isRecord(task) || typeof task.id !== 'string') continue;
    if (!layerByTask.has(task.id)) errors.push(`task "${task.id}" is not assigned to any execution layer`);
    if (!isStringArray(task.dependencies)) continue;
    for (const depId of task.dependencies) {
      if (!taskIds.has(depId)) {
        errors.push(`task "${task.id}" depends on unknown task "${depId}"`);
        continue;
      }
      const depLayer = layerByTask.get(depId);
      const taskLayer = layerByTask.get(task.id);
      if (depLayer !== undefined && taskLayer !== undefined && depLayer >= taskLayer) {
        errors.push(`task "${task.id}" depends on "${depId}" in the same or later layer`);
      }
    }
  }

  const visiting = new Set();
  const visited = new Set();
  const taskById = new Map(tasks.filter(isRecord).map((task) => [task.id, task]));
  const visit = (id, pathIds) => {
    if (visited.has(id) || !taskById.has(id)) return;
    if (visiting.has(id)) {
      errors.push(`cycle detected in DAG: ${[...pathIds, id].join(' -> ')}`);
      return;
    }
    visiting.add(id);
    const deps = taskById.get(id).dependencies;
    if (Array.isArray(deps)) {
      for (const depId of deps) visit(depId, [...pathIds, id]);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of taskIds) visit(id, []);

  return errors;
}

function runProbe(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd || process.cwd(),
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: options.timeoutMs || 10_000,
  });
}

function commandSpawned(result) {
  return !result.error || result.error.code !== 'ENOENT';
}

function resultOutput(result) {
  return `${result.stderr || ''}${result.stdout || ''}`.trim();
}

function resultFailure(result) {
  return resultOutput(result) || result.error?.message || 'unknown error';
}

function providerFromArgs(userArgs) {
  const raw = userArgs.find((arg) => arg.startsWith('--provider='));
  const provider = raw ? raw.split('=')[1] : 'codex';
  return provider === 'claude' ? 'claude' : 'codex';
}

function providerBin(provider) {
  return provider === 'claude' ? process.env.CLAUDE_BIN || 'claude' : process.env.CODEX_BIN || 'codex';
}

function checkDagFile(dagPath, errors) {
  const dag = readJson(dagPath);
  if (!dag) {
    errors.push(`DAG validation failed: ${dagPath} is not readable JSON`);
    return;
  }
  const validationErrors = validateDagShape(dag);
  for (const error of validationErrors) errors.push(`DAG validation failed: ${error}`);
}

function checkCommand(name, command, args, errors, warnings) {
  const result = runProbe(command, args, { timeoutMs: 5_000 });
  if (result.error) {
    if (result.error.code === 'ENOENT') {
      errors.push(`${name} is not available: ${command}`);
    } else if (result.error.code === 'ETIMEDOUT') {
      warnings.push(`${name} probe timed out: ${command} ${args.join(' ')}`);
    } else {
      errors.push(`${name} probe failed: ${command} (${result.error.message})`);
    }
  }
  return result;
}

function checkExecutablePath(name, command, args, errors, warnings) {
  if (command.includes(path.sep) || fs.existsSync(command)) {
    try {
      fs.accessSync(command, fs.constants.X_OK);
      return { status: 0 };
    } catch (err) {
      errors.push(`${name} is not executable: ${command} (${err.message})`);
      return { status: 1, error: err };
    }
  }
  return checkCommand(name, command, args, errors, warnings);
}

function checkDagLock(dagPath, errors, warnings) {
  const lockPath = `${dagPath}.lock`;
  if (!fs.existsSync(lockPath)) return;

  const removeStaleLock = () => {
    warnings.push(`stale DAG lock detected and removed: ${lockPath}`);
    fs.rmSync(lockPath, { force: true });
  };

  let pid;
  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    pid = JSON.parse(raw).pid;
  } catch {
    removeStaleLock();
    return;
  }

  if (isPositiveInteger(pid) && isPidAlive(pid)) {
    errors.push(`DAG lock is held by running pid ${pid}: ${lockPath}`);
    return;
  }

  removeStaleLock();
}

function checkSupervisorCheckpoint(checkpointPath, warnings) {
  const checkpoint = readJson(checkpointPath);
  if (!checkpoint || !ACTIVE_CHECKPOINT_STATUSES.has(checkpoint.status)) return;
  const pid = activeSupervisorPid(checkpoint);
  if (pid && !isPidAlive(pid)) warnings.push(`stale supervisor PID ${pid} in ${checkpointPath}`);
}

function checkGitRepo({ allowDirtyRepo, errors, warnings }) {
  const gitVersion = checkCommand('git', 'git', ['--version'], errors, warnings);
  if (!commandSpawned(gitVersion)) return;

  const root = runProbe('git', ['rev-parse', '--show-toplevel']);
  if (root.status !== 0) {
    errors.push('current directory is not inside a git repository');
    return;
  }

  const status = runProbe('git', ['status', '--porcelain']);
  if (status.status !== 0) {
    errors.push(`git status failed: ${resultFailure(status)}`);
    return;
  }

  if (status.stdout.trim()) {
    if (allowDirtyRepo) {
      warnings.push('git working tree is dirty; proceeding because --allow-dirty-repo is set');
    } else {
      errors.push('git working tree is dirty; commit/stash changes or pass --allow-dirty-repo');
      return;
    }
  }

  const tmpParent = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-preflight-'));
  const wtPath = path.join(tmpParent, 'worktree');
  try {
    const add = runProbe('git', ['worktree', 'add', '--detach', wtPath, 'HEAD'], { timeoutMs: 15_000 });
    if (add.status !== 0) {
      errors.push(`git worktree probe failed: ${resultFailure(add)}`);
      return;
    }
    const remove = runProbe('git', ['worktree', 'remove', '--force', wtPath], { timeoutMs: 15_000 });
    if (remove.status !== 0) {
      warnings.push(`git worktree cleanup failed: ${resultFailure(remove)}`);
    }
  } finally {
    fs.rmSync(tmpParent, { recursive: true, force: true });
  }
}

function runPreflight({ dagPath, userArgs, checkpointPath, allowDirtyRepo }) {
  const errors = [];
  const warnings = [];

  checkDagFile(dagPath, errors);
  checkDagLock(dagPath, errors, warnings);
  checkSupervisorCheckpoint(checkpointPath, warnings);

  const dagExecutor = process.env.DAG_EXECUTOR_BIN || 'dag-executor';
  checkExecutablePath('dag-executor', dagExecutor, ['--help'], errors, warnings);

  const provider = providerFromArgs(userArgs);
  const modelBin = providerBin(provider);
  const providerResult = checkCommand(provider, modelBin, ['--version'], errors, warnings);
  if (commandSpawned(providerResult) && providerResult.status !== 0) {
    warnings.push(`${provider} smoke check returned ${providerResult.status}: ${resultOutput(providerResult)}`);
  }

  checkGitRepo({ allowDirtyRepo, errors, warnings });

  for (const warning of warnings) console.error(`[loom-supervisor] preflight warning: ${warning}`);
  if (errors.length === 0) {
    console.error('[loom-supervisor] preflight ok');
    return true;
  }

  for (const error of errors) console.error(`[loom-supervisor] preflight failed: ${error}`);
  return false;
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

function taskCounts({ dagPath }) {
  const dag = readJson(dagPath);
  const state = readJson(statePathFor(dagPath));
  const stateTasks = state && typeof state === 'object' && state.tasks ? state.tasks : {};
  const dagTasks = Array.isArray(dag?.tasks) ? dag.tasks : [];
  const taskIds = dagTasks.length > 0 ? dagTasks.map((task) => task.id).filter(Boolean) : Object.keys(stateTasks);
  const statusFor = (id) => stateTasks[id]?.status || 'pending';
  const failed = new Set(taskIds.filter((id) => statusFor(id) === 'failed'));
  const completed = taskIds.filter((id) => statusFor(id) === 'completed').length;
  const taskById = new Map(dagTasks.map((task) => [task.id, task]));
  const blockedMemo = new Map();

  const isBlocked = (id, visiting = new Set()) => {
    if (blockedMemo.has(id)) return blockedMemo.get(id);
    if (statusFor(id) === 'completed' || statusFor(id) === 'failed') {
      blockedMemo.set(id, false);
      return false;
    }
    if (visiting.has(id)) return false;
    visiting.add(id);
    const task = taskById.get(id);
    const deps = Array.isArray(task?.dependencies) ? task.dependencies : [];
    const blocked = deps.some((depId) => failed.has(depId) || isBlocked(depId, visiting));
    visiting.delete(id);
    blockedMemo.set(id, blocked);
    return blocked;
  };

  const blocked = taskIds.filter((id) => isBlocked(id)).length;
  const failedCount = failed.size;
  return {
    completed,
    failed: failedCount,
    blocked,
    pending: Math.max(0, taskIds.length - completed - failedCount - blocked),
  };
}

function formatTaskCounts(counts) {
  return `completed=${counts.completed} failed=${counts.failed} pending=${counts.pending} blocked=${counts.blocked}`;
}

function printField(label, value) {
  console.log(`${label}: ${value === undefined || value === null || value === '' ? '-' : value}`);
}

function statusExitCode(status, counts, checkpointMissing) {
  if (checkpointMissing) return 1;
  if (counts.blocked > 0) return 2;
  if (['paused', 'stopped', 'aborted'].includes(status)) return 2;
  return 0;
}

function showStatus({ dagPath, checkpointPath }) {
  const checkpoint = readJson(checkpointPath);
  const counts = taskCounts({ dagPath });

  if (!checkpoint) {
    console.error(`[loom-supervisor] checkpoint not found: ${checkpointPath}`);
    printField('status', 'missing');
    printField('dagPath', dagPath);
    printField('checkpoint', checkpointPath);
    printField('tasks', formatTaskCounts(counts));
    return statusExitCode('missing', counts, true);
  }

  const status = checkpoint.status || 'unknown';
  const pid = activeSupervisorPid(checkpoint);
  const pause = status === 'paused' ? latestPause(dagPath) : EMPTY_PAUSE;
  const pauseReason = pause.reason || checkpoint.reason;
  const blockedTasks = pause.blockedTasks.length > 0 ? pause.blockedTasks : checkpoint.blockedTasks;

  printField('status', status);
  printField('runId', checkpoint.runId);
  printField('dagPath', checkpoint.dagPath || dagPath);
  printField('checkpoint', checkpointPath);
  printField('supervisorPid', pid ? `${pid}${isPidAlive(pid) ? ' alive' : ' not-running'}` : '');
  printField('attempt', checkpoint.attempts);
  printField('lastExitCode', checkpoint.lastExitCode);
  printField('lastLogPath', checkpoint.lastLogPath);
  printField('nextRetryAt', checkpoint.nextRunAt);
  printField('waitKind', checkpoint.waitKind);
  printField('quotaCategory', checkpoint.quota?.category);
  printField('quotaResetAt', checkpoint.quota?.resetAt);
  printField('pauseReason', pauseReason);
  printField('blockedTasks', formatBlockedTasks(blockedTasks));
  printField('nextAction', checkpoint.nextAction);
  printField('tasks', formatTaskCounts(counts));
  return statusExitCode(status, counts, false);
}

function detachSupervisor({ dagPath, userArgs, checkpointPath, logDir, detachLogPath, forceDetach, allowDirtyRepo }) {
  const existing = readJson(checkpointPath);
  if (!forceDetach && checkpointLooksActive(existing)) {
    const pid = activeSupervisorPid(existing);
    console.error(`[loom-supervisor] supervisor already running for this DAG (pid ${pid})`);
    console.error(`[loom-supervisor] checkpoint=${checkpointPath}`);
    console.error('[loom-supervisor] use --force-detach only after verifying the old run is stale');
    return 4;
  }

  if (!runPreflight({ dagPath, userArgs, checkpointPath, allowDirtyRepo })) return 1;

  fs.mkdirSync(path.dirname(detachLogPath), { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });

  const runId = existing?.runId || makeRunId();
  const nodeArgs = [__filename, dagPath, ...userArgs];
  const caffeinate = caffeinateCommand();
  const command = caffeinate || process.execPath;
  const args = caffeinate ? ['-dimsu', process.execPath, ...nodeArgs] : nodeArgs;
  const detachCommand = caffeinate ? `${caffeinate} -dimsu node` : process.execPath;

  appendStatus(checkpointPath, {
    runId,
    dagPath,
    status: 'starting',
    detached: true,
    detachCommand,
    detachLogPath,
    logDir,
    nextAction: `stop with loom-supervisor --stop ${dagPath}`,
  });

  const fd = fs.openSync(detachLogPath, 'a');

  let child;
  try {
    child = spawn(command, args, {
      detached: true,
      stdio: ['ignore', fd, fd],
      env: {
        ...process.env,
        ...(allowDirtyRepo && { LOOM_SUPERVISOR_ALLOW_DIRTY_REPO: '1' }),
      },
    });
  } finally {
    fs.closeSync(fd);
  }

  child.unref();
  appendStatus(checkpointPath, {
    detachedPid: child.pid,
    supervisorPid: child.pid,
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
  const { flags, dagArg, userArgs } = parseArgs(argv);
  if (flags.help) {
    usage();
    return 0;
  }

  const queuePath = resolveQueuePath(flags.queuePath);
  if (flags.queueStatus) return showQueueStatus(queuePath);
  if (flags.queueAdd) {
    return addQueueItem({
      queuePath,
      dagArg,
      userArgs,
      priority: flags.priority,
      allowDirtyRepo: flags.allowDirtyRepo,
    });
  }
  if (flags.queuePause) return updateQueueItemStatus({ queuePath, itemId: dagArg, nextStatus: 'paused' });
  if (flags.queueResume) return updateQueueItemStatus({ queuePath, itemId: dagArg, nextStatus: 'queued' });
  if (flags.queueCancel) return updateQueueItemStatus({ queuePath, itemId: dagArg, nextStatus: 'canceled' });
  if (flags.queuePriority) {
    return updateQueueItemPriority({ queuePath, itemId: dagArg, priority: Number(userArgs[0]) });
  }
  if (flags.queueRun) {
    if (flags.detach) return detachQueueWorker({ queuePath, forceDetach: flags.forceDetach });
    return runQueueWorker({ queuePath });
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
  const allowDirtyRepo = flags.allowDirtyRepo || process.env.LOOM_SUPERVISOR_ALLOW_DIRTY_REPO === '1';
  const defaultStatus = invokedAs === 'loom-status';
  if (flags.status || defaultStatus) return showStatus({ dagPath, checkpointPath });
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
      allowDirtyRepo,
    });
  }

  if (!runPreflight({ dagPath, userArgs, checkpointPath, allowDirtyRepo })) return 1;

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
      const pause = latestPause(dagPath);
      const reason = pause.reason;
      const pauses = (readJson(checkpointPath)?.pauses || 0) + 1;
      if (!isQuotaPause(pause)) {
        appendStatus(checkpointPath, {
          status: 'paused',
          pauses,
          reason: reason || 'dag-executor paused',
          blockedTasks: pause.blockedTasks.length > 0 ? pause.blockedTasks : undefined,
          quota: undefined,
          nextAction: `inspect ${statePathFor(dagPath)} and resume with loom-supervisor ${dagPath}`,
        });
        return 2;
      }

      const delayMs = quotaDelayMs(pause.quota, quotaDelaySec);
      const nextRunAt = new Date(Date.now() + delayMs).toISOString();
      appendStatus(checkpointPath, {
        status: 'waiting',
        pauses,
        reason,
        waitKind: 'quota',
        quota: pause.quota,
        nextRunAt,
        nextAction: `retry quota pause after ${formatSeconds(Math.ceil(delayMs / 1000))}`,
      });
      console.error(`[loom-supervisor] quota pause: retrying at ${nextRunAt}`);
      await sleep(delayMs, signalState);
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
