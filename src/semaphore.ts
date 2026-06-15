import { mkdirSync, openSync, writeSync, writeFileSync, closeSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { MAX_GLOBAL_SLOTS, SLOT_POLL_MS } from './consts.js';
import { isPidAlive } from './pid.js';

// ---------------------------------------------------------------------------
// Cross-process concurrency semaphore
// ---------------------------------------------------------------------------
//
// WHY: each dag-executor window spawns parallel CC sessions, and an in-process
// limit (p-limit) can't see sessions running in *other* Warp windows. This is a
// machine-wide budget: N slot files in a shared dir, claimed atomically. Three
// windows on a 24GB Mac sharing 4 slots stops the OOM/swap death spiral.
//
// A slot is an exclusively-created file (O_CREAT|O_EXCL — atomic on POSIX, so
// two racing processes can't both win the same slot). Holder PID is recorded so
// a crashed holder's slot is reclaimable (process.kill(pid, 0) → ESRCH = dead).

export const DEFAULT_SLOT_DIR = join(homedir(), '.dag-executor', 'slots');

interface SlotMeta {
  pid: number;
  label: string;
  startedAt: string;
}

// A waiter marker: a task parked in acquireSlot's poll loop with all slots full.
// Written as `wait-<pid>-<seq>` (plain write, no O_EXCL — the name is unique so
// there's no claim race), removed on slot acquisition, abort, or process exit.
export interface WaitMeta {
  pid: number;
  label: string;
  since: string;
}

export interface AcquireSlotOptions {
  /** Total machine-wide slots. Defaults to MAX_GLOBAL_SLOTS. */
  maxSlots?: number;
  /** Poll interval (ms) when all slots are busy. Defaults to SLOT_POLL_MS. */
  pollMs?: number;
  /** Override slot directory (tests). Defaults to ~/.dag-executor/slots. */
  slotDir?: string;
  /** Abort waiting (e.g. SIGINT). Rejects acquire if fired before a slot frees. */
  signal?: AbortSignal;
}

// Slots/waiter-markers held by THIS process, so the exit handler can free all of
// them on crash. Waiter markers are parked-task files; one process can park
// several tasks at once, so <seq> disambiguates them.
const heldSlots = new Set<string>();
const heldWaiters = new Set<string>();
let waitSeq = 0;
let exitHandlerRegistered = false;

const registerExitHandler = (): void => {
  if (exitHandlerRegistered) return;
  exitHandlerRegistered = true;
  const releaseAll = (): void => {
    for (const path of [...heldSlots, ...heldWaiters]) {
      try {
        rmSync(path);
      } catch {
        /* already gone — ignore */
      }
    }
    heldSlots.clear();
    heldWaiters.clear();
  };
  process.on('exit', releaseAll);
  process.on('SIGINT', releaseAll);
  // SIGTERM (k8s/Docker/CI graceful shutdown) does not fire 'exit' by default, so the
  // slot files would leak. Clean up explicitly, then exit with the 128+SIGTERM code.
  process.on('SIGTERM', () => {
    releaseAll();
    process.exit(143);
  });
};

// Atomically claim slotPath. Returns true on success, false if already held.
const tryClaim = (slotPath: string, label: string): boolean => {
  let fd: number;
  try {
    fd = openSync(slotPath, 'wx'); // wx = O_CREAT | O_EXCL; throws EEXIST if present
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
  try {
    const meta: SlotMeta = { pid: process.pid, label, startedAt: new Date().toISOString() };
    writeSync(fd, JSON.stringify(meta));
  } finally {
    closeSync(fd);
  }
  heldSlots.add(slotPath);
  return true;
};

// Reclaim slots AND waiter markers whose owner PID is no longer alive (crashed
// without releasing). Corrupt/empty slot files are reclaimed too; corrupt wait
// markers are left alone (scanSlots skips them, and they carry no claim).
const reclaimStale = (slotDir: string): void => {
  let entries: string[];
  try {
    entries = readdirSync(slotDir);
  } catch {
    return; // dir missing — nothing to reclaim
  }
  const reclaim = (filePath: string): void => {
    try {
      rmSync(filePath);
    } catch {
      /* raced with another reclaimer — ignore */
    }
  };
  for (const name of entries) {
    const isSlot = name.startsWith('slot-');
    const isWait = name.startsWith('wait-');
    if (!isSlot && !isWait) continue;
    const filePath = join(slotDir, name);
    let pid: number | undefined;
    try {
      pid = (JSON.parse(readFileSync(filePath, 'utf-8')) as SlotMeta | WaitMeta).pid;
    } catch {
      // Corrupt/empty: reclaim slot files (stale claim), leave wait markers.
      if (isSlot) reclaim(filePath);
      continue;
    }
    // Dead (ESRCH), or an invalid/non-integer/<=0 PID (a corrupt claim) → reclaim.
    // A live PID (EPERM/other) is left alone. See isPidAlive.
    if (!isPidAlive(pid)) reclaim(filePath);
  }
};

const delay = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Aborted while waiting for a concurrency slot'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('Aborted while waiting for a concurrency slot'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/**
 * Acquires one machine-wide concurrency slot, waiting if all are busy.
 *
 * Returns a release function that frees the slot. The release is idempotent and
 * also fires automatically on process exit/SIGINT (crash safety). Stale slots
 * from dead holders are reclaimed on each poll.
 *
 * @param label  Identifier (e.g. taskId) recorded in the slot file for debugging.
 */
export const acquireSlot = async (label: string, opts: AcquireSlotOptions = {}): Promise<() => void> => {
  const slotDir = opts.slotDir ?? DEFAULT_SLOT_DIR;
  const maxSlots = opts.maxSlots ?? MAX_GLOBAL_SLOTS;
  const pollMs = opts.pollMs ?? SLOT_POLL_MS;

  mkdirSync(slotDir, { recursive: true });
  registerExitHandler();

  // Waiter marker for THIS acquire call, written lazily the first time we park
  // (all slots full) and removed once we acquire, abort, or exit.
  const waitPath = join(slotDir, `wait-${process.pid}-${waitSeq++}`);
  let waiting = false;
  const startWaiting = (): void => {
    if (waiting) return;
    const meta: WaitMeta = { pid: process.pid, label, since: new Date().toISOString() };
    try {
      writeFileSync(waitPath, JSON.stringify(meta));
      heldWaiters.add(waitPath);
      waiting = true;
    } catch {
      /* marker is advisory — a failed write must not block acquisition */
    }
  };
  const stopWaiting = (): void => {
    if (!waiting) return;
    waiting = false;
    heldWaiters.delete(waitPath);
    try {
      rmSync(waitPath);
    } catch {
      /* already removed — ignore */
    }
  };

  try {
    for (;;) {
      if (opts.signal?.aborted) {
        throw new Error('Aborted while waiting for a concurrency slot');
      }
      for (let i = 0; i < maxSlots; i++) {
        const slotPath = join(slotDir, `slot-${i}`);
        if (tryClaim(slotPath, label)) {
          stopWaiting();
          let released = false;
          return (): void => {
            if (released) return;
            released = true;
            heldSlots.delete(slotPath);
            try {
              rmSync(slotPath);
            } catch {
              /* already removed — ignore */
            }
          };
        }
      }
      // All slots busy — register as a waiter, drop any from crashed holders,
      // then wait with jitter (jitter de-syncs windows that began polling at
      // the same instant).
      startWaiting();
      reclaimStale(slotDir);
      await delay(pollMs + Math.floor(Math.random() * pollMs), opts.signal);
    }
  } catch (err) {
    stopWaiting();
    throw err;
  }
};
