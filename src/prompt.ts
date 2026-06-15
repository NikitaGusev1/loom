import type { ContractOutput, DAGTask } from './types.js';

// Prepended to the failure detail when re-invoking a session whose changes failed
// automated verification (Tier-1). The executor runs verification itself after the
// session — the agent only needs to fix what's reported.
export const VERIFICATION_FIX_NOTICE =
  'VERIFICATION FAILED: your previous changes did not pass automated verification ' +
  '(run automatically after your session — you do not need to run it yourself). ' +
  'Fix the failures reported below, then stop. Fix the root cause — never weaken or ' +
  'delete tests to make them pass. The exact failing output:';

const renderOutputLine = (name: string, out: ContractOutput): string => {
  switch (out.kind) {
    case 'file':
      return `- ${name}: file at \`${out.path}\`${out.mediaType ? ` (${out.mediaType})` : ''} — ${out.description}`;
    case 'export':
      return `- ${name}: ${out.exportKind} \`${out.exportName}\` exported from \`${out.file}\` — ${out.description}`;
    case 'behavioral':
      return `- ${name}: behavioral guarantee — ${out.description}`;
    default: {
      const _exhaustive: never = out;
      return _exhaustive;
    }
  }
};

const buildPhaseZero = (task: DAGTask): string[] => {
  const sections: string[] = [];
  const figmaRef = task.context.figmaRef;

  if (figmaRef) {
    sections.push('## Phase 0: Design Research (MANDATORY — complete before writing styled code)');
    sections.push('');

    if (figmaRef.nodeId) {
      sections.push(
        '1. Query `mcp__figma-console__figma_get_component_for_development` with nodeId ' +
          `\`${figmaRef.nodeId}\` to get exact design specs`,
      );
    } else if (figmaRef.url) {
      sections.push(
        `1. Use \`mcp__figma-console__figma_navigate\` to navigate to: ${figmaRef.url}`,
        '   Then use `mcp__figma-console__figma_take_screenshot` + `mcp__figma-console__figma_get_component` to extract tokens',
      );
    }

    sections.push(
      '2. Document every token you find: colors, sizes, spacing, font weights, radii, borders',
      '3. Cross-reference tokens with `src/configs/theme/colors.ts` to find the correct `g`-prefixed theme tokens',
      '4. Map Figma values to codebase equivalents (e.g. Figma "#1A1A1A" → `gTextBody`)',
    );

    if (figmaRef.hints && figmaRef.hints.length > 0) {
      sections.push('');
      sections.push('**Pay special attention to:**');
      for (const hint of figmaRef.hints) {
        sections.push(`- ${hint}`);
      }
    }

    sections.push('');
  }

  // Component discovery — always included for UI tasks (tasks with figmaRef, layoutSpec, or style-related files)
  const isUITask =
    figmaRef ||
    task.context.layoutSpec ||
    task.context.files.some((f) => f.includes('style.ts') || f.includes('Style.ts'));

  if (isUITask) {
    sections.push(
      '### Understand Existing Styles (BEFORE modifying any styled code)',
      '',
      'Before changing any style property, read the FULL style chain:',
      "- Read the component's `style.ts` completely — understand every existing property",
      '- Read the component file to see how styled components are composed',
      '- Read parent components that render this component — understand the layout context (flex direction, alignment, spacing)',
      '- A property you overlook (padding, flex, margin, overflow) can silently conflict with your changes',
      '- Plans describe the target state but may not list every existing property that affects layout. You must discover those yourself.',
      '',
      '### Component Discovery (BEFORE creating styled components)',
      '',
      'Before creating ANY new styled component, search for existing equivalents:',
      '- Grep for component names that match what you need (Button, Input, Card, Sheet, Tag, etc.)',
      '- Check `src/components/common/` for shared components (e.g. PrimaryButton, SecondaryButton, ThemedText)',
      '- If a shared component does 80%+ of what you need, USE IT. Do not recreate.',
      '- Document which shared components you found and your use/skip decision with reasoning.',
      '',
    );
  }

  if (figmaRef) {
    sections.push(
      '**If Figma MCP is unavailable:** STOP immediately. Include `FIGMA_UNAVAILABLE` in your result. Do not guess token values.',
      '',
    );
  }

  return sections;
};

