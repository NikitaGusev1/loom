// Quota / usage-limit detection.
// These failures are not useful to spin-retry inside Loom: the right recovery is
// to persist state, stop the run, and let the operator resume after the account
// limit resets.

export const QUOTA_LIMIT_ERROR_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(daily|weekly|monthly|five[-_\s]?hour)\s+(usage\s+)?limit\b/i,
  /\busage\s+limit\b/i,
  /\btoken\s+limit\b/i,
  /\bquota\b/i,
  /\bcredits?\b.*\b(exhausted|used up|insufficient)\b/i,
  /\b(reached|exceeded)\s+(your\s+)?(current\s+)?(usage|rate|token)\s+limit\b/i,
];

export const isQuotaLimitError = (errorMessage: string): boolean =>
  QUOTA_LIMIT_ERROR_PATTERNS.some((pattern) => pattern.test(errorMessage));
