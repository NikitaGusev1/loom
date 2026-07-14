import { runCodexCli } from '../../codex-cli.js';
import { triageResultSchema, type TriageProvider, type UiTriageResult } from './types.js';
import type { IntakeProjectContext } from './context.js';

const extractJson = (value: string): unknown => {
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  return JSON.parse((fenced ?? value).trim());
};

export const buildTriagePrompt = (body: string, context: IntakeProjectContext, revision: number): string => `
Classify this project todo for a controlled local agent intake system. Return JSON only.

Todo: ${JSON.stringify(body)}
Project context: ${JSON.stringify(context)}

Required shape:
{"version":1,"status":"complete","relevance":"relevant|adjacent|unrelated|unknown","complexity":"trivial|small|medium|large|unknown","risk":"low|elevated|high","confidence":0.0,"summary":"...","rationale":"...","needsClarification":false,"questions":[],"estimatedFiles":[],"proposedAction":"execute-sequential|propose-dag|clarify|defer|reject","evaluatedAt":"ISO timestamp","proposalRevision":${revision}}

Use execute-sequential only for narrow trivial/small work. Ambiguous pronouns, unclear outcomes, destructive work, auth, secrets, dependencies, deployment, migrations, and external side effects must not auto-run.
`;

export const parseTriageResult = (value: unknown, revision: number): UiTriageResult => {
  const parsed = typeof value === 'string' ? extractJson(value) : value;
  return triageResultSchema.parse({ ...(parsed as object), proposalRevision: revision });
};

export class CodexTriageProvider implements TriageProvider {
  async triage(prompt: string, signal?: AbortSignal): Promise<unknown> {
    const result = await runCodexCli(prompt, { model: 'account-default', signal });
    return result.trace.lastAssistantText;
  }
}
