#!/usr/bin/env node
/* eslint-disable no-undef -- node CJS file: require/process/module are node globals; flat ESLint config scopes globals to *.ts/*.tsx only */
// auto-run-checkpoint.cjs — dependency-free node helper for auto-run checkpoint IO.
//
// Purpose: chat session writes ONLY `decision`; supervisor/headless phases write
// phase/status/pendingGate/retryCount/paths/models. Single-field merge prevents
// either side from clobbering fields it did not touch.
//
// Design constraints (see .claude/references/auto-run-checkpoint.md):
//   - Atomic writes: write to <path>.tmp-<pid>-<rand> then fs.renameSync over the target.
//   - Read-modify-write reads the latest on-disk state, sets ONE field, writes back.
//   - Structured logs go to stderr ONLY. stdout is reserved for requested values
//     (so callers can `VALUE=$(node auto-run-checkpoint.cjs get <path> decision)`).
//   - No external deps; only `fs` and `path` from node stdlib.
//
// CLI:
//   node auto-run-checkpoint.cjs get   <path> <field>
//   node auto-run-checkpoint.cjs set   <path> <field> <value>           # single-field merge write
//   node auto-run-checkpoint.cjs merge <path> <jsonObject>              # multi-field merge write
//   node auto-run-checkpoint.cjs init  <path> <jsonObject>              # create only if missing
//   node auto-run-checkpoint.cjs dump  <path>                           # pretty-print full JSON
//
// Lib (when require()d):
//   const ck = require('./auto-run-checkpoint');
//   ck.read(path)                -> object | null
//   ck.writeAtomic(path, object) -> void   (full overwrite — internal/init use)
//   ck.mergeField(path, k, v)    -> object (returns merged state)
//   ck.mergeFields(path, patch)  -> object
//
// Exit codes:
//   0  ok
//   1  usage error / unknown command
//   2  IO error (read/write failure not recoverable)
//   3  not-found (get on missing file / missing field)

'use strict';

const fs = require('fs');
const path = require('path');

const STATUS_ENUM = ['running', 'needs-decision', 'done', 'aborted', 'error'];

// Fields each writer is allowed to touch. Helper does NOT enforce this at the
// schema level (so the same helper serves both writers), but the merge semantics
// guarantee that whichever field you write does not disturb the others.
const OWNERSHIP = Object.freeze({
  chat: ['decision', 'status'],
  supervisor: [
    'phase',
    'status',
    'pendingGate',
    'retryCount',
    'planPath',
    'dagPath',
    'reviewPath',
    'models',
    'runId',
    'mode',
  ],
});

function logErr(msg, extra) {
  const line =
    extra !== undefined ? `[auto-run-checkpoint] ${msg} ${JSON.stringify(extra)}` : `[auto-run-checkpoint] ${msg}`;
  process.stderr.write(line + '\n');
}

function read(targetPath) {
  let raw;
  try {
    raw = fs.readFileSync(targetPath, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw e;
  }
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`checkpoint at ${targetPath} is not valid JSON: ${e.message}`);
  }
}

function writeAtomic(targetPath, obj) {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(targetPath)}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const json = JSON.stringify(obj, null, 2) + '\n';
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o644);
    fs.writeSync(fd, json, 0, 'utf8');
    try {
      fs.fsyncSync(fd);
    } catch {
      /* fsync best-effort */
    }
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, targetPath);
  } catch (e) {
    if (fd !== null && fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* tmp may not exist */
    }
    throw e;
  }
}

function stampUpdatedAt(obj) {
  obj.lastUpdated = new Date().toISOString();
  return obj;
}

function mergeFields(targetPath, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('mergeFields: patch must be a plain object');
  }
  const current = read(targetPath) || {};
  const next = { ...current };
  for (const key of Object.keys(patch)) {
    next[key] = patch[key];
  }
  stampUpdatedAt(next);
  writeAtomic(targetPath, next);
  return next;
}

function mergeField(targetPath, field, value) {
  if (!field || typeof field !== 'string') {
    throw new Error('mergeField: field must be a non-empty string');
  }
  return mergeFields(targetPath, { [field]: value });
}

