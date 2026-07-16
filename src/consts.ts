import type { DAGTask } from './types.js';
export { ZERO_USAGE } from './usage.js';

export const WEIGHT_MAX_TURNS: Record<DAGTask['weight'], number> = {
  trivial: 50,
  standard: 100,
  heavy: 150,
};

export const WEIGHT_DEADLINE_MS: Record<DAGTask['weight'], number> = {
  trivial: 300_000,
  standard: 900_000,
  heavy: 1_800_000,
};

// Per-weight hard cost ceiling passed to `claude -p --max-budget-usd` — the
// runaway-session guard (the CLI exposes no documented --max-turns; that flag is
// passed best-effort via WEIGHT_MAX_TURNS). These are generous caps, not targets:
// a session that hits its budget aborts. Tune down from dagCostSummary actuals.
export const WEIGHT_BUDGET_USD: Record<DAGTask['weight'], number> = {
  trivial: 2,
  standard: 6,
  heavy: 20,
};

// Machine-wide cap on concurrent CC sessions across ALL dag-executor windows
// (cross-process, enforced via file-based slots in semaphore.ts). Sized for a
// 24GB Mac at ~2-4GB peak per live session: 4 slots ≈ 12-16GB, leaving headroom
// for the OS, Warp, and a browser before swap kicks in.
export const MAX_GLOBAL_SLOTS = 4;

// Poll interval (ms) when waiting for a slot to free. Actual wait adds 0–pollMs
// jitter to de-synchronize windows that began waiting simultaneously.
export const SLOT_POLL_MS = 1_000;

// Cap the heap of executor-spawned node tooling (jest/eslint/prettier). Bounds
// per-process RAM so the semaphore's session budget isn't blown by a runaway
// post-exec step. Spread over process.env at the call site to keep PATH etc.
export const NODE_HEAP_ENV = { NODE_OPTIONS: '--max-old-space-size=2048' } as const;

// Per-weight wall-clock ceiling (ms) for a single verification check (test /
// lint / typecheck). A check that exceeds it is treated as a failure, not a
// hang. Heavier tasks touch more surface, so allow them longer.
export const WEIGHT_VERIFICATION_TIMEOUT_MS: Record<DAGTask['weight'], number> = {
  trivial: 120_000,
  standard: 180_000,
  heavy: 300_000,
};

// Max in-worktree fix re-invokes after a Tier-1 verification failure before the
// task is marked permanently verification-failed (and left unmerged).
export const VERIFICATION_MAX_FIX_ATTEMPTS = 2;

export const BACKLOG_PAUSE_ABORT_REASON = 'backlog-pause';

export const MODEL_CONTEXT_WINDOW: Record<string, number> = {
  'claude-opus-4-8': 1_000_000,
  'claude-sonnet-5': 1_000_000,
  'claude-sonnet-4-6': 1_000_000,
  'claude-haiku-4-5-20251001': 200_000,
  'account-default': 250_000,
  'gpt-5': 400_000,
  'gpt-5-mini': 400_000,
};

export const DEFAULT_CONTEXT_WINDOW = 250_000;

export const DEFAULT_EXECUTOR_MODELS = {
  provider: 'codex',
  defaultModel: 'gpt-5.6-terra',
  heavyModel: 'gpt-5.6-sol',
  maxTurns: 80,
  permissionMode: 'bypassPermissions',
  dagPath: '',
  dryRun: false,
} as const;
