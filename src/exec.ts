import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const exec = promisify(execFile);

export const toErrorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
