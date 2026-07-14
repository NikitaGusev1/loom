const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, '$1[REDACTED]'],
  [/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]'],
  [/\b((?:API_KEY|TOKEN|SECRET|PASSWORD|CODEX_API_KEY|ANTHROPIC_API_KEY)\s*[=:]\s*)\S+/gi, '$1[REDACTED]'],
];

export const redactIntakeOutput = (value: string): string =>
  SECRET_PATTERNS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value).slice(0, 16_000);
