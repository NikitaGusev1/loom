import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { runCodexCli } from '../../codex-cli.js';
import { validateDAG } from '../../validation.js';
import type { UiInboxItem } from '../types.js';
import type { UiTriageResult } from './types.js';

export interface DagProposal {
  planPath: string;
  dagPath: string;
}

export interface DagPlanner {
  propose(projectPath: string, item: UiInboxItem, triage: UiTriageResult): Promise<DagProposal>;
}

export const buildDagPlannerPrompt = (item: UiInboxItem, triage: UiTriageResult): string =>
  `Use loom:explore only if clarification is needed, then loom:plan-from-spec and loom:decompose to create an approved plan and validated DAG for this project request. Do not implement it. Loom may also keep durable copies in its central artifact repository, but the UI requires project-local artifacts: copy or reuse the final plan and DAG under this project's .claude/ai directory and return those project-local paths. Return JSON only as {"planPath":"...","dagPath":"..."}. Request: ${JSON.stringify(item.body)}. Clarification transcript: ${JSON.stringify(item.clarificationMessages ?? [])}. Triage: ${JSON.stringify(triage)}`;

const within = (projectPath: string, path: string): string => {
  const absolute = resolve(projectPath, path);
  if (relative(resolve(projectPath), absolute).startsWith('..')) throw new Error('DAG proposal path escapes project');
  return absolute;
};

export class CodexDagPlanner implements DagPlanner {
  async propose(projectPath: string, item: UiInboxItem, triage: UiTriageResult): Promise<DagProposal> {
    const prompt = buildDagPlannerPrompt(item, triage);
    const result = await runCodexCli(prompt, { model: 'account-default', cwd: projectPath });
    const parsed = JSON.parse(result.trace.lastAssistantText) as DagProposal;
    const proposal = { planPath: within(projectPath, parsed.planPath), dagPath: within(projectPath, parsed.dagPath) };
    validateDAG(JSON.parse(readFileSync(proposal.dagPath, 'utf-8')));
    return proposal;
  }
}
