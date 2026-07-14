import type { UiInboxItem } from '../types.js';
import type { UiTriageResult } from './types.js';

export const buildSequentialPlan = (projectPath: string, item: UiInboxItem, triage: UiTriageResult): string => `---
date: ${triage.evaluatedAt.slice(0, 10)}
status: approved
execution_mode: sequential
source_todo: ${item.id}
---

# ${triage.summary}

## Request

${item.body}

## Project

${projectPath}

## Scope

${triage.rationale}

Likely files:
${triage.estimatedFiles.map((file) => `- \`${file}\``).join('\n') || '- Determine during implementation.'}

## Acceptance Criteria

- Implement the requested narrow change without unrelated refactors.
- Run the repository's detected tests, formatting, and type checks.
- Review the resulting diff before completion.

## Execution

Use Loom's sequential implement-plan path. Do not create or execute a DAG decomposition.
`;