const buildCompletionCriteria = (task: DAGTask): string[] => {
  const sections: string[] = ['## Completion Criteria'];
  if (task.completionCriteria.automated.length > 0) {
    sections.push('Automated:');
    for (const criterion of task.completionCriteria.automated) {
      sections.push(`- ${criterion}`);
    }
  }
  if (task.completionCriteria.manual.length > 0) {
    sections.push('Manual:');
    for (const criterion of task.completionCriteria.manual) {
      sections.push(`- ${criterion}`);
    }
  }
  sections.push('');
  return sections;
};

const buildVerificationProtocol = (task: DAGTask): string[] => {
  const sections: string[] = [];

  sections.push('## Completion Protocol');
  sections.push('');
  sections.push(
    'Verification (tests, lint, type-check) runs AUTOMATICALLY after your session — you do',
    'not need to run it yourself or paste output. If it fails, you will be re-invoked with the',
    'exact errors to fix. Before finishing, make sure every declared output below actually',
    'exists on disk (written via the Write/Edit tools — content pasted into your reply writes nothing).',
    '',
  );

  // List expected output contracts for clarity
  const outputs = Object.entries(task.contracts.outputs);
  if (outputs.length > 0) {
    sections.push('**Your output contracts (must all exist when you finish):**');
    for (const [name, out] of outputs) {
      sections.push(renderOutputLine(name, out));
    }
    sections.push('');
  }

  sections.push(
    '### Debug systematically',
    'If tests fail: read the error, trace the root cause, form a single hypothesis,',
    'and make the smallest fix. Do NOT guess or try multiple fixes at once.',
    'If 3 fix attempts fail, stop and report findings.',
    '',
    '### Fix the root cause, not the symptom',
    'Never modify test files to make tests pass. Never weaken assertions.',
    'If a test expectation seems wrong, report it as a deviation — do not change the test.',
    '',
  );

  return sections;
};

