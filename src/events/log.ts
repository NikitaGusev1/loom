import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import type { DagEvent } from './types.js';

export const getEventLogPath = (dagPath: string): string => dagPath.replace(/\.json$/, '.events.jsonl');

export const getDagPathFromEventLog = (eventLogPath: string): string =>
  eventLogPath.replace(/\.events\.jsonl$/, '.json');

export class EventLogParseError extends Error {
  lineNumber: number;
  lineContent: string;

  constructor(lineNumber: number, lineContent: string, cause: unknown) {
    super(`Failed to parse event log line ${lineNumber}: ${String(cause)}`);
    this.name = 'EventLogParseError';
    this.lineNumber = lineNumber;
    this.lineContent = lineContent;
    this.cause = cause;
  }
}

export const appendEvent = (logPath: string, event: DagEvent): void => {
  const line = `${JSON.stringify(event)}\n`;
  appendFileSync(logPath, line, { encoding: 'utf-8', flag: 'a' });
};

export const readEvents = (logPath: string): DagEvent[] => {
  if (!existsSync(logPath)) return [];
  const raw = readFileSync(logPath, 'utf-8');
  if (raw.length === 0) return [];

  const lines = raw.split('\n');
  const events: DagEvent[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === '') continue;

    try {
      events.push(JSON.parse(line) as DagEvent);
    } catch (cause) {
      throw new EventLogParseError(i + 1, line, cause);
    }
  }

  return events;
};

export const readRequiredEvents = (logPath: string): DagEvent[] => {
  if (!existsSync(logPath)) throw new Error(`event log not found: ${logPath}`);
  const events = readEvents(logPath);
  if (events.length === 0) throw new Error(`event log is empty: ${logPath}`);
  return events;
};
