import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isPidAlive } from './pid.js';

// ---------------------------------------------------------------------------
// Pure scan + render of the cross-process slot directory (semaphore.ts).
// ---------------------------------------------------------------------------
//
// WHY: `dag-executor --slots` peeks at live machine-wide session status without
// touching the running executors — it just reads the shared slot dir. Holders
// are `slot-*` files; parked tasks are `wait-*` markers. Both layers are pure
// over the filesystem so they're trivially testable.

/** A claimed concurrency slot (`slot-*` file). */
export interface SlotInfo {
  /** Slot filename, e.g. `slot-0`. */
  slot: string;
  pid: number;
  label: string;
  startedAt: string;
  /** Holder PID is no longer alive (dead but not yet reclaimed). */
  stale: boolean;
}

/** A parked task waiting for a slot (`wait-*` marker). */
export interface WaitInfo {
  pid: number;
  label: string;
  since: string;
}

export interface SlotsScan {
  /** Total machine-wide slots (the N in `H/N held`). */
  maxSlots: number;
  holders: SlotInfo[];
  waiters: WaitInfo[];
}

/**
 * Scans `slotDir` into holders + waiters. Defensive throughout: a missing dir
 * yields an empty scan, and corrupt/empty files (or ones that vanish mid-scan)
 * are skipped. Dead-PID waiters are filtered out; dead-PID holders are kept but
 * flagged `stale` so the snapshot still shows the leaked slot.
 */
export const scanSlots = (slotDir: string, maxSlots: number): SlotsScan => {
  let entries: string[];
  try {
    entries = readdirSync(slotDir);
  } catch {
    return { maxSlots, holders: [], waiters: [] };
  }

  const holders: SlotInfo[] = [];
  const waiters: WaitInfo[] = [];

  for (const name of entries) {
    const isSlot = name.startsWith('slot-');
    const isWait = name.startsWith('wait-');
    if (!isSlot && !isWait) continue;

    let parsed: { pid: number; label: string; startedAt?: string; since?: string };
    try {
      parsed = JSON.parse(readFileSync(join(slotDir, name), 'utf-8'));
    } catch {
      continue; // corrupt/empty/ENOENT mid-scan — skip
    }

    if (isSlot) {
      holders.push({
        slot: name,
        pid: parsed.pid,
        label: parsed.label,
        startedAt: parsed.startedAt ?? '',
        stale: !isPidAlive(parsed.pid),
      });
    } else if (isPidAlive(parsed.pid)) {
      waiters.push({ pid: parsed.pid, label: parsed.label, since: parsed.since ?? '' });
    }
  }

  // Sort holders by numeric slot index (slot-2 before slot-10, not lexicographic).
  const slotIndex = (slot: string): number => {
    const n = Number.parseInt(slot.slice('slot-'.length), 10);
    return Number.isNaN(n) ? Number.MAX_SAFE_INTEGER : n;
  };
  holders.sort((a, b) => slotIndex(a.slot) - slotIndex(b.slot));
  // Sort waiters oldest-first by parsed timestamp; missing/corrupt `since` sorts last.
  const sinceTime = (s: string): number => {
    const t = Date.parse(s);
    return Number.isNaN(t) ? Infinity : t;
  };
  waiters.sort((a, b) => {
    const va = sinceTime(a.since);
    const vb = sinceTime(b.since);
    return va === vb ? 0 : va < vb ? -1 : 1;
  });
  return { maxSlots, holders, waiters };
};

// `4m12s`-style duration. logger.ts's fmtDuration is `4.2m`-style and unexported,
// so we write our own — a compact whole-seconds form reads better for slot ages.
const fmtDuration = (ms: number): string => {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m${s}s` : `${s}s`;
};

const fmtAge = (iso: string, now: number): string => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? '?' : fmtDuration(now - t);
};

/**
 * Renders a scan to a human-readable multi-line string. The first line is always
 * exactly `slots H/N held · W waiting`; holder and waiter lines follow.
 */
export const renderSlotsStatus = (scan: SlotsScan, now: number = Date.now()): string => {
  const lines: string[] = [`slots ${scan.holders.length}/${scan.maxSlots} held · ${scan.waiters.length} waiting`];

  for (const h of scan.holders) {
    const staleMark = h.stale ? ' (stale)' : '';
    lines.push(`  ${h.slot}  ${h.label}  pid ${h.pid}  ${fmtAge(h.startedAt, now)}${staleMark}`);
  }
  for (const w of scan.waiters) {
    lines.push(`  wait  ${w.label}  pid ${w.pid}  ${fmtAge(w.since, now)}`);
  }

  return lines.join('\n');
};