export const buildTaskPrompt = (task: DAGTask): string => {
  const sections: string[] = [];

  sections.push(
    'You are implementing a single task from a decomposition plan. Stay strictly within',
    'your scope — only modify files listed in your context, and produce exactly the',
    'outputs specified in your contracts.',
    '',
    'CRITICAL: files exist ONLY if you create or modify them via the Write/Edit tools.',
    'File content pasted into your reply text writes NOTHING. A task that ends with zero',
    'file modifications is a FAILURE — even if you believe the work is already done,',
    'verify each declared output exists on disk and contains the required changes.',
    '',
    '## Project Context',
    'Read `.claude/references/design-system-tokens.md` if your task involves UI/styling — it maps Figma tokens to codebase theme tokens.',
    '',
  );

  // Task
  sections.push(`## Task: ${task.name}`, task.description, '');

  // Input Contracts
  sections.push('## Input Contracts');
  const inputEntries = Object.entries(task.contracts.inputs);
  if (inputEntries.length === 0) {
    sections.push('This is a root task with no input dependencies.');
  } else {
    for (const [name, { type, source }] of inputEntries) {
      sections.push(`- ${name}: ${type ?? 'any'} — from ${source}`);
    }
  }
  sections.push('');

  // Output Contracts
  sections.push('## Output Contracts (you MUST produce these)');
  for (const [name, out] of Object.entries(task.contracts.outputs)) {
    sections.push(renderOutputLine(name, out));
  }
  sections.push('');

  // Files in Scope
  sections.push('## Files in Scope');
  for (const file of task.context.files) {
    sections.push(`- ${file}`);
  }
  sections.push('');
  sections.push(
    'Only read and modify these files. If you discover you need to touch a file outside',
    'this list, note it in your response but do not modify it.',
    '',
  );

  // Phase 0: Design Research + Component Discovery
  sections.push(...buildPhaseZero(task));

  // Related Patterns
  if (task.context.relatedPatterns && task.context.relatedPatterns.length > 0) {
    sections.push('## Related Patterns (model your work after these)');
    for (const { file, relevance } of task.context.relatedPatterns) {
      sections.push(`- ${file}: ${relevance}`);
    }
    sections.push('');
  }

  // Layout Specification
  if (task.context.layoutSpec) {
    sections.push('## Layout Specification (FOLLOW EXACTLY)');
    sections.push(
      'This layout structure comes from the Figma design and must be reproduced faithfully.',
      'Pay close attention to: flex direction, alignment, spacing values, nesting order,',
      'and which containers use flex vs fixed sizing.',
      '',
      task.context.layoutSpec,
      '',
    );
  }

  // Figma Design Tokens
  const figmaTokens = task.context.figmaTokens;
  if (figmaTokens && Object.keys(figmaTokens).length > 0) {
    sections.push('## Figma Design Tokens (VERIFY before implementing)');
    sections.push(
      'The following tokens were extracted from the plan. They may be APPROXIMATE or WRONG.',
      'Before writing styled code, you MUST query Figma MCP tools to verify exact values:',
      '- `mcp__figma-desktop__get_design_context` — structural overview with resolved tokens',
      '- `mcp__figma-console__figma_get_component_for_development` — dev-ready specs with exact sizes',
      '',
      'Figma is the source of truth. If plan values differ from Figma, use Figma values.',
      'Pay special attention to: icon sizes, border colors, font sizes/weights, and layout alignment.',
      '',
    );
    for (const [element, token] of Object.entries(figmaTokens)) {
      sections.push(`- ${element}: ${token}`);
    }
    sections.push('');
  }

  // Conventions
  if (task.context.conventions && task.context.conventions.length > 0) {
    sections.push('## Conventions');
    for (const convention of task.context.conventions) {
      sections.push(`- ${convention}`);
    }
    sections.push('');
  }

  sections.push(...buildCompletionCriteria(task));
  sections.push(...buildVerificationProtocol(task));

  // Reporting instruction
  sections.push(
    'Implement this task now. When done, report:',
    '1. What files you created or modified',
    '2. What exports/interfaces you produced (matching output contracts)',
    '3. Any issues or deviations from the plan',
  );

  return sections.join('\n');
};

export const buildBatchedTrivialPrompt = (tasks: DAGTask[]): string => {
  const sections: string[] = [];

  sections.push(
    'You are implementing multiple trivial tasks from a decomposition plan.',
    'Each task is small and mechanical. Complete them as a checklist, one by one.',
    '',
    'CRITICAL: files exist ONLY if you create or modify them via the Write/Edit tools.',
    'File content pasted into your reply text writes NOTHING. A task that ends with zero',
    'file modifications is a FAILURE — even if you believe the work is already done,',
    'verify each declared output exists on disk and contains the required changes.',
    '',
  );

  for (const [i, task] of tasks.entries()) {
    sections.push(`## Task ${i + 1}: ${task.name}`);
    sections.push(task.description);
    sections.push('');

    sections.push('**Files:**');
    for (const file of task.context.files) {
      sections.push(`- ${file}`);
    }
    sections.push('');

    sections.push('**Output contracts:**');
    for (const [name, out] of Object.entries(task.contracts.outputs)) {
      sections.push(renderOutputLine(name, out));
    }
    sections.push('');

    if (task.context.conventions && task.context.conventions.length > 0) {
      sections.push('**Conventions:**');
      for (const convention of task.context.conventions) {
        sections.push(`- ${convention}`);
      }
      sections.push('');
    }
  }

  sections.push(
    '## Completion Protocol',
    '',
    'Verification (tests, lint, type-check) runs AUTOMATICALLY after your session — you do not',
    'need to run it yourself or paste output. If it fails, you will be re-invoked with the errors',
    'to fix. Before finishing, make sure every declared output from every task above actually',
    'exists on disk (written via the Write/Edit tools — content pasted into your reply writes nothing).',
  );

  return sections.join('\n');
};