// Coerce CLI string into JSON-ish type. `set <path> retryCount 3` → number;
// `set <path> decision continue` → plain string; JSON-shaped strings parsed.
function coerceCliValue(raw) {
  if (raw === 'null') return null;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw !== '' && !Number.isNaN(Number(raw)) && /^-?\d+(\.\d+)?$/.test(raw)) {
    return Number(raw);
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      /* fall through to string */
    }
  }
  return raw;
}

function printValue(v) {
  if (v === undefined || v === null) {
    process.stdout.write('');
    return;
  }
  if (typeof v === 'string') {
    process.stdout.write(v);
    return;
  }
  process.stdout.write(JSON.stringify(v));
}

function usage() {
  process.stderr.write(
    'Usage:\n' +
      '  auto-run-checkpoint get   <path> <field>\n' +
      '  auto-run-checkpoint set   <path> <field> <value>\n' +
      '  auto-run-checkpoint merge <path> <jsonObject>\n' +
      '  auto-run-checkpoint init  <path> <jsonObject>\n' +
      '  auto-run-checkpoint dump  <path>\n',
  );
}

function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd) {
    usage();
    return 1;
  }

  try {
    switch (cmd) {
      case 'get': {
        const [p, field] = rest;
        if (!p || !field) {
          usage();
          return 1;
        }
        const state = read(p);
        if (!state) {
          logErr('checkpoint missing', { path: p });
          return 3;
        }
        if (!(field in state)) {
          logErr('field missing', { field });
          return 3;
        }
        printValue(state[field]);
        return 0;
      }
      case 'set': {
        const [p, field, rawValue] = rest;
        if (!p || !field || rawValue === undefined) {
          usage();
          return 1;
        }
        const value = coerceCliValue(rawValue);
        if (field === 'status' && !STATUS_ENUM.includes(value)) {
          logErr('invalid status', { value, allowed: STATUS_ENUM });
          return 1;
        }
        mergeField(p, field, value);
        logErr('set ok', { path: p, field });
        return 0;
      }
      case 'merge': {
        const [p, rawJson] = rest;
        if (!p || !rawJson) {
          usage();
          return 1;
        }
        let patch;
        try {
          patch = JSON.parse(rawJson);
        } catch (e) {
          logErr('merge: invalid JSON', { error: e.message });
          return 1;
        }
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
          logErr('merge: patch must be a JSON object');
          return 1;
        }
        if ('status' in patch && !STATUS_ENUM.includes(patch.status)) {
          logErr('invalid status', { value: patch.status, allowed: STATUS_ENUM });
          return 1;
        }
        mergeFields(p, patch);
        logErr('merge ok', { path: p, fields: Object.keys(patch) });
        return 0;
      }
      case 'init': {
        const [p, rawJson] = rest;
        if (!p || !rawJson) {
          usage();
          return 1;
        }
        if (read(p)) {
          logErr('init: checkpoint exists, no-op', { path: p });
          return 0;
        }
        let initial;
        try {
          initial = JSON.parse(rawJson);
        } catch (e) {
          logErr('init: invalid JSON', { error: e.message });
          return 1;
        }
        if (!initial || typeof initial !== 'object' || Array.isArray(initial)) {
          logErr('init: payload must be a JSON object');
          return 1;
        }
        stampUpdatedAt(initial);
        writeAtomic(p, initial);
        logErr('init ok', { path: p });
        return 0;
      }
      case 'dump': {
        const [p] = rest;
        if (!p) {
          usage();
          return 1;
        }
        const state = read(p);
        if (!state) {
          logErr('checkpoint missing', { path: p });
          return 3;
        }
        process.stdout.write(JSON.stringify(state, null, 2) + '\n');
        return 0;
      }
      default:
        usage();
        return 1;
    }
  } catch (e) {
    logErr('fatal', { error: e && e.message ? e.message : String(e) });
    return 2;
  }
}

module.exports = {
  read,
  writeAtomic,
  mergeField,
  mergeFields,
  STATUS_ENUM,
  OWNERSHIP,
  _internal: { coerceCliValue },
};

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
