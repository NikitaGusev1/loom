// Quota / usage-limit detection.
// These failures are not useful to spin-retry inside Loom: the right recovery is
// to persist state, stop the run, and let the operator resume after the account
// limit resets.

import type { QuotaLimitCategory, QuotaLimitMetadata } from '../types.js';

export const QUOTA_LIMIT_ERROR_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(daily|weekly|monthly|five[-_\s]?hour)\s+(usage\s+)?limit\b/i,
  /\busage\s+limit\b/i,
  /\baccount\s+limit\b/i,
  /\btoken\s+limit\b/i,
  /\bquota\b/i,
  /\bcredits?\b.*\b(exhausted|used up|insufficient|limit)\b/i,
  /\b(reached|exceeded|hit)\s+(your\s+)?(current\s+)?(account|usage|rate|token|credit)\s+limit\b/i,
  /\b(usage|account|token|credit)\s+(cap|limit)\s+(reached|exceeded)\b/i,
];

const CATEGORY_PATTERNS: ReadonlyArray<[QuotaLimitCategory, RegExp]> = [
  ['daily', /\bdaily\b/i],
  ['weekly', /\bweekly\b/i],
  ['monthly', /\bmonthly\b/i],
  ['five-hour', /\bfive[-_\s]?hour\b/i],
  ['credit', /\bcredits?\b|\binsufficient\s+funds\b/i],
  ['token', /\btokens?\b/i],
  ['account', /\baccount\b/i],
  ['usage', /\busage\b/i],
  ['rate', /\brate\b/i],
  ['quota', /\bquota\b/i],
];

const ISO_DATE_PATTERN = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/;
const RESET_AT_NUMBER_PATTERN = /\b(?:resetsAt|reset_at|resetAt)\b["'\s:=]+(\d{10,13})\b/i;
const RETRY_AFTER_PATTERN = /\bretry[-_\s]?after\b["'\s:=]+(\d+)\b/i;

const categoryFor = (errorMessage: string): QuotaLimitCategory => {
  for (const [category, pattern] of CATEGORY_PATTERNS) {
    if (pattern.test(errorMessage)) return category;
  }
  return 'quota';
};

const isoFromEpoch = (raw: string): string | undefined => {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const ms = raw.length >= 13 ? n : n * 1000;
  return new Date(ms).toISOString();
};

const extractResetAt = (errorMessage: string): string | undefined => {
  const iso = errorMessage.match(ISO_DATE_PATTERN)?.[0];
  if (iso) return iso;

  const epoch = errorMessage.match(RESET_AT_NUMBER_PATTERN)?.[1];
  if (epoch) return isoFromEpoch(epoch);

  return undefined;
};

const extractRetryAfterMs = (errorMessage: string): number | undefined => {
  const seconds = errorMessage.match(RETRY_AFTER_PATTERN)?.[1];
  if (!seconds) return undefined;
  const n = Number(seconds);
  return Number.isFinite(n) && n >= 0 ? n * 1000 : undefined;
};

export const classifyQuotaLimitError = (errorMessage: string): QuotaLimitMetadata | null => {
  const reason = errorMessage.trim();
  if (!reason) return null;
  if (!QUOTA_LIMIT_ERROR_PATTERNS.some((pattern) => pattern.test(reason))) return null;
  const resetAt = extractResetAt(reason);
  const retryAfterMs = extractRetryAfterMs(reason);

  return {
    category: categoryFor(reason),
    reason,
    ...(resetAt ? { resetAt } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
};

export const isQuotaLimitError = (errorMessage: string): boolean => classifyQuotaLimitError(errorMessage) !== null;
