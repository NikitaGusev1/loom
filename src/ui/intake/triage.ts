import { runCodexCli } from '../../codex-cli.js';
import { triageResultSchema, type TriageProvider, type UiClarificationMessage, type UiTriageResult } from './types.js';
import type { IntakeProjectContext } from './context.js';

const extractJson = (value: string): unknown => {
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  return JSON.parse((fenced ?? value).trim());
};

export const buildTriagePrompt = (
  body: string,
  context: IntakeProjectContext,
  revision: number,
  clarificationMessages: UiClarificationMessage[] = [],
): string => `
Classify this project todo for a controlled local agent intake system. Return JSON only.

Todo: ${JSON.stringify(body)}
Clarification transcript: ${JSON.stringify(clarificationMessages)}
Project context: ${JSON.stringify(context)}

Required shape:
{"version":1,"status":"complete","relevance":"relevant|adjacent|unrelated|unknown","complexity":"trivial|small|medium|large|unknown","risk":"low|elevated|high","confidence":0.0,"summary":"...","rationale":"...","needsClarification":false,"questions":[],"estimatedFiles":[],"proposedAction":"execute-sequential|propose-dag|clarify|defer|reject","evaluatedAt":"ISO timestamp","proposalRevision":${revision}}

Use execute-sequential only for narrow trivial/small work. Infer safe defaults when they do not materially change the implementation. Request clarification only when unresolved ambiguity changes the target, scope, or outcome. When clarification is required, ask exactly one concise primary question and do not repeat an answered question. Understandable risk involving destructive work, auth, secrets, dependencies, deployment, migrations, external side effects, or dirty Git requires approval rather than clarification.
`;

export const parseTriageResult = (value: unknown, revision: number): UiTriageResult => {
  const parsed = typeof value === 'string' ? extractJson(value) : value;
  return triageResultSchema.parse({ ...(parsed as object), proposalRevision: revision });
};

export class CodexTriageProvider implements TriageProvider {
  async triage(prompt: string, signal?: AbortSignal): Promise<unknown> {
    const result = await runCodexCli(prompt, { model: 'gpt-5.6-luna', reasoningEffort: 'low', signal });
    return result.trace.lastAssistantText;
  }
}
