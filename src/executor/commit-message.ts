// Builds descriptive commit messages for the executor's auto-commits from the
// DAGTask material already in hand (name, description), replacing the opaque
// `dag-executor: <id>` subjects. Deterministic — no model call. Each task id is
// preserved as a `task-id:` trailer so traceability and grep survive.

import type { DAGTask } from '../types.js';

const SUBJECT_MAX = 72;

// Collapse whitespace to one line and cap at the conventional 72-char subject
// width, with an ellipsis when truncated.
const subjectLine = (s: string): string => {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= SUBJECT_MAX) return oneLine;
  return `${oneLine.slice(0, SUBJECT_MAX - 1).trimEnd()}…`;
};

// Single worktree task: name as subject, description as body, id as trailer.
export const buildTaskCommitMessage = (task: DAGTask): string => {
  const subject = subjectLine(task.name || task.id);
  const body = task.description?.trim();
  const trailer = `task-id: ${task.id}`;
  return [subject, body, trailer].filter(Boolean).join('\n\n');
};

// Trivial batch: one commit for N independent tasks, so there is no single
// focused subject — a summary subject plus a bulleted body, one line per task,
// each carrying its own id.
export const buildBatchCommitMessage = (tasks: DAGTask[], opts: { verifyFix?: boolean } = {}): string => {
  const label = opts.verifyFix ? 'trivial batch verify-fix' : 'trivial batch';
  const subject = `${label}: ${tasks.length} task${tasks.length === 1 ? '' : 's'}`;
  const lines = tasks.map((t) => `- ${subjectLine(t.name || t.id)} (${t.id})`);
  return [subject, lines.join('\n')].filter(Boolean).join('\n\n');
};
